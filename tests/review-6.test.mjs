// review-6.test.mjs — sixth review: caller-supplied idempotency keys and machine-readable delivery
// outcomes, late dispatchers (no grace-period correctness), explicit abandon with late-report
// fencing, tombstones that outlive gc, and lock/lease takeover only from provably dead instances.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootId, pidAlive, procStart, tryLock, unlock } from "../lib/util.mjs";
import { acquireLease, leaseStatus, readLease } from "../lib/lock.mjs";
import { normalizeConfig } from "../lib/config.mjs";
import { HANDLERS, KeyConflictError, SUBMIT_GRACE_MS, batchOutcome, dispatch, dispatchExitCode, flushOutbox, gc, reconcileSubmits, resumeAll, tick, verdictLine, worker } from "../lib/relay.mjs";
import { RpcError } from "../lib/rpc.mjs";
import { BRIEF, FAKE, tempRepo, testConfig, testContext } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
const waitFor = async (fn, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("waitFor timeout"); await new Promise((r) => setTimeout(r, 20)); } };
// Every child is killed when the file ends, even if an assertion failed first (a SIGSTOPped or
// sleeping child must never keep the test runner alive).
const kids = [];
after(() => { for (const k of kids) try { process.kill(k.pid, "SIGKILL"); } catch { /* gone */ } });
const track = (c) => { kids.push(c); return c; };
const sleeper = (opts = {}) => track(spawn("sleep", ["60"], { stdio: "ignore", ...opts }));
const DAY = 86400_000;

