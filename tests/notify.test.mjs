// notify.test.mjs — batch wake rules, outbox dedup/retry, coordinator report ordering, ack, heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, batchWakeEvents } from "../lib/notify.mjs";
import { HANDLERS, checkHeartbeats, flushOutbox, verdictLine } from "../lib/relay.mjs";
import { testConfig, testContext, tempRepo } from "./helpers.mjs";

const B = (tasks, extra = {}) => ({ id: "b-1", project: "PD", tasks, acked: false, ...extra });

test("no wake while tasks are still running; one wake when the whole batch is terminal", () => {
  assert.deepEqual(batchWakeEvents(B({ a: { state: "done" }, b: { state: "running" } })), []);
  const ev = batchWakeEvents(B({ a: { state: "done" }, b: { state: "failed", exit_code: 1 } }));
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { source: "nova-relay", batch: "b-1", id: "*", state: "batch_done", exit_code: 1 });
  assert.equal(batchWakeEvents(B({ a: { state: "done" }, b: { state: "done" } }))[0].payload.exit_code, 0);
});

test("batch_done waits for all expected tasks (partially registered batch)", () => {
  assert.deepEqual(batchWakeEvents(B({ a: { state: "done" } }, { expected: 2 })), []);
});

test("early wakes: approval, auth, blocked, escalated failure; none after ack", () => {
  const ev = batchWakeEvents(B({ a: { state: "needs_approval", wake_seq: 1 }, b: { state: "running" }, c: { state: "failed", escalated: true, exit_code: 1 }, d: { state: "needs_auth", wake_seq: 1 } }));
  assert.deepEqual(ev.map((e) => e.payload.state).sort(), ["failed", "needs_approval", "needs_auth"]);
  for (const e of ev) assert.deepEqual(Object.keys(e.payload).sort(), ["batch", "exit_code", "id", "source", "state"], "payload carries no task content");
  assert.deepEqual(batchWakeEvents(B({ a: { state: "needs_approval" } }, { acked: true })), []);
  // A second approval round gets a new key (wake_seq), the same round does not.
  const k1 = batchWakeEvents(B({ a: { state: "needs_approval", wake_seq: 1 } }))[0].key;
  const k2 = batchWakeEvents(B({ a: { state: "needs_approval", wake_seq: 2 } }))[0].key;
  assert.notEqual(k1, k2);
});

test("outbox: dedup by key, retry with backoff, dead-letter after max attempts", async () => {
  const home = mkdtempSync(join(tmpdir(), "nova-ob-"));
  const ob = new Outbox(home);
  assert.equal(ob.enqueue("k1", { kind: "webhook", payload: {} }), true);
  assert.equal(ob.enqueue("k1", { kind: "webhook", payload: {} }), false, "duplicate key ignored");
  let calls = 0;
  const failing = async () => { calls++; throw new Error("ECONNREFUSED"); };
  const now = Date.now();
  await ob.flush(failing, { now });
  assert.equal(calls, 1);
  await ob.flush(failing, { now: now + 1000 });
  assert.equal(calls, 1, "backoff: not retried immediately");
  await ob.flush(failing, { now: now + 31_000 });
  assert.equal(calls, 2);
  await ob.flush(async () => {}, { now: now + 10 * 60_000 });
  assert.equal(ob.pending().length, 0);
  assert.equal(ob.enqueue("k1", { kind: "webhook", payload: {} }), false, "sent key stays deduped");
  ob.enqueue("k2", { kind: "webhook", payload: {} });
  await ob.flush(failing, { now: Date.now() + 1000, maxAttempts: 1 });
  assert.equal(ob.dead().length, 1);
});

