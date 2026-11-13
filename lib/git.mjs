// git.mjs — the few git operations nova-relay needs (worktrees, diffs, checkpoints, conflicts).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function git(cwd, args, { allowFail = false, input } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`);
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export const revParse = (cwd, ref) => git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).out;

// One worktree + branch per task: nova/<task-id>. Idempotent (resume after a crash).
export function ensureWorktree(repo, path, branch, base) {
  if (existsSync(path)) return { path, base: git(path, ["merge-base", "HEAD", base], { allowFail: true }).out || revParse(repo, base) };
  mkdirSync(dirname(path), { recursive: true });
  const baseSha = revParse(repo, base);
  const exists = git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true }).ok;
  git(repo, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, baseSha]);
  return { path, base: baseSha };
}

export function removeWorktree(repo, path) {
  git(repo, ["worktree", "remove", "--force", path], { allowFail: true });
  git(repo, ["worktree", "prune"], { allowFail: true });
}

// Checkpoint after every segment so a killed/frozen segment never loses more than one segment.
export function checkpoint(cwd, message) {
  git(cwd, ["add", "-A"]);
  const staged = !git(cwd, ["diff", "--cached", "--quiet"], { allowFail: true }).ok;
  if (!staged) return null;
  git(cwd, ["-c", "user.name=nova-relay", "-c", "user.email=nova-relay@localhost", "commit", "-q", "--no-verify", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).out;
}

// Changed files vs base, including uncommitted and untracked files.
export function changedFiles(cwd, base) {
  const files = new Map();
  for (const line of git(cwd, ["diff", "--name-status", "--no-renames", base]).out.split("\n")) {
    const m = line.match(/^([A-Z])\d*\t(.+)$/);
    if (m) files.set(m[2], m[1]);
  }
  for (const f of git(cwd, ["ls-files", "--others", "--exclude-standard"]).out.split("\n")) if (f) files.set(f, "A");
  return [...files].map(([path, status]) => ({ path, status }));
}

export function diffText(cwd, base, file) {
  return git(cwd, ["diff", base, "--", file], { allowFail: true }).out;
}

export function diffStat(cwd, base) {
  let add = 0, del = 0;
  for (const line of git(cwd, ["diff", "--numstat", base]).out.split("\n")) {
    const [a, d] = line.split("\t");
    add += Number(a) || 0; del += Number(d) || 0;
  }
  return { add, del };
}

// Would merging `branch` into the current tip of `base` conflict? (git >= 2.38)
export function mergeConflicts(repo, base, branch) {
  const r = git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch], { allowFail: true });
  if (r.ok) return [];
  const lines = r.out.split("\n").slice(1).filter(Boolean);
  return lines.length ? lines : ["(unknown)"];
}

// What an executor could tamper with to get code run or data sent later by the owner, outside
// the task branch: the shared repo config (remotes, aliases, core.hooksPath, credential helpers)
// and the shared hooks directory. Snapshot at task start, compared at acceptance. This is the
// after-the-fact check that also covers executors without a pre-execution hook (Codex).
export function integritySnapshot(repo) {
  const common = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).out);
  const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const read = (p) => { try { return readFileSync(p); } catch { return Buffer.alloc(0); } };
  const hooksDir = join(common, "hooks");
  let hooks = "";
  try {
    for (const f of readdirSync(hooksDir).sort()) {
      const p = join(hooksDir, f);
      const st = statSync(p);
      hooks += `${f}:${st.mode & 0o111 ? "x" : "-"}:${h(read(p))}\n`;
    }
  } catch { /* no hooks dir */ }
  return { config: h(read(join(common, "config"))), hooks: h(hooks) };
}

export function integrityChanges(repo, snap) {
  if (!snap) return [];
  const now = integritySnapshot(repo);
  return Object.keys(snap).filter((k) => snap[k] !== now[k]).map((k) => (k === "config" ? ".git/config" : ".git/hooks"));
}

// Symlinks added/changed by the task whose target resolves outside the worktree.
export function escapingSymlinks(cwd, base) {
  const out = [];
  const r = git(cwd, ["diff", "--raw", "--no-renames", base], { allowFail: true }).out;
  const paths = new Set();
  for (const line of r.split("\n")) {
    const m = line.match(/^:\d+ (\d+) \S+ \S+ ([A-Z])\d*\t(.+)$/);
    if (m && m[1] === "120000" && m[2] !== "D") paths.add(m[3]);
  }
  for (const f of git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }).out.split("\n")) {
    if (f) { try { if (lstatSync(join(cwd, f)).isSymbolicLink()) paths.add(f); } catch { /* ignore */ } }
  }
  for (const p of paths) {
    let target;
    try { target = readlinkSync(join(cwd, p)); } catch { continue; }
    const abs = isAbsolute(target) ? resolve(target) : resolve(dirname(join(cwd, p)), target);
    if (abs !== cwd && !abs.startsWith(`${cwd}/`)) out.push(p);
  }
  return out;
}
