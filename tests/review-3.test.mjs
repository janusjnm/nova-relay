// review-3.test.mjs — third review: guard directory changes (git -C / --git-dir / --work-tree,
// make -C, npm --prefix, env -C, cd + scripts), option-taking wrappers, env-var injection;
// explicit model ids (no defaults, fail closed); acceptance in a clean checkout with a clean env
// and fatal tamper checks; watchdog detection vs notification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "../lib/guard.mjs";
import { ConfigError, normalizeConfig } from "../lib/config.mjs";
import { ADAPTERS, classifyFailure } from "../lib/executors/index.mjs";
import { deepseekKeyCheck } from "../lib/executors/deepseek-check.mjs";
import { accept } from "../lib/acceptance.mjs";
import { parseBrief } from "../lib/brief.mjs";
import { acceptanceEnv, runProcess } from "../lib/runner.mjs";
import { integritySnapshot } from "../lib/git.mjs";
import { HANDLERS, dispatch, hostStatusPath, watchdog, worker } from "../lib/relay.mjs";
import { RpcError } from "../lib/rpc.mjs";
import { BRIEF, sh, tempRepo, testConfig, testContext } from "./helpers.mjs";

// ------------------------------------------------------------------ guard

function workdir(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "nova-g3-"));
  const wd = join(root, "wd");
  mkdirSync(join(wd, "sub"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(wd, p, ".."), { recursive: true });
    writeFileSync(join(wd, p), text);
  }
  return wd;
}
// extraWritable: [] — the temp workdir lives under /tmp, so /tmp must not count as writable here.
const chk = (cmd, wd) => checkCommand(cmd, {}, { workdir: wd, forbidden: [".git/**"], extraWritable: [] });
const blocked = (wd, cmds) => { for (const c of cmds) assert.ok(chk(c, wd), `blocked: ${c}`); };
const allowed = (wd, cmds) => { for (const c of cmds) assert.equal(chk(c, wd), null, `allowed: ${c}`); };

test("guard: git -C / --git-dir / --work-tree outside the workdir are blocked (all forms, chained, cumulative)", () => {
  const wd = workdir();
  blocked(wd, [
    "git -C .. reset --hard", "git -C ../other checkout -- .", "git -C/etc status", "git -C ../other clean -fdx",
    "git -C sub -C ../.. clean -fdx", "git -C \"$TARGET\" status", "git -C $(pwd)/.. status",
    "git --git-dir=../other/.git log", "git --git-dir ../other/.git --work-tree ../other checkout .", "git --work-tree=/ checkout -- etc",
    "cd sub && git -C ../.. reset --hard", "npm test && git -C .. commit -am x", "git --exec-path=/tmp/e status", "git --frobnicate status",
    "git diff --output=/etc/x", "git format-patch -o ../other HEAD~1", "git worktree add ../../x", "git clone https://github.com/a/b ../other/b",
    "GIT_DIR=../other/.git git reset --hard", "GIT_WORK_TREE=/ git checkout .", "env GIT_DIR=/x/.git git log",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!rm -rf ~' git x", "export GIT_CONFIG_PARAMETERS=\"'core.hookspath=/tmp'\"",
  ]);
  assert.equal(chk("git -C .. status", wd).category, "path");
  assert.match(chk("git -C \"$TARGET\" status", wd).reason, /cannot be verified/);
  allowed(wd, ["git -C sub status", "git -C . log --oneline", "cd sub && git -C .. status", "git status", "git diff --stat", "GIT_AUTHOR_NAME=x git commit -m y",
    "git --no-pager log", "git -c color.ui=never diff", "git worktree list"]);
});

test("guard: protected branches cannot be moved locally (update-ref, branch -f, fetch into, checkout -B)", () => {
  const wd = workdir();
  blocked(wd, ["git update-ref refs/heads/main HEAD", "git branch -f main HEAD", "git branch -D master", "git fetch . HEAD:main",
    "git checkout -B main", "git switch -C release/1", "git checkout --ignore-other-worktrees main", "git symbolic-ref HEAD refs/heads/main"]);
  allowed(wd, ["git branch -f scratch HEAD", "git branch", "git fetch origin", "git checkout -b feature"]);
});

