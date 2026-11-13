// concurrency.test.mjs — cross-process races, crash recovery, leases, frozen-after-sleep, workers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../lib/store.mjs";
import { Outbox } from "../lib/notify.mjs";
import { HANDLERS, dispatch, resumeAll, worker } from "../lib/relay.mjs";
import { finish } from "../lib/runner.mjs";
import { pauseExecutor, readPaused } from "../lib/budget.mjs";
import { procStart } from "../lib/lock.mjs";
import { globsIntersect, redact, scopesOverlap, tryLock, unlock, withLock } from "../lib/util.mjs";
import { BRIEF, tempRepo, testConfig, testContext } from "./helpers.mjs";

const LIB = fileURLToPath(new URL("../lib/", import.meta.url));
const runNode = (code) => new Promise((res) => {
  const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  c.on("close", (code) => res({ code, err }));
});

test("store.update from many processes at once loses no update (task lock + journal seq)", async () => {
  const home = mkdtempSync(join(tmpdir(), "nova-conc-"));
  const s = new Store(home);
  s.create({ id: "t-1", n: 0 }, "brief");
  const code = (w) => `import { Store } from ${JSON.stringify(join(LIB, "store.mjs"))};
    const s = new Store(${JSON.stringify(home)});
    for (let i = 0; i < 25; i++) s.transition("t-1", (cur) => ({ n: cur.n + 1, ["w${w}"]: i }));`;
  const rs = await Promise.all([0, 1, 2, 3].map((w) => runNode(code(w))));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const t = s.get("t-1");
  assert.equal(t.n, 100);
  assert.equal(t.seq, 100);
  assert.equal(s.replay("t-1").n, 100, "journal replays to the same state");
});

test("concurrent coordinator reports for one batch (separate rpc processes) are all kept", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const ctx = testContext(cfg);
  const ids = Array.from({ length: 6 }, (_, i) => `t-${i}`);
  HANDLERS["batch-register"](ctx, { batch: { id: "b-1", project: "PD", owner: "grok", expected: ids.length, tasks: Object.fromEntries(ids.map((id) => [id, { state: "queued", rev: 0 }])) } });
  const code = (id) => `import { Store } from ${JSON.stringify(join(LIB, "store.mjs"))};
    const s = new Store(${JSON.stringify(cfg.home)});
    s.mutateBatch("b-1", (b) => { b.tasks["${id}"] = { state: "done", rev: 2 }; return b; });`;
  const rs = await Promise.all(ids.map((id) => runNode(code(id))));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const b = ctx.store.getBatch("b-1");
  assert.deepEqual(ids.map((id) => b.tasks[id].state), ids.map(() => "done"));
});

test("crash between journal append and state.json write: get() replays the journal", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-crash-"));
  const s = new Store(home);
  s.create({ id: "t-1" }, "b");
  s.update("t-1", { segments: 1 });
  // Simulate: journal has seq 2, state.json still at seq 1.
  appendFileSync(join(s.dir("t-1"), "journal.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), type: "patch", seq: 2, patch: { segments: 2, state: "running" } })}\n`);
  const t = s.get("t-1");
  assert.equal(t.segments, 2);
  assert.equal(t.state, "running");
  assert.equal(JSON.parse(readFileSync(join(s.dir("t-1"), "state.json"), "utf8")).seq, 2, "state.json repaired");
});

test("file lock: exclusive, released, stale lock of a dead process is stolen", () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-lock-"));
  const p = join(dir, "x");
  const a = tryLock(p);
  assert.ok(a);
  assert.equal(tryLock(p), null);
  unlock(p, a);
  writeFileSync(`${p}.lock`, JSON.stringify({ pid: 999999, host: hostname(), at: Date.now(), nonce: "dead" }));
  assert.equal(withLock(p, () => 42), 42, "dead holder's lock stolen");
  assert.ok(!existsSync(`${p}.lock`));
});