// Coordinator + dispatcher on "vps", task host "box" over a simulated ssh (as in review-5).
// net.submit: "ok" | "lost-reply" (host stores, reply lost) | "undelivered" (never reaches the host).
// net.boxDown fails every call to box. net.beforeSubmit(payload) runs before the host sees a submit.
function twoHosts() {
  const { root, repo } = tempRepo();
  const mk = (self) => normalizeConfig({
    self, coordinator: "vps", home: join(root, `home-${self}`),
    hosts: { box: { role: "box", ssh: "box" }, vps: { role: "vps", ssh: "vps" } },
    limits: { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, max_local_retries: 2, lease_ttl_sec: 30 },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
    routing: { rules: [{ type: "code", executor: "claude" }] },
    projects: { PD: { repo: { box: repo, vps: repo }, base: "main", worktrees: { box: join(root, "wt-box"), vps: join(root, "wt-vps") }, webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
  }, {});
  const net = { submit: "ok", boxDown: false, calls: [], beforeSubmit: null };
  const ctxs = {};
  const sshCall = async (_cfg, host, method, payload) => {
    net.calls.push(`${host}:${method}`);
    const timeout = () => new RpcError(`ssh ${host} ${method}: timeout`, { network: true });
    if (host === "box" && net.boxDown) throw new RpcError(`ssh ${host} unreachable: exit 255`, { network: true });
    if (method === "submit" && net.submit === "undelivered") throw timeout();
    if (method === "submit" && net.beforeSubmit) await net.beforeSubmit(payload);
    const c = ctxs[host];
    const r = JSON.parse(JSON.stringify((await c.handlers[method](c, JSON.parse(JSON.stringify(payload)))) ?? { ok: true }));
    if (method === "submit" && net.submit === "lost-reply") throw timeout();
    return r;
  };
  ctxs.box = testContext(mk("box"), { FAKE_MODE: "ok" }, { sshCall });
  ctxs.vps = testContext(mk("vps"), {}, { sshCall });
  const send = (key, briefs = [BRIEF()]) => dispatch(ctxs.vps, { project: "PD", owner: "grok", key, briefs: briefs.map((text, i) => ({ name: `b${i}.md`, text })) });
  const created = (id) => { const j = join(ctxs.box.store.dir(id), "journal.jsonl"); return existsSync(j) ? readFileSync(j, "utf8").split("\n").filter((l) => l.includes('"created"')).length : 0; };
  return { ctxs, net, send, created };
}
const batchFiles = (ctx) => readdirSync(ctx.store.batches).filter((f) => f.endsWith(".json"));
const wakes = (ctx) => [...ctx.outbox.pending(), ...ctx.sent.map((s) => ({ payload: s.body }))].filter((e) => e.payload?.state === "batch_done");

// ------------------------------------------------------------------ 1. idempotency key + outcomes

test("idempotency key: lost submit reply + host down → unreconciled (exit 75); retries with the same key resume ONE batch; the task is created once", async () => {
  const { ctxs, net, send, created } = twoHosts();
  net.submit = "lost-reply";
  const origSubmit = ctxs.box.handlers.submit;
  ctxs.box.handlers = { ...ctxs.box.handlers, submit: (c, p) => { const r = origSubmit(c, p); net.boxDown = true; return r; } };
  const r1 = await send("job-42");
  const id = r1.tasks[0].id;
  assert.equal(r1.created, true);
  assert.equal(r1.outcome.status, "unreconciled");
  assert.equal(r1.outcome.tasks[id].delivery, "unknown");
  assert.equal(dispatchExitCode(r1), 75, "ambiguous delivery is its own exit status, not a plain failure");

  // A caller retries on that exit status while the host is still down: same batch, still unknown.
  const r2 = await send("job-42");
  assert.equal(r2.batch, r1.batch);
  assert.equal(r2.created, false);
  assert.deepEqual(r2.resumed, [id], "the unconfirmed entry is resubmitted with the same id");
  assert.equal(dispatchExitCode(r2), 75);
  assert.equal(batchFiles(ctxs.vps).length, 1, "no second batch");

  // Host back; another retry: idempotent submit finds the stored task.
  net.boxDown = false; net.submit = "ok";
  ctxs.box.handlers = { ...ctxs.box.handlers, submit: origSubmit };
  const r3 = await send("job-42");
  assert.equal(r3.batch, r1.batch);
  assert.equal(r3.outcome.tasks[id].delivery, "delivered");
  assert.equal(r3.outcome.status, "in_progress");
  assert.equal(dispatchExitCode(r3), 0);
  assert.equal(created(id), 1, "created exactly once on the host");
  assert.equal(ctxs.box.store.list().length, 1);
  assert.equal(batchFiles(ctxs.vps).length, 1);

  // Once delivered, a further retry submits nothing.
  const before = net.calls.filter((c) => c === "box:submit").length;
  const r4 = await send("job-42");
  assert.deepEqual(r4.resumed, []);
  assert.equal(net.calls.filter((c) => c === "box:submit").length, before);
  await worker(ctxs.box, { once: true });
  const o = batchOutcome(ctxs.vps.store.getBatch(r1.batch));
  assert.equal(o.status, "terminal");
  assert.equal(o.verdict, "PASS");
});

test("idempotency key: a confirmed non-delivery stays not_delivered on retry (exit 1, nothing resubmitted); a different key is a new batch; changed briefs are refused", async () => {
  const { ctxs, net, send } = twoHosts();
  net.submit = "undelivered";
  const r1 = await send("k-a");
  const id = r1.tasks[0].id;
  assert.equal(r1.outcome.tasks[id].delivery, "not_delivered");
  assert.equal(r1.outcome.status, "terminal");
  assert.equal(dispatchExitCode(r1), 1);
  net.submit = "ok";
  const r2 = await send("k-a");
  assert.equal(r2.batch, r1.batch);
  assert.deepEqual(r2.resumed, [], "a fenced entry is never resubmitted under the same key");
  assert.equal(ctxs.box.store.exists(id), false);
  assert.equal(dispatchExitCode(r2), 1);

  const r3 = await send("k-b");
  assert.notEqual(r3.batch, r1.batch, "different key → different batch");
  assert.notEqual(r3.tasks[0].id, id);
  assert.equal(dispatchExitCode(r3), 0);
  assert.equal(batchFiles(ctxs.vps).length, 2);

  await assert.rejects(send("k-b", [BRIEF("extra line")]), KeyConflictError);
  assert.equal(batchFiles(ctxs.vps).length, 2, "a key conflict dispatches nothing");
});

test("idempotency key: without a key a retry is a new batch (documented); outcome objects are plain JSON with the documented fields", async () => {
  const { ctxs, send } = twoHosts();
  const a = await send(undefined), b = await send(undefined);
  assert.notEqual(a.batch, b.batch);
  const o = JSON.parse(JSON.stringify(a.outcome));
  assert.deepEqual(Object.keys(o).sort(), ["acked", "batch", "key", "line", "schema", "status", "tasks", "verdict"]);
  assert.deepEqual(Object.keys(o.tasks[a.tasks[0].id]).sort(), ["delivery", "executor", "host", "state", "verdict"]);
  assert.equal(ctxs.vps.store.getBatch(a.batch).idempotency_key, null);
});

test("CLI dispatch --key --json: machine-readable outcome, same key → same batch (created:false), changed briefs → exit 4", () => {
  const { root, repo } = tempRepo();
  const home = join(root, "home");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    self: "box", coordinator: "box", home, hosts: { box: { role: "box" } },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
    routing: { rules: [{ type: "code", executor: "claude" }] },
    projects: { PD: { repo, base: "main", owner: "grok", worktrees: join(root, "wt"), webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
  }));
  const env = { ...process.env, NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env"), PD_URL: "https://127.0.0.1:9/x", PD_KEY: "k".repeat(20), FAKE_MODE: "ok" };
  writeFileSync(join(root, "a.md"), BRIEF());
  writeFileSync(join(root, "b.md"), BRIEF("changed"));
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  const d1 = cli("dispatch", "--project", "PD", "--key", "smoke-1", "--json", join(root, "a.md"));
  assert.equal(d1.status, 0, d1.stderr);
  const j1 = JSON.parse(d1.stdout);
  assert.equal(j1.created, true);
  assert.equal(j1.exit_code, 0);
  assert.equal(j1.outcome.tasks[j1.tasks[0].id].delivery, "delivered");
  const d2 = cli("dispatch", "--project", "PD", "--key", "smoke-1", "--json", join(root, "a.md"));
  const j2 = JSON.parse(d2.stdout);
  assert.equal(j2.batch, j1.batch);
  assert.equal(j2.created, false);
  const d3 = cli("dispatch", "--project", "PD", "--key", "smoke-1", "--json", join(root, "b.md"));
  assert.equal(d3.status, 4);
  assert.equal(JSON.parse(d3.stdout).status, "key_conflict");
  assert.equal(readdirSync(join(home, "batches")).filter((f) => f.endsWith(".json")).length, 1);
  const bj = JSON.parse(cli("batch", j1.batch, "--json").stdout);
  assert.ok(bj.tasks && bj.outcome && bj.outcome.batch === j1.batch, "batch --json keeps the raw view and adds outcome");
});

// ------------------------------------------------------------------ 2. late dispatcher, no grace assumption

test("late dispatcher (slept days past the reconcile hint, before its submit reached the host): refused, recorded not_delivered; its key retry never creates", async () => {
  const { ctxs, net, send } = twoHosts();
  let tickRes = null;
  // The dispatcher stalls just before its submit reaches the host; meanwhile the coordinator's
  // tick runs days later and fences the entry.
  net.beforeSubmit = async () => { if (!tickRes) tickRes = await reconcileSubmits(ctxs.vps, Date.now() + 3 * DAY); };
  const r = await send("late-1");
  const id = r.tasks[0].id;
  assert.deepEqual(tickRes.map((x) => x.ok), [true], "the tick fenced while the dispatcher slept");
  assert.match(r.errors.join("\n"), /refused fenced ids/);
  assert.equal(ctxs.box.store.exists(id), false, "the late submit created nothing");
  assert.equal(r.outcome.tasks[id].delivery, "not_delivered");
  assert.equal(dispatchExitCode(r), 1);
  net.beforeSubmit = null;
  const again = await send("late-1");
  assert.equal(again.batch, r.batch);
  assert.equal(ctxs.box.store.exists(id), false);
  assert.equal(batchFiles(ctxs.vps).length, 1);
});

test("late dispatcher whose task WAS stored: the tick's fence (any time later) finds it; the late reply/retry is idempotent → delivered, created once", async () => {
  const { ctxs, net, send, created } = twoHosts();
  net.submit = "lost-reply";
  const origSubmit = ctxs.box.handlers.submit;
  ctxs.box.handlers = { ...ctxs.box.handlers, submit: (c, p) => { const r = origSubmit(c, p); net.boxDown = true; return r; } };
  const r = await send("late-2");
  const id = r.tasks[0].id;
  net.boxDown = false; net.submit = "ok";
  ctxs.box.handlers = { ...ctxs.box.handlers, submit: origSubmit };
  const res = await reconcileSubmits(ctxs.vps, Date.now() + 30 * DAY);
  assert.deepEqual(res.map((x) => x.ok), [true]);
  assert.equal(batchOutcome(ctxs.vps.store.getBatch(r.batch)).tasks[id].delivery, "delivered");
  const again = await send("late-2");
  assert.deepEqual(again.resumed, []);
  assert.equal(created(id), 1);
});

test("reconcile hint counts from the latest submit attempt: a resumed dispatch is not fenced at once; fence and create still serialize (either outcome is consistent)", async () => {
  const { ctxs } = twoHosts();
  const old = new Date(Date.now() - 5 * DAY).toISOString();
  await HANDLERS["batch-register"](ctxs.vps, { batch: { id: "b-h", project: "PD", owner: "grok", expected: 1, tasks: { "t-h": { host: "box", executor: "claude", state: "submitting", rev: 0 } } } });
  ctxs.vps.store.mutateBatch("b-h", (b) => ({ ...b, created_at: old }));
  await HANDLERS["submit-attempt"](ctxs.vps, { batch: "b-h", ids: ["t-h"] });
  assert.deepEqual(await reconcileSubmits(ctxs.vps), [], "a fresh attempt postpones the tick's fence (hint only)");
  assert.equal((await reconcileSubmits(ctxs.vps, Date.now() + SUBMIT_GRACE_MS + 1000)).length, 1);
  assert.equal(ctxs.box.store.fenced("t-h"), true);
  assert.throws(() => ctxs.box.store.create({ id: "t-h", batch: "b-h" }, "x"), /fenced/);
});

// ------------------------------------------------------------------ 3. abandon

async function deliveredThenDown() {
  const env = twoHosts();
  const r = await env.send("ab-1");
  env.net.boxDown = true;
  return { ...env, r, id: r.tasks[0].id };
}

test("abandon: dry run without --yes; with it the entry is terminal (FAIL), wakes the planner once, ack allowed; the warning never claims remote work stopped", async () => {
  const { ctxs, r, id } = await deliveredThenDown();
  await assert.rejects(HANDLERS.ack(ctxs.vps, { batch: r.batch }), /not finished/);
  const dry = await HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "box" });
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.would_abandon, [id]);
  assert.equal(ctxs.vps.store.getBatch(r.batch).tasks[id].state, "queued", "dry run changes nothing");
  assert.match(dry.warning, /does NOT stop anything on box/);
  assert.match(dry.warning, /may still run detached/);
  assert.match(dry.warning, /nothing is confirmed stopped/);
  const a = await HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "box", confirm: true });
  assert.deepEqual(a.abandoned, [id]);
  assert.match(a.remote_cancel, /not confirmed/);
  const b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "abandoned");
  assert.equal(b.tasks[id].abandoned_from, "queued");
  assert.match(verdictLine(b), / FAIL 0\/1 \| .* abandoned/);
  assert.equal(batchOutcome(b).tasks[id].delivery, "abandoned");
  assert.equal(wakes(ctxs.vps).length, 1, "one batch_done wake");
  assert.ok(ctxs.vps.outbox.pending().some((e) => e.method === "abandoned" && e.host === "box"), "remote cancel queued for when the host returns");
  await HANDLERS.ack(ctxs.vps, { batch: r.batch });
});

