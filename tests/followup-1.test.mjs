// Bounded watchdog log (append + rotate under a lock, concurrent writers, CLI writes it itself),
// worker.log rotation race, and CLI contract cache controls (TTL limit, package.json identity,
// contract-cache --clear). Spawns are counted through cliContract's `run` hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../lib/executors/index.mjs";
import { binIdentity, cliContract, contractCache, preflight } from "../lib/runner.mjs";
import { openWorkerLog } from "../lib/relay.mjs";
import { normalizeConfig } from "../lib/config.mjs";
import { appendLog, tryLock, unlock } from "../lib/util.mjs";
import { isolatedEnv, tempRepo, testConfig, testContext } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));
const UTIL = new URL("../lib/util.mjs", import.meta.url).href;
const RELAY = new URL("../lib/relay.mjs", import.meta.url).href;
const HELP = "--print --output-format --verbose --resume --session-id --settings --setting-sources --strict-mcp-config --permission-mode --allowedTools --disallowedTools";

const tmp = () => mkdtempSync(join(tmpdir(), "nova-fu1-"));
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);

function counter(version = "2.5.0 (Claude Code)") {
  const calls = [];
  const run = async (bin, args) => { calls.push(args.join(" ")); return { status: 0, stdout: args[0] === "--version" ? version : HELP, stderr: "", aborted: false }; };
  return { calls, run };
}

// N node processes appending M lines each, all started before any of them writes.
function writers(n, m, script) {
  return Promise.all(Array.from({ length: n }, (_, w) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script, String(w), String(m)], { env: isolatedEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => (code === 0 ? res() : rej(new Error(`writer ${w} exit ${code}: ${err}`))));
  })));
}

test("appendLog: rotates over the limit into one .1 generation, keeps both bounded, forces 0600", () => {
  const p = join(tmp(), "run", "watchdog.log");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "old line from a shell >> redirect\n", { mode: 0o644 });
  chmodSync(p, 0o644);
  const max = 200;
  for (let i = 0; i < 100; i++) appendLog(p, `line ${String(i).padStart(3, "0")} ${"x".repeat(20)}`, max);
  assert.equal(statSync(p).mode & 0o777, 0o600, "existing 0644 log tightened to 0600");
  const rec = 30; // one line
  assert.ok(statSync(p).size <= max + rec, `live log bounded (${statSync(p).size})`);
  assert.ok(statSync(`${p}.1`).size <= max + rec, "previous generation bounded");
  assert.deepEqual(readdirSync(join(p, "..")).filter((f) => f.startsWith("watchdog.log")).sort(), ["watchdog.log", "watchdog.log.1"], "one generation, no .2, no stray lock files");
  // The newest lines are all present, in order, across .1 + live.
  const kept = [...lines(`${p}.1`), ...lines(p)];
  assert.equal(kept.at(-1), `line 099 ${"x".repeat(20)}`);
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i] > kept[i - 1], "contiguous, ordered tail");
  // Under the limit nothing rotates and nothing is truncated.
  const q = join(tmp(), "w.log");
  appendLog(q, "a", 1000);
  appendLog(q, "b", 1000);
  assert.deepEqual(lines(q), ["a", "b"]);
  assert.equal(existsSync(`${q}.1`), false);
});

test("appendLog: concurrent writers across one rotation lose no line and tear none", async () => {
  const p = join(tmp(), "watchdog.log");
  const n = 6, m = 150;
  // ~40 bytes per line × 900 lines ≈ 36 KB; a 24 KB limit forces exactly one rotation, so every
  // line must survive in .1 + live (an unlocked double rename would drop the first generation).
  const script = `import { appendLog } from ${JSON.stringify(UTIL)};
    const [w, m] = process.argv.slice(1).map(Number);
    for (let i = 0; i < m; i++) appendLog(${JSON.stringify(p)}, "ERROR w" + w + " i" + String(i).padStart(4, "0") + " " + "e".repeat(20), 24 * 1024);`;
  await writers(n, m, script);
  const all = [...lines(`${p}.1`), ...lines(p)];
  assert.equal(all.length, n * m, "every line present exactly once");
  assert.equal(new Set(all).size, n * m);
  for (const l of all) assert.match(l, /^ERROR w\d i\d{4} e{20}$/, "no torn line");
  for (let w = 0; w < n; w++) {
    const mine = all.filter((l) => l.startsWith(`ERROR w${w} `));
    assert.deepEqual(mine, [...mine].sort(), `writer ${w} lines in order`);
  }
  assert.equal(existsSync(`${p}.lock`), false, "lock released");
});

