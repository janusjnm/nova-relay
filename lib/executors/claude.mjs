// claude.mjs — official Claude Code CLI (`claude -p`) on the box, subscription login only.
// Never `--bare`, never a third-party gateway: API-key/gateway env vars are stripped.
export default {
  name: "claude",
  kind: "agent",
  sessions: true,
  defaults: { bin: "claude", min_version: "1.0.0", permission_mode: "acceptEdits",
    allowed_tools: ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "TodoWrite"],
    disallowed_tools: ["WebFetch", "WebSearch"] },
  versionArgs: ["--version"],
  helpArgs: ["--help"],
  requiredFlags: ["--print", "--output-format", "--verbose", "--resume", "--session-id", "--settings", "--permission-mode", "--allowedTools", "--disallowedTools"],
  unsetEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
  credentialFiles: ["~/.claude/.credentials.json", "~/.claude.json"],

  validate(ex, cfg) {
    const p = [];
    const all = [...(ex.args || []), ...Object.keys(ex.env || {})];
    if (all.includes("--bare")) p.push("`--bare` is not allowed (it skips subscription login/hooks)");
    if (all.some((a) => /ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN)/.test(a))) p.push("gateway/API-key env vars are not allowed; claude uses the subscription login");
    if (cfg?.hosts?.[ex.host]?.role && cfg.hosts[ex.host].role !== "box") p.push(`claude runs only on the box (host "${ex.host}" has role "${cfg.hosts[ex.host].role}")`);
    return p;
  },

  buildCommand({ ex, prompt, session, resume, hookCmd }) {
    const o = { ...this.defaults, ...ex };
    const settings = { hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: hookCmd }] }] } };
    const args = ["--print", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", o.permission_mode,
      "--settings", JSON.stringify(settings),
      "--allowedTools", o.allowed_tools.join(","),
      "--disallowedTools", (o.allow_web ? o.disallowed_tools.filter((t) => !/^Web/.test(t)) : o.disallowed_tools).join(",")];
    if (o.model) args.push("--model", o.model);
    args.push(...(resume ? ["--resume", session] : ["--session-id", session]));
    args.push(...(ex.args || []));
    return { cmd: o.bin, args };
  },

  parseOutput(stdout) {
    // stream-json: one event per line (keeps the idle detector fed); the last "result" event wins.
    const lines = stdout.trim().split("\n").filter((l) => l.includes('"type":"result"') || l.includes('"type": "result"'));
    try {
      const j = JSON.parse(lines.pop());
      return { text: String(j.result ?? ""), session_id: j.session_id ?? null, is_error: Boolean(j.is_error), usage: { cost_usd: j.total_cost_usd ?? 0 } };
    } catch {
      return { text: stdout, session_id: null, is_error: false, usage: {} };
    }
  },
};
