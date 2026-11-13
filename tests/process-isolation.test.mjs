// process-isolation.test.mjs — opt-in strict process isolation (bubblewrap), lib/isolation.mjs.
// Not nova-guard (a heuristic check); this is OS namespaces + mounts.
//   [simulated]     fixture bwrap binaries / pure profile building — run everywhere
//   [real-runtime]  the real bwrap on this host; skipped (with the probe's reason) where it cannot run
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeConfig } from "../lib/config.mjs";
import { buildSandbox, findBwrap, probeIsolation, unsafeBind, IsolationError } from "../lib/isolation.mjs";
import { dispatch, worker } from "../lib/relay.mjs";
import { runCommandAsync } from "../lib/acceptance.mjs";
import { BRIEF, sh, tempRepo, testConfig, testContext } from "./helpers.mjs";

const LIVE = probeIsolation();
const liveSkip = LIVE.ok ? false : `bwrap unavailable here: ${LIVE.why}`;

// A fixture "bwrap" that records every invocation and fails (probe failure on a host without userns).
function fakeBwrap(dir, exit = 1) {
  const p = join(dir, "bwrap");
  writeFileSync(p, `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(dir, "bwrap-calls"))}\necho "bwrap: No permissions to create new namespace" >&2\nexit ${exit}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function runOne(mode, { isolation, bwrapBin, env = {}, fakeHome } = {}) {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, isolation ? { isolation } : {});
  const ctx = testContext(cfg, { FAKE_MODE: mode, ...(fakeHome ? { HOME: fakeHome } : {}), ...env }, bwrapBin ? { bwrapBin } : {});
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const id = r.tasks[0].id;
  return { ctx, cfg, root, repo, id, t: ctx.store.get(id) };
}

test("[simulated] isolation config: default off; strict defaults to both steps; unknown adapter/step/key and unsafe ro_binds are errors", () => {
  const off = normalizeConfig({}, {});
  assert.equal(off.isolation.mode, "off");
  assert.deepEqual(normalizeConfig({ isolation: { mode: "strict" } }, {}).isolation.apply_to, ["acceptance", "executor"]);
  assert.equal(normalizeConfig({ isolation: { mode: "strict" } }, {}).isolation.acceptance_network, false);
  const bad = (iso) => { try { normalizeConfig({ isolation: iso }, {}); return ""; } catch (e) { return e.message; } };
  assert.match(bad({ mode: "strict", adapter: "docker" }), /isolation\.adapter: unknown adapter "docker"/);
  assert.match(bad({ mode: "sandbox" }), /isolation\.mode/);
  assert.match(bad({ mode: "strict", apply_to: ["network"] }), /isolation\.apply_to/);
  assert.match(bad({ mode: "strict", aply_to: ["acceptance"] }), /isolation\.aply_to: unknown key/);
  assert.match(bad({ mode: "strict", acceptance_network: "yes" }), /acceptance_network/);
  assert.match(bad({ ro_binds: ["/"] }), /root directory/);
  assert.match(bad({ ro_binds: [homedir()] }), /home directory/);
  assert.match(bad({ ro_binds: ["~/.ssh"] }), /credential\/secret path/);
  assert.match(bad({ ro_binds: ["~/.config"] }), /credential\/secret path/, "an ancestor of a secret path is refused too");
  assert.match(bad({ ro_binds: ["relative/dir"] }), /absolute/);
  assert.equal(bad({ ro_binds: ["/opt/toolchain"] }), "", "a narrow toolchain dir is fine");
});

test("[simulated] unsafeBind / buildSandbox refuse broad or secret binds and a cwd outside the workspace", () => {
  const novaHome = mkdtempSync(join(tmpdir(), "nova-iso-home-"));
  assert.match(unsafeBind(novaHome, { novaHome }), /nova-relay home/);
  assert.equal(unsafeBind(join(novaHome, "worktrees", "PD"), { novaHome, internal: true }), null);
  assert.match(unsafeBind(join(novaHome, "tasks"), { novaHome }), /inside the nova-relay home/, "config binds may not reach into the nova home");
  const ws = mkdtempSync(join(tmpdir(), "nova-iso-ws-"));
  const other = mkdtempSync(join(tmpdir(), "nova-iso-other-"));
  const b = (o) => () => buildSandbox({ bin: "/usr/bin/bwrap", cmd: "/usr/bin/true", cwd: ws, rw: [ws], network: false, policy: { novaHome }, ...o });
  assert.throws(b({ rw: [homedir()], cwd: homedir() }), IsolationError);
  assert.throws(b({ ro: ["/"] }), /root directory/);
  assert.throws(b({ cwd: other }), /not inside the writable workspace/);
  assert.throws(b({ cmd: "definitely-not-a-command-xyz" }), /not found/);
  const { args } = b({})();
  assert.ok(args.includes("--die-with-parent") && args.includes("--unshare-user") && args.includes("--unshare-pid") && args.includes("--unshare-net"));
  assert.ok(!args.join(" ").includes(`--bind / /`) && !args.join(" ").includes(`--ro-bind / /`), "never the whole filesystem");
  const i = args.indexOf(homedir());
  assert.equal(args[i - 1], "--tmpfs", "the host home is only ever a private tmpfs");
  assert.ok(!buildSandbox({ bin: "/usr/bin/bwrap", cmd: "/usr/bin/true", cwd: ws, rw: [ws], network: true, policy: { novaHome } }).args.includes("--unshare-net"), "network kept only when asked");
});

test("[simulated] probe failure → strict executor step fails closed: task blocked, executor never ran, one wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-fakebw-"));
  const bw = fakeBwrap(dir);
  const fakeHome = mkdtempSync(join(tmpdir(), "nova-fakehome-"));
  mkdirSync(join(fakeHome, ".claude"));
  const { t, ctx, id } = await runOne("ok", { isolation: { mode: "strict" }, bwrapBin: bw, fakeHome });
  assert.equal(t.state, "blocked");
  assert.match(t.reason, /strict isolation: bwrap could not create the sandbox.*no unsandboxed fallback/);
  assert.ok(t.block_incident, "executor-wide incident");
  assert.ok(!existsSync(join(ctx.store.dir(id), "fake-count")), "the executor was never started unsandboxed");
  assert.equal(t.segments, 0);
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual(Object.keys(ctx.sent[0].body).sort(), ["batch", "exit_code", "id", "source", "state"]);
  assert.equal(ctx.sent[0].body.state, "blocked");
});

test("[simulated] probe failure with apply_to [acceptance]: executor runs, acceptance never runs unsandboxed → blocked, no PASS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-fakebw-"));
  const { t } = await runOne("ok", { isolation: { mode: "strict", apply_to: ["acceptance"] }, bwrapBin: fakeBwrap(dir) });
  assert.equal(t.state, "blocked");
  assert.equal(t.verdict, null);
  assert.match(t.reason, /strict isolation/);
  // runCommandAsync with a wrap that throws never spawns the command.
  const marker = join(dir, "ran");
  const r = await runCommandAsync(`touch ${marker}`, dir, 10, process.env, { clean: true, wrap: () => { throw new IsolationError("no bwrap"); } });
  assert.equal(r.ok, false);
  assert.match(r.isolation, /no bwrap/);
  assert.ok(!existsSync(marker));
});

test("[simulated] mode off does not wrap: bwrap is never invoked, behaviour unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-fakebw-"));
  const bw = fakeBwrap(dir, 0);
  const { t, ctx, id } = await runOne("ok", { bwrapBin: bw });
  assert.equal(t.state, "done");
  assert.equal(t.verdict, "PASS");
  assert.ok(!existsSync(join(dir, "bwrap-calls")), "no bwrap call at all in mode off");
  assert.ok(existsSync(join(ctx.store.dir(id), "fake-count")), "executor ran directly");
});

test("[simulated] strict executor with an adapter that has no profile (codex) fails closed", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { isolation: { mode: "strict", apply_to: ["executor"] } });
  const { executorIsolationProblem } = await import("../lib/isolation.mjs");
  const { ADAPTERS } = await import("../lib/executors/index.mjs");
  const ctx = testContext(cfg);
  const why = executorIsolationProblem(ctx, ADAPTERS.codex);
  assert.match(why, LIVE.ok ? /no strict isolation profile/ : /strict isolation/);
});

test("[real-runtime] LIVE bwrap: workspace write lands on the host; host home and a canary secret are invisible and unwritable; the wrapped command runs in its own pid namespace", { skip: liveSkip }, () => {
  const ws = mkdtempSync(join(tmpdir(), "nova-live-ws-"));
  const canaryDir = mkdtempSync(join(tmpdir(), "nova-live-canary-"));
  writeFileSync(join(canaryDir, "secret.env"), "CANARY_TOKEN=do-not-leak\n", { mode: 0o600 });
  const probeName = `nova-live-probe-${process.pid}`;
  const script = [
    "set -u",
    "echo inside > out.txt && echo WS_WRITE_OK",
    `cat ${join(canaryDir, "secret.env")} 2>/dev/null && echo CANARY_VISIBLE || echo CANARY_HIDDEN`,
    `touch ${join(canaryDir, "pwned")} 2>/dev/null && echo CANARY_WRITABLE_IN_SANDBOX || echo CANARY_UNWRITABLE`,
    `ls -A ${homedir()} | grep -v '^tools$' | head -5 | tr '\\n' ' '; echo HOME_LISTED`,
    `test -e ${join(homedir(), ".claude")} && echo CLAUDE_VISIBLE || echo CLAUDE_HIDDEN`,
    `test -e ${join(homedir(), ".ssh")} && echo SSH_VISIBLE || echo SSH_HIDDEN`,
    `echo x > ${join(homedir(), probeName)} && echo HOME_TMPFS_WRITE`,
    "echo PID=$$ HOST=$(hostname) EXE=$(readlink /proc/$$/exe)",
  ].join("\n");
  writeFileSync(join(ws, "probe.sh"), script);
  const sb = buildSandbox({ bin: LIVE.bin, cmd: "bash", args: ["--noprofile", "--norc", join(ws, "probe.sh")], cwd: ws, env: { PATH: "/usr/bin:/bin" }, rw: [ws], network: false, policy: {} });
  assert.match(sb.cmd, /bwrap$/, "the spawned process is bwrap wrapping the command");
  const r = spawnSync(sb.cmd, sb.args, { cwd: ws, env: sb.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const o = r.stdout;
  assert.match(o, /WS_WRITE_OK/);
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "inside\n", "workspace write appears on the host");
  assert.match(o, /CANARY_HIDDEN/);
  assert.match(o, /CANARY_UNWRITABLE|CANARY_WRITABLE_IN_SANDBOX/);
  assert.ok(!existsSync(join(canaryDir, "pwned")), "the host canary dir was not written");
  assert.match(o, /CLAUDE_HIDDEN/);
  assert.match(o, /SSH_HIDDEN/);
  assert.match(o, /^\s*HOME_LISTED/m, "host home looks empty inside");
  assert.ok(!existsSync(join(homedir(), probeName)), "writes to $HOME stayed in the private tmpfs, not on the host");
  const m = o.match(/PID=(\d+) HOST=(\S+) EXE=(\S+)/);
  assert.ok(m && Number(m[1]) < 10, `own pid namespace (pid ${m?.[1]})`);
  assert.equal(m[2], "nova-sandbox");
  assert.match(m[3], /bash$/, "the wrapped command is what runs");
});

test("[real-runtime] LIVE bwrap end-to-end: strict executor + acceptance → PASS; hook-calls reach the host, other task-dir writes do not", { skip: liveSkip }, async () => {
  // A throwaway HOME with a dummy .claude: the real ~/.claude is never bound by the test suite.
  const fakeHome = mkdtempSync(join(tmpdir(), "nova-fakehome-"));
  mkdirSync(join(fakeHome, ".claude"));
  const saved = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const { t, ctx, id, repo } = await runOne("hooked", { isolation: { mode: "strict" }, fakeHome });
    assert.equal(t.state, "done", t.reason);
    assert.equal(t.verdict, "PASS");
    assert.equal(sh(repo, `git show nova/${id}:src/hello.txt`), "hello");
    assert.ok(readFileSync(join(ctx.store.dir(id), "hook-calls"), "utf8").length > 0, "the narrowly bound hook-calls file was written through");
    assert.ok(!existsSync(join(ctx.store.dir(id), "fake-args.jsonl")), "writes elsewhere in the task dir stayed inside the sandbox");
    const args = JSON.parse(readFileSync(join(ctx.store.dir(id), "..", "..", "run", "budget-" + new Date().toISOString().slice(0, 10) + ".json"), "utf8")).claude;
    assert.equal(args.segments, 1);
  } finally { process.env.HOME = saved; }
});

test("[real-runtime] LIVE bwrap: a setsid'd background process does not outlive the sandbox (pid namespace)", { skip: liveSkip }, () => {
  const ws = mkdtempSync(join(tmpdir(), "nova-live-bg-"));
  const secs = 4000 + (process.pid % 900);
  const sb = buildSandbox({ bin: LIVE.bin, cmd: "bash", args: ["-c", `setsid nohup sleep ${secs} >/dev/null 2>&1 & disown; echo started`], cwd: ws, env: { PATH: "/usr/bin:/bin" }, rw: [ws], network: false, policy: {} });
  assert.match(spawnSync(sb.cmd, sb.args, { env: sb.env, encoding: "utf8", timeout: 30_000 }).stdout, /started/);
  const survivors = spawnSync("ps", ["-eo", "comm=,args="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("sleep") && l.includes(`sleep ${secs}`));
  assert.deepEqual(survivors, [], "background process ended with the sandbox");
});

test("[real-runtime] bwrap discovery reports the binary or the reason", () => {
  const b = findBwrap();
  if (b) assert.ok(existsSync(b)); else assert.equal(LIVE.ok, false);
});