test("appendLog: many rotations under contention keep both files bounded with whole lines", async () => {
  const p = join(tmp(), "watchdog.log");
  const script = `import { appendLog } from ${JSON.stringify(UTIL)};
    const [w, m] = process.argv.slice(1).map(Number);
    for (let i = 0; i < m; i++) appendLog(${JSON.stringify(p)}, "w" + w + " i" + String(i).padStart(4, "0"), 512);`;
  await writers(4, 200, script);
  for (const f of [p, `${p}.1`]) {
    assert.ok(statSync(f).size <= 512 + 12, `${f} bounded (${statSync(f).size})`);
    for (const l of lines(f)) assert.match(l, /^w\d i\d{4}$/);
  }
  // Only whole older generations are dropped: what is kept of each writer is a contiguous suffix
  // of its lines (no hole from a lost append), and the overall newest lines are kept.
  const all = [...lines(`${p}.1`), ...lines(p)];
  assert.ok(all.length > 0);
  for (let w = 0; w < 4; w++) {
    const idx = all.filter((l) => l.startsWith(`w${w} `)).map((l) => Number(l.slice(-4)));
    idx.forEach((v, k) => assert.equal(v, 200 - idx.length + k, `writer ${w}: contiguous suffix`));
  }
  assert.ok(["w0", "w1", "w2", "w3"].some((w) => all.includes(`${w} i0199`)), "the last writer's last line kept");
});

test("appendLog: a stalled lock holder does not cost a line (append goes ahead, rotation skipped)", () => {
  const p = join(tmp(), "watchdog.log");
  writeFileSync(p, "x".repeat(300));
  const held = tryLock(p); // this live process holds it: never stolen
  assert.ok(held);
  try {
    const t0 = Date.now();
    appendLog(p, "ERROR still written", 100, { timeoutMs: 150 });
    assert.ok(Date.now() - t0 < 5000);
  } finally { unlock(p, held); }
  assert.match(readFileSync(p, "utf8"), /ERROR still written\n$/);
  assert.equal(existsSync(`${p}.1`), false, "no rotation without the lock");
});

test("openWorkerLog: concurrent spawners over the limit rotate once; the old log survives as .1", async () => {
  const home = join(tmp(), "home");
  mkdirSync(join(home, "run"), { recursive: true });
  const p = join(home, "run", "worker.log");
  writeFileSync(p, "OLD-GENERATION\n".repeat(20)); // 300 bytes > 100
  const script = `import { openWorkerLog } from ${JSON.stringify(RELAY)};
    import { writeSync, closeSync } from "node:fs";
    const [w] = process.argv.slice(1).map(Number);
    const fd = openWorkerLog(${JSON.stringify(home)}, 100); writeSync(fd, "spawner " + w + "\\n"); closeSync(fd);`;
  await writers(8, 1, script);
  assert.equal(readFileSync(`${p}.1`, "utf8"), "OLD-GENERATION\n".repeat(20), ".1 is the old log, not replaced by a second rename");
  assert.equal(lines(p).length, 8, "every spawner's line in the new log");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const fd = openWorkerLog(home); // default 5 MB: plain append
  assert.equal(typeof fd, "number");
});