test("abandon: late reports (even 'done') are recorded but ignored; the batch keeps its abandoned verdict and no second wake fires", async () => {
  const { ctxs, net, r, id } = await deliveredThenDown();
  await HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "box", confirm: true });
  net.boxDown = false;
  // The host comes back and its worker runs before the queued cancel is delivered.
  await worker(ctxs.box, { once: true });
  assert.equal(ctxs.box.store.get(id).state, "done", "detached execution did continue on the host");
  const b = ctxs.vps.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "abandoned", "not applied as if the abandon failed");
  assert.equal(b.tasks[id].late.state, "done", "kept for the record");
  assert.match(verdictLine(b), / FAIL 0\/1/);
  assert.equal(batchOutcome(b).tasks[id].late_report_ignored.state, "done");
  assert.equal(wakes(ctxs.vps).length, 1);
  // The queued cancel arrives late: the finished task stays as it is.
  await flushOutbox(ctxs.vps);
  assert.equal(ctxs.box.store.get(id).state, "done");
});

test("abandon of an undelivered-unknown entry: the queued cancel fences the id on the host when it returns; a late create is refused; never automatic", async () => {
  const { ctxs, net, send } = twoHosts();
  net.submit = "undelivered";
  net.boxDown = false;
  // Submit and the immediate fence both fail: delivery unknown.
  const origFence = ctxs.box.handlers.fence;
  ctxs.box.handlers = { ...ctxs.box.handlers, fence: () => { throw new RpcError("down", { network: true }); } };
  const r = await send("ab-2");
  const id = r.tasks[0].id;
  assert.equal(r.outcome.tasks[id].delivery, "unknown");
  ctxs.box.handlers = { ...ctxs.box.handlers, fence: origFence };
  net.boxDown = true;
  // Time passes; the tick never gives up on the operator's behalf.
  await reconcileSubmits(ctxs.vps, Date.now() + 365 * DAY);
  await tick(ctxs.vps);
  assert.equal(ctxs.vps.store.getBatch(r.batch).tasks[id].state, "submitting", "no automatic abandon");
  await HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "box", confirm: true });
  net.boxDown = false;
  await flushOutbox(ctxs.vps, { now: Date.now() + DAY });
  assert.equal(ctxs.box.store.fenced(id), true);
  net.submit = "ok";
  const late = await ctxs.box.handlers.submit(ctxs.box, { tasks: [{ task: { id, batch: r.batch, project: "PD", owner: "grok", type: "code", executor: "claude", host: "box" }, brief: BRIEF() }] });
  assert.deepEqual(late.refused, [id]);
  const again = await send("ab-2");
  assert.deepEqual(again.resumed, [], "a key retry does not resurrect an abandoned entry");
  assert.equal(again.outcome.tasks[id].delivery, "abandoned");
});

