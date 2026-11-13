// review-fixes.test.mjs — end-to-end checks for: guard liveness, Codex post-hoc audit, repo
// integrity + symlink escapes, failure classification on CLI text only, run-time cap excluding
// pauses, quota reroute of a running task (same host and cross-host handoff), env-file perms,
// doctor --live, config isolation of worktree roots, install.sh under a minimal PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HANDLERS, dispatch, worker } from "../lib/relay.mjs";
import { readPaused } from "../lib/budget.mjs";
import { doctor } from "../lib/doctor.mjs";
import { ConfigError, normalizeConfig } from "../lib/config.mjs";
import { fallbackFor } from "../lib/routing.mjs";
import { BRIEF, FAKE, sh, tempRepo, testConfig, testContext } from "./helpers.mjs";

const codexEx = { adapter: "codex", host: "box", bin: FAKE, credential_files: [FAKE] };

async function run(mode, { cfgOver = {}, env = {}, brief = BRIEF(), mutate } = {}) {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, cfgOver);
  mutate?.(cfg, root);
  const ctx = testContext(cfg, { FAKE_MODE: mode, ...env });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: brief }] });
  await worker(ctx, { once: true });
  const id = r.tasks[0].id;
  return { ctx, cfg, root, repo, id, batch: r.batch, t: ctx.store.get(id) };
}

test("claude: guarded tool calls without any hook invocation → blocked (guard inactive), never done", async () => {
  const { t, ctx } = await run("noguard");
  assert.equal(t.state, "blocked");
  assert.match(t.reason, /guard inactive/);
  assert.ok(ctx.sent.some((s) => s.body.state === "blocked"), "wakes the planner");
  const ok = await run("hooked");
  assert.equal(ok.t.state, "done", "hook fired for the tool call → fine");
});

test("codex: --json events are audited after the fact; a push becomes an audit approval; deny fails the task", async () => {
  const cfgOver = { executors: { codex: codexEx }, routing: { rules: [{ type: "code", executor: "codex" }] } };
  const { t, ctx, id } = await run("ok", { cfgOver, env: { FAKE_CODEX_MODE: "audit" } });
  assert.equal(t.state, "needs_approval");
  const args = JSON.parse(readFileSync(join(ctx.store.dir(id), "fake-args.jsonl"), "utf8").split("\n")[0]);
  assert.ok(args.includes("--json") && args.includes("--sandbox") && args.includes("--cd"));
  const st = HANDLERS.status(ctx, { id });
  const audit = st.approvals.find((a) => a.kind === "audit");
  assert.match(audit.subject, /^ran: .*git push origin main/);
  assert.equal(st.approvals.length, 1, "npm test and the in-worktree file change are not flagged");
  const r = await HANDLERS.deny(ctx, { id, req: audit.req, owner: "grok" });
  assert.equal(r.state, "failed");
  assert.equal(ctx.store.get(id).reason, "owner rejected an operation the executor already ran");

  const ok = await run("ok", { cfgOver, env: { FAKE_CODEX_MODE: "ok" } });
  assert.equal(ok.t.state, "done");
  assert.equal(readdir(ok.ctx.store.dir(ok.id)).some((f) => f.startsWith("codex-last-")), false, "unredacted last-message file removed");
});
const readdir = (d) => spawnSync("ls", ["-A", d], { encoding: "utf8" }).stdout.split("\n");

test("integrity: executor tampering with the shared .git/hooks fails at once (no retry, escalated)", async () => {
  const { t } = await run("hooks-tamper");
  assert.equal(t.state, "failed");
  assert.match(t.verdict, /^FAIL integrity:\.git\/hooks/);
  assert.equal(t.local_retries, 0);
  assert.equal(t.escalated, true);
});

test("executor env drops GIT_CONFIG_* as a group (a partial strip breaks git), and git askpass/ssh overrides", async () => {
  const { executorEnv } = await import("../lib/runner.mjs");
  const { ADAPTERS } = await import("../lib/executors/index.mjs");
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo), { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "store", GIT_SSH_COMMAND: "ssh -i k", GIT_AUTHOR_NAME: "me" });
  const env = executorEnv(ctx, { adapter: ADAPTERS.claude, ex: ctx.cfg.executors.claude, task: { id: "t-1", project: "PD" }, workdir: repo, projectEnv: {} });
  for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_SSH_COMMAND"]) assert.equal(env[k], undefined, k);
  assert.equal(env.GIT_AUTHOR_NAME, "me");
  assert.equal(spawnSync("git", ["status", "--short"], { cwd: repo, env, encoding: "utf8" }).status, 0);
});

test("acceptance: a symlink in the diff pointing outside the worktree fails", async () => {
  const { t } = await run("symlink");
  assert.match(t.verdict, /^FAIL symlink-escape:src\/etc-link/);
});

