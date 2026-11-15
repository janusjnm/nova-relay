// Spawn / file-growth reductions: CLI contract cache keyed on binary identity + config, no duplicate
// first-segment probes, bounded run/worker.log. Spawns are counted through cliContract's `run` hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "../lib/executors/index.mjs";
import { binIdentity, cliContract } from "../lib/runner.mjs";
import { dispatch, openWorkerLog, worker } from "../lib/relay.mjs";
import { BRIEF, FAKE, isolatedEnv, tempRepo, testConfig, testContext } from "./helpers.mjs";

const HELP = "--print --output-format --verbose --resume --session-id --settings --setting-sources --strict-mcp-config --permission-mode --allowedTools --disallowedTools";

// Fake runner: answers --version / --help without spawning, records every call.
function counter(version = "2.5.0 (Claude Code)") {
  const calls = [];
  const run = async (bin, args) => { calls.push(args.join(" ")); return { status: 0, stdout: args[0] === "--version" ? version : HELP, stderr: "", aborted: false }; };
  return { calls, run, set: (v) => { version = v; } };
}

function setup(content = "\x7fELF native") {
  const dir = mkdtempSync(join(tmpdir(), "nova-perf-"));
  const home = join(dir, "home");
  mkdirSync(join(home, "run"), { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(bin, content, { mode: 0o755 });
  return { dir, home, bin };
}

test("cliContract: warm cache on an unchanged native binary spawns nothing; mtime, path, min_version, flags, TTL, force re-check", async () => {
  const { dir, home, bin } = setup();
  const c = counter();
  const env = isolatedEnv();
  const check = (ex = {}, opts = {}, adapter = ADAPTERS.claude) => cliContract(home, "claude", { bin, min_version: "2.0.0", ...ex }, adapter, { env, run: c.run, ...opts });

  assert.deepEqual(await check(), { ok: true, version: "2.5.0 (Claude Code)" });
  assert.deepEqual(c.calls, ["--version", "--help"], "cold: version + help");
  c.calls.length = 0;
  assert.deepEqual(await check(), { ok: true, version: "2.5.0 (Claude Code)" });
  assert.deepEqual(c.calls, [], "warm, binary unchanged: no spawn at all");

  // Binary replaced in place (upgrade): mtime changes → full re-check, and the new version is seen.
  c.set("2.6.0 (Claude Code)");
  const later = new Date(Date.now() + 5000);
  utimesSync(bin, later, later);
  assert.equal((await check()).version, "2.6.0 (Claude Code)");
  assert.deepEqual(c.calls, ["--version", "--help"], "mtime change re-checks");
  c.calls.length = 0;

  // Raised min_version: the cached OK must not survive (old cache ignored min_version).
  const r = await check({ min_version: "3.0.0" });
  assert.equal(r.ok, false);
  assert.match(r.why, /< min_version 3\.0\.0/);
  assert.deepEqual(c.calls, ["--version"]);
  c.calls.length = 0;

  // Different required flags (nova-relay upgrade) → re-check.
  await check();
  c.calls.length = 0;
  const r2 = await check({}, {}, { ...ADAPTERS.claude, requiredFlags: [...ADAPTERS.claude.requiredFlags, "--brand-new-flag"] });
  assert.equal(r2.ok, false);
  assert.match(r2.why, /lacks flags: --brand-new-flag/);
  assert.deepEqual(c.calls, ["--version", "--help"]);
  c.calls.length = 0;

  // Different bin path with identical content → re-check.
  await check();
  c.calls.length = 0;
  const bin2 = join(dir, "claude2");
  writeFileSync(bin2, readFileSync(bin), { mode: 0o755 });
  await cliContract(home, "claude", { bin: bin2, min_version: "2.0.0" }, ADAPTERS.claude, { env, run: c.run });
  assert.deepEqual(c.calls, ["--version", "--help"], "new path re-checks");
  c.calls.length = 0;

  // TTL expired → re-check; force (doctor) → re-check even when warm.
  await check();
  c.calls.length = 0;
  const cp = join(home, "run", "contract-claude.json");
  writeFileSync(cp, JSON.stringify({ ...JSON.parse(readFileSync(cp, "utf8")), at: new Date(Date.now() - 2 * 3600_000).toISOString() }));
  await check();
  assert.deepEqual(c.calls, ["--version", "--help"], "expired TTL re-checks");
  c.calls.length = 0;
  await check({}, { force: true });
  assert.deepEqual(c.calls, ["--version", "--help"], "force bypasses the cache");
  c.calls.length = 0;

  // A cache file in the old format (no key) is not trusted.
  writeFileSync(cp, JSON.stringify({ ok: true, version: "2.6.0 (Claude Code)", at: new Date().toISOString() }));
  await check();
  assert.deepEqual(c.calls, ["--version", "--help"]);
});

test("cliContract: a #! wrapper or an unresolvable bin still runs --version every time; --help only while the version matches", async () => {
  const { home, bin } = setup("#!/bin/bash\nexec \"$HOME/.local/bin/claude.real\" \"$@\"\n");
  assert.equal(binIdentity(bin).script, true);
  const c = counter();
  const env = isolatedEnv();
  const check = (b = bin) => cliContract(home, "claude", { bin: b }, ADAPTERS.claude, { env, run: c.run });
  await check();
  c.calls.length = 0;
  await check();
  assert.deepEqual(c.calls, ["--version"], "wrapper: version still spawned, help skipped");
  c.calls.length = 0;
  c.set("2.7.0 (Claude Code)"); // the wrapped binary was upgraded; the wrapper file did not change
  assert.equal((await check()).version, "2.7.0 (Claude Code)");
  assert.deepEqual(c.calls, ["--version", "--help"]);

  // Not found on PATH: no identity → --version always runs (and fails if spawn fails).
  const env2 = isolatedEnv({ PATH: "/nonexistent-dir" });
  assert.equal(binIdentity("claude-not-here", env2), null);
  const c2 = counter();
  for (let i = 0; i < 2; i++) await cliContract(home, "nobin", { bin: "claude-not-here" }, ADAPTERS.claude, { env: env2, run: c2.run });
  assert.deepEqual(c2.calls, ["--version", "--help", "--version"]);
});

test("cliContract: PATH lookup uses the executor env and follows symlinks; aborted signal spawns nothing", async () => {
  const { dir, bin } = setup();
  const id = binIdentity("claude", { PATH: `/nonexistent:${dir}` });
  assert.equal(id.path, bin);
  assert.equal(id.script, false);
  const ac = new AbortController();
  ac.abort();
  const c = counter();
  const r = await cliContract(join(dir, "home"), "claude", { bin }, ADAPTERS.claude, { env: isolatedEnv(), run: c.run, signal: ac.signal });
  assert.equal(r.kind, "aborted");
  assert.deepEqual(c.calls, []);
});

test("runTask: preflight_cmd runs once before the first segment and again before each later segment", async () => {
  const { root, repo } = tempRepo();
  const log = join(root, "pf-runs");
  const cfg = testConfig(root, repo, {
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE], preflight_cmd: `echo x >> ${log}` } },
    routing: { rules: [{ type: "code", executor: "claude" }] } });
  const ctx = testContext(cfg, { FAKE_MODE: "fail-then-ok" });
  const d = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(d.tasks[0].id);
  assert.equal(t.state, "done", `${t.state}: ${t.reason}`);
  assert.equal(t.segments, 2);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "start + segment 2 (was 3: start, segment 1, segment 2)");
});

test("openWorkerLog: over the limit the log becomes worker.log.1 (one generation); under it, appends", () => {
  const home = join(mkdtempSync(join(tmpdir(), "nova-perf-")), "home");
  mkdirSync(join(home, "run"), { recursive: true });
  const p = join(home, "run", "worker.log");
  const put = (s, max) => { const fd = openWorkerLog(home, max); writeSync(fd, s); closeSync(fd); };
  put("a".repeat(50), 100);
  put("b".repeat(60), 100);
  assert.equal(statSync(p).size, 110, "at/under the limit when opened: appended");
  assert.equal(existsSync(`${p}.1`), false);
  put("c", 100);
  assert.equal(readFileSync(`${p}.1`, "utf8"), "a".repeat(50) + "b".repeat(60), "old content kept as .1");
  assert.equal(readFileSync(p, "utf8"), "c");
  assert.equal(statSync(p).mode & 0o777, 0o600);
});