test("abandon refuses the coordinator's own host, acked batches, and touches only the named host's unresolved entries", async () => {
  const { ctxs, r } = await deliveredThenDown();
  await assert.rejects(HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "vps", confirm: true }), /use cancel/);
  const none = await HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "elsewhere", confirm: true });
  assert.deepEqual(none.abandoned, []);
  await HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "box", confirm: true });
  await HANDLERS.ack(ctxs.vps, { batch: r.batch });
  await assert.rejects(HANDLERS.abandon(ctxs.vps, { batch: r.batch, host: "box", confirm: true }), /already acked/);
});

// ------------------------------------------------------------------ 4. tombstones vs gc

test("tombstones are never collected: a fenced id still refuses a create after gc far in the future", async () => {
  const { ctxs, net, send } = twoHosts();
  net.submit = "undelivered";
  const r = await send("tomb-1");
  const id = r.tasks[0].id;
  gc(ctxs.box, Date.now() + 100 * 365 * DAY);
  assert.equal(ctxs.box.store.fenced(id), true);
  assert.throws(() => ctxs.box.store.create({ id, batch: r.batch }, "x"), /fenced/);
});

test("gc of a finished task leaves a tombstone first: no create window; gc of a keyed batch leaves one too and a key retry returns 'retired'", async () => {
  const { ctxs, send, created } = twoHosts();
  const r = await send("tomb-2");
  const id = r.tasks[0].id;
  await worker(ctxs.box, { once: true });
  await HANDLERS.ack(ctxs.vps, { batch: r.batch });
  await flushOutbox(ctxs.vps);
  assert.equal(ctxs.box.store.get(id).acked, true);
  const far = Date.now() + 400 * DAY;
  assert.equal(gc(ctxs.box, far).tasks, 1);
  assert.equal(ctxs.box.store.exists(id), false);
  assert.equal(ctxs.box.store.fenced(id), true);
  assert.deepEqual(readdirSync(ctxs.box.store.dir(id)).filter((f) => !f.startsWith("state.lock")), ["fenced.json"]);
  assert.throws(() => ctxs.box.store.create({ id, batch: r.batch }, "x"), /fenced/, "a late create after gc is refused");
  assert.equal(gc(ctxs.box, far + 100 * 365 * DAY).tasks, 0, "the tombstone itself is never collected");
  assert.equal(ctxs.box.store.fenced(id), true);

  assert.equal(gc(ctxs.vps, far).batches, 1);
  assert.equal(ctxs.vps.store.getBatch(r.batch), null);
  const again = await send("tomb-2");
  assert.equal(again.batch, r.batch);
  assert.equal(again.created, false);
  assert.equal(again.outcome.status, "retired");
  assert.equal(ctxs.vps.store.getBatch(r.batch), null, "the gc'd batch is not re-registered");
  assert.equal(created(id), 0, "nothing re-created on the host");
});