test("coordinator: out-of-order reports ignored by rev; webhook sent once; ack stops wakes", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-9", project: "PD", owner: "grok", expected: 2, tasks: { a: { state: "queued", rev: 0 }, b: { state: "queued", rev: 0 } } } });
  await HANDLERS.report(ctx, { batch: "b-9", id: "a", state: "done", exit_code: 0, rev: 5 });
  await HANDLERS.report(ctx, { batch: "b-9", id: "a", state: "running", rev: 3 }); // late, stale
  assert.equal(ctx.store.getBatch("b-9").tasks.a.state, "done");
  assert.equal(ctx.sent.length, 0, "no wake until the batch is done");
  await HANDLERS.report(ctx, { batch: "b-9", id: "b", state: "failed", exit_code: 1, verdict: "FAIL cmd:npm test: 1 failing", rev: 4 });
  await HANDLERS.report(ctx, { batch: "b-9", id: "b", state: "failed", exit_code: 1, rev: 6 }); // duplicate terminal
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual(ctx.sent[0].body, { source: "nova-relay", batch: "b-9", id: "*", state: "batch_done", exit_code: 1 });
  assert.equal(ctx.sent[0].headers["Idempotency-Key"], "b-9:batch_done");
  assert.match(ctx.sent[0].headers.Authorization, /^Bearer k+$/);
  const pending = HANDLERS.pending(ctx, { owner: "grok" });
  assert.equal(pending.length, 1);
  assert.match(pending[0].line, /^batch b-9 FAIL 1\/2 \| b failed/);
  assert.equal(HANDLERS.pending(ctx, { owner: "someone-else" }).length, 0);
  await assert.rejects(HANDLERS.ack(ctx, { batch: "b-9", owner: "intruder" }), /belongs to/);
  await HANDLERS.ack(ctx, { batch: "b-9", owner: "grok" });
  assert.equal(HANDLERS.pending(ctx, { owner: "grok" }).length, 0, "idempotent: after ack, duplicate wakes find nothing");
});

test("webhook failure stays queued and is retried by flush", async () => {
  const { root, repo } = tempRepo();
  let up = false;
  const ctx = testContext(testConfig(root, repo), {}, { fetchImpl: async () => { if (!up) throw new Error("fetch failed"); return { ok: true, status: 200 }; } });
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-2", project: "PD", owner: "g", tasks: { a: { state: "queued" } } } });
  await HANDLERS.report(ctx, { batch: "b-2", id: "a", state: "done", exit_code: 0, rev: 1 });
  assert.equal(ctx.outbox.pending().length, 1);
  up = true;
  await ctx.outbox.flush(async () => {}, { now: Date.now() + 60_000 });
  assert.equal(ctx.outbox.pending().length, 0);
  void flushOutbox;
});

test("missing webhook env never sends and never crashes", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo), { PD_URL: "" });
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-3", project: "PD", owner: "g", tasks: { a: { state: "queued" } } } });
  await HANDLERS.report(ctx, { batch: "b-3", id: "a", state: "done", exit_code: 0, rev: 1 });
  assert.equal(ctx.sent.length, 0);
  assert.match(ctx.outbox.pending()[0].last_error, /not set/);
});

test("heartbeat fallback: missed box heartbeat wakes once per outage", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { self: "vps", coordinator: "vps", hosts: { vps: { role: "vps" }, box: { role: "box", ssh: "box" } } });
  const ctx = testContext(cfg);
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-4", project: "PD", owner: "g", tasks: { a: { host: "box", state: "running" } } } });
  HANDLERS.heartbeat(ctx, { host: "box" });
  assert.deepEqual(checkHeartbeats(ctx), [], "fresh heartbeat");
  const later = Date.now() + 20 * 60_000;
  assert.equal(checkHeartbeats(ctx, later).length, 1);
  assert.equal(checkHeartbeats(ctx, later + 60_000).length, 0, "same outage → no second wake");
  const e = ctx.outbox.pending()[0];
  assert.deepEqual(e.payload, { source: "nova-relay", batch: "b-4", id: "*", state: "box_unreachable", exit_code: null });
  writeFileSync(join(cfg.home, "run", "heartbeat-box.json"), JSON.stringify({ received_at: new Date(later).toISOString() }));
  // A new outage inside notify_cooldown_minutes (60) of the last wake is coalesced (flapping link);
  // once the cooldown has passed and the host is still out, it wakes again.
  assert.equal(checkHeartbeats(ctx, later + 30 * 60_000).length, 0, "flapping: new outage within the cooldown → no wake");
  assert.equal(checkHeartbeats(ctx, later + 61 * 60_000).length, 1, "new outage after the cooldown wakes again");
  assert.equal(checkHeartbeats(ctx, later + 62 * 60_000).length, 0, "and only once");
});

test("verdict line is one line", () => {
  const l = verdictLine(B({ a: { state: "done" }, b: { state: "needs_approval", approvals: [{ req: "abcd1234" }] } }));
  assert.equal(l, "batch b-1 WAIT 1/2 | b needs_approval req=abcd1234");
  assert.ok(!l.includes("\n"));
});
