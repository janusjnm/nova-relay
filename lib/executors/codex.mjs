// codex.mjs — official Codex CLI (`codex exec`) with ChatGPT subscription login, on the VPS.
// Sandbox is workspace-write (no network by default); each segment is a fresh exec that gets
// the brief + progress summary, so no long-lived session is needed.
// Flags verified against the official Codex CLI reference (codex is not installed on the build
// machine; preflight re-checks every required flag against `codex exec --help` before use).
//
// Codex has no per-command hook, so nova-relay audits after the fact: with --json the event
// stream lists every executed command and file change; each one goes through nova-guard and a
// hit turns into an "audit" approval request (needs_approval) before the task can continue.
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Event shapes accepted (current `--json` JSONL and the older `msg` envelope).
function commandOf(j) {
  const it = j.item || j.msg || j;
  const t = it.type || it.item_type;
  if ((t === "command_execution" || t === "exec_command_begin") && it.command) return Array.isArray(it.command) ? it.command.join(" ") : String(it.command);
  return null;
}
function changesOf(j) {
  const it = j.item || j.msg || j;
  if ((it.type || it.item_type) === "file_change" && Array.isArray(it.changes)) return it.changes.map((c) => c.path).filter(Boolean);
  if (it.type === "patch_apply_begin" && it.changes && typeof it.changes === "object") return Object.keys(it.changes);
  return [];
}
function errorOf(j) {
  if (j.type === "error") return j.message || j.error?.message || "error";
  if (j.type === "turn.failed") return j.error?.message || "turn failed";
  if (j.msg?.type === "error") return j.msg.message || "error";
  return null;
}

export default {
  name: "codex",
  kind: "agent",
  sessions: false,
  audit: true,
  defaults: { bin: "codex", min_version: "0.30.0", sandbox: "workspace-write" },
  versionArgs: ["--version"],
  helpArgs: ["exec", "--help"],
  requiredFlags: ["--sandbox", "--output-last-message", "--cd", "--skip-git-repo-check", "--json"],
  unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_API_KEY"],
  credentialFiles: ["~/.codex/auth.json"],

  validate(ex) {
    const p = [];
    if ((ex.args || []).some((a) => /dangerously|bypass|danger-full-access|--yolo|network_access/.test(a)) || ex.sandbox === "danger-full-access") p.push("sandbox bypass flags are not allowed");
    if (Object.keys(ex.env || {}).some((k) => /OPENAI_(BASE_URL|API_KEY)|CODEX_API_KEY/.test(k))) p.push("gateway/API-key env vars are not allowed; codex uses the ChatGPT login");
    return p;
  },

  buildCommand({ ex, prompt, workdir, taskDir, segment }) {
    const o = { ...this.defaults, ...ex };
    const out = join(taskDir, `codex-last-${segment}.txt`);
    const args = ["exec", "--json", "--sandbox", o.sandbox, "--cd", workdir, "--skip-git-repo-check", "--output-last-message", out];
    if (o.model) args.push("--model", o.model);
    args.push(...(ex.args || []), prompt);
    return { cmd: o.bin, args, outFile: out };
  },

  parseOutput(stdout, built) {
    const commands = [], files = [], errors = [];
    let events = 0;
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      events++;
      const c = commandOf(j); if (c) commands.push(c);
      files.push(...changesOf(j));
      const e = errorOf(j); if (e) errors.push(e);
    }
    let text = events ? "" : stdout;
    try {
      if (built?.outFile) { text = readFileSync(built.outFile, "utf8"); rmSync(built.outFile, { force: true }); } // unredacted copy: remove
    } catch { /* fall back to stdout */ }
    return { text, session_id: null, is_error: false, usage: {}, audit: { commands, files, events }, errors, parsed: events > 0 };
  },

  failureText({ stdout, stderr, parsed }) {
    return `${(parsed.errors || []).join("\n")}\n${stderr.slice(-4000)}\n${parsed.parsed ? "" : stdout.slice(-4000)}`;
  },

  // doctor --live: `codex login status` exits 0 when credentials are present; must be ChatGPT.
  liveCheck({ ex, env }) {
    const o = { ...this.defaults, ...ex };
    const r = spawnSync(o.bin, ["login", "status"], { encoding: "utf8", timeout: 30_000, env });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (r.error || r.status !== 0) return { ok: false, detail: `not logged in (${r.error?.code || out.split("\n").pop() || `exit ${r.status}`}); run codex login` };
    if (/api key/i.test(out)) return { ok: false, detail: "logged in with an API key, not the ChatGPT subscription" };
    return { ok: true, detail: out.split("\n").pop().slice(0, 120) };
  },
};
