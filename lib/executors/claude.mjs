// claude.mjs — official Claude Code CLI (`claude -p`) on the box, subscription login only.
// Never `--bare`, never a third-party gateway: API-key/gateway env vars are stripped.
// Flags verified against `claude --help` of Claude Code 2.1.308 (see docs/config.md).
import { spawnSync } from "node:child_process";
import { UNKNOWN_USAGE, claudeUsage } from "../usage.mjs";

export const GUARDED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];

export default {
  name: "claude",
  kind: "agent",
  sessions: true,
  defaults: { bin: "claude", min_version: "2.0.0", permission_mode: "acceptEdits", setting_sources: "user",
    allowed_tools: ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "TodoWrite"],
    disallowed_tools: ["WebFetch", "WebSearch"] },
  versionArgs: ["--version"],
  helpArgs: ["--help"],
  requiredFlags: ["--print", "--output-format", "--verbose", "--resume", "--session-id", "--settings", "--setting-sources",
    "--strict-mcp-config", "--permission-mode", "--allowedTools", "--disallowedTools"],
  unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN"],
  // ~/.claude.json is the CLI's config file and exists even when logged out, so it is not evidence.
  credentialFiles: ["~/.claude/.credentials.json"],
  // The PreToolUse hook appends to <task>/hook-calls; the runner compares that with the tool uses
  // in the stream. `claude -p` silently ignores --settings that fail validation, so this is the
  // only way to notice that the guard is not running.
  hookCounted: true,
  // Strict isolation (isolation.apply_to includes "executor"): the official login directory is
  // bound read-only (a bind, not a copy; ~/.claude.json too if present), plus the CLI binary, the
  // node binary and nova-relay's hook script; hook-calls/approvals.jsonl are the only writable
  // task-dir paths. Network is not unshared (subscription auth needs the vendor). The sandboxed
  // CLI can still read these credential files. ~/.claude is read-only, so session transcripts do
  // not persist: every segment starts a fresh session from progress.md (no --resume).
  sandbox: {
    credentialPaths: [{ path: "~/.claude", required: true }, { path: "~/.claude.json", required: false }],
    taskFiles: ["hook-calls", "approvals.jsonl"],
    hookRoot: true,
    freshSessions: true,
  },

  validate(ex, cfg) {
    const p = [];
    const all = [...(ex.args || []), ...Object.keys(ex.env || {})];
    if (all.includes("--bare")) p.push("`--bare` is not allowed (it skips subscription login/hooks)");
    if (all.some((a) => /dangerously-skip-permissions|bypassPermissions/.test(a)) || ex.permission_mode === "bypassPermissions") p.push("permission bypass is not allowed");
    if (all.some((a) => /ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN)|CLAUDE_CODE_USE_/.test(a))) p.push("gateway/API-key env vars are not allowed; claude uses the subscription login");
    if (cfg?.hosts?.[ex.host]?.role && cfg.hosts[ex.host].role !== "box") p.push(`claude runs only on the box (host "${ex.host}" has role "${cfg.hosts[ex.host].role}")`);
    return p;
  },

  buildCommand({ ex, prompt, session, resume, hookCmd }) {
    const o = { ...this.defaults, ...ex };
    const settings = { hooks: { PreToolUse: [{ matcher: GUARDED_TOOLS.join("|"), hooks: [{ type: "command", command: hookCmd }] }] } };
    // The prompt is the positional argument right after the boolean --print; variadic tool lists
    // come later and are always followed by another --flag.
    const args = ["--print", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", o.permission_mode,
      "--settings", JSON.stringify(settings),
      // Repo-controlled settings (.claude/settings*.json hooks/permissions) and MCP servers
      // (.mcp.json, which could send messages) are prompt-injection surfaces: ignored.
      "--setting-sources", o.setting_sources, "--strict-mcp-config",
      "--allowedTools", o.allowed_tools.join(","),
      "--disallowedTools", (o.allow_web ? o.disallowed_tools.filter((t) => !/^Web/.test(t)) : o.disallowed_tools).join(",")];
    if (o.model) args.push("--model", o.model);
    args.push(...(resume ? ["--resume", session] : ["--session-id", session]));
    args.push(...(ex.args || []));
    return { cmd: o.bin, args };
  },

  parseOutput(stdout) {
    // stream-json: one event per line (keeps the idle detector fed); the last "result" event wins.
    let result = null, toolUses = 0;
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === "result") result = j;
      else if (j.type === "assistant") for (const c of j.message?.content || []) if (c.type === "tool_use" && GUARDED_TOOLS.includes(c.name)) toolUses++;
    }
    // Usage: only what the result event reports (total_cost_usd, usage.*_tokens); missing = null.
    if (!result) return { text: stdout, session_id: null, is_error: false, usage: UNKNOWN_USAGE, guarded_tool_uses: toolUses, parsed: false };
    return { text: String(result.result ?? ""), session_id: result.session_id ?? null, is_error: Boolean(result.is_error),
      usage: claudeUsage(result), guarded_tool_uses: toolUses, parsed: true };
  },

  // Classify failures on the CLI's own words only — never on tool output inside the stream
  // (a test log mentioning "429" or "unauthorized" must not pause the executor).
  failureText({ stdout, stderr, parsed }) {
    return `${stderr.slice(-4000)}\n${parsed.parsed ? parsed.text : stdout.slice(-4000)}`;
  },

  // doctor --live: local, no model call, no quota. Requires the subscription login (claude.ai).
  liveCheck({ ex, env }) {
    const o = { ...this.defaults, ...ex };
    const r = spawnSync(o.bin, ["auth", "status", "--json"], { encoding: "utf8", timeout: 30_000, env });
    if (r.error || r.status !== 0) return { ok: false, detail: `claude auth status failed (${r.error?.code || `exit ${r.status}`})` };
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { ok: false, detail: "claude auth status: unparseable output" }; }
    if (!j.loggedIn) return { ok: false, detail: "not logged in (run claude, then /login with the subscription account)" };
    if (j.authMethod !== "claude.ai") return { ok: false, detail: `logged in via ${j.authMethod}, not the claude.ai subscription` };
    return { ok: true, detail: `subscription login (${j.subscriptionType || "?"})` };
  },
};