test("failure classification uses the CLI's own error, not tool output in the stream", async () => {
  const { t, ctx } = await run("noisy-fail");
  assert.equal(readPaused(ctx.cfg.home).claude, undefined, "a test log mentioning 429 does not pause the executor");
  assert.equal(t.state, "failed");
  assert.match(t.reason, /segment failed \d+ times \(error\)/);
});

test("task run-time cap counts segment time only: a task paused for hours still runs", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo), { FAKE_MODE: "ok" });
  const r = await dispatch(ctx, { project: "PD", briefs: [{ name: "a.md", text: BRIEF() }] });
  const id = r.tasks[0].id;
  ctx.store.update(id, { started_at: new Date(Date.now() - 10 * 3600_000).toISOString(), active_minutes: 5 });
  await worker(ctx, { once: true });
  assert.equal(ctx.store.get(id).state, "done");
  const r2 = await dispatch(ctx, { project: "PD", briefs: [{ name: "b.md", text: BRIEF() }] });
  ctx.store.update(r2.tasks[0].id, { active_minutes: 181 });
  await worker(ctx, { once: true });
  assert.match(ctx.store.get(r2.tasks[0].id).reason, /run-time cap/);
});

test("quota on a running task → rerouted at the segment boundary to a same-host fallback (config opt-in)", async () => {
  const cfgOver = { executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] }, codex: codexEx },
    routing: { rules: [{ type: "code", executor: "claude", fallback: ["codex"] }], reroute_paused: "same-host" } };
  const { t, ctx, id, repo } = await run("partial-then-quota", { cfgOver, env: { FAKE_CODEX_MODE: "ok" } });
  assert.ok(readPaused(ctx.cfg.home).claude, "claude paused for quota");
  // The reroute re-queued it; the same worker run (or the next) finishes it on codex.
  await worker(ctx, { once: true });
  const nt = ctx.store.get(id);
  assert.equal(nt.state, "done");
  assert.equal(nt.executor, "codex");
  assert.equal(nt.rerouted_from, "claude");
  assert.equal(sh(repo, `git show nova/${id}:src/partial.txt`), "partial", "claude's checkpoint carried over");
  void t;
  // Off by default: the same situation just pauses.
  const off = await run("partial-then-quota", { cfgOver: { ...cfgOver, routing: { ...cfgOver.routing, reroute_paused: "off" } } });
  assert.equal(off.t.state, "paused");
  assert.equal(off.t.executor, "claude");
});

test("fallbackFor: pinned briefs, kind mismatch, project allowlist, host mode, reroute cap", () => {
  const cfg = normalizeConfig({
    self: "box", coordinator: "box", hosts: { box: { role: "box" }, vps: { role: "vps", ssh: "vps" } },
    executors: { claude: { adapter: "claude", host: "box" }, codex: { adapter: "codex", host: "vps" }, ds: { adapter: "deepseek-text", host: "vps", model: "test-model" } },
    routing: { rules: [{ type: "code", executor: "claude", fallback: ["ds", "codex"] }], reroute_paused: "any" },
    projects: { PD: { repo: "/srv/pd" }, NM: { repo: "/srv/nm", executors: ["claude"] } },
  }, {});
  const t = { type: "code", executor: "claude", project: "PD" };
  assert.deepEqual(fallbackFor(cfg, t, { claude: {} }), { executor: "codex", host: "vps" }, "skips the text executor");
  assert.equal(fallbackFor(cfg, { ...t, pinned: true }, { claude: {} }), null);
  assert.equal(fallbackFor(cfg, { ...t, project: "NM" }, { claude: {} }), null);
  assert.equal(fallbackFor(cfg, { ...t, reroutes: 2 }, { claude: {} }), null);
  assert.equal(fallbackFor(cfg, t, { claude: {}, codex: {} }), null);
  assert.equal(fallbackFor({ ...cfg, routing: { ...cfg.routing, reroute_paused: "same-host" } }, t, { claude: {} }), null);
});

