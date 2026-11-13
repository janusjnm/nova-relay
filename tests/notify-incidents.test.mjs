// notify-incidents.test.mjs — incident dedup / cooldown for planner wakes, delivery counters.
// batch_done semantics stay: exactly one when terminal, none after ack, payload {source,batch,id,state,exit_code}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, admitWake, batchWakeEvents, deliveryCounts, incidentFor } from "../lib/notify.mjs";
import { HANDLERS, dispatch, flushOutbox, tick, worker } from "../lib/relay.mjs";
import { BRIEF, tempRepo, testConfig, testContext } from "./helpers.mjs";

const B = (tasks, extra = {}) => ({ id: "b-1", project: "PD", tasks, acked: false, ...extra });

test("same executor-wide cause on several tasks of a batch → one blocked wake; distinct causes still wake separately", () => {
  const ev = batchWakeEvents(B({ a: { state: "blocked", block_incident: "claude_cli-x", wake_seq: 1 }, b: { state: "blocked", block_incident: "claude_cli-x", wake_seq: 1 }, c: { state: "blocked", wake_seq: 1 } }));
  assert.equal(new Set(ev.map((e) => e.key)).size, 2, "a+b share one key; c (no incident) has its own");
  const esc = batchWakeEvents(B({ a: { state: "failed", escalated: true, escalation_incident: "net-1" }, b: { state: "failed", escalated: true, escalation_incident: "net-1" }, c: { state: "running" } }));
  assert.equal(new Set(esc.map((e) => e.key)).size, 1, "network escalations share an incident");
  for (const e of [...ev, ...esc]) assert.deepEqual(Object.keys(e.payload).sort(), ["batch", "exit_code", "id", "source", "state"]);
  // A blocked task without an incident and the batch_done rule are unchanged.
  const done = batchWakeEvents(B({ a: { state: "done" }, b: { state: "failed", exit_code: 1 } }));
  assert.deepEqual(done.map((e) => e.key), ["b-1:batch_done"]);
  assert.deepEqual(batchWakeEvents(B({ a: { state: "blocked", block_incident: "x" } }, { acked: true })), []);
});

test("incidentFor: one id within the cooldown, a new id afterwards (durable on disk)", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-inc-"));
  const t0 = Date.now();
  const a = incidentFor(home, "claude:cli", 60_000, t0);
  const b = incidentFor(home, "claude:cli", 60_000, t0 + 30_000);
  const c = incidentFor(home, "claude:cli", 60_000, t0 + 61_000);
  assert.equal(a.fresh, true);
  assert.equal(b.id, a.id);
  assert.equal(b.fresh, false);
  assert.notEqual(c.id, a.id);
  assert.notEqual(incidentFor(home, "codex:cli", 60_000, t0).id, a.id, "per cause class");
  assert.equal(admitWake(home, "unreachable:b:box", "o1", 60_000, t0), true);
  assert.equal(admitWake(home, "unreachable:b:box", "o1", 60_000, t0 + 1000), true, "same outage: admitted (the outbox dedups the key)");
  assert.equal(admitWake(home, "unreachable:b:box", "o2", 60_000, t0 + 2000), false, "new outage inside the cooldown: suppressed");
  assert.equal(admitWake(home, "unreachable:b:box", "o2", 60_000, t0 + 61_000), true);
});

test("runner: two tasks blocked by the same CLI-flag failure → the first wake goes out at once, the second adds none", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const ctx = testContext(cfg, { FAKE_MODE: "badflag-run" });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }, { name: "b.md", text: BRIEF() }] });
  await worker(ctx, { once: true }); // scopes overlap: the tasks run one after the other
  assert.equal(ctx.sent.length, 1, "first task blocked → wake sent immediately, before the second ran");
  await worker(ctx, { once: true });
  const [a, b] = r.tasks.map((x) => ctx.store.get(x.id));
  assert.equal(a.state, "blocked");
  assert.equal(b.state, "blocked");
  assert.equal(a.block_incident, b.block_incident);
  assert.equal(ctx.sent.length, 1, "one planner wake for one incident");
  assert.equal(ctx.sent[0].body.state, "blocked");
  await tick(ctx);
  await tick(ctx);
  assert.equal(ctx.sent.length, 1, "repeated ticks enqueue nothing new");
  assert.equal(HANDLERS.pending(ctx, { owner: "grok" }).length, 1, "the batch is still pending for the planner");
});

test("delivery counters: attempts vs unique deliveries; a webhook dropped after ack is neither", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  let failures = 2;
  const ctx = testContext(cfg, {}, { fetchImpl: async () => { if (failures-- > 0) throw new Error("ENETUNREACH"); return { ok: true, status: 200 }; } });
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-c", project: "PD", owner: "g", expected: 1, tasks: { a: { host: "box", state: "queued", rev: 0 } } } });
  await HANDLERS.report(ctx, { batch: "b-c", id: "a", state: "done", exit_code: 0, rev: 2 });
  await flushOutbox(ctx, { now: Date.now() + 60_000 });
  await flushOutbox(ctx, { now: Date.now() + 10 * 60_000 });
  await flushOutbox(ctx, { now: Date.now() + 20 * 60_000 });
  const c = deliveryCounts(cfg.home).webhook;
  assert.deepEqual(c, { notification_attempts: 3, notification_deliveries: 1, notification_failures: 2 });
  // Acked before the queued wake went out: dropped, not counted as a delivery.
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-d", project: "PD", owner: "g", expected: 1, tasks: { a: { host: "box", state: "queued", rev: 0 } } } });
  ctx.fetchImpl = async () => { throw new Error("down"); };
  await HANDLERS.report(ctx, { batch: "b-d", id: "a", state: "done", exit_code: 0, rev: 2 });
  await HANDLERS.ack(ctx, { batch: "b-d" });
  await flushOutbox(ctx, { now: Date.now() + 60 * 60_000 });
  const d = deliveryCounts(cfg.home).webhook;
  assert.equal(d.notification_deliveries, 1, "dropped wake not counted");
  assert.equal(new Outbox(cfg.home).pending().length, 0);
});
