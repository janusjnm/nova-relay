// review-5.test.mjs — fifth review: tryLock steal races, submit delivery that is lost after the
// host accepted (reconcile/fence before a batch can be terminal), async cancel-safe preflight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __setLockHook, tryLock, unlock } from "../lib/util.mjs";
import { normalizeConfig } from "../lib/config.mjs";
import { HANDLERS, SUBMIT_GRACE_MS, dispatch, reconcileSubmits, tick, verdictLine, worker } from "../lib/relay.mjs";
import { RpcError } from "../lib/rpc.mjs";
import { runTask } from "../lib/runner.mjs";
import { BRIEF, FAKE, tempRepo, testConfig, testContext } from "./helpers.mjs";

const deadPid = () => Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
const lockDir = () => mkdtempSync(join(tmpdir(), "nova-lock-"));
const holderOf = (p) => JSON.parse(readFileSync(`${p}.lock`, "utf8")).nonce;
// Run fn with the hook disabled (racers started from inside a hook must not re-trigger it).
const withHook = (hook, fn) => {
  let busy = false;
  __setLockHook((step) => { if (busy) return; busy = true; try { hook(step); } finally { busy = false; } });
  try { return fn(); } finally { __setLockHook(null); }
};

// ------------------------------------------------------------------ tryLock

test("tryLock: A steals a dead holder's lock while B (stale view) is mid-steal and C links in the gap — one holder only", () => {
  const p = join(lockDir(), "res");
  writeFileSync(`${p}.lock`, JSON.stringify({ pid: deadPid(), host: hostname(), at: Date.now(), nonce: "dead00000000" }));
  let A = null, C = null;
  const B = withHook((step) => {
    if (step === "judged" && !A) A = tryLock(p);   // B judged D dead; A completes a whole steal now
    if (step === "moved" && !C) C = tryLock(p);    // B moved something aside; C links into the gap
  }, () => tryLock(p));
  if (!C) C = tryLock(p);
  const holders = [A, B, C].filter(Boolean);
  assert.equal(holders.length, 1, `exclusive holders: ${holders.map((h) => h.nonce).join(", ")}`);
  assert.equal(holderOf(p), A.nonce, "the first stealer still holds it");
  unlock(p, A);
});

test("tryLock: a lock released and re-taken between B's failed link and its read is never moved aside", () => {
  const p = join(lockDir(), "res");
  const X = tryLock(p);
  let A = null;
  const B = withHook((step) => {
    if (step === "contended") unlock(p, X);        // holder releases right after B's link failed
    if (step === "judged" && !A) A = tryLock(p);   // and A takes the free lock before B acts
  }, () => tryLock(p));
  if (!A) A = tryLock(p);
  assert.equal([A, B].filter(Boolean).length, 1, "only one of A and B holds the lock");
  assert.equal(holderOf(p), (A || B).nonce);
});

test("tryLock: a stealer that died holding the steal token does not wedge the lock; a live one is respected", () => {
  const p = join(lockDir(), "res");
  const nonce = "dead11111111";
  writeFileSync(`${p}.lock`, JSON.stringify({ pid: deadPid(), host: hostname(), at: Date.now(), nonce }));
  writeFileSync(`${p}.lock.steal-${nonce}.0`, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), nonce: "a1fe22222222" }));
  assert.equal(tryLock(p), null, "a live stealer owns this instance");
  writeFileSync(`${p}.lock.steal-${nonce}.0`, JSON.stringify({ pid: deadPid(), host: hostname(), at: Date.now(), nonce: "dead33333333" }));
  const me = tryLock(p);
  assert.ok(me, "the dead stealer's token is skipped");
  assert.equal(holderOf(p), me.nonce);
  assert.deepEqual(readdirSync(join(p, "..")).filter((f) => f.includes(".steal-")), [], "steal tokens are cleaned up");
});

test("tryLock stress: 6 processes with random delays between protocol steps + holders killed inside the lock → never two holders", async () => {
  const dir = lockDir();
  const child = (mode, iters) => new Promise((resolve) => {
    const c = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/lock-stress.mjs", import.meta.url)), dir, String(iters), mode], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", (code, signal) => resolve({ code, signal, out: out.trim() }));
  });
  const workers = Array.from({ length: 6 }, () => child("work", 150));
  const crashers = [];
  for (let i = 0; i < 6; i++) { crashers.push(await child("crash", 1)); }
  const results = await Promise.all(workers);
  assert.ok(crashers.every((c) => c.signal === "SIGKILL"), "crashers died holding the lock");
  for (const r of results) assert.equal(r.code, 0);
  assert.deepEqual(results.map((r) => Number(r.out)), [0, 0, 0, 0, 0, 0], "overlapping critical sections per worker");
});