test("CLI watchdog: writes its own 0600 log (default path and --log), silent on a non-TTY stdout, --json prints", () => {
  const root = tmp();
  const home = join(root, "home");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ self: "vps", coordinator: "vps", home, hosts: { vps: { role: "vps" } }, executors: {}, projects: {} }));
  const env = isolatedEnv({ NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env") });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  for (let i = 0; i < 2; i++) {
    const r = cli("watchdog");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "cron/systemd: nothing on stdout (no redirect needed, nothing to mail)");
  }
  const log = join(home, "run", "watchdog.log");
  const recs = lines(log).map((l) => JSON.parse(l));
  assert.equal(recs.length, 2);
  for (const rec of recs) { assert.equal(rec.ok, true); assert.deepEqual(rec.unreachable, []); assert.ok(rec.ts && rec.result.hosts); }
  assert.equal(statSync(log).mode & 0o777, 0o600);
  const j = cli("watchdog", "--json");
  assert.ok(JSON.parse(j.stdout).hosts, "--json prints the result");
  const other = join(root, "elsewhere", "wd.log");
  assert.equal(cli("watchdog", "--log", other).status, 0);
  assert.equal(lines(other).length, 1);
  assert.equal(lines(log).length, 3, "--log PATH does not also write the default log");
});

test("contract cache: limits.contract_cache_ttl_sec is a known limit, positive, per executor; lowering it re-checks", async () => {
  const base = { self: "box", hosts: { box: {} }, executors: { claude: { adapter: "claude", bin: "/x/claude", limits: { contract_cache_ttl_sec: 60 } } } };
  const cfg = normalizeConfig({ ...base, limits: { contract_cache_ttl_sec: 7200 } }, {});
  assert.equal(cfg.limits.contract_cache_ttl_sec, 7200);
  assert.equal(cfg.executors.claude.limits.contract_cache_ttl_sec, 60);
  assert.equal(normalizeConfig({ self: "box" }, {}).limits.contract_cache_ttl_sec, 3600, "default");
  assert.throws(() => normalizeConfig({ ...base, limits: { contract_cache_ttl: 5 } }, {}), /contract_cache_ttl: unknown limit/);
  assert.throws(() => normalizeConfig({ ...base, limits: { contract_cache_ttl_sec: 0 } }, {}), /must be a positive number/);

  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(join(home, "run"), { recursive: true });
  const bin = join(dir, "claude");
  writeFileSync(bin, "\x7fELF native", { mode: 0o755 });
  const c = counter();
  const check = (ttl) => cliContract(home, "claude", { bin, limits: { contract_cache_ttl_sec: ttl } }, ADAPTERS.claude, { env: isolatedEnv(), run: c.run });
  await check(3600);
  c.calls.length = 0;
  await check(3600);
  assert.deepEqual(c.calls, [], "warm within TTL");
  const cp = join(home, "run", "contract-claude.json");
  writeFileSync(cp, JSON.stringify({ ...JSON.parse(readFileSync(cp, "utf8")), at: new Date(Date.now() - 120_000).toISOString() }));
  await check(3600);
  assert.deepEqual(c.calls, [], "2 min old, 1 h TTL: warm");
  await check(60);
  assert.deepEqual(c.calls, ["--version", "--help"], "same entry, TTL lowered to 60 s: re-check");
  c.calls.length = 0;
  writeFileSync(cp, JSON.stringify({ ...JSON.parse(readFileSync(cp, "utf8")), at: new Date(Date.now() + 3600_000).toISOString() }));
  await check(3600);
  assert.deepEqual(c.calls, ["--version", "--help"], "a cache entry from the future (clock change) is not trusted");
});