test("guard: make -C / --directory / -f follow the directory; recipes and includes are scanned there", () => {
  const wd = workdir({
    "Makefile": "all:\n\techo ok\n",
    "sub/Makefile": "all:\n\trm -rf ~\n",
    "ok/Makefile": "include rules.mk\nall:\n\techo ok > out.txt\n",
    "ok/rules.mk": "x:\n\tgit push origin main\n",
    "nest/Makefile": "all:\n\t$(MAKE) -C ../.. clean\n",
    "rel/Makefile": "all:\n\techo x > ../../escape.txt\n",
  });
  blocked(wd, ["make -C sub", "make -Csub", "make --directory=sub", "make --directory sub", "cd sub && make", "make -C ../other", "make -C $DIR",
    "make -C ok", "make -C nest", "make -C rel", "make -f -", "env -C sub make", "nice -n 5 make -C sub"]);
  assert.match(chk("make -C ok", wd).reason, /push/);
  assert.match(chk("make -C rel", wd).reason, /outside the task workdir/);
  allowed(wd, ["make", "make -C .", "make all"]);
});

test("guard: scripts and package.json are read from the current directory (cd, --prefix, -C, --cwd); .npmrc script-shell", () => {
  const wd = workdir({
    "x.sh": "#!/bin/sh\necho ok\n",
    "sub/x.sh": "#!/bin/sh\ngit push origin main\n",
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "sub/package.json": JSON.stringify({ scripts: { test: "rm -rf ~" } }),
    "rc/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "rc/.npmrc": "script-shell=./evil.sh\n",
  });
  blocked(wd, ["cd sub && bash x.sh", "cd sub && ./x.sh", "cd sub && npm test", "npm --prefix sub test", "npm -C sub test", "pnpm -C sub test",
    "yarn --cwd sub test", "npm --prefix ../other test", "cd rc && npm test", "cd $X && bash x.sh"]);
  allowed(wd, ["bash x.sh", "npm test", "cd sub && cd .. && npm test"]);
});

test("guard: option-taking wrappers do not hide the command (env -i, nice -n, timeout, time -p, xargs, sudo, eval, env -S/-C)", () => {
  const wd = workdir();
  blocked(wd, ["env -i rm -rf ~", "nice -n 10 rm -rf ~", "timeout 5 git push origin main", "timeout -s KILL 5 git push origin main", "time -p git push origin main",
    "stdbuf -oL git push origin main", "sudo -u root rm -rf /", "sudo ls", "xargs rm -rf < list", "find . -name x | xargs -0 rm",
    "eval 'git push origin main'", "env -S 'git push origin main'", "env -C / rm -rf home", "env -C .. touch x", "env -u HOME", "nohup nice git push origin main &",
    "time -o /etc/x ls", "flock /etc/lock true"]);
  assert.equal(chk("sudo rm -rf /", wd).category, "disaster", "the wrapped command's category wins");
  allowed(wd, ["timeout 600 npm test", "nice npm test", "env NODE_ENV=test node --test", "time npm test", "xargs -0 grep foo < list", "command -v git", "nohup npm test"]);
});

test("guard: environment assignments that inject code or redirect git are blocked; benign ones pass", () => {
  const wd = workdir();
  blocked(wd, ["PATH=./bin:$PATH make", "export PATH=$PWD/node_modules/.bin:$PATH", "PATH=/tmp/x:$PATH ls", "LD_PRELOAD=./x.so ls", "BASH_ENV=./x.sh bash -c true",
    "NODE_OPTIONS='--require ./x.js' npm test", "HOME=/tmp/h git status", "npm_config_script_shell=./x.sh npm test", "declare -x GIT_DIR=/x"]);
  allowed(wd, ["PATH=/usr/local/bin:$PATH make", "FOO=1 npm test", "export NODE_ENV=test", "CI=1 npm test"]);
});

test("guard: archive extraction, find -exec and download outputs outside the workdir are blocked", () => {
  const wd = workdir();
  blocked(wd, ["tar -xf a.tar -C ~", "tar xzf a.tgz --directory=/etc", "tar -czf /etc/x.tgz src", "unzip a.zip -d /etc", "find / -exec rm -rf {} +",
    "find .. -name '*.js' -delete", "find . -exec git push origin main \\;", "find . -fprint /etc/list", "wget -O /etc/x https://example.com/x",
    "rsync -a src/ ../other/"]);
  allowed(wd, ["tar -xzf a.tgz -C sub", "tar czf out.tgz src", "find . -name '*.pyc' -delete", "find . -name '*.ts' -exec grep -l foo {} +", "unzip a.zip -d sub"]);
});

