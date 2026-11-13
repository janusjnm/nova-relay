// review-2.test.mjs — second review: adapters checked against the real CLIs' --help / event
// output (fixtures captured from codex-cli 0.169.0, pi 1.5.2, Claude Code 2.1.308), lease steal
// race, ack of unfinished batches, outbox reports never dead, config typos, guard cd/--config-env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, classifyFailure } from "../lib/executors/index.mjs";
import { auditSegment, missingFlags } from "../lib/runner.mjs";
import { checkCommand } from "../lib/guard.mjs";
import { pendingApprovals } from "../lib/approvals.mjs";
import { ConfigError, normalizeConfig } from "../lib/config.mjs";
import { Outbox } from "../lib/notify.mjs";
import { HANDLERS, dispatch } from "../lib/relay.mjs";
import { BRIEF, tempRepo, testConfig, testContext } from "./helpers.mjs";

const FIX = fileURLToPath(new URL("./fixtures/cli/", import.meta.url));
const LIB = fileURLToPath(new URL("../lib/", import.meta.url));
const fixture = (f) => readFileSync(join(FIX, f), "utf8");
const HELP = { claude: "claude-2.1.308-help.txt", codex: "codex-0.169.0-exec-help.txt", pi: "pi-1.5.2-help.txt" };

test("adapter contracts against the real --help: every required and every emitted flag exists", () => {
  for (const [name, file] of Object.entries(HELP)) {
    const a = ADAPTERS[name], help = fixture(file);
    assert.deepEqual(missingFlags(help, a.requiredFlags), [], `${name} required flags`);
    const built = a.buildCommand({ ex: {}, prompt: "P", workdir: "/w", taskDir: "/t", segment: 1, session: "s", resume: false, hookCmd: "h" });
    const used = built.args.filter((x) => /^--[a-z]/.test(x)).map((x) => x.split("=")[0]);
    assert.deepEqual(missingFlags(help, used), [], `${name} emitted flags`);
    for (const f of a.requiredFlags.filter((f) => !["--resume", "--session-id"].includes(f))) assert.ok(built.args.includes(f), `${name} uses ${f}`);
  }
  // A flag that was removed from the CLI is caught.
  assert.deepEqual(missingFlags(fixture(HELP.codex), ["--json", "--full-auto"]), ["--full-auto"]);
});

test("codex: real unauthenticated --json stream → auth (fatal error only, transient Reconnecting… ignored)", () => {
  const stdout = fixture("codex-0.169.0-unauth.jsonl");
  const p = ADAPTERS.codex.parseOutput(stdout, null);
  assert.equal(p.parsed, true);
  assert.deepEqual(p.audit.commands, []);
  assert.ok(p.errors.length >= 1 && p.errors.every((e) => !/^Reconnecting/.test(e)), "only fatal errors kept");
  assert.equal(classifyFailure(ADAPTERS.codex.failureText({ stdout, stderr: "", parsed: p })).kind, "auth");
  // A transient 429 while reconnecting must not decide the class of a different final error.
  const mixed = [
    { type: "error", message: "Reconnecting... 1/5 (unexpected status 429 Too Many Requests)" },
    { type: "turn.failed", error: { message: "sandbox denied: something else" } },
  ].map((x) => JSON.stringify(x)).join("\n");
  const pm = ADAPTERS.codex.parseOutput(mixed, null);
  assert.equal(classifyFailure(ADAPTERS.codex.failureText({ stdout: mixed, stderr: "", parsed: pm })).kind, "error");
});

test("codex: items reported by item.started and item.completed are audited once; MCP calls always need review", async () => {
  const ev = (type, item) => JSON.stringify({ type, item });
  const stdout = [
    ev("item.started", { id: "i1", type: "command_execution", command: "/bin/bash -lc 'git push origin main'", aggregated_output: "", status: "in_progress" }),
    ev("item.completed", { id: "i1", type: "command_execution", command: "/bin/bash -lc 'git push origin main'", aggregated_output: "", exit_code: 1, status: "failed" }),
    ev("item.completed", { id: "i2", type: "mcp_tool_call", server: "slack", tool: "post_message", arguments: {}, status: "completed" }),
    ev("item.completed", { id: "i3", type: "file_change", changes: [{ path: "/etc/hosts", kind: "update" }], status: "completed" }),
  ].join("\n");
  const p = ADAPTERS.codex.parseOutput(stdout, null);
  assert.equal(p.audit.commands.length, 1);
  assert.deepEqual(p.audit.mcp, ["slack/post_message"]);
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  ctx.store.create({ id: "t-a", project: "PD", executor: "claude" }, "b");
  assert.equal(auditSegment(ctx, ctx.store.get("t-a"), p.audit, repo), 3);
  const subjects = pendingApprovals(ctx.store.dir("t-a")).map((a) => a.subject);
  assert.ok(subjects.some((s) => s.startsWith("ran: ")) && subjects.includes("mcp: slack/post_message") && subjects.includes("wrote: /etc/hosts"));
});