// ------------------------------------------------------------------ 5. locks and leases: instance identity, fail closed

test("tryLock records the instance (pid, start time, boot id); a live same-host holder is never stolen however old its lock; once dead it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-lock6-"));
  const p = join(dir, "res");
  const me = tryLock(p);
  const info = JSON.parse(readFileSync(`${p}.lock`, "utf8"));
  assert.equal(info.pid, process.pid);
  assert.equal(info.pid_start, procStart(process.pid));
  assert.equal(info.boot_id, bootId());
  unlock(p, me);

  const s = sleeper();
  await waitFor(() => procStart(s.pid));
  const aged = { pid: s.pid, host: hostname(), pid_start: procStart(s.pid), boot_id: bootId(), at: Date.now() - 7 * DAY, nonce: "abcdef000001" };
  writeFileSync(`${p}.lock`, JSON.stringify(aged));
  assert.equal(tryLock(p), null, "aged lock of a live instance is not stolen");
  writeFileSync(`${p}.lock`, JSON.stringify({ ...aged, pid_start: undefined, nonce: "abcdef000002" }));
  assert.equal(tryLock(p), null, "legacy lock (pid only, pid alive): liveness uncertain → not stolen");
  s.kill("SIGKILL");
  await waitFor(() => !pidAlive(s.pid, aged.pid_start));
  writeFileSync(`${p}.lock`, JSON.stringify(aged));
  const got = tryLock(p);
  assert.ok(got, "dead instance's lock is stolen");
  unlock(p, got);
});