// ------------------------------------------------------------------ model ids

test("models: pi and deepseek-text need an explicit, valid model id — no default, placeholder rejected", () => {
  const cfg = (ex) => normalizeConfig({ self: "box", hosts: { box: {} }, executors: { x: ex } }, {});
  for (const adapter of ["pi", "deepseek-text"]) {
    assert.throws(() => cfg({ adapter }), (e) => e instanceof ConfigError && /executors\.x: model: required/.test(e.message), `${adapter} without model`);
    assert.throws(() => cfg({ adapter, model: "<DEEPSEEK_MODEL_ID>" }), /placeholder/);
    assert.throws(() => cfg({ adapter, model: "deepseek *" }), /not a valid model id/);
    assert.equal(ADAPTERS[adapter].defaults.model, undefined, "no built-in default");
    assert.ok(cfg({ adapter, model: "some-model" }));
  }
  assert.throws(() => cfg({ adapter: "pi", model: "m:high" }), /thinking-level/);
  assert.throws(() => cfg({ adapter: "pi", model: "m", args: ["--model", "other"] }), /model\/provider overrides/);
  assert.throws(() => ADAPTERS.pi.buildCommand({ ex: {}, prompt: "P" }), /model: required/);
  // The example config ships a placeholder, so an unedited copy fails config-check instead of guessing.
  const example = JSON.parse(readFileSync(new URL("../config/nova-relay.example.json", import.meta.url), "utf8"));
  assert.equal(example.executors.pi.model, "<DEEPSEEK_MODEL_ID>");
  assert.equal(example.executors["deepseek-text"].model, "<DEEPSEEK_MODEL_ID>");
});

test("models: doctor --live fails closed when /models is unreadable or lacks the id; nothing substituted", async () => {
  const mk = (models) => async (url) => (url.endsWith("/models")
    ? (models ? { ok: true, status: 200, text: async () => JSON.stringify({ data: models.map((id) => ({ id })) }) } : { ok: false, status: 503, text: async () => "" })
    : { ok: true, status: 200, text: async () => JSON.stringify({ is_available: true }) });
  assert.equal((await deepseekKeyCheck({ key: "k", model: "a", fetchImpl: mk(["a", "b"]) })).ok, true);
  const miss = await deepseekKeyCheck({ key: "k", model: "c", fetchImpl: mk(["a", "b"]) });
  assert.equal(miss.ok, false);
  assert.match(miss.detail, /not offered.*nothing is substituted/);
  const down = await deepseekKeyCheck({ key: "k", model: "a", fetchImpl: mk(null) });
  assert.equal(down.ok, false);
  assert.match(down.detail, /not verified/);
  assert.match((await deepseekKeyCheck({ key: "k", model: undefined, fetchImpl: mk(["a"]) })).detail, /required/);
});

test("models: the configured id is sent verbatim; a provider 'model does not exist' blocks the task (no retry loop, no fallback id)", async () => {
  assert.equal(classifyFailure('HTTP 400 {"error":{"message":"Model Not Exist","type":"invalid_request_error"}}').kind, "model");
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("deepseek")) { bodies.push(JSON.parse(init.body)); return { ok: false, status: 400, text: async () => '{"error":{"message":"Model Not Exist"}}' }; }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const ctx = testContext(cfg, { DEEPSEEK_API_KEY: "test-key-123456" }, { fetchImpl });
  const r = await dispatch(ctx, { project: "PD", briefs: [{ name: "t.md", text: "---\ntype: text\n---\n# Goal\nTranslate hello\n" }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(r.tasks[0].id);
  assert.equal(t.state, "blocked");
  assert.match(t.reason, /rejected model "test-model"/);
  assert.deepEqual(bodies.map((b) => b.model), ["test-model"], "one call, exactly the configured id");
});

// ------------------------------------------------------------------ acceptance

const git = (cwd, cmd) => sh(cwd, `git -c user.name=t -c user.email=t@t ${cmd}`);

// A repo + task worktree on nova/t-1 with `files` committed on the branch.
function taskTree(baseFiles = {}, files = {}) {
  const { root, repo } = tempRepo();
  for (const [p, s] of Object.entries(baseFiles)) { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), s); }
  if (Object.keys(baseFiles).length) git(repo, "add -A && git -c user.name=t -c user.email=t@t commit -qm base");
  const base = sh(repo, "git rev-parse HEAD");
  const wt = join(root, "wt", "t-1");
  git(repo, `worktree add -q -b nova/t-1 ${wt} ${base}`);
  for (const [p, s] of Object.entries(files)) { mkdirSync(join(wt, p, ".."), { recursive: true }); writeFileSync(join(wt, p), s); }
  if (Object.keys(files).length) git(wt, "add -A && git -c user.name=t -c user.email=t@t commit -qm work");
  return { root, repo, wt, base, integrity: integritySnapshot(repo) };
}
const briefOf = (acc, extra = "", scope = "- **") => parseBrief(`---\ntype: code\n${extra}---\n# Goal\ng\n# Scope\n${scope}\n# Acceptance\n${acc}\n`);
const run = (tt, brief, more = {}) => accept({ workdir: tt.wt, base: tt.base, brief, repo: tt.repo, integrity: tt.integrity, branch: "nova/t-1", ...more });