test("contract cache: a package.json beside the binary or one level up is part of the identity", async () => {
  for (const layout of ["sibling", "parent"]) {
    const dir = tmp();
    const home = join(dir, "home");
    mkdirSync(join(home, "run"), { recursive: true });
    const pkgDir = join(dir, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    const bin = join(pkgDir, "bin", "claude.exe");
    writeFileSync(bin, "\x7fELF native", { mode: 0o755 });
    const pkg = join(layout === "sibling" ? join(pkgDir, "bin") : pkgDir, "package.json");
    writeFileSync(pkg, JSON.stringify({ version: "2.5.0" }));
    assert.equal(binIdentity(bin).pkg.path, pkg);
    const c = counter();
    const check = () => cliContract(home, "claude", { bin }, ADAPTERS.claude, { env: isolatedEnv(), run: c.run });
    await check();
    c.calls.length = 0;
    await check();
    assert.deepEqual(c.calls, [], `${layout}: warm`);
    // In-place package update; the native file itself is byte-for-byte and stat-identical.
    const before = statSync(bin);
    writeFileSync(pkg, JSON.stringify({ version: "2.6.0" }));
    const later = new Date(Date.now() + 5000);
    utimesSync(pkg, later, later);
    assert.equal(statSync(bin).mtimeMs, before.mtimeMs);
    await check();
    assert.deepEqual(c.calls, ["--version", "--help"], `${layout}: package.json change re-checks`);
  }
  const dir = tmp();
  writeFileSync(join(dir, "solo"), "\x7fELF", { mode: 0o755 });
  // No package.json within one level: pkg is null (tmpdir's parent has none either).
  assert.equal(binIdentity(join(dir, "solo")).pkg, null);
});

test("contract-cache --clear deletes only run/contract-*.json; next preflight re-checks; credentials are still checked on a warm cache", async () => {
  const { root, repo } = tempRepo();
  const bin = join(root, "claude-native");
  writeFileSync(bin, "\x7fELF native", { mode: 0o755 });
  const cfg = testConfig(root, repo, { executors: { claude: { adapter: "claude", host: "box", bin, credential_files: [join(root, "no-login.json")] } },
    routing: { rules: [{ type: "code", executor: "claude" }] } });
  const home = cfg.home;
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "worker.lease"), "{}");
  const c = counter();
  await cliContract(home, "claude", cfg.executors.claude, ADAPTERS.claude, { env: isolatedEnv(), run: c.run });
  assert.equal(c.calls.length, 2);

  // Warm, no spawn possible (the "binary" is not executable code) — yet no login → auth, not OK.
  const ctx = testContext(cfg);
  const pf = await preflight(ctx, "claude");
  assert.equal(pf.kind, "auth", "a cached contract is never login proof");

  assert.deepEqual(contractCache(home).map((e) => [e.executor, e.ok]), [["claude", true]]);
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ self: "box", home, hosts: { box: {} }, executors: { claude: { adapter: "claude", bin, credential_files: [bin] } } }));
  const env = isolatedEnv({ NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env") });
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  assert.match(cli("contract-cache").stdout, /^claude OK 2\.5\.0/);
  const r = cli("contract-cache", "--clear");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^cleared claude OK/);
  assert.equal(existsSync(join(home, "run", "contract-claude.json")), false);
  assert.ok(existsSync(join(home, "run", "worker.lease")), "other run/ files untouched");
  assert.match(cli("contract-cache").stdout, /no cached CLI contracts/);
  assert.deepEqual(JSON.parse(cli("contract-cache", "--clear", "--json").stdout), []);
  c.calls.length = 0;
  await cliContract(home, "claude", cfg.executors.claude, ADAPTERS.claude, { env: isolatedEnv(), run: c.run });
  assert.deepEqual(c.calls, ["--version", "--help"], "after --clear: full check");
});

test("spawn counter: 10 warm preflight contract checks — native 0 spawns, #! wrapper 10 × --version", async () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(join(home, "run"), { recursive: true });
  const nat = join(dir, "claude.exe"), wrap = join(dir, "claude");
  writeFileSync(nat, "\x7fELF native", { mode: 0o755 });
  writeFileSync(wrap, "#!/bin/bash\nexec claude.real \"$@\"\n", { mode: 0o755 });
  const count = async (name, bin) => {
    const c = counter();
    await cliContract(home, name, { bin }, ADAPTERS.claude, { env: isolatedEnv(), run: c.run });
    c.calls.length = 0;
    for (let i = 0; i < 10; i++) await cliContract(home, name, { bin }, ADAPTERS.claude, { env: isolatedEnv(), run: c.run });
    return c.calls;
  };
  assert.deepEqual(await count("nat", nat), []);
  assert.deepEqual(await count("wrap", wrap), Array(10).fill("--version"), "wrapper still versions every time");
});