test("tryLock instance identity: same pid but another start time (pid reused) or another boot id = dead; zombie = dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-lock6-"));
  const p = join(dir, "res");
  const base = { pid: process.pid, host: hostname(), pid_start: procStart(process.pid), boot_id: bootId(), at: Date.now() };
  writeFileSync(`${p}.lock`, JSON.stringify({ ...base, pid_start: "1", nonce: "abcdef000003" }));
  let got = tryLock(p); assert.ok(got, "pid reused by a different process instance"); unlock(p, got);
  if (bootId()) {
    writeFileSync(`${p}.lock`, JSON.stringify({ ...base, boot_id: "00000000-0000-0000-0000-000000000000", nonce: "abcdef000004" }));
    got = tryLock(p); assert.ok(got, "holder from an earlier boot"); unlock(p, got);
  }
  // A zombie (exited, never reaped: its parent exec'd into a process that does not wait) still
  // answers kill(pid, 0) but cannot write: dead.
  const parent = track(spawn("bash", ["-c", "sleep 0 & echo $!; exec sleep 3"], { stdio: ["ignore", "pipe", "ignore"] }));
  const zpid = Number(await new Promise((res) => parent.stdout.once("data", (d) => res(String(d).trim()))));
  await waitFor(() => { try { return readFileSync(`/proc/${zpid}/stat`, "utf8").split(") ")[1].startsWith("Z"); } catch { return false; } });
  assert.doesNotThrow(() => process.kill(zpid, 0), "the zombie's pid still exists");
  assert.equal(pidAlive(zpid), false);
  writeFileSync(`${p}.lock`, JSON.stringify({ ...base, pid: zpid, pid_start: undefined, nonce: "abcdef000005" }));
  got = tryLock(p); assert.ok(got, "zombie holder's lock is stolen"); unlock(p, got);
  parent.kill("SIGKILL");
  assert.equal(pidAlive(deadPid()), false);
});