test("acceptance runs in a clean checkout of the commit: ignored/untracked files planted by the executor do not count", async () => {
  const tt = taskTree({ ".gitignore": ".cache/\n" }, { "src/a.txt": "a\n" });
  mkdirSync(join(tt.wt, ".cache"));
  writeFileSync(join(tt.wt, ".cache", "verified"), "PASS\n"); // ignored: never committed
  const r = await run(tt, briefOf("test -f .cache/verified"));
  assert.equal(r.pass, false, "the planted ignored file is not in the checkout");
  assert.match(r.line, /^FAIL cmd:test -f \.cache\/verified/);
  assert.equal((await run(tt, briefOf("test -f src/a.txt"))).pass, true);
  assert.equal(existsSync(join(tt.root, "wt", ".accept-t-1")), false, "scratch checkout removed");
  // Uncommitted leftovers are not part of the work.
  writeFileSync(join(tt.wt, "src", "late.txt"), "x");
  assert.match((await run(tt, briefOf("true"))).line, /^FAIL uncommitted/);
});

test("acceptance env: allowlist only (no host secrets, no executor-set vars), empty HOME, no shell startup files", async () => {
  const ctx = { env: { PATH: "/usr/bin:/bin", HOME: "/home/real", OPENAI_API_KEY: "x", MY_TOKEN: "x", RANDOM_VAR: "1", BASH_ENV: "/tmp/evil", GOCACHE: "/c", LANG: "C.UTF-8" } };
  const env = acceptanceEnv(ctx, { PROJ: "1" }, { acceptance_env_pass: ["GOCACHE"] });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "GIT_TERMINAL_PROMPT", "GOCACHE", "LANG", "PATH", "PROJ"]);
  assert.throws(() => normalizeConfig({ self: "box", hosts: { box: {} }, projects: { P: { repo: "/r", acceptance_env_pass: ["GH_TOKEN"] } } }, {}), /looks like a secret/);
  const tt = taskTree({}, { "src/a.txt": "a\n" });
  const r = await run(tt, briefOf('case "$HOME" in /home/real|"") exit 1;; esac; test ! -e "$HOME/.ssh" && test -z "$RANDOM_VAR" && test -z "$BASH_ENV"'), { env });
  assert.equal(r.pass, true, r.detail);
});

