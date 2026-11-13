// runner.test.mjs — end-to-end on one host with a fake executor CLI and a real git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { HANDLERS, dispatch, gc, resumeAll, worker } from "../lib/relay.mjs";
import { readPaused } from "../lib/budget.mjs";
import { cliContract } from "../lib/runner.mjs";
import { ADAPTERS } from "../lib/executors/index.mjs";
import { doctor } from "../lib/doctor.mjs";
import { BRIEF, FAKE, sh, tempRepo, testConfig, testContext } from "./helpers.mjs";

async function runOne(mode, { brief = BRIEF(), cfgOver = {}, limits = {}, env = {} } = {}) {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, cfgOver);
  Object.assign(cfg.executors.claude.limits, limits);
  const ctx = testContext(cfg, { FAKE_MODE: mode, ...env });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: brief }] });
  await worker(ctx, { once: true });
  const id = r.tasks[0].id;
  return { ctx, cfg, root, repo, id, batch: r.batch, t: ctx.store.get(id), b: ctx.store.getBatch(r.batch) };
}

test("happy path: worktree + branch, acceptance PASS, done, one batch_done wake", async () => {
  const { ctx, t, b, repo, id } = await runOne("ok");
  assert.equal(t.state, "done");
  assert.equal(t.verdict, "PASS");
  assert.equal(t.branch, `nova/${id}`);
  assert.equal(sh(repo, `git show nova/${id}:src/hello.txt`), "hello", "checkpoint committed on the task branch");
  assert.equal(sh(repo, "git rev-parse --abbrev-ref HEAD"), "main", "main untouched");
  assert.ok(!existsSync(join(repo, "src", "hello.txt")), "main worktree untouched");
  assert.equal(b.tasks[id].state, "done");
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual(ctx.sent[0].body, { source: "nova-relay", batch: b.id, id: "*", state: "batch_done", exit_code: 0 });
  const args = readFileSync(join(ctx.store.dir(id), "fake-args.jsonl"), "utf8");
  assert.ok(!args.includes("--bare"));
  assert.match(args, /--session-id/);
  assert.match(readFileSync(join(ctx.store.dir(id), "result.md"), "utf8"), /^PASS/);
});

test("hallucinated success: executor claims done with no diff → FAIL empty-diff after local retries", async () => {
  const { t, ctx, id } = await runOne("liar");
  assert.equal(t.state, "failed");
  assert.equal(t.verdict, "FAIL empty-diff");
  assert.equal(t.local_retries, 3, "max_local_retries=2, then escalated on the 3rd");
  const lastPrompt = JSON.parse(readFileSync(join(ctx.store.dir(id), "fake-args.jsonl"), "utf8").trim().split("\n").pop())[1];
  assert.match(lastPrompt, /Last acceptance failure — fix this first\nFAIL empty-diff/);
});

test("local retry with the error: wrong first attempt, fixed on retry", async () => {
  const { t } = await runOne("fail-then-ok");
  assert.equal(t.state, "done");
  assert.equal(t.local_retries, 1);
  assert.equal(t.segments, 2);
});

test("test tampering and out-of-scope edits fail acceptance", async () => {
  const s = await runOne("skip-tests", { brief: BRIEF().replace("- src/**", "- src/**\n- tests/**") });
  assert.match(s.t.verdict, /^FAIL tests-skipped:tests\/a\.test\.js/);
  const o = await runOne("out-of-scope");
  assert.match(o.t.verdict, /^FAIL scope:other\/x\.txt/);
});

test("quota: executor paused until reset, task paused, no wake, no loop", async () => {
  const { t, ctx, cfg } = await runOne("quota");
  assert.equal(t.state, "paused");
  assert.equal(t.quota_pauses, 1);
  assert.ok(Date.parse(t.resume_after) > Date.now() + 50 * 60_000, "reset time parsed from CLI output");
  assert.equal(readPaused(cfg.home).claude.reason, "quota");
  assert.equal(ctx.sent.length, 0, "quota does not wake the planner");
  await worker(ctx, { once: true });
  assert.equal(JSON.parse(readFileSync(join(ctx.store.dir(t.id), "fake-count"), "utf8")), 1, "paused task is not re-run before reset");
});

test("auth failure → needs_auth, executor paused, exactly one wake", async () => {
  const { t, ctx, cfg } = await runOne("auth");
  assert.equal(t.state, "needs_auth");
  assert.equal(readPaused(cfg.home).claude.reason, "auth");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].body.state, "needs_auth");
});

