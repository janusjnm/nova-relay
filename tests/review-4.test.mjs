// review-4.test.mjs — fourth review: acceptance isolation (standalone scratch clone, PATH/TMPDIR,
// setup failures, async so leases renew and cancel works), out-of-order batch reports, webhook
// redirects, unknown config keys, secret env names declared by config / secrets.env, install.sh
// systemd units.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accept, acceptancePath } from "../lib/acceptance.mjs";
import { parseBrief } from "../lib/brief.mjs";
import { integritySnapshot } from "../lib/git.mjs";
import { acceptanceEnv, executorEnv } from "../lib/runner.mjs";
import { ADAPTERS } from "../lib/executors/index.mjs";
import { loadSecrets, normalizeConfig } from "../lib/config.mjs";
import { Outbox, postWebhook } from "../lib/notify.mjs";
import { HANDLERS, dispatch, worker } from "../lib/relay.mjs";
import { redact } from "../lib/util.mjs";
import { BRIEF, isolatedEnv, sh, tempRepo, testConfig, testContext } from "./helpers.mjs";

const git = (cwd, cmd) => sh(cwd, `git -c user.name=t -c user.email=t@t ${cmd}`);
function taskTree(files = {}) {
  const { root, repo } = tempRepo();
  const base = sh(repo, "git rev-parse HEAD");
  const wt = join(root, "wt", "t-1");
  git(repo, `worktree add -q -b nova/t-1 ${wt} ${base}`);
  for (const [p, s] of Object.entries(files)) { mkdirSync(join(wt, p, ".."), { recursive: true }); writeFileSync(join(wt, p), s); }
  git(wt, "add -A && git -c user.name=t -c user.email=t@t commit -qm work");
  return { root, repo, wt, base, integrity: integritySnapshot(repo) };
}
const briefOf = (acc) => parseBrief(`---\ntype: code\n---\n# Goal\ng\n# Scope\n- **\n# Acceptance\n${acc}\n`);
const run = (tt, brief, more = {}) => accept({ workdir: tt.wt, base: tt.base, brief, repo: tt.repo, integrity: tt.integrity, branch: "nova/t-1",
  env: { PATH: process.env.PATH }, ...more });