test("acceptance tamper checks are fatal (not retried): harness, referenced script, package scripts, removed tests, symlinks, HEAD, history", async () => {
  const base = { "check.sh": "#!/bin/sh\ntest -f src/a.txt\n", "package.json": JSON.stringify({ scripts: { test: "node --test" }, dependencies: {} }, null, 2),
    "tests/a.test.js": "test('one', () => {});\ntest('two', () => {});\n", "Makefile": "check:\n\ttrue\n" };
  const cases = [
    [{ "check.sh": "#!/bin/sh\nexit 0\n" }, /^FAIL harness:check\.sh/],
    [{ "Makefile": "check:\n\texit 0\n" }, /^FAIL harness:Makefile/],
    [{ "jest.config.js": "module.exports = { testPathIgnorePatterns: ['.'] };\n" }, /^FAIL harness:jest\.config\.js/],
    [{ "package.json": JSON.stringify({ scripts: { test: "node --test", pretest: "exit 0" }, dependencies: {} }, null, 2) }, /^FAIL harness:package\.json/],
    [{ "tests/a.test.js": "test('one', () => {});\n" }, /^FAIL tests-removed:tests\/a\.test\.js/],
    [{ "tests/a.test.js": "test('one', () => {});\ntest.skip('two', () => {});\n" }, /^FAIL tests-skipped/],
  ];
  for (const [files, re] of cases) {
    const tt = taskTree(base, { "src/a.txt": "a\n", ...files });
    const r = await run(tt, briefOf("sh check.sh"));
    assert.match(r.line, re);
    assert.equal(r.fatal, true, `${r.line} is fatal`);
  }
  // Dependencies may change; scripts may not.
  const deps = taskTree(base, { "src/a.txt": "a\n", "package.json": JSON.stringify({ scripts: { test: "node --test" }, dependencies: { x: "1" } }, null, 2) });
  assert.equal((await run(deps, briefOf("sh check.sh"))).pass, true);
  // The brief can allow harness work explicitly.
  const ok = taskTree(base, { "src/a.txt": "a\n", "Makefile": "check:\n\techo new\n" });
  assert.equal((await run(ok, briefOf("sh check.sh", "allow_harness_changes: true\n"))).pass, true);
  // A test file replaced by a symlink.
  const ln = taskTree(base, { "src/a.txt": "a\n", "src/empty.js": "" });
  sh(ln.wt, "rm tests/a.test.js && ln -s ../src/empty.js tests/a.test.js");
  git(ln.wt, "add -A && git -c user.name=t -c user.email=t@t commit -qm ln");
  assert.match((await run(ln, briefOf("true"))).line, /^FAIL (symlink-harness|tests-removed):tests\/a\.test\.js/);
  // HEAD moved off the task branch / history rewritten.
  const hd = taskTree(base, { "src/a.txt": "a\n" });
  git(hd.wt, "checkout -q -b elsewhere");
  assert.match((await run(hd, briefOf("true"))).line, /^FAIL integrity:head/);
  const hist = taskTree(base, { "src/a.txt": "a\n" });
  git(hist.wt, "checkout -q --orphan tmp && git -c user.name=t -c user.email=t@t commit -qm orphan && git branch -f nova/t-1 HEAD && git checkout -q nova/t-1");
  const h = await run(hist, briefOf("true"));
  assert.match(h.line, /^FAIL integrity:history/);
  assert.equal(h.fatal, true);
});

test("acceptance: .git/info changes are integrity failures too", async () => {
  const tt = taskTree({}, { "src/a.txt": "a\n" });
  mkdirSync(join(tt.repo, ".git", "info"), { recursive: true });
  writeFileSync(join(tt.repo, ".git", "info", "attributes"), "* filter=evil\n");
  const r = await run(tt, briefOf("true"));
  assert.match(r.line, /^FAIL integrity:\.git\/info/);
  assert.equal(r.fatal, true);
});

test("runner: tampering with the acceptance script is not retried away (failed, escalated, 0 local retries)", async () => {
  const { root, repo } = tempRepo();
  writeFileSync(join(repo, "check.sh"), "#!/bin/sh\ngrep -qx hello src/hello.txt\n");
  git(repo, "add -A && git -c user.name=t -c user.email=t@t commit -qm check");
  const ctx = testContext(testConfig(root, repo), { FAKE_MODE: "tamper-check" });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF().replace("- src/**", "- src/**\n- check.sh").replace("grep -qx hello src/hello.txt", "sh check.sh") }] });
  await worker(ctx, { once: true });
  const t = ctx.store.get(r.tasks[0].id);
  assert.equal(t.state, "failed");
  assert.match(t.verdict, /^FAIL harness:check\.sh/);
  assert.equal(t.local_retries, 0);
  assert.equal(t.escalated, true);
  assert.match(t.reason, /tampering detected/);
});