test("auth incident: several tasks hit the same logged-out executor → still one wake", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo), { FAKE_MODE: "auth" });
  const briefs = ["a", "b", "c"].map((n) => ({ name: n, text: BRIEF().replace("- src/**", `- src/${n}/**`) }));
  await dispatch(ctx, { project: "PD", owner: "grok", briefs });
  await worker(ctx, { once: true });
  await worker(ctx, { once: true });
  assert.equal(ctx.store.list().filter((t) => t.state === "needs_auth").length, 3);
  assert.equal(ctx.sent.filter((s) => s.body.state === "needs_auth").length, 1);
});

test("CLI flag removed: preflight contract → blocked + wake; adapter rejected flag at run → blocked", async () => {
  const a = await runOne("badflags");
  assert.equal(a.t.state, "blocked");
  assert.match(a.t.reason, /lacks flags: --verbose --resume/);
  assert.equal(a.ctx.sent[0].body.state, "blocked");
  const b = await runOne("badflag-run");
  assert.equal(b.t.state, "blocked");
});

test("network errors: retried with backoff, recovers", async () => {
  const { t } = await runOne("net-then-ok");
  assert.equal(t.state, "done");
  assert.equal(t.segment_failures, 0);
});

test("hung executor: idle timeout kills it; > max_segment_failures escalates with an immediate wake", async () => {
  const { t, ctx } = await runOne("hang", { limits: { idle_timeout_sec: 1, max_segment_failures: 1 } });
  assert.equal(t.state, "failed");
  assert.equal(t.escalated, true);
  assert.equal(ctx.sent.filter((s) => s.body.state === "failed").length, 1);
});

test("guard block → needs_approval wake → approve → task resumes", async () => {
  const { t, ctx, id } = await runOne("guard");
  assert.equal(t.state, "needs_approval");
  assert.equal(ctx.sent[0].body.state, "needs_approval");
  const st = HANDLERS.status(ctx, { id });
  assert.equal(st.approvals.length, 1);
  assert.equal(st.approvals[0].category, "disaster");
  await assert.rejects(HANDLERS.approve(ctx, { id, req: st.approvals[0].req, owner: "intruder" }), /belongs to/);
  const r = await HANDLERS.deny(ctx, { id, req: st.approvals[0].req, owner: "grok" });
  assert.equal(r.state, "queued");
  ctx.env.FAKE_MODE = "ok";
  await worker(ctx, { once: true });
  assert.equal(ctx.store.get(id).state, "done");
});

test("merge conflict with base → needs_approval; approve marks done", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const ctx = testContext(cfg, { FAKE_MODE: "ok" });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  // Someone commits a conflicting src/hello.txt on main while the task is queued.
  writeFileSync(join(repo, "src", "hello.txt"), "other\n");
  sh(repo, "git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm conflict");
  // The worktree was not created yet, so create it from the old base to simulate a concurrent change.
  sh(repo, `git branch nova/${r.tasks[0].id} HEAD~1`);
  await worker(ctx, { once: true });
  const id = r.tasks[0].id;
  assert.equal(ctx.store.get(id).state, "needs_approval");
  const req = HANDLERS.status(ctx, { id }).approvals[0];
  assert.equal(req.kind, "merge");
  await HANDLERS.approve(ctx, { id, req: req.req });
  assert.equal(ctx.store.get(id).state, "done");
});

test("text job via deepseek-text: no shell, result.md written, secrets redacted", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("deepseek")) { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "你好 sk-abcdefghijklmnopqrstuvwx" } }], usage: { total_tokens: 42 } }) }; }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const ctx = testContext(cfg, { DEEPSEEK_API_KEY: "test-key-123456" }, { fetchImpl });
  const r = await dispatch(ctx, { project: "PD", briefs: [{ name: "t.md", text: "---\ntype: text\n---\n# Goal\nTranslate hello to Chinese\n" }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(r.tasks[0].id);
  assert.equal(t.state, "done");
  assert.equal(calls.length, 1);
  const res = readFileSync(join(ctx.store.dir(t.id), "result.md"), "utf8");
  assert.match(res, /你好/);
  assert.doesNotMatch(res, /sk-abcdef/);
});

test("resume: stale lease after a crash is re-queued once; held lease untouched; idempotent", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  let spawned = 0;
  const ctx = testContext(cfg, { FAKE_MODE: "ok" }, { spawnWorker: () => { spawned++; } });
  const r = await dispatch(ctx, { project: "PD", briefs: [{ name: "a.md", text: BRIEF() }] });
  const id = r.tasks[0].id;
  ctx.store.update(id, { state: "running", segments: 1 });
  writeFileSync(join(ctx.store.dir(id), "lease.json"), JSON.stringify({ owner: "x", host: hostname(), pid: 999999, ttl_ms: 1000, expires_at: new Date(Date.now() - 10_000).toISOString() }));
  const a = await resumeAll(ctx);
  assert.deepEqual(a.resumed, [id]);
  assert.equal(ctx.store.get(id).state, "queued");
  await worker(ctx, { once: true });
  assert.equal(ctx.store.get(id).state, "done");
  assert.ok(spawned >= 1);
  const again = await resumeAll(ctx);
  assert.deepEqual(again.resumed, [], "done task is never resumed");
});