const waitFor = async (pred, ms = 10_000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

// ------------------------------------------------------------------ acceptance isolation

test("acceptance: setup/test git commands change only the scratch clone, never the shared repo config or branches", async () => {
  const tt = taskTree({ "src/a.txt": "a\n", "t.sh": "git config core.hooksPath .husky && git update-ref refs/heads/main HEAD && git branch -f nova/t-1 HEAD~1\n" });
  const cfgBefore = readFileSync(join(tt.repo, ".git", "config"), "utf8");
  const mainBefore = sh(tt.repo, "git rev-parse main");
  // husky-style setup (`git config core.hooksPath`) and test code moving refs
  const r = await run(tt, briefOf("sh t.sh"), { project: { acceptance_setup: ["git config core.hooksPath .husky"] } });
  assert.equal(r.pass, true, r.detail);
  assert.equal(readFileSync(join(tt.repo, ".git", "config"), "utf8"), cfgBefore, "shared .git/config untouched");
  assert.equal(sh(tt.repo, "git rev-parse main"), mainBefore, "main not moved");
  assert.equal(sh(tt.repo, "git rev-parse nova/t-1"), sh(tt.wt, "git rev-parse HEAD"), "task branch not moved");
  // and the next acceptance is not blamed for it
  assert.equal((await run(tt, briefOf("true"))).pass, true);
  // the scratch clone has no remote to push to
  assert.equal((await run(tt, briefOf("test -z \"$(git remote)\""))).pass, true);
  assert.equal(existsSync(join(tt.root, "wt", ".accept-t-1")), false, "scratch clone removed");
});

test("acceptance: shared .git or the task branch changed *while* the commands ran (absolute paths) is fatal", async () => {
  const tt = taskTree({ "src/a.txt": "a\n" });
  const r = await run(tt, briefOf(`git config --file ${join(tt.repo, ".git", "config")} alias.x '!sh'`));
  assert.match(r.line, /^FAIL integrity:\.git\/config/);
  assert.equal(r.fatal, true);
  const tt2 = taskTree({ "src/a.txt": "a\n" });
  const r2 = await run(tt2, briefOf(`git -C ${tt2.repo} update-ref refs/heads/nova/t-1 ${tt2.base}`));
  assert.match(r2.line, /^FAIL integrity:refs/);
  assert.equal(r2.fatal, true);
});

test("acceptance: PATH has no relative/empty or repo/worktree entries (committed bin/ cannot shadow tools); TMPDIR is private", async () => {
  assert.equal(acceptancePath("bin::.:/usr/bin:node_modules/.bin:/r/repo/bin:/r/wt/x/bin:/bin", ["/r/repo", "/r/wt"]), "/usr/bin:/bin");
  assert.equal(acceptancePath("", []), "/usr/local/bin:/usr/bin:/bin", "nothing usable left → system dirs, never empty");
  const tt = taskTree({ "src/a.txt": "a\n", "bin/grep": "#!/bin/sh\nexit 0\n" });
  chmodSync(join(tt.wt, "bin", "grep"), 0o755);
  git(tt.wt, "add -A && git -c user.name=t -c user.email=t@t commit -qm bin");
  const env = acceptanceEnv({ env: { PATH: `bin::${join(tt.wt, "bin")}:${process.env.PATH}`, TMPDIR: "/tmp" } }, {}, {});
  const r = await run(tt, briefOf("grep -q nothere src/a.txt"), { env });
  assert.match(r.line, /^FAIL cmd:grep/, "the real grep ran, not the committed one");
  const t = await run(tt, briefOf('case "$TMPDIR" in "$HOME"/*) test -d "$TMPDIR" && test -w "$TMPDIR";; *) exit 1;; esac'), { env });
  assert.equal(t.pass, true, t.detail);
});

test("acceptance: a failing acceptance_setup is FAIL setup:… (not a test failure); runner escalates without executor retries", async () => {
  const tt = taskTree({ "src/a.txt": "a\n" });
  const r = await run(tt, briefOf("true"), { project: { acceptance_setup: ["echo 'npm ERR! network request failed ENOTFOUND' >&2; exit 1"] } });
  assert.match(r.line, /^FAIL setup:.*ENOTFOUND/);
  assert.equal(r.setup, true);
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { projects: { PD: { repo, base: "main", worktrees: join(root, "wt"), acceptance_setup: ["exit 7"], webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } } });
  const ctx = testContext(cfg);
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(d.tasks[0].id);
  assert.equal(t.state, "failed");
  assert.equal(t.escalated, true);
  assert.equal(t.local_retries, 0);
  assert.equal(t.segments, 1, "the executor was not re-run for an environment problem");
  assert.match(t.verdict, /^FAIL setup:exit 7/);
});

test("acceptance is async: the task lease keeps renewing while long acceptance commands run", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { limits: { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, lease_ttl_sec: 1.5 } });
  const ctx = testContext(cfg);
  const lease = `$(ls -d ${join(cfg.home, "tasks")}/*/lease.json)`;
  const acc = `L=${lease}; a=$(grep -o '"expires_at":"[^"]*"' $L); sleep 3; b=$(grep -o '"expires_at":"[^"]*"' $L); test "$a" != "$b" && grep -qx hello src/hello.txt`;
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF().replace("grep -qx hello src/hello.txt", acc) }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(d.tasks[0].id);
  assert.equal(t.state, "done", t.verdict);
});

test("cancel during acceptance kills the acceptance command; no verdict is recorded afterwards", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { limits: { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, lease_ttl_sec: 1.5 } });
  const ctx = testContext(cfg);
  const started = join(root, "started"), late = join(root, "late");
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF().replace("grep -qx hello src/hello.txt", `touch ${started}; sleep 20; touch ${late}`) }] });
  const id = d.tasks[0].id;
  const t0 = Date.now();
  const w = worker(ctx, { once: true });
  await waitFor(() => existsSync(started));
  await HANDLERS.cancel(ctx, { id, owner: "grok" });
  await w;
  assert.ok(Date.now() - t0 < 15_000, "worker did not wait for the 20 s command");
  const t = ctx.store.get(id);
  assert.equal(t.state, "cancelled");
  assert.equal(t.verdict, null);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(late), false);
});

// ------------------------------------------------------------------ batch reports / outbox / webhook