test("runner: the executor's leftover background jobs are killed when the segment ends", async () => {
  const d = mkdtempSync(join(tmpdir(), "nova-bg-"));
  const f = join(d, "late.txt");
  await runProcess({ cmd: "bash", args: ["-c", `(sleep 1; echo x > ${f}) >/dev/null 2>&1 & echo started`], cwd: d, env: process.env,
    logPath: join(d, "log"), wallMs: 30_000, idleMs: 30_000 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(existsSync(f), false, "background writer did not survive the segment");
});

// ------------------------------------------------------------------ sleep / wake

test("watchdog: an unreachable box is detected and recorded, never 'woken'; resume happens once it is reachable again", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { self: "vps", coordinator: "vps", hosts: { vps: { role: "vps" }, box: { role: "box", ssh: "box" } },
    executors: { claude: { adapter: "claude", host: "box" } }, routing: { rules: [{ type: "code", executor: "claude" }] } });
  let up = false;
  const calls = [];
  const sshCall = async (_cfg, host, method) => {
    calls.push(`${host}:${method}`);
    if (!up) throw new RpcError(`ssh ${host} unreachable: exit 255`, { network: true });
    return { resumed: ["t-1"], frozen: [], running: [] };
  };
  const ctx = testContext(cfg, {}, { sshCall });
  const down = await watchdog(ctx, () => Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(down.hosts.box.reachable, false);
  assert.match(down.hosts.box.action, /ssh cannot wake a sleeping host/);
  assert.equal(down.hosts.box.unreachable_since, "2026-01-01T00:00:00.000Z");
  const again = await watchdog(ctx, () => Date.parse("2026-01-01T00:05:00Z"));
  assert.equal(again.hosts.box.unreachable_since, "2026-01-01T00:00:00.000Z", "outage start is kept");
  up = true;
  const back = await watchdog(ctx, () => Date.parse("2026-01-01T01:00:00Z"));
  assert.equal(back.hosts.box.reachable, true);
  assert.deepEqual(back.hosts.box.resume.resumed, ["t-1"]);
  assert.equal(back.hosts.box.back_after_outage_since, "2026-01-01T00:00:00.000Z");
  assert.equal(JSON.parse(readFileSync(hostStatusPath(ctx, "box"), "utf8")).unreachable_since, null);
  assert.ok(calls.every((c) => c === "box:resume-all"), "only resume-all is ever asked; nothing tries to wake the host");
  assert.equal(ctx.sent.length, 0, "the watchdog itself sends no webhook; the heartbeat check notifies");
});

test("heartbeat notification payload says unreachable (a notification, not a wake of the machine)", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { self: "vps", coordinator: "vps", hosts: { vps: { role: "vps" }, box: { role: "box", ssh: "box" } } });
  const ctx = testContext(cfg);
  await HANDLERS["batch-register"](ctx, { batch: { id: "b-9", project: "PD", owner: "g", tasks: { a: { host: "box", state: "running" } } } });
  const { checkHeartbeats } = await import("../lib/relay.mjs");
  assert.equal(checkHeartbeats(ctx, Date.now() + 60 * 60_000).length, 1);
  assert.equal(ctx.outbox.pending()[0].payload.state, "box_unreachable");
});

test("Claude hook: the Bash tool's persisted cwd (hook input `cwd`) is where relative targets resolve", async () => {
  const { spawnSync } = await import("node:child_process");
  const { HOOK, isolatedEnv } = await import("./helpers.mjs");
  const wd = workdir({ "sub/keep.txt": "x" });
  const hook = (command, cwd) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), encoding: "utf8",
    env: isolatedEnv({ NOVA_WORKDIR: wd, NOVA_TASK_DIR: "", NOVA_GUARD_POLICY: "{}", NOVA_FORBIDDEN: "[]" }) }).status;
  assert.equal(hook("rm -rf other", wd), 0);
  assert.equal(hook("rm -rf other", join(wd, "sub")), 0);
  assert.equal(hook("touch etc/x", "/"), 2, "shell is at / after an earlier cd: relative write lands in /etc");
  assert.equal(hook("touch etc/x", wd), 0);
  assert.equal(checkCommand("rm -rf other", {}, { workdir: wd, extraWritable: [], cwd: join(wd, "..") })?.category, "path", "a cd .. from an earlier call is honoured");
  assert.equal(checkCommand("rm -rf other", {}, { workdir: wd, extraWritable: [], cwd: join(wd, "sub") }), null);
});

test("example config: fails only on the model placeholders; valid once they are filled in", () => {
  const raw = JSON.parse(readFileSync(new URL("../config/nova-relay.example.json", import.meta.url), "utf8"));
  assert.throws(() => normalizeConfig(structuredClone(raw), {}), (e) => e.problems.length === 2 && e.problems.every((p) => /placeholder/.test(p)));
  raw.executors.pi.model = "m1";
  raw.executors["deepseek-text"].model = "m1";
  assert.ok(normalizeConfig(raw, {}));
});