// ------------------------------------------------------------------ submit delivery

// Coordinator + dispatcher on "vps", task host "box" over a simulated ssh. net.submit decides what
// happens to submit calls: "ok", "lost-reply" (host stores the tasks, the reply never arrives:
// timeout) or "undelivered" (times out before reaching the host). net.boxDown fails every call.
async function twoHosts() {
  const { root, repo } = tempRepo();
  const mk = (self) => normalizeConfig({
    self, coordinator: "vps", home: join(root, `home-${self}`),
    hosts: { box: { role: "box", ssh: "box" }, vps: { role: "vps", ssh: "vps" } },
    limits: { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, max_local_retries: 2, lease_ttl_sec: 30 },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
    routing: { rules: [{ type: "code", executor: "claude" }] },
    projects: { PD: { repo: { box: repo, vps: repo }, base: "main", worktrees: { box: join(root, "wt-box"), vps: join(root, "wt-vps") }, webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
  }, {});
  const net = { submit: "ok", boxDown: false, calls: [] };
  const ctxs = {};
  const sshCall = async (_cfg, host, method, payload) => {
    net.calls.push(`${host}:${method}`);
    const timeout = () => new RpcError(`ssh ${host} ${method}: timeout`, { network: true });
    if (host === "box" && net.boxDown) throw new RpcError(`ssh ${host} unreachable: exit 255`, { network: true });
    if (method === "submit" && net.submit === "undelivered") throw timeout();
    const c = ctxs[host];
    const r = JSON.parse(JSON.stringify((await c.handlers[method](c, JSON.parse(JSON.stringify(payload)))) ?? { ok: true }));
    if (method === "submit" && net.submit === "lost-reply") throw timeout();
    return r;
  };
  ctxs.box = testContext(mk("box"), { FAKE_MODE: "ok" }, { sshCall });
  ctxs.vps = testContext(mk("vps"), {}, { sshCall });
  return { ctxs, net, dispatchOne: () => dispatch(ctxs.vps, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] }) };
}
const batchDoneQueued = (ctx) => [...ctx.outbox.pending(), ...ctx.sent.map((s) => ({ payload: s.body }))].some((e) => e.payload?.state === "batch_done");

test("submit reply lost after the host stored the task: batch is NOT failed; fence finds the task; host reports apply; batch completes PASS", async () => {
  const { ctxs, net, dispatchOne } = await twoHosts();
  net.submit = "lost-reply";
  const r = await dispatchOne();
  const id = r.tasks[0].id;
  assert.match(r.errors.join("\n"), /timeout; delivered after all/);
  assert.equal(net.calls.filter((c) => c === "box:submit").length, 3, "retried with the same id");
  assert.equal(readFileSync(join(ctxs.box.store.dir(id), "journal.jsonl"), "utf8").split("\n").filter((l) => l.includes('"created"')).length, 1, "created exactly once");
  let b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "queued", "reconciled to the host's real state");
  assert.match(verdictLine(b), / WAIT /);
  assert.equal(batchDoneQueued(ctxs.vps), false, "no false batch_done wake");
  await assert.rejects(HANDLERS.ack(ctxs.vps, { batch: r.batch, owner: "grok" }), /not finished/);
  await worker(ctxs.box, { once: true });
  b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "done", "the host's rev-1 running and later reports were not discarded as stale");
  assert.match(verdictLine(b), / PASS 1\/1/);
});

test("submit never reached the host: fenced → FAIL submit; a late duplicate submit is refused and creates nothing", async () => {
  const { ctxs, net, dispatchOne } = await twoHosts();
  net.submit = "undelivered";
  const r = await dispatchOne();
  const id = r.tasks[0].id;
  assert.match(r.errors.join("\n"), /not delivered \(fenced, FAIL submit\)/);
  const b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "failed");
  assert.equal(b.tasks[id].verdict, "FAIL submit");
  assert.equal(b.tasks[id].executor, "claude", "batch entry keeps its executor");
  assert.match(verdictLine(b), / FAIL 0\/1/);
  // The original request finally arrives (a stalled ssh session) — it must not resurrect the task.
  const late = await ctxs.box.handlers.submit(ctxs.box, { tasks: [{ task: { id, batch: r.batch, project: "PD", owner: "grok", type: "code", executor: "claude", host: "box" }, brief: BRIEF() }] });
  assert.deepEqual(late.refused, [id]);
  assert.equal(ctxs.box.store.exists(id), false);
  assert.equal(ctxs.box.store.list().length, 0, "the worker has nothing to run");
});