test("cross-host quota reroute: task handed over with a git bundle of its branch; batch completes on the other host", async () => {
  const { root, repo } = tempRepo();
  const repoV = join(root, "repo-vps");
  spawnSync("git", ["clone", "-q", repo, repoV]);
  sh(repoV, "git branch -f main origin/main 2>/dev/null || true");
  const mk = (self) => normalizeConfig({
    self, coordinator: "box", home: join(root, `home-${self}`),
    hosts: { box: { role: "box", ssh: "box" }, vps: { role: "vps", ssh: "vps" } },
    limits: { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, max_local_retries: 2, lease_ttl_sec: 30 },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] }, codex: { ...codexEx, host: "vps" } },
    routing: { rules: [{ type: "code", executor: "claude", fallback: ["codex"] }], reroute_paused: "any" },
    projects: { PD: { repo: { box: repo, vps: repoV }, base: "main", worktrees: { box: join(root, "wt-box"), vps: join(root, "wt-vps") }, webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
  }, {});
  const ctxs = {};
  const sshCall = async (_cfg, host, method, payload) => {
    const c = ctxs[host];
    return JSON.parse(JSON.stringify((await c.handlers[method](c, JSON.parse(JSON.stringify(payload)))) ?? { ok: true }));
  };
  ctxs.box = testContext(mk("box"), { FAKE_MODE: "partial-then-quota" }, { sshCall });
  ctxs.vps = testContext(mk("vps"), { FAKE_CODEX_MODE: "ok" }, { sshCall });
  const r = await dispatch(ctxs.box, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  const id = r.tasks[0].id;
  await worker(ctxs.box, { once: true });
  assert.equal(ctxs.box.store.get(id).state, "moved");
  const vt = ctxs.vps.store.get(id);
  assert.equal(vt.executor, "codex");
  assert.match(ctxs.vps.store.events(id).map((e) => e.text).join("\n"), /branch imported from bundle/);
  assert.equal(sh(repoV, `git show nova/${id}:src/partial.txt`), "partial");
  await worker(ctxs.vps, { once: true });
  assert.equal(ctxs.vps.store.get(id).state, "done");
  const b = ctxs.box.store.getBatch(r.batch);
  assert.equal(b.tasks[id].state, "done");
  assert.equal(b.tasks[id].host, "vps");
  assert.deepEqual(ctxs.box.sent.map((s) => s.body.state), ["batch_done"], "one wake, no wake for the reroute");
  assert.equal((await HANDLERS.locate(ctxs.box, { id })).host, "vps");
});

test("project env_file readable by others → task blocked; 0600 → injected and redacted", async () => {
  const blocked = await run("ok", { mutate: (cfg, root) => {
    const f = join(root, "pd.env"); writeFileSync(f, "PD_DB_PASS=supersecret-123\n"); chmodSync(f, 0o644); cfg.projects.PD.env_file = f;
  } });
  assert.equal(blocked.t.state, "blocked");
  assert.match(blocked.t.reason, /chmod 600/);
  const ok = await run("ok", { mutate: (cfg, root) => {
    const f = join(root, "pd.env"); writeFileSync(f, "PD_DB_PASS=supersecret-123\n"); chmodSync(f, 0o600); cfg.projects.PD.env_file = f;
  } });
  assert.equal(ok.t.state, "done");
});

test("doctor --live: subscription login check via `claude auth status`; DeepSeek key via /user/balance (opt-in)", async () => {
  const { root, repo } = tempRepo();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/models") ? { data: [{ id: "test-model" }] } : { is_available: true }) }; };
  const ctx = testContext(testConfig(root, repo), { FAKE_MODE: "ok", DEEPSEEK_API_KEY: "sk-test-1234567890" }, { fetchImpl });
  const by = async (opts) => Object.fromEntries((await doctor(ctx, { remote: false, ...opts })).map((r) => [r.name, r]));
  const off = await by({});
  assert.equal(off["executor claude live"], undefined, "no live checks unless asked");
  assert.equal(calls.length, 0);
  const on = await by({ live: true });
  assert.equal(on["executor claude live"].level, "OK");
  assert.equal(on["executor deepseek-text live"].level, "OK");
  assert.equal(calls[0], "https://api.deepseek.com/user/balance");
  ctx.env.FAKE_MODE = "apikey";
  assert.match((await by({ live: true }))["executor claude live"].detail, /not the claude\.ai subscription/);
});

test("config: worktree roots must not sit inside another project's repo; reroute_paused validated", () => {
  const raw = () => ({ self: "box", hosts: { box: {} }, projects: { PD: { repo: "/srv/pd" }, NM: { repo: "/srv/nm", worktrees: "/srv/pd/.wt" } } });
  assert.throws(() => normalizeConfig(raw(), {}), (e) => e instanceof ConfigError && e.problems.some((p) => p.includes("projects.NM.worktrees") && p.includes("projects.PD.repo")));
  const r2 = raw(); r2.projects.NM.worktrees = "/srv/nm-wt"; r2.routing = { rules: [], reroute_paused: "sometimes" };
  assert.throws(() => normalizeConfig(r2, {}), /reroute_paused/);
});

test("log rpc returns a task's events (the CLI forwards it to the task host like status)", async () => {
  const { t, ctx, id } = await run("auth");
  assert.equal(t.state, "needs_auth");
  assert.ok(HANDLERS.log(ctx, { id, n: 5 }).length > 0);
});

test("install.sh: idempotent, records node so timers/ssh with a minimal PATH work", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-inst-"));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH };
  for (let i = 0; i < 2; i++) {
    const r = spawnSync("bash", [join(root, "install.sh"), "--systemd", "box"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  const v = spawnSync(join(home, ".local", "bin", "nova-relay"), ["version"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(statMode(join(home, ".config", "nova-relay", "secrets.env")), 0o600);
  assert.ok(existsSync(join(home, ".config", "systemd", "user", "nova-relay-tick.timer")));
});
const statMode = (p) => spawnSync("stat", ["-c", "%a", p], { encoding: "utf8" }).stdout.trim() === "600" ? 0o600 : -1;