test("outbox: overlapping flushes send each entry once; dead letters revived by manual flush", async () => {
  const home = mkdtempSync(join(tmpdir(), "nova-ob-"));
  const ob = new Outbox(home);
  ob.enqueue("k1", { kind: "webhook", payload: {} });
  let sends = 0;
  const slow = async () => { sends++; await new Promise((r) => setTimeout(r, 50)); };
  await Promise.all([ob.flush(slow), ob.flush(slow)]);
  assert.equal(sends, 1);
  ob.enqueue("k2", { kind: "webhook", payload: {} });
  await ob.flush(async () => { throw new Error("down"); }, { maxAttempts: 1 });
  assert.equal(ob.dead().length, 1);
  assert.equal((await ob.flush(async () => {}, { now: Date.now() + 3600_000 })).length, 0, "dead letters are not retried automatically");
  assert.equal(ob.reviveDead(), 1);
  const r = await ob.flush(async () => {});
  assert.deepEqual(r.map((x) => x.ok), [true]);
});

test("pauseExecutor: same incident while active is not fresh (one wake), later reset extends", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-pause-"));
  const t1 = new Date(Date.now() + 3600_000).toISOString(), t2 = new Date(Date.now() + 7200_000).toISOString();
  assert.equal(pauseExecutor(home, "claude", "quota", t1).fresh, true);
  assert.equal(pauseExecutor(home, "claude", "quota", t1).fresh, false);
  assert.equal(pauseExecutor(home, "claude", "quota", t2).fresh, false);
  assert.equal(readPaused(home).claude.until, t2);
});

test("finish never overwrites a cancel that landed mid-segment", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  ctx.store.create({ id: "t-c", batch: "b-c", project: "PD", host: "box", executor: "claude" }, BRIEF());
  await HANDLERS.cancel(ctx, { id: "t-c" });
  assert.equal(await finish(ctx, "t-c", "done", {}), "cancelled");
  assert.equal(ctx.store.get("t-c").state, "cancelled");
  await assert.rejects(HANDLERS.cancel(ctx, { id: "t-c", owner: "someone-else" }), /belongs to/);
});

function sleeper() {
  const c = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  c.unref();
  return c;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("box wake from sleep: an expired lease of a live worker is NOT killed on first sight (frozen, observed over time)", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  ctx.store.create({ id: "t-f", batch: "b", project: "PD", host: "box", executor: "claude" }, BRIEF());
  ctx.store.update("t-f", { state: "running" });
  const w = sleeper();
  const leasePath = join(ctx.store.dir("t-f"), "lease.json");
  const expired = new Date(Date.now() - 6 * 3600_000).toISOString(); // slept for hours
  writeFileSync(leasePath, JSON.stringify({ owner: "w", host: hostname(), pid: w.pid, pid_start: procStart(w.pid), ttl_ms: 30_000, expires_at: expired }));
  const now = Date.now();
  let r = await resumeAll(ctx, now);
  assert.deepEqual(r.frozen, ["t-f"]);
  assert.ok(alive(w.pid), "not killed on first observation even though hours overdue");
  // The worker renews (it was just waking up): the observation resets.
  const renewed = new Date(now - 1000).toISOString();
  writeFileSync(leasePath, JSON.stringify({ owner: "w", host: hostname(), pid: w.pid, pid_start: procStart(w.pid), ttl_ms: 30_000, expires_at: renewed }));
  r = await resumeAll(ctx, now + 10_000);
  assert.deepEqual(r.frozen, ["t-f"]);
  r = await resumeAll(ctx, now + 60_000);
  assert.ok(alive(w.pid), "only 50 s since the new observation (< 3×TTL)");
  r = await resumeAll(ctx, now + 200_000);
  assert.deepEqual(r.resumed, ["t-f"]);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(!alive(w.pid), "still not renewing after 3×TTL of observation → killed");
  assert.equal(ctx.store.get("t-f").state, "queued");
});

