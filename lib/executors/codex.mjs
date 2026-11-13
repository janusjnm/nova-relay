// codex.mjs — official Codex CLI (`codex exec`) with ChatGPT subscription login, on the VPS.
// Sandbox is workspace-write (no network by default); each segment is a fresh exec that gets
// the brief + progress summary, so no long-lived session is needed.
import { join } from "node:path";
import { readFileSync } from "node:fs";

export default {
  name: "codex",
  kind: "agent",
  sessions: false,
  defaults: { bin: "codex", min_version: "0.30.0", sandbox: "workspace-write" },
  versionArgs: ["--version"],
  helpArgs: ["exec", "--help"],
  requiredFlags: ["--sandbox", "--output-last-message", "--cd", "--skip-git-repo-check"],
  unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_API_KEY"],
  credentialFiles: ["~/.codex/auth.json"],

  validate(ex) {
    const p = [];
    if ((ex.args || []).some((a) => /dangerously|bypass|danger-full-access/.test(a))) p.push("sandbox bypass flags are not allowed");
    if (Object.keys(ex.env || {}).some((k) => /OPENAI_(BASE_URL|API_KEY)/.test(k))) p.push("gateway/API-key env vars are not allowed; codex uses the ChatGPT login");
    return p;
  },

  buildCommand({ ex, prompt, workdir, taskDir, segment }) {
    const o = { ...this.defaults, ...ex };
    const out = join(taskDir, `codex-last-${segment}.txt`);
    const args = ["exec", "--sandbox", o.sandbox, "--cd", workdir, "--skip-git-repo-check", "--output-last-message", out];
    if (o.model) args.push("--model", o.model);
    args.push(...(ex.args || []), prompt);
    return { cmd: o.bin, args, outFile: out };
  },

  parseOutput(stdout, built) {
    let text = stdout;
    try { if (built?.outFile) text = readFileSync(built.outFile, "utf8"); } catch { /* fall back to stdout */ }
    return { text, session_id: null, is_error: false, usage: {} };
  },
};