test("batch view: a delayed older report never rolls back a newer re-queued state; registration placeholder still yields", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-1", project: "PD", owner: "g", expected: 1, tasks: { "t-1": { host: "box", executor: "claude", state: "queued", rev: 0 } } } });
  const rep = (state, rev) => HANDLERS.report(ctx, { batch: "b-1", id: "t-1", host: "box", executor: "claude", state, rev, wake_seq: 1, exit_code: null });
  assert.equal((await rep("queued", 0)).stale, undefined, "first report at rev 0 replaces the placeholder");
  await rep("queued", 3);
  assert.equal((await rep("needs_approval", 2)).stale, true);
  assert.equal((await rep("queued", 3)).stale, true, "duplicate");
  assert.equal(ctx.store.getBatch("b-1").tasks["t-1"].state, "queued");
  await rep("done", 4);
  assert.equal(ctx.store.getBatch("b-1").tasks["t-1"].state, "done");
});

test("outbox flushes oldest first", async () => {
  const home = mkdtempSync(join(tmpdir(), "nova-ob-"));
  mkdirSync(join(home, "outbox"));
  const ob = new Outbox(home);
  for (let i = 0; i < 8; i++) { ob.enqueue(`report:t:${i}`, { kind: "rpc", payload: { i } }); await new Promise((r) => setTimeout(r, 3)); }
  const order = [];
  await ob.flush(async (e) => { order.push(e.payload.i); });
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("webhook: redirects are refused (no silent 'sent' to another origin without auth); the entry stays queued", async () => {
  const hits = [];
  const b = http.createServer((req, res) => { hits.push(req.headers.authorization); res.end("ok"); }).listen(0, "127.0.0.1");
  await new Promise((r) => b.on("listening", r));
  const a = http.createServer((req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${b.address().port}/x` }); res.end(); }).listen(0, "127.0.0.1");
  await new Promise((r) => a.on("listening", r));
  try {
    const key = "s3cret-bearer-value-123";
    await assert.rejects(postWebhook({ url: `http://127.0.0.1:${a.address().port}/hook`, key }, { source: "nova-relay" }, "k"), (e) => /redirect refused/.test(e.message) && !e.message.includes(key) && !e.message.includes("127.0.0.1"));
    assert.equal(hits.length, 0, "redirect target never contacted");
    const home = mkdtempSync(join(tmpdir(), "nova-wh-"));
    mkdirSync(join(home, "outbox"));
    const ob = new Outbox(home);
    ob.enqueue("b:batch_done", { kind: "webhook", payload: { source: "nova-relay" } });
    const res = await ob.flush((e) => postWebhook({ url: `http://127.0.0.1:${a.address().port}/hook`, key }, e.payload, e.key));
    assert.equal(res[0].ok, false);
    assert.equal(ob.pending().length, 1, "still queued for retry");
    assert.ok(!JSON.stringify(ob.pending()).includes(key));
  } finally { a.close(); b.close(); }
});

// ------------------------------------------------------------------ config

test("config: unknown keys are errors at every level (a typo must not drop a protection)", () => {
  const ok = { self: "box", hosts: { box: { role: "box" } }, projects: { P: { repo: "/r/p" } }, _comment: "free-form" };
  assert.doesNotThrow(() => normalizeConfig(ok, {}));
  const bad = [
    [{ ...ok, edited: true }, /^edited: unknown key/],
    [{ ...ok, projects: { P: { repo: "/r/p", forbiden_paths: ["x/**"] } } }, /projects\.P\.forbiden_paths: unknown key/],
    [{ ...ok, projects: { P: { repo: "/r/p", harness_path: ["x"] } } }, /projects\.P\.harness_path: unknown key/],
    [{ ...ok, projects: { P: { repo: "/r/p", webhook: { url_env: "U", key_env: "K", url: "https://x" } } } }, /projects\.P\.webhook\.url: unknown key/],
    [{ ...ok, guard: { protected_branch: ["prod"] } }, /guard\.protected_branch: unknown key/],
    [{ ...ok, routing: { rules: [{ type: "code", executor: "c", fallbak: [] }] }, executors: { c: { adapter: "codex" } } }, /routing\.rules\[0\]\.fallbak: unknown key/],
    [{ ...ok, routing: { reroute: "any" } }, /routing\.reroute: unknown key/],
    [{ ...ok, executors: { c: { adapter: "codex", budgt: { segments_per_day: 1 } } } }, /executors\.c\.budgt: unknown key/],
    [{ ...ok, executors: { c: { adapter: "codex", permission_mode: "x" } } }, /executors\.c\.permission_mode: unknown key/],
    [{ ...ok, hosts: { box: { role: "box", sshh: "x" } } }, /hosts\.box\.sshh: unknown key/],
    [{ ...ok, hosts: { box: { role: "laptop" } } }, /hosts\.box\.role: must be/],
  ];
  for (const [raw, re] of bad) assert.throws(() => normalizeConfig(raw, {}), (e) => e.problems.some((p) => re.test(p)), JSON.stringify(raw));
});

// ------------------------------------------------------------------ secrets by declaration

test("secrets: config-declared env names (webhook url/key, executor key_env) and secrets.env names never reach executors or acceptance; values redacted", () => {
  const { root, repo } = tempRepo();
  const sec = join(root, "secrets.env");
  writeFileSync(sec, "ODD_NAMED_THING=abcdefgh-not-a-pattern-123\n", { mode: 0o600 });
  const env = isolatedEnv({ NOVA_RELAY_SECRETS: sec });
  assert.equal(loadSecrets(env).loaded, 1);
  const cfg = testConfig(root, repo, { projects: { PD: { repo, worktrees: join(root, "wt"), webhook: { url_env: "PD_HOOK", key_env: "PD_BEARER" }, acceptance_env_pass: ["ODD_NAMED_THING"] } } });
  const ctx = testContext(cfg, { ...env, PD_HOOK: "https://grok.example/r/route-id-1", PD_BEARER: "bearer-value-zzzzzz" });
  const xenv = executorEnv(ctx, { adapter: ADAPTERS.claude, ex: cfg.executors.claude, built: {}, task: { id: "t-1", project: "PD" }, workdir: "/w", projectEnv: {} });
  for (const k of ["PD_HOOK", "PD_BEARER", "ODD_NAMED_THING"]) assert.equal(k in xenv, false, `${k} not in executor env`);
  const aenv = acceptanceEnv(ctx, {}, cfg.projects.PD);
  assert.equal("ODD_NAMED_THING" in aenv, false, "acceptance_env_pass cannot pull a secrets.env name");
  assert.equal(redact("x bearer-value-zzzzzz https://grok.example/r/route-id-1 abcdefgh-not-a-pattern-123"), "x [REDACTED] [REDACTED] [REDACTED]");
  assert.throws(() => normalizeConfig({ self: "box", hosts: { box: {} }, projects: { P: { repo: "/r/p", webhook: { url_env: "P_HOOK", key_env: "P_BEARER" }, acceptance_env_pass: ["P_BEARER"] } } }, {}), /configured secret/);
  // pi still gets its own key, explicitly
  const pi = { adapter: "pi", host: "box", model: "m-1", key_env: "DEEPSEEK_API_KEY", limits: cfg.limits };
  const built = ADAPTERS.pi.buildCommand({ ex: pi, prompt: "p", env: { DEEPSEEK_API_KEY: "sk-test" } });
  const penv = executorEnv({ ...ctx, env: { ...ctx.env, DEEPSEEK_API_KEY: "sk-test" } }, { adapter: ADAPTERS.pi, ex: pi, built, task: { id: "t-1", project: "PD" }, workdir: "/w", projectEnv: {} });
  assert.equal(penv.DEEPSEEK_API_KEY, "sk-test");
});

// ------------------------------------------------------------------ install.sh

test("install.sh: systemd units point at the bin dir actually used; an edited unit is kept (new one beside it)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const t = mkdtempSync(join(tmpdir(), "nova inst-"));
  const env = { PATH: process.env.PATH, HOME: join(t, "home"), NOVA_RELAY_BIN_DIR: join(t, "my bin") };
  const inst = () => spawnSync("bash", [join(root, "install.sh"), "--systemd", "vps"], { env, encoding: "utf8" });
  assert.equal(inst().status, 0);
  const unit = join(t, "home", ".config", "systemd", "user", "nova-relay-watchdog.service");
  assert.match(readFileSync(unit, "utf8"), new RegExp(`ExecStart="${join(t, "my bin")}/nova-relay" watchdog`));
  assert.equal(inst().status, 0, "second run");
  assert.equal(existsSync(`${unit}.nova-new`), false, "unchanged unit is simply updated");
  writeFileSync(unit, `${readFileSync(unit, "utf8")}Environment=X=1\n`);
  const r = inst();
  assert.equal(r.status, 0);
  assert.match(readFileSync(unit, "utf8"), /Environment=X=1/, "user edit kept");
  assert.ok(existsSync(`${unit}.nova-new`));
  assert.match(r.stdout, /kept your edited/);
  const cli = spawnSync(join(t, "my bin", "nova-relay"), ["--help"], { env: { HOME: env.HOME, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /^nova-relay \d/);
});
