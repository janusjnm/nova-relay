// backup.test.mjs — snapshot (no secrets), restore drill (path safety, integrity, inert restore),
// migrate --dry-run. All under throwaway /tmp dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrationPlan, restore, snapshot } from "../lib/backup.mjs";
import { Outbox } from "../lib/notify.mjs";
import { flushOutbox, makeContext, resumeAll } from "../lib/relay.mjs";
import { normalizeConfig } from "../lib/config.mjs";
import { BRIEF, FAKE, isolatedEnv, tempRepo, testConfig } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));
const SECRET = "sk-canarysecretvalue-0123456789abcdef";

function walkFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
}

// A coordinator+box home with: a running task (lease, segment pid, logs), a queued task, a done
// task, a batch view, a pending and a sent webhook, plus things that must never be copied.
function seededHome() {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  cfg.executors.claude.env = { SOME_SETTING: SECRET };
  const ctx = makeContext(cfg, { env: isolatedEnv(), spawnWorker: () => { throw new Error("worker spawned"); } });
  const st = ctx.store;
  const mk = (id, state, extra = {}) => { st.create({ id, batch: "b-1", project: "PD", owner: "grok", host: "box", executor: "claude", type: "code" }, BRIEF()); return st.update(id, { state, ...extra }); };
  mk("t-run", "running", { segment_pid: 999999, segment_pid_start: "1" });
  mk("t-q", "queued");
  mk("t-done", "done", { verdict: "PASS" });
  writeFileSync(join(st.dir("t-run"), "lease.json"), JSON.stringify({ owner: "box:1:t-run", pid: 1, expires_at: new Date(Date.now() + 1e6).toISOString() }));
  mkdirSync(join(st.dir("t-run"), "logs"));
  writeFileSync(join(st.dir("t-run"), "logs", "segment-1.log"), `log with ${SECRET}\n`);
  st.putBatch({ id: "b-1", project: "PD", owner: "grok", expected: 3, acked: false, created_at: new Date().toISOString(),
    tasks: { "t-run": { host: "box", state: "running", rev: 1 }, "t-q": { host: "box", state: "queued", rev: 1 }, "t-done": { host: "box", state: "done", rev: 2 } } });
  const ob = new Outbox(cfg.home);
  ob.enqueue("b-1:t-x:blocked:1", { kind: "webhook", project: "PD", payload: { source: "nova-relay", batch: "b-1", id: "t-x", state: "blocked", exit_code: null } });
  // Never in a snapshot: a secrets file, worker log, contract cache, a worktree, symlinks.
  writeFileSync(join(cfg.home, "secrets.env"), `DEEPSEEK_API_KEY=${SECRET}\n`);
  writeFileSync(join(cfg.home, "run", "worker.log"), SECRET);
  writeFileSync(join(cfg.home, "run", "contract-claude.json"), "{}");
  mkdirSync(join(cfg.home, "worktrees", "PD", "t-run"), { recursive: true });
  writeFileSync(join(cfg.home, "worktrees", "PD", "t-run", "file.txt"), SECRET);
  const outside = join(root, "outside-secret.json");
  writeFileSync(outside, JSON.stringify({ k: SECRET }));
  symlinkSync(outside, join(cfg.home, "run", "paused.json")); // allowlisted name, but a symlink
  symlinkSync("/etc", join(cfg.home, "tasks", "t-link"));
  return { root, repo, cfg, ctx };
}