test("ack → gc removes worktree (branch kept) and later the task dir", async () => {
  const { ctx, id, batch, repo, t } = await runOne("ok");
  await HANDLERS.ack(ctx, { batch, owner: "grok" });
  assert.equal(ctx.store.get(id).acked, true);
  gc(ctx);
  assert.ok(!existsSync(t.worktree));
  assert.equal(sh(repo, `git show nova/${id}:src/hello.txt`), "hello");
  assert.ok(ctx.store.exists(id), "kept until retention expires");
  gc(ctx, Date.now() + 8 * 86400_000);
  assert.ok(!ctx.store.exists(id));
});

test("secrets in executor output are redacted in progress and logs; child env has no webhook secrets", async () => {
  const { ctx, id } = await runOne("secret", { env: { NOVA_RELAY_WEBHOOK_KEY: "should-not-leak-1234" } });
  const progress = readFileSync(join(ctx.store.dir(id), "progress.md"), "utf8");
  assert.doesNotMatch(progress, /sk-abcdefghij/);
  const { executorEnv } = await import("../lib/runner.mjs");
  const env = executorEnv(ctx, { adapter: ADAPTERS.claude, ex: ctx.cfg.executors.claude, task: ctx.store.get(id), workdir: "/w", projectEnv: {} });
  assert.equal(env.PD_KEY, undefined);
  assert.equal(env.NOVA_RELAY_WEBHOOK_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});

test("adapter contracts: required flags present in built commands; cliContract detects old versions", () => {
  for (const [name, a] of Object.entries(ADAPTERS)) {
    if (a.kind !== "agent") continue;
    const built = a.buildCommand({ ex: {}, prompt: "P", workdir: "/w", taskDir: "/t", segment: 1, session: "s", resume: false, hookCmd: "h" });
    assert.ok(built.args.includes("P") || built.args.some((x) => x === "P"), `${name} passes the prompt`);
    for (const f of a.requiredFlags.filter((f) => !["--resume", "--help", "--no-session", "--session-id"].includes(f))) {
      if (name === "claude" || name === "codex") assert.ok(built.args.includes(f), `${name} uses ${f}`);
    }
  }
  const resumed = ADAPTERS.claude.buildCommand({ ex: {}, prompt: "P", session: "s1", resume: true, hookCmd: "h" });
  assert.deepEqual(resumed.args.slice(-2), ["--resume", "s1"]);
  const home = testConfig(tempRepo().root, "/tmp").home;
  process.env.FAKE_MODE = "oldversion";
  try {
    const c = cliContract(home, "claude", { bin: FAKE, min_version: "1.0.0" }, ADAPTERS.claude, { force: true });
    assert.equal(c.ok, false);
    assert.match(c.why, /< min_version/);
  } finally { delete process.env.FAKE_MODE; }
  assert.equal(cliContract(home, "claude", { bin: "/nonexistent/claude" }, ADAPTERS.claude, { force: true }).kind, "cli");
});

test("disk preflight blocks before running", async () => {
  const { t } = await runOne("ok", { limits: { min_free_mb: 1e12 } });
  assert.equal(t.state, "blocked");
  assert.match(t.reason, /^disk/);
});

test("doctor reports problems without crashing", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo), { FAKE_MODE: "ok" });
  const res = await doctor(ctx, { remote: false });
  const by = Object.fromEntries(res.map((r) => [r.name, r.level]));
  assert.equal(by.node, "OK");
  assert.equal(by["executor claude cli"], "OK");
  assert.equal(by["project PD"], "OK");
  assert.equal(by["webhook PD"], "OK");
  assert.equal(by["executor deepseek-text auth"], process.env.DEEPSEEK_API_KEY ? "OK" : "FAIL");
});