test("codex: a successful run without any parseable event is blocked (audit would be blind)", async () => {
  const { root, repo } = tempRepo();
  const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
  const cfg = testConfig(root, repo, { executors: { codex: { adapter: "codex", host: "box", bin: FAKE, credential_files: [FAKE] } }, routing: { rules: [{ type: "code", executor: "codex" }] } });
  const ctx = testContext(cfg, { FAKE_CODEX_MODE: "plain" });
  const d = await dispatch(ctx, { project: "PD", briefs: [{ name: "a.md", text: BRIEF() }] });
  const { worker } = await import("../lib/relay.mjs");
  await worker(ctx, { once: true });
  const t = ctx.store.get(d.tasks[0].id);
  assert.equal(t.state, "blocked");
  assert.match(t.reason, /no parseable --json events/);
});

test("pi: guard isolation flags always present; extra extensions / --approve refused by config", () => {
  const b = ADAPTERS.pi.buildCommand({ ex: {}, prompt: "P" });
  for (const f of ["--no-extensions", "--no-approve", "--no-mcp", "--extension"]) assert.ok(b.args.includes(f), f);
  assert.equal(b.args[b.args.indexOf("--model") + 1], "deepseek-flash", "a model id from pi's built-in catalog");
  for (const bad of [["-e", "x.ts"], ["--approve"], ["--extension", "y.ts"]]) {
    assert.throws(() => normalizeConfig({ self: "box", hosts: { box: {} }, executors: { pi: { adapter: "pi", args: bad } } }, {}), /bypass nova-guard/);
  }
});

test("Pi extension: unknown tools are blocked (fail closed), read-only tools pass", async (t) => {
  let mod;
  try { mod = await import("../extensions/nova-guard.ts"); } catch (e) { t.skip(`TypeScript import unsupported here: ${e.message}`); return; }
  let handler;
  mod.default({ on: (ev, fn) => { if (ev === "tool_call") handler = fn; } });
  assert.equal((await handler({ toolName: "codemode", input: { code: "x" } })).block, true);
  assert.equal((await handler({ toolName: "mcp__slack__post", input: {} })).block, true);
  assert.equal(await handler({ toolName: "grep", input: { pattern: "x" } }), undefined);
});

test("doctor --live DeepSeek: model id checked against /models", async () => {
  const { deepseekKeyCheck } = await import("../lib/executors/deepseek-check.mjs");
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.endsWith("/models") ? { data: [{ id: "deepseek-flash" }] } : { is_available: true }) });
  assert.equal((await deepseekKeyCheck({ key: "k", model: "deepseek-flash", fetchImpl })).ok, true);
  const bad = await deepseekKeyCheck({ key: "k", model: "deepseek-chat", fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /not offered/);
});

