// git.mjs — the few git operations nova-relay needs (worktrees, diffs, checkpoints, conflicts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