test("tryLock: a SIGSTOPped holder inside its critical section blocks (fail closed) instead of being stolen; SIGKILL makes it stealable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-lock6-"));
  const p = join(dir, "res");
  const util = fileURLToPath(new URL("../lib/util.mjs", import.meta.url));
  const c = track(spawn(process.execPath, ["--input-type=module", "-e", `import { withLock } from ${JSON.stringify(util)}; withLock(${JSON.stringify(p)}, () => process.kill(process.pid, "SIGSTOP"));`], { stdio: "ignore" }));
  await waitFor(() => existsSync(`${p}.lock`) && readFileSync(`/proc/${c.pid}/stat`, "utf8").split(") ")[1]?.startsWith("T"));
  const info = JSON.parse(readFileSync(`${p}.lock`, "utf8"));
  writeFileSync(`${p}.lock`, JSON.stringify({ ...info, at: Date.now() - DAY })); // pretend it has been stopped for a day
  assert.equal(tryLock(p), null, "stopped-but-alive holder keeps the lock");
  const closed = new Promise((r) => c.on("close", r));
  c.kill("SIGKILL");
  await closed;
  const got = tryLock(p);
  assert.ok(got);
  unlock(p, got);
});

test("leases: an expired lease of a live same-host instance is never taken over (no steal option); dead / reused pid / other boot = stale", async () => {
  const d = mkdtempSync(join(tmpdir(), "nova-lease6-"));
  const p = join(d, "lease.json");
  const s = sleeper();
  await waitFor(() => procStart(s.pid));
  const lease = { owner: "w", host: hostname(), pid: s.pid, pid_start: procStart(s.pid), boot_id: bootId(), ttl_ms: 1000, expires_at: new Date(Date.now() - 30 * DAY).toISOString() };
  writeFileSync(p, JSON.stringify(lease));
  assert.equal(leaseStatus(readLease(p)), "frozen");
  assert.equal(acquireLease(p, "other", 60_000, { stealFrozen: true }), null, "no option steals from a live instance");
  writeFileSync(p, JSON.stringify({ ...lease, pid_start: "1" }));
  assert.equal(leaseStatus(readLease(p)), "stale", "same pid, other start time");
  if (bootId()) { writeFileSync(p, JSON.stringify({ ...lease, boot_id: "x" })); assert.equal(leaseStatus(readLease(p)), "stale", "earlier boot"); }
  s.kill("SIGKILL");
  await waitFor(() => !pidAlive(s.pid, lease.pid_start));
  writeFileSync(p, JSON.stringify(lease));
  assert.ok(acquireLease(p, "other", 60_000), "dead holder's lease is taken over");
});

