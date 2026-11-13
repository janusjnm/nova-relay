// acceptance.mjs — the only source of truth for "done". The executor's self-report is ignored.
// Prints/returns exactly one line: "PASS" or "FAIL <where>".
//
// Independence: the verdict is about the task branch's *commit*, checked out fresh (detached, no
// hooks) in a standalone clone next to the executor's worktree — untracked/ignored files the
// executor left behind (a planted node_modules/.bin/jest, a fake build output) do not exist there,
// and git commands run there cannot reach the shared repo. Commands run with
// `bash --noprofile --norc`, an allowlisted environment (no host secrets), an empty HOME, a
// private TMPDIR and a PATH without relative or repo/worktree entries. They run asynchronously so
// the worker keeps renewing its lease (a long `npm ci` + test run is not mistaken for a hang).
// Tampering (shared .git changed, HEAD moved off the task branch, tests removed/skipped, test
// harness or package scripts changed, planted symlinks; branches or shared .git changed *while*
// the acceptance commands ran) is fatal: escalated, never retried. A failing `acceptance_setup`
// (registry/network down, broken lockfile) is reported as `FAIL setup:…` and is not handed back to
// the executor as a test failure.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { changedFiles, diffStat, diffText, git, integrityChanges, scratchCheckout, showFile, symlinksInDiff } from "./git.mjs";
import { splitCommands, tokenizeShell } from "./guard.mjs";
import { matchesAny, redact } from "./util.mjs";

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs)$/;
export const SKIP_MARKERS = /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|pytest\.skip\(|\bt\.Skip(?:Now)?\(|@(?:Disabled|Ignore)\b|\{\s*skip\s*:\s*true|#\[ignore\]/;
// One test case / suite definition per line (JS/TS, Python, Go, Rust, JUnit).
export const TEST_DEF = /^\s*(?:it|test|describe|context|specify)(?:\.each\b[^(]*)?\s*\(|^\s*(?:async\s+)?def\s+test_\w*|^\s*func\s+Test\w*\s*\(|^\s*#\[(?:tokio::)?test\]|@Test\b/;
// Files that decide what "the tests pass" means. Changing them is tampering unless the brief
// says `allow_harness_changes: true` (projects add more with `harness_paths`).
export const HARNESS_FILE = new RegExp([
  "(^|/)(GNUmakefile|[Mm]akefile|[^/]+\\.mk|[Jj]ustfile|Taskfile\\.ya?ml)$",
  "(^|/)(\\.npmrc|\\.yarnrc(\\.ya?ml)?|\\.pnpmfile\\.c?js|bunfig\\.toml)$",
  "(^|/)(jest|vitest|vite|playwright|cypress|ava|karma)\\.(config|conf)\\.[cm]?[jt]s(on)?$|(^|/)vitest\\.workspace\\.[cm]?[jt]s(on)?$|(^|/)jest\\.config\\.json$",
  "(^|/)(\\.mocharc[^/]*|\\.c8rc[^/]*|\\.nycrc[^/]*|tsconfig[^/]*\\.json|\\.eslintrc[^/]*|eslint\\.config\\.[cm]?[jt]s|biome\\.jsonc?)$",
  "(^|/)(pytest\\.ini|conftest\\.py|tox\\.ini|noxfile\\.py|\\.coveragerc|mypy\\.ini|\\.?ruff\\.toml)$",
].join("|"));
// pyproject.toml / setup.cfg are harness only where the changed lines configure test tools.
const HARNESS_LINES = /pytest|addopts|testpaths|python_files|python_functions|norecursedirs|\[tool\.(coverage|tox|nox|mypy|ruff)/;

function lastLine(s) {
  const lines = String(s).split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.pop() || "").slice(0, 160);
}

// clean=true (acceptance): no profile/rc files, so nothing from the host's or the executor's
// shell startup files runs. Preflight commands keep the login shell (PATH from the profile).
export function runCommand(cmd, cwd, timeoutSec = 600, env = process.env, { clean = false } = {}) {
  const r = spawnSync("bash", clean ? ["--noprofile", "--norc", "-c", cmd] : ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env });
  return { ok: r.status === 0, timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM", output: `${r.stdout || ""}${r.stderr || ""}` };
}

// Async variant for acceptance: the worker's event loop (lease renewal, other tasks' timers) keeps
// running. The command gets its own process group; timeout or abort kills the whole group.
export function runCommandAsync(cmd, cwd, timeoutSec = 600, env = process.env, { clean = false, signal } = {}) {
  return new Promise((done) => {
    const maxKeep = 4 * 1024 * 1024;
    let output = "", timedOut = false, aborted = false;
    const child = spawn("bash", clean ? ["--noprofile", "--norc", "-c", cmd] : ["-lc", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    const keep = (d) => { output += d; if (output.length > maxKeep) output = output.slice(-maxKeep); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutSec * 1000);
    const onAbort = () => { aborted = true; killGroup(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killGroup(); // background jobs the command left behind
      done({ ok: code === 0 && !timedOut && !aborted, timedOut, aborted, output });
    };
    child.on("error", (e) => { output += `\n${e.message}`; finish(127); });
    child.on("close", (code) => finish(code ?? 1));
  });
}

// PATH for acceptance: absolute entries only, and none inside the repo, the worktrees root or the
// scratch checkout. An empty or relative entry ("", ".", "node_modules/.bin") would resolve inside
// the checkout, i.e. run whatever the task committed under that name instead of the real tool.
export function acceptancePath(path, blocked = []) {
  const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  const kept = String(path || "").split(":")
    .filter((p) => isAbsolute(p) && !blocked.some((b) => b && inside(resolve(p), resolve(b))));
  return kept.length ? kept.join(":") : "/usr/local/bin:/usr/bin:/bin";
}

// Repo files an acceptance command names directly (`bash scripts/accept.sh`, `node tests/run.mjs`).
export function referencedFiles(cmds, existsAtBase) {
  const out = new Set();
  for (const cmd of cmds) for (const sub of splitCommands(cmd)) for (const tok of tokenizeShell(sub)) {
    const t = tok.replace(/^\.\//, "");
    if (!t || t.startsWith("-") || isAbsolute(t) || t.includes("..") || /[$*?`]/.test(t) || !/[./]/.test(t)) continue;
    const n = normalize(t);
    if (existsAtBase(n)) out.add(n);
  }
  return out;
}

function scriptsOf(text) {
  if (text === null) return {};
  try { return JSON.parse(text).scripts || {}; } catch { return null; }
}

// Fatal checks on what the commit changes. Returns null or [where, detail].
function tamperCheck({ workdir, base, head, files, brief, project, cmds }) {
  const allowHarness = brief.allow_harness_changes === true;
  const harness = project.harness_paths || [];
  const referenced = referencedFiles(cmds, (p) => showFile(workdir, base, p) !== null);
  for (const f of files) {
    const diff = () => diffText(workdir, base, f.path, head);
    if (TEST_FILE.test(f.path)) {
      if (f.status === "D") return [`tests-deleted:${f.path}`, "a test file was deleted"];
      const lines = diff().split("\n");
      const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
      if (added.some((l) => SKIP_MARKERS.test(l.slice(1)))) return [`tests-skipped:${f.path}`, "a skip/only/todo marker was added"];
      const defs = (ls) => ls.filter((l) => TEST_DEF.test(l.slice(1))).length;
      if (!allowHarness && defs(removed) > defs(added)) return [`tests-removed:${f.path}`, `${defs(removed) - defs(added)} test definitions removed`];
    }
    if (allowHarness) continue;
    if (HARNESS_FILE.test(f.path) || matchesAny(f.path, harness) || referenced.has(f.path)) return [`harness:${f.path}`, "the test/acceptance harness was changed (brief has no allow_harness_changes: true)"];
    if (/(^|\/)(pyproject\.toml|setup\.cfg)$/.test(f.path) && diff().split("\n").some((l) => /^[-+][^-+]/.test(l) && HARNESS_LINES.test(l))) return [`harness:${f.path}`, "test tool configuration changed"];
    if (/(^|\/)package\.json$/.test(f.path)) {
      const a = scriptsOf(showFile(workdir, base, f.path)), b = scriptsOf(f.status === "D" ? null : showFile(workdir, head, f.path));
      if (a === null || b === null || JSON.stringify(a) !== JSON.stringify(b)) return [`harness:${f.path}`, "package.json scripts changed (or unparseable)"];
    }
  }
  for (const { path, target } of symlinksInDiff(workdir, base, head)) {
    const abs = isAbsolute(target) ? resolve(target) : resolve(dirname(join(workdir, path)), target);
    if (abs !== workdir && !abs.startsWith(`${workdir}/`)) return [`symlink-escape:${path}`, "a symlink in the diff points outside the worktree"];
    const rel = abs.slice(workdir.length + 1);
    if (TEST_FILE.test(path) || HARNESS_FILE.test(path) || referenced.has(path) || rel === ".git" || rel.startsWith(".git/")) return [`symlink-harness:${path}`, "a test/harness file was replaced by a symlink (or a link into .git)"];
  }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.workdir   task worktree
 * @param {string} o.base      base commit sha
 * @param {object} o.brief     parsed brief (scope, acceptance, allow_empty_diff, allow_harness_changes)
 * @param {object} o.project   project config (checks, forbidden_paths, harness_paths, acceptance_setup)
 * @param {string} [o.repo]    main repo (integrity check + scratch checkout)
 * @param {object} [o.integrity] snapshot taken at task start (git.integritySnapshot)
 * @param {string} [o.branch]  the task branch HEAD must be on (nova/<id>)
 * @param {string} [o.scratch] where the clean checkout goes (default: next to the worktree)
 * @param {AbortSignal} [o.signal] lease lost / task cancelled: kill the running command
 * @returns {Promise<{pass:boolean,line:string,detail?:string,fatal?:boolean,setup?:boolean,aborted?:boolean}>}
 */
export async function accept({ workdir, base, brief, project = {}, timeoutSec = 900, env = {}, repo, integrity, branch, scratch, signal }) {
  const fail = (where, detail = "", fatal = false, more = {}) => ({ pass: false, line: `FAIL ${where}`, detail: redact(detail), fatal, ...more });
  // Shared repo config/hooks changed while the task ran: never retried, escalated to the owner.
  const tampered = repo ? integrityChanges(repo, integrity) : [];
  if (tampered.length) return fail(`integrity:${tampered.join(",")}`, `changed outside the task branch: ${tampered.join(", ")} — inspect before running any git command in ${repo}`, true);
  // The delivered work is the task branch: HEAD must still be on it and descend from base.
  if (branch) {
    const ref = git(workdir, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }).out;
    if (ref !== `refs/heads/${branch}`) return fail("integrity:head", `worktree HEAD is ${ref || "detached"}, not refs/heads/${branch}`, true);
  }
  const head = git(workdir, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFail: true }).out;
  if (!head) return fail("integrity:head", "no HEAD commit in the worktree", true);
  if (!git(workdir, ["merge-base", "--is-ancestor", base, head], { allowFail: true }).ok) return fail("integrity:history", `base ${base.slice(0, 12)} is not an ancestor of HEAD (history rewritten)`, true);
  // The runner checkpoints everything first; anything left uncommitted is not part of the work.
  const dirty = git(workdir, ["status", "--porcelain", "--untracked-files=all"], { allowFail: true }).out;
  if (dirty) return fail("uncommitted", `files changed after the checkpoint:\n${dirty.slice(0, 2000)}`);

  const files = changedFiles(workdir, base, head);
  const stat = diffStat(workdir, base, head);
  if (!files.length && !brief.allow_empty_diff) return fail("empty-diff", "no changes vs base");
  for (const f of files) if (matchesAny(f.path, project.forbidden_paths || [])) return fail(`forbidden:${f.path}`);
  if (brief.scope?.length) for (const f of files) if (!matchesAny(f.path, brief.scope)) return fail(`scope:${f.path}`);
  const cmds = [...(brief.acceptance || []), ...(project.checks || [])];
  const tamper = tamperCheck({ workdir, base, head, files, brief, project, cmds });
  if (tamper) return fail(tamper[0], tamper[1], true);

  // Run the commands in a fresh, standalone checkout of exactly that commit.
  const dir = scratch || join(dirname(workdir), `.accept-${workdir.split("/").pop()}`);
  const home = `${dir}.home`;
  const shared = repo || workdir;
  let cleanup = () => {};
  try {
    try { cleanup = scratchCheckout(shared, dir, head); } catch (e) { return fail("checkout", `could not create the clean acceptance checkout: ${e.message}`); }
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
    const cenv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), TMPDIR: join(home, "tmp"),
      PATH: acceptancePath(env.PATH, [shared, dirname(workdir), dir]), NOVA_ACCEPT_COMMIT: head };
    const setup = project.acceptance_setup || [];
    for (const [i, cmd] of [...setup, ...cmds].entries()) {
      const r = await runCommandAsync(cmd, dir, timeoutSec, cenv, { clean: true, signal });
      if (r.aborted) return fail("aborted", "lease lost or task cancelled while acceptance ran", false, { aborted: true });
      if (r.ok) continue;
      const why = `${cmd.slice(0, 60)}${r.timedOut ? " (timeout)" : ""}: ${lastLine(redact(r.output))}`;
      // Setup is environment (registry, network, toolchain), not the work under test.
      if (i < setup.length) return fail(`setup:${why}`, `acceptance_setup failed — check network/registry access and the dependency manifests the task changed:\n${r.output.slice(-4000)}`, false, { setup: true });
      return fail(`cmd:${why}`, r.output.slice(-4000));
    }
  } finally {
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
  // The commands ran code the task committed. They must not have changed the shared repo by any
  // route (absolute paths to .git, a git binary outside the clone): fatal, never retried.
  const after = repo ? integrityChanges(repo, integrity) : [];
  if (after.length) return fail(`integrity:${after.join(",")}`, `changed while the acceptance commands ran: ${after.join(", ")} — inspect before running any git command in ${repo}`, true);
  // The delivered commit must still be the task branch tip (other branches may move legitimately:
  // the owner's own work, other tasks' checkpoints).
  if (branch) {
    const tip = git(shared, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`], { allowFail: true }).out;
    if (tip !== head) return fail("integrity:refs", `refs/heads/${branch} moved from ${head.slice(0, 12)} to ${tip.slice(0, 12) || "(deleted)"} while the acceptance commands ran`, true);
  }
  return { pass: true, line: "PASS", detail: `${files.length} files, +${stat.add} -${stat.del} (commit ${head.slice(0, 12)})`, files: files.length, commit: head, ...stat };
}
