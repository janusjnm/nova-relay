// codex.mjs — official Codex CLI (`codex exec`) with ChatGPT subscription login, on the VPS.
// Sandbox is workspace-write (no network by default); each segment is a fresh exec that gets
// the brief + progress summary, so no long-lived session is needed.
// Flags verified against `codex exec --help` of codex-cli 0.169.0; preflight re-checks every
// required flag against the installed version before use.
//   --ignore-user-config  ~/.codex/config.toml can add MCP servers (which can send messages) or
//                         loosen the sandbox; the login in CODEX_HOME is still used
//   --ignore-rules        execpolicy .rules (user or repo) can allow commands; ignored
//   (no --trust)          repo-local .codex/ config stays untrusted
//
// Codex has no per-command hook, so nova-relay audits after the fact. `--json` prints the
// ThreadEvent JSONL documented in @openai/codex-sdk (index.d.ts): item.started / item.updated /
// item.completed carry an item {id, type}; command_execution has `command` (string),
// file_change has `changes[{path, kind}]`, mcp_tool_call has `server`/`tool`. Every command,
// file change and MCP call goes through nova-guard (MCP calls always count as hits); a hit turns
// into an "audit" approval request (needs_approval) before the task can continue.
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Fatal errors only: `{"type":"error","message":"Reconnecting... 2/5 (…401…)"}` events are
// transient retries and item-level errors are non-fatal; neither may decide the classification.
function fatalError(j) {
  if (j.type === "turn.failed") return j.error?.message || "turn failed";
  if (j.type === "error" && !/^Reconnecting\.\.\./.test(j.message || "")) return j.message || "error";
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
  requiredFlags: ["--sandbox", "--output-last-message", "--cd", "--skip-git-repo-check", "--json", "--ignore-user-config", "--ignore-rules"],
  unsetEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_API_KEY"],
  credentialFiles: ["~/.codex/auth.json"],

  validate(ex) {
    const p = [];
    if ((ex.args || []).some((a) => /dangerously|bypass|danger-full-access|--yolo|network_access|^--(trust|add-dir)\b/.test(a)) || ex.sandbox === "danger-full-access") p.push("sandbox bypass / trust flags are not allowed");
    if (ex.sandbox && !["read-only", "workspace-write"].includes(ex.sandbox)) p.push(`sandbox must be read-only or workspace-write`);
    if (Object.keys(ex.env || {}).some((k) => /OPENAI_(BASE_URL|API_KEY)|CODEX_API_KEY/.test(k))) p.push("gateway/API-key env vars are not allowed; codex uses the ChatGPT login");
    return p;
  },

  buildCommand({ ex, prompt, workdir, taskDir, segment }) {
    const o = { ...this.defaults, ...ex };
    const out = join(taskDir, `codex-last-${segment}.txt`);
    const args = ["exec", "--json", "--sandbox", o.sandbox, "--cd", workdir, "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--output-last-message", out];
    if (o.model) args.push("--model", o.model);
    args.push(...(ex.args || []), prompt);
    return { cmd: o.bin, args, outFile: out };
  },

  parseOutput(stdout, built) {
    const items = new Map(), errors = [];
    let events = 0;
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      events++;
      // An item is reported by item.started and again by item.completed: count it once.
      if (j.item?.type) items.set(j.item.id ?? `#${events}`, j.item);
      const e = fatalError(j); if (e) errors.push(e);
    }
    const commands = [], files = [], mcp = [];
    for (const it of items.values()) {
      if (it.type === "command_execution" && it.command) commands.push(Array.isArray(it.command) ? it.command.join(" ") : String(it.command));
      else if (it.type === "file_change" && Array.isArray(it.changes)) files.push(...it.changes.map((c) => c.path).filter(Boolean));
      else if (it.type === "mcp_tool_call") mcp.push(`${it.server}/${it.tool}`);
    }
    let text = events ? "" : stdout;
    try {
      if (built?.outFile) { text = readFileSync(built.outFile, "utf8"); rmSync(built.outFile, { force: true }); } // unredacted copy: remove
    } catch { /* fall back to stdout */ }
    return { text, session_id: null, is_error: false, usage: {}, audit: { commands, files, mcp, events }, errors, parsed: events > 0 };
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