test("snapshot: allowlisted metadata only, no secrets/logs/leases/worktrees, symlinks not followed, 0700/0600", () => {
  const { root, cfg } = seededHome();
  const out = join(root, "snap");
  const r = snapshot(cfg, { out });
  const files = walkFiles(out).map((p) => p.slice(out.length + 1)).sort();
  assert.ok(files.includes("manifest.json") && files.includes("config.redacted.json"));
  assert.ok(files.includes("home/tasks/t-run/state.json") && files.includes("home/batches/b-1.json"));
  for (const f of files) {
    assert.ok(!/lease|logs\/|secrets\.env|worker\.log|contract-|worktrees|t-link/.test(f), `excluded: ${f}`);
    assert.ok(!readFileSync(join(out, f), "utf8").includes(SECRET), `no secret value in ${f}`);
    assert.equal(statSync(join(out, f)).mode & 0o777, 0o600, f);
  }
  assert.ok(!files.includes("home/run/paused.json"), "symlinked file not copied");
  assert.ok(r.skipped.some((s) => /paused\.json \(symlink/.test(s)));
  assert.equal(statSync(out).mode & 0o777, 0o700);
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.ok(m.excluded.some((x) => /does NOT restore/.test(x)));
  assert.equal(JSON.parse(readFileSync(join(out, "config.redacted.json"), "utf8")).executors.claude.env.SOME_SETTING, "[REDACTED]");
  assert.throws(() => snapshot(cfg, { out }), /not an empty directory/);
});

test("restore: needs --dest, never the live home or a non-empty dir; restored tasks are inert, outbox held, nothing spawned or sent", async () => {
  const { root, cfg } = seededHome();
  const snap = join(root, "snap");
  snapshot(cfg, { out: snap });
  assert.throws(() => restore(cfg, { from: snap }), /needs --dest/);
  assert.throws(() => restore(cfg, { from: snap, dest: cfg.home }), /live nova-relay home/);
  assert.throws(() => restore(cfg, { from: snap, dest: join(cfg.home, "drill") }), /live nova-relay home/);
  const busy = join(root, "busy");
  mkdirSync(busy);
  writeFileSync(join(busy, "x"), "");
  assert.throws(() => restore(cfg, { from: snap, dest: busy }), /not an empty directory/);

  const dest = join(root, "drill");
  const r = restore(cfg, { from: snap, dest });
  assert.deepEqual(r.blocked.sort(), ["t-q", "t-run"]);
  assert.equal(r.worker_started, false);
  assert.equal(r.held_outbox, 1);
  const rcfg = normalizeConfig({ ...structuredClone(testConfig(root, cfg.projects.PD.repo)), home: dest }, {});
  let spawned = 0, sent = 0;
  const rctx = makeContext(rcfg, { env: isolatedEnv({ PD_URL: "https://grok.example/x", PD_KEY: "k".repeat(20) }), spawnWorker: () => { spawned++; }, fetchImpl: async () => { sent++; return { ok: true, status: 200 }; } });
  const run = rctx.store.get("t-run");
  assert.equal(run.state, "blocked");
  assert.equal(run.restored_from_state, "running");
  assert.equal(run.segment_pid, null);
  assert.match(run.reason, /not resumed automatically/);
  assert.equal(rctx.store.get("t-done").state, "done");
  assert.ok(!existsSync(join(dest, "tasks", "t-run", "lease.json")), "no lease restored");
  assert.deepEqual((await resumeAll(rctx)).resumed, [], "nothing runnable");
  assert.equal(spawned, 0, "no worker spawned");
  await flushOutbox(rctx, { now: Date.now() + 3600_000 });
  assert.equal(sent, 0, "held notifications are not replayed");
  assert.equal(rctx.outbox.pending().length, 0);
  assert.equal(readdirSync(join(dest, "outbox", "held")).length, 1);
  assert.equal(statSync(dest).mode & 0o777, 0o700);
  // Explicit opt-in keeps the outbox sendable.
  const dest2 = join(root, "drill2");
  assert.equal(restore(cfg, { from: snap, dest: dest2, replayOutbox: true }).held_outbox, 0);
  assert.equal(new Outbox(dest2).pending().length, 1);
});

test("restore refuses unsafe or tampered snapshots before writing anything: traversal, symlink, hash, integrity", () => {
  const { root, cfg } = seededHome();
  const fresh = () => { const d = mkdtempSync(join(root, "snap-")); snapshot(cfg, { out: join(d, "s") }); return join(d, "s"); };
  const editManifest = (s, fn) => { const p = join(s, "manifest.json"); const m = JSON.parse(readFileSync(p, "utf8")); fn(m); writeFileSync(p, JSON.stringify(m)); };
  const check = (s, re, name) => {
    const dest = join(root, `dest-${name}`);
    assert.throws(() => restore(cfg, { from: s, dest }), re, name);
    assert.ok(!existsSync(dest), `${name}: nothing written`);
  };
  let s = fresh();
  editManifest(s, (m) => m.files.push({ path: "../../escape.json", sha256: "x" }));
  check(s, /unsafe path/, "traversal");
  s = fresh();
  editManifest(s, (m) => m.files.push({ path: "/etc/passwd", sha256: "x" }));
  check(s, /unsafe path/, "absolute");
  s = fresh();
  editManifest(s, (m) => m.files.push({ path: "tasks/t-run/lease.json", sha256: "x" }));
  check(s, /not allowed/, "not-allowlisted");
  s = fresh();
  const p = join(s, "home", "tasks", "t-q", "brief.md");
  unlinkSync(p);
  symlinkSync("/etc/hostname", p);
  check(s, /not a regular file/, "symlink");
  s = fresh();
  writeFileSync(join(s, "home", "tasks", "t-q", "brief.md"), "tampered");
  check(s, /hash mismatch/, "hash");
  s = fresh();
  unlinkSync(join(s, "home", "batches", "b-1.json"));
  editManifest(s, (m) => { m.files = m.files.filter((f) => f.path !== "batches/b-1.json"); });
  check(s, /integrity check[\s\S]*batch b-1 is missing/, "integrity");
  s = fresh();
  editManifest(s, (m) => { m.state_schema = 99; });
  check(s, /newer/, "newer-schema");
});

test("migrate --dry-run: readable vs not, rollback plan, explicit exclusions; CLI snapshot/restore/migrate (isolated env)", () => {
  const { root, cfg, repo } = seededHome();
  const plan = migrationPlan(cfg);
  assert.equal(plan.dry_run, true);
  assert.deepEqual(plan.found.tasks, { 1: 3 });
  assert.ok(plan.rollback.some((x) => /does not contain them/.test(x)));
  assert.ok(plan.excluded.some((x) => /does NOT restore/.test(x)));

  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ self: "box", coordinator: "box", home: cfg.home, hosts: { box: { role: "box" } },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
    routing: { rules: [{ type: "code", executor: "claude" }] }, projects: { PD: { repo, base: "main" } } }));
  const env = isolatedEnv({ NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env") });
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: "utf8" });
  const sn = cli("snapshot", "--out", join(root, "cli-snap"));
  assert.equal(sn.status, 0, sn.stderr);
  assert.match(sn.stdout, /excluded: secrets\.env/);
  const rs = cli("restore", "--from", join(root, "cli-snap"), "--dest", join(root, "cli-drill"));
  assert.equal(rs.status, 0, rs.stderr);
  assert.match(rs.stdout, /no worker started/);
  assert.ok(!existsSync(join(root, "cli-drill", "run", "worker.lease")) && !existsSync(join(root, "cli-drill", "run", "worker.log")));
  assert.notEqual(cli("restore", "--from", join(root, "cli-snap")).status, 0, "--dest is required");
  assert.equal(cli("migrate").status, 2, "only --dry-run");
  const mg = cli("migrate", "--dry-run", "--json");
  assert.equal(mg.status, 0, mg.stderr);
  assert.equal(JSON.parse(mg.stdout).state_schema, 1);
  // A newer task schema on disk: reported as unreadable by this version (exit 1), never rewritten.
  const sp = join(cfg.home, "tasks", "t-q", "state.json");
  writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, "utf8")), schema: 2 }));
  const mg2 = cli("migrate", "--dry-run");
  assert.equal(mg2.status, 1);
  assert.match(mg2.stdout, /cannot read: 1 task\/batch files with state schema > 1/);
});