test("delivery unknown and host unreachable: batch stays WAIT (no terminal state, ack refused) until the coordinator's tick reconciles it", async () => {
  const { ctxs, net, dispatchOne } = await twoHosts();
  net.submit = "lost-reply";
  // The host goes away right after storing the task: the immediate fence cannot reach it.
  const origSubmit = ctxs.box.handlers.submit;
  ctxs.box.handlers = { ...ctxs.box.handlers, submit: (c, p) => { const res = origSubmit(c, p); net.boxDown = true; return res; } };
  const r = await dispatchOne();
  const id = r.tasks[0].id;
  assert.match(r.errors.join("\n"), /delivery unknown/);
  let b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "submitting");
  assert.equal(b.tasks[id].submit_unknown, true);
  assert.match(verdictLine(b), / WAIT /);
  await assert.rejects(HANDLERS.ack(ctxs.vps, { batch: r.batch, owner: "grok" }), /not finished/);
  assert.equal((await reconcileSubmits(ctxs.vps)).every((x) => !x.ok), true, "tick retry while still down: no change");
  assert.equal(ctxs.vps.store.getBatch(r.batch).tasks[id].state, "submitting");
  assert.equal(batchDoneQueued(ctxs.vps), false);
  net.boxDown = false;
  const tk = await tick(ctxs.vps);
  assert.deepEqual(tk.submits.map((x) => x.ok), [true]);
  b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "queued", "the task the host stored is found, not failed");
  await worker(ctxs.box, { once: true });
  assert.match(verdictLine(ctxs.vps.store.getBatch(r.batch)), / PASS 1\/1/);
});

test("dispatcher died before submitting: entries stay 'submitting' through the grace period, then the tick fences them (FAIL submit)", async () => {
  const { ctxs } = await twoHosts();
  await HANDLERS["batch-register"](ctxs.vps, { batch: { id: "b-orphan", project: "PD", owner: "grok", expected: 1, tasks: { "t-orphan": { host: "box", executor: "claude", state: "submitting", rev: 0 } } } });
  assert.deepEqual(await reconcileSubmits(ctxs.vps), [], "within the grace period nothing is fenced (dispatch may still be submitting)");
  const later = Date.now() + SUBMIT_GRACE_MS + 1000;
  assert.deepEqual((await reconcileSubmits(ctxs.vps, later)).map((x) => x.ok), [true]);
  const b = ctxs.vps.store.getBatch("b-orphan");
  assert.equal(b.tasks["t-orphan"].state, "failed");
  assert.match(verdictLine(b), / FAIL 0\/1/);
  assert.equal(batchDoneQueued(ctxs.vps), true, "the planner is woken with the definite result");
  await assert.rejects(Promise.resolve().then(() => ctxs.box.store.create({ id: "t-orphan", batch: "b-orphan" }, "x")), /fenced/);
});

test("submit delivered but wake-worker fails: tasks are not marked failed (the host's tick starts them)", async () => {
  const { ctxs, dispatchOne } = await twoHosts();
  ctxs.box.handlers = { ...ctxs.box.handlers, "wake-worker": () => { throw new Error("spawn failed"); } };
  const r = await dispatchOne();
  const id = r.tasks[0].id;
  assert.match(r.errors.join("\n"), /tasks delivered, wake-worker failed/);
  assert.equal(ctxs.vps.store.getBatch(r.batch).tasks[id].state, "queued");
  await worker(ctxs.box, { once: true });
  assert.match(verdictLine(ctxs.vps.store.getBatch(r.batch)), / PASS 1\/1/);
});

// ------------------------------------------------------------------ async, cancel-safe preflight