test("resume after a worker crash kills the orphaned executor process group", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  ctx.store.create({ id: "t-o", batch: "b", project: "PD", host: "box", executor: "claude" }, BRIEF());
  const orphan = sleeper();
  ctx.store.update("t-o", { state: "running", segment_pid: orphan.pid, segment_pid_start: procStart(orphan.pid) });
  writeFileSync(join(ctx.store.dir("t-o"), "lease.json"), JSON.stringify({ owner: "x", host: hostname(), pid: 999999, ttl_ms: 1000, expires_at: new Date(Date.now() - 10_000).toISOString() }));
  const r = await resumeAll(ctx);
  assert.deepEqual(r.resumed, ["t-o"]);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(!alive(orphan.pid));
  assert.equal(ctx.store.get("t-o").segment_pid, null);
});

test("only one worker per host: a second worker exits while the first holds the host lease", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo), { FAKE_MODE: "ok" });
  const r = await dispatch(ctx, { project: "PD", briefs: [{ name: "a.md", text: BRIEF() }] });
  const w = sleeper();
  writeFileSync(join(ctx.cfg.home, "run", "worker.lease"), JSON.stringify({ owner: "other", host: hostname(), pid: w.pid, pid_start: procStart(w.pid), ttl_ms: 30_000, expires_at: new Date(Date.now() + 30_000).toISOString() }));
  assert.equal(await worker(ctx, { once: true }), "another worker is running");
  assert.equal(ctx.store.get(r.tasks[0].id).state, "queued");
  process.kill(w.pid, "SIGKILL");
  await new Promise((res) => setTimeout(res, 100));
  writeFileSync(join(ctx.cfg.home, "run", "worker.lease"), JSON.stringify({ owner: "other", host: hostname(), pid: 999999, ttl_ms: 1000, expires_at: new Date(Date.now() - 5000).toISOString() }));
  await worker(ctx, { once: true });
  assert.equal(ctx.store.get(r.tasks[0].id).state, "done", "stale worker lease taken over");
});

test("scope overlap is exact glob intersection, not a prefix guess", () => {
  assert.equal(scopesOverlap(["src/*.ts"], ["src/b/c.md"]), false);
  assert.equal(scopesOverlap(["src/**/*.ts"], ["src/**/*.md"]), false);
  assert.equal(scopesOverlap(["src/a.ts"], ["src/a.tsx"]), false);
  assert.equal(scopesOverlap(["src/**"], ["**/*.md"]), true);
  assert.equal(scopesOverlap(["docs/"], ["docs/x/y.md"]), true);
  assert.equal(globsIntersect("src/a*", "src/*b"), true);
  assert.equal(globsIntersect("src/?.js", "src/ab.js"), false);
});

test("redaction: secrets split across output chunks, JWTs, URL passwords", async () => {
  assert.equal(redact("https://bob:hunter22@git.example/x"), "https://bob:[REDACTED]@git.example/x");
  assert.doesNotMatch(redact("tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P"), /eyJ/);
  const { runProcess } = await import("../lib/runner.mjs");
  const dir = mkdtempSync(join(tmpdir(), "nova-log-"));
  const log = join(dir, "seg.log");
  await runProcess({ cmd: process.execPath, args: ["-e", "process.stdout.write('k sk-abcdefghij'); setTimeout(() => process.stdout.write('klmnopqrstuvwxyz123456 end\\n'), 50)"],
    cwd: dir, env: process.env, logPath: log, wallMs: 10_000, idleMs: 10_000 });
  await new Promise((r) => setTimeout(r, 50));
  const text = readFileSync(log, "utf8");
  assert.doesNotMatch(text, /sk-abcdefghij/);
  assert.match(text, /\[REDACTED\] end/);
});

test("gc removes crash leftovers (tmp files of interrupted atomic writes)", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  ctx.store.create({ id: "t-g", batch: "b", project: "PD", host: "box", executor: "claude" }, BRIEF());
  const tmp = join(ctx.store.dir("t-g"), "state.json.tmp-123-abcdef");
  writeFileSync(tmp, "{");
  spawnSync("touch", ["-d", "2 hours ago", tmp]);
  const { gc } = await import("../lib/relay.mjs");
  gc(ctx);
  assert.ok(!existsSync(tmp));
});
