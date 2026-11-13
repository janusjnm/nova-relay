// acceptance.mjs — the only source of truth for "done". The executor's self-report is ignored.
// Prints/returns exactly one line: "PASS" or "FAIL <where>".
import { spawnSync } from "node:child_process";
import { changedFiles, diffStat, diffText } from "./git.mjs";
import { matchesAny, redact } from "./util.mjs";

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs)$/;
export const SKIP_MARKERS = /\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|pytest\.skip\(|\bt\.Skip(?:Now)?\(|@(?:Disabled|Ignore)\b|\{\s*skip\s*:\s*true|#\[ignore\]/;

function lastLine(s) {
  const lines = String(s).split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.pop() || "").slice(0, 160);
}

export function runCommand(cmd, cwd, timeoutSec = 600, env = process.env) {
  const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env });
  return { ok: r.status === 0, timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM", output: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * @param {object} o
 * @param {string} o.workdir   task worktree
 * @param {string} o.base      base commit sha
 * @param {object} o.brief     parsed brief (scope, acceptance, allow_empty_diff)
 * @param {object} o.project   project config (checks, forbidden_paths)
 */
export function accept({ workdir, base, brief, project = {}, timeoutSec = 900, env }) {
  const fail = (where, detail = "") => ({ pass: false, line: `FAIL ${where}`, detail: redact(detail) });
  const files = changedFiles(workdir, base);
  const stat = diffStat(workdir, base);
  if (!files.length && !brief.allow_empty_diff) return fail("empty-diff", "no changes vs base");

  for (const f of files) if (matchesAny(f.path, project.forbidden_paths || [])) return fail(`forbidden:${f.path}`);
  if (brief.scope?.length) for (const f of files) if (!matchesAny(f.path, brief.scope)) return fail(`scope:${f.path}`);

  for (const f of files) {
    if (TEST_FILE.test(f.path)) {
      if (f.status === "D") return fail(`tests-deleted:${f.path}`);
      const added = diffText(workdir, base, f.path).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      if (added.some((l) => SKIP_MARKERS.test(l))) return fail(`tests-skipped:${f.path}`);
    }
    if (/(^|\/)package\.json$/.test(f.path) && /^[-+]\s*"test"\s*:/m.test(diffText(workdir, base, f.path))) return fail(`test-script-changed:${f.path}`);
  }

  for (const cmd of [...(brief.acceptance || []), ...(project.checks || [])]) {
    const r = runCommand(cmd, workdir, timeoutSec, env);
    if (!r.ok) return fail(`cmd:${cmd.slice(0, 60)}${r.timedOut ? " (timeout)" : ""}: ${lastLine(redact(r.output))}`, r.output.slice(-4000));
  }
  return { pass: true, line: "PASS", detail: `${files.length} files, +${stat.add} -${stat.del}`, files: files.length, ...stat };
}