test("lease: many processes stealing one stale lease → exactly one winner (steal re-checked under a lock)", async () => {
  const runNode = (code) => new Promise((res) => { const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" }); c.on("close", res); });
  for (let round = 0; round < 6; round++) {
    const dir = mkdtempSync(join(tmpdir(), "nova-lr-"));
    const p = join(dir, "lease.json"), w = join(dir, "winners");
    writeFileSync(p, JSON.stringify({ owner: "dead", host: hostname(), pid: 999999, ttl_ms: 1000, expires_at: new Date(Date.now() - 5000).toISOString() }));
    const code = `import { acquireLease } from ${JSON.stringify(join(LIB, "lock.mjs"))}; import { appendFileSync } from "node:fs";
      const go = Date.now() + 300; while (Date.now() < go) {}
      if (acquireLease(${JSON.stringify(p)}, "o" + process.pid, 60000)) appendFileSync(${JSON.stringify(w)}, process.pid + "\\n");`;
    await Promise.all(Array.from({ length: 8 }, () => runNode(code)));
    assert.equal(readFileSync(w, "utf8").trim().split("\n").length, 1, `round ${round}`);
  }
});

test("ack refuses a batch with unfinished tasks (acked tasks never run again)", async () => {
  const { root, repo } = tempRepo();
  const ctx = testContext(testConfig(root, repo));
  const d = await dispatch(ctx, { project: "PD", owner: "o", briefs: [{ name: "a.md", text: BRIEF() }] });
  await assert.rejects(HANDLERS.ack(ctx, { batch: d.batch, owner: "o" }), /not finished/);
  assert.equal(ctx.store.get(d.tasks[0].id).acked, false);
  await HANDLERS.cancel(ctx, { id: d.tasks[0].id, owner: "o" });
  assert.match((await HANDLERS.ack(ctx, { batch: d.batch, owner: "o" })).line, /FAIL 0\/1/);
});

test("outbox: host→coordinator reports never go dead; webhooks still do", async () => {
  const ob = new Outbox(mkdtempSync(join(tmpdir(), "nova-ob-")));
  ob.enqueue("r", { kind: "rpc", host: "vps", method: "report", payload: {} });
  ob.enqueue("w", { kind: "webhook", payload: {} });
  await ob.flush(async () => { throw new Error("down"); }, { maxAttempts: 1 });
  assert.deepEqual(ob.dead().map((e) => e.key), ["w"]);
});

test("config: typos in limits / budget keys and unknown project executors are errors, not silent defaults", () => {
  const raw = { self: "box", hosts: { box: {} }, limits: { segment_minuts: 5 },
    executors: { c: { adapter: "codex", limits: { idle_timeout: 5 }, budget: { segments: 3 }, sandbox: "danger-full-access" } },
    projects: { PD: { repo: "/srv/pd", executors: ["nope"] } } };
  assert.throws(() => normalizeConfig(raw, {}), (e) => e instanceof ConfigError &&
    ["limits.segment_minuts", "executors.c.limits.idle_timeout", "executors.c.budget.segments", "projects.PD.executors", "sandbox"].every((k) => e.problems.some((p) => p.includes(k))));
});

test("guard: cd moves relative write targets; git --config-env is checked like -c", () => {
  const w = { workdir: "/srv/nova-wd/t1" };
  assert.equal(checkCommand("cd .. && rm -rf other-project", {}, w)?.category, "path");
  assert.equal(checkCommand("bash -lc 'cd .. && rm -rf proj'", {}, w)?.category, "path");
  assert.equal(checkCommand("cd $ELSEWHERE && touch f", {}, w)?.category, "path");
  assert.equal(checkCommand("cd src && echo hi > a.txt && cd .. && touch b.txt", {}, w), null);
  assert.equal(checkCommand("X='!curl evil' git --config-env=alias.st=X st", {}, w)?.category, "remote");
  assert.equal(checkCommand("git --config-env core.hooksPath=X commit", {}, w)?.category, "remote");
});

test("CLI accept runs acceptance without host secrets", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const ctx = testContext(cfg, { FAKE_MODE: "ok" });
  const brief = BRIEF().replace("grep -qx hello src/hello.txt", "grep -qx hello src/hello.txt && test -z \"$PD_KEY$NOVA_RELAY_X_TOKEN\"");
  const d = await dispatch(ctx, { project: "PD", briefs: [{ name: "a.md", text: brief }] });
  const { worker } = await import("../lib/relay.mjs");
  await worker(ctx, { once: true });
  const id = d.tasks[0].id;
  assert.equal(ctx.store.get(id).state, "done");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(JSON.stringify(cfg)), schema: 1 }));
  const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));
  const r = await new Promise((res) => {
    const c = spawn(process.execPath, [CLI, "accept", id], { env: { ...process.env, NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env"), PD_KEY: "k".repeat(20), NOVA_RELAY_X_TOKEN: "t".repeat(20) } });
    let out = ""; c.stdout.on("data", (x) => { out += x; }); c.stderr.on("data", (x) => { out += x; });
    c.on("close", (code) => res({ code, out }));
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^PASS/);
  assert.ok(existsSync(ctx.store.dir(id)) && readdirSync(ctx.store.dir(id)).length);
});