const waitFor = async (fn, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("waitFor timeout"); await new Promise((r) => setTimeout(r, 50)); } };
const shortLease = { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, max_segment_failures: 3, lease_ttl_sec: 1.5 };
function preflightSetup(preflightCmd, { bin = FAKE } = {}) {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { limits: shortLease,
    executors: { claude: { adapter: "claude", host: "box", bin, credential_files: [FAKE], preflight_cmd: preflightCmd(root) } },
    routing: { rules: [{ type: "code", executor: "claude" }] } });
  const ctx = testContext(cfg, { FAKE_MODE: "ok" });
  return { root, cfg, ctx };
}

test("preflight is async: the task lease renews while a long preflight_cmd runs; the task then completes", async () => {
  const { root, cfg, ctx } = preflightSetup((root) => {
    const L = `$(ls -d ${join(root, "home", "tasks")}/*/lease.json)`;
    const exp = `grep -o '"expires_at": *"[^"]*"' ${L}`;
    return `a=$(${exp}); sleep 3; b=$(${exp}); test -n "$a" && test -n "$b" && test "$a" != "$b" && echo renewed >> ${join(root, "renewed")}`;
  });
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(d.tasks[0].id);
  assert.equal(t.state, "done", `${t.state}: ${t.reason}`);
  assert.equal(readFileSync(join(root, "renewed"), "utf8").trim().split("\n").length, 2, "lease renewed during both preflight runs (before start, before the segment)");
  assert.ok(cfg.limits.lease_ttl_sec * 1000 < 3000, "the preflight outlasted the lease TTL");
});

test("cancel during preflight_cmd kills it; no preflight verdict, failure count or pause is recorded", async () => {
  const { root, ctx } = preflightSetup((root) => `touch ${join(root, "started")}; sleep 4; touch ${join(root, "late")}`);
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  const id = d.tasks[0].id;
  const t0 = Date.now();
  const w = worker(ctx, { once: true });
  await waitFor(() => existsSync(join(root, "started")));
  await HANDLERS.cancel(ctx, { id, owner: "grok" });
  await w;
  assert.ok(Date.now() - t0 < 3500, "the worker did not wait for the preflight command");
  const t = ctx.store.get(id);
  assert.equal(t.state, "cancelled");
  assert.equal(t.segment_failures, 0);
  assert.equal(t.segments, 0, "no segment started");
  assert.equal(ctx.store.events(id, 100).filter((e) => e.type === "preflight").length, 0, "no preflight verdict logged");
  assert.ok(ctx.store.events(id, 100).some((e) => /aborted during preflight/.test(e.text)));
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(existsSync(join(root, "late")), false, "the preflight command was killed");
});

test("lease lost during preflight: command killed, task left queued for resume (not paused, no failure counted)", async () => {
  const { root, ctx } = preflightSetup((root) => `touch ${join(root, "started")}; sleep 4; touch ${join(root, "late")}`);
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  const id = d.tasks[0].id;
  const r = runTask(ctx, id);
  await waitFor(() => existsSync(join(root, "started")));
  const lp = join(ctx.store.dir(id), "lease.json");
  writeFileSync(lp, JSON.stringify({ ...JSON.parse(readFileSync(lp, "utf8")), owner: "someone-else" }));
  assert.equal(await r, "queued");
  const t = ctx.store.get(id);
  assert.equal(t.state, "queued");
  assert.equal(t.segment_failures, 0);
  assert.equal(t.resume_after, null);
});

test("cancel during a slow CLI contract check (--version) kills it and caches no contract verdict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-bin-"));
  const bin = join(dir, "slow-claude");
  writeFileSync(bin, `#!/bin/bash\nif [ "$1" = "--version" ]; then touch ${join(dir, "started")}; sleep 20; fi\nexec ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  const { cfg, ctx } = preflightSetup(() => "true", { bin });
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  const id = d.tasks[0].id;
  const t0 = Date.now();
  const w = worker(ctx, { once: true });
  await waitFor(() => existsSync(join(dir, "started")));
  await HANDLERS.cancel(ctx, { id, owner: "grok" });
  await w;
  assert.ok(Date.now() - t0 < 5000, "the worker did not wait for the 20 s --version");
  assert.equal(ctx.store.get(id).state, "cancelled");
  assert.equal(existsSync(join(cfg.home, "run", "contract-claude.json")), false, "no contract verdict cached from an aborted check");
  assert.equal(ctx.store.events(id, 100).filter((e) => e.type === "preflight").length, 0);
});