function runningTask(ctx, id, lease, patch = {}) {
  ctx.store.create({ id, batch: "b", project: "PD", host: "box", executor: "claude" }, BRIEF());
  ctx.store.update(id, { state: "running", ...patch });
  writeFileSync(join(ctx.store.dir(id), "lease.json"), JSON.stringify(lease));
}

test("frozen worker: replaced only after a confirmed death; a lease without a start time (pid not verifiable) is never killed or replaced", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  const now = Date.now();
  const expired = new Date(now - 3600_000).toISOString();

  const a = sleeper();
  await waitFor(() => procStart(a.pid));
  runningTask(ctx, "t-nostart", { owner: "w", host: hostname(), pid: a.pid, ttl_ms: 30_000, expires_at: expired });
  const b = sleeper();
  await waitFor(() => procStart(b.pid));
  const bStart = procStart(b.pid);
  b.kill("SIGSTOP");
  runningTask(ctx, "t-stopped", { owner: "w", host: hostname(), pid: b.pid, pid_start: bStart, boot_id: bootId(), ttl_ms: 30_000, expires_at: expired });

  let r = await resumeAll(ctx, now);
  assert.deepEqual(r.frozen.sort(), ["t-nostart", "t-stopped"], "first sight: observed, nothing killed");
  r = await resumeAll(ctx, now + 4 * 30_000);
  assert.deepEqual(r.unconfirmed, ["t-nostart"]);
  assert.ok(pidAlive(a.pid), "unverifiable pid is not killed");
  assert.equal(ctx.store.get("t-nostart").state, "running", "fail closed: not re-queued");
  assert.deepEqual(r.resumed, ["t-stopped"]);
  assert.equal(pidAlive(b.pid, bStart), false, "the frozen holder was dead before its task was re-queued");
  assert.equal(ctx.store.get("t-stopped").state, "queued");
  a.kill("SIGKILL");
});

test("orphaned segment group whose leader died but a member still runs: not re-queued (unconfirmed) until the member is gone", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  // Leader (bash) in its own group starts a member (sleep), then exits on stdin EOF.
  const lead = track(spawn("bash", ["-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!; read x"], { detached: true, stdio: ["pipe", "pipe", "ignore"] }));
  const member = Number(await new Promise((res) => lead.stdout.once("data", (d) => res(String(d).trim()))));
  kids.push({ pid: member });
  const start = procStart(lead.pid);
  runningTask(ctx, "t-g", { owner: "x", host: hostname(), pid: deadPid(), ttl_ms: 1000, expires_at: new Date(Date.now() - 10_000).toISOString() }, { segment_pid: lead.pid, segment_pid_start: start });
  const closed = new Promise((r) => lead.on("exit", r));
  lead.stdin.end();
  await closed;
  assert.ok(pidAlive(member), "member outlived its leader");
  let r = await resumeAll(ctx);
  assert.deepEqual(r.unconfirmed, ["t-g"]);
  assert.equal(ctx.store.get("t-g").state, "running");
  assert.ok(pidAlive(member), "an unverifiable group is not signalled");
  process.kill(member, "SIGKILL");
  await waitFor(() => !pidAlive(member));
  r = await resumeAll(ctx);
  assert.deepEqual(r.resumed, ["t-g"]);
  assert.equal(ctx.store.get("t-g").state, "queued");
});
