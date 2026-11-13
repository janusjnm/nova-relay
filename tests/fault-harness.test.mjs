// fault-harness.test.mjs — repeatable, isolated fault scenarios on one host with the fake executor
// CLI (tests/fixtures/fake-agent.mjs), a temp git repo and a fixture webhook (no real network).
//
// Every case here is [simulated]: the fault is injected by the fake CLI / fake fetch. The real-
// runtime case is the LIVE bwrap test in process-isolation.test.mjs. Real VPS/ssh, Codex login,
// DeepSeek credentials, off-loopback webhooks, host sleep/reboot and production repos are pending
// external gates (docs/failure-modes.md) and are never exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, flushOutbox, worker } from "../lib/relay.mjs";
import { readPaused } from "../lib/budget.mjs";
import { deliveryCounts } from "../lib/notify.mjs";
import { stats } from "../lib/stats.mjs";
import { BRIEF, tempRepo, testConfig, testContext } from "./helpers.mjs";

async function harness(mode, { n = 1, limits = {}, cfgOver = {}, fetchImpl, env = {}, passes = 1 } = {}) {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, cfgOver);
  Object.assign(cfg.executors.claude.limits, limits);
  const ctx = testContext(cfg, { FAKE_MODE: mode, ...env }, fetchImpl ? { fetchImpl } : {});
  if (fetchImpl) ctx.sent = [];
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: Array.from({ length: n }, (_, i) => ({ name: `${i}.md`, text: BRIEF() })) });
  for (let i = 0; i < passes; i++) await worker(ctx, { once: true });
  return { ctx, cfg, tasks: r.tasks.map((x) => ctx.store.get(x.id)), batch: r.batch };
}

test("[simulated] lost network: segment failures back off, then escalate once; tasks hit by the same outage share one wake", async () => {
  const { ctx, tasks } = await harness("net", { n: 2, passes: 2, limits: { max_segment_failures: 1 } });
  for (const t of tasks) {
    assert.equal(t.state, "failed");
    assert.equal(t.escalated, true);
    assert.match(t.reason, /segment failed 2 times \(network\)/);
  }
  assert.equal(tasks[0].escalation_incident, tasks[1].escalation_incident);
  assert.equal(ctx.sent.filter((s) => s.body.state === "failed").length, 1, "one escalation wake for one network incident");
  assert.equal(ctx.sent.filter((s) => s.body.state === "batch_done").length, 1, "and the batch's own terminal wake");
});

test("[simulated] lost network at preflight (preflight_cmd fails): paused with backoff, no wake, nothing run", async () => {
  const { ctx, tasks } = await harness("ok", { cfgOver: { hosts: { box: { role: "box", preflight_cmd: "exit 1" } } } });
  assert.equal(tasks[0].state, "paused");
  assert.ok(Date.parse(tasks[0].resume_after) > Date.now());
  assert.equal(tasks[0].segments, 0);
  assert.equal(ctx.sent.length, 0);
});

test("[simulated] quota wall: executor paused until the parsed reset, task paused, no wake; stats shows the pause", async () => {
  const { ctx, cfg, tasks } = await harness("quota");
  assert.equal(tasks[0].state, "paused");
  const p = readPaused(cfg.home).claude;
  assert.equal(p.reason, "quota");
  assert.ok(Date.parse(p.until) > Date.now() + 50 * 60_000, "reset time from the CLI message (~1h)");
  assert.equal(ctx.sent.length, 0);
  assert.equal(stats(cfg).executors.find((e) => e.executor === "claude").paused.reason, "quota");
});

test("[simulated] auth failure: every affected task needs_auth, one wake per auth incident", async () => {
  const { ctx, tasks } = await harness("auth", { n: 2, passes: 2 });
  for (const t of tasks) assert.equal(t.state, "needs_auth");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].body.state, "needs_auth");
});

test("[simulated] hung executor: killed by the idle timeout, counted as a segment failure, escalated after the limit", async () => {
  const { tasks, ctx } = await harness("hang", { limits: { idle_timeout_sec: 1, max_segment_failures: 1 } });
  assert.equal(tasks[0].state, "failed");
  assert.match(tasks[0].reason, /segment failed 2 times/);
  assert.ok(ctx.store.events(tasks[0].id, 50).some((e) => /idle/.test(e.text)), "idle kill recorded");
});

test("[simulated] notification delivery failure: outbox retries with backoff, one delivery, no duplicate batch_done", async () => {
  let fails = 3;
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); if (fails-- > 0) throw new Error("ECONNREFUSED"); return { ok: true, status: 200 }; };
  const { ctx, cfg } = await harness("ok", { fetchImpl });
  const t0 = Date.now();
  for (const dt of [0, 31_000, 92_000, 300_000, 900_000, 1_800_000]) await flushOutbox(ctx, { now: t0 + dt });
  const done = posts.filter((p) => p.state === "batch_done");
  assert.equal(done.length, 4, "3 failed attempts + 1 success");
  assert.equal(new Set(done.map((p) => JSON.stringify(p))).size, 1, "always the same payload");
  const c = deliveryCounts(cfg.home).webhook;
  assert.equal(c.notification_deliveries, 1);
  assert.equal(c.notification_attempts, 4);
  assert.equal(ctx.outbox.pending().length, 0);
});
