// pi.mjs — Pi coding agent (pi.dev, npm @earendil-works/pi-coding-agent) with a DeepSeek API
// key, for multi-step code edits on the VPS. The nova-guard Pi extension is always loaded.
// Flags verified against `pi --help` of pi 1.5.2 (preflight re-checks them before use):
//   --no-extensions  no auto-discovered/global extensions: extensions run in load order and may
//                    rewrite a tool call's input after nova-guard approved it (explicit -e still loads)
//   --no-approve     never load trust-gated repo files (.pi/extensions, .pi/settings.json, .pi/mcp.json)
//   --no-mcp         no MCP tools (`--tools` keeps MCP tools; MCP servers can send messages)
// The model id must be set explicitly in the config (no default): pi's own catalog is not
// authoritative for what the provider serves, and pi sends an unknown id as is (with a warning).
// `doctor --live` checks the id against DeepSeek's GET /models. pi's --model takes a pattern, so ids
// with glob characters or a ":" (thinking-level suffix) are refused by config validation.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepseekKeyCheck, modelProblem } from "./deepseek-check.mjs";

const GUARD_EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "nova-guard.ts");
// Pi's built-in DeepSeek provider reads this variable (pi.dev/docs/latest/providers.md).
const PI_KEY_VAR = "DEEPSEEK_API_KEY";

export default {
  name: "pi",
  kind: "agent",
  sessions: false,
  defaults: { bin: "pi", min_version: "0.1.0", provider: "deepseek", key_env: "DEEPSEEK_API_KEY",
    tools: "read,grep,find,ls,bash,edit,write" },
  versionArgs: ["--version"],
  helpArgs: ["--help"],
  requiredFlags: ["--print", "--provider", "--model", "--tools", "--no-session", "--extension", "--no-extensions", "--no-approve", "--no-mcp"],
  unsetEnv: [],
  credentialEnv: (ex) => [ex.key_env || "DEEPSEEK_API_KEY"],
  guardExtension: GUARD_EXT,
  // The extension writes <task>/guard-loaded when Pi loads it; no marker after a segment = the
  // guard was not active (extension failed to load) → task blocked.
  guardMarker: "guard-loaded",

  validate(ex) {
    const p = [];
    // Another extension could rewrite tool input after the guard; trusting the repo loads its .pi/ code.
    if ((ex.args || []).some((a) => /^(--extension|-e|--approve|-a|--mcp-config|--model|-m|--models|--provider)$/.test(a))) p.push("extra extensions, --approve, MCP and model/provider overrides in args are not allowed (they bypass nova-guard or the validated model)");
    const mp = modelProblem(ex.model);
    if (mp) p.push(mp);
    // pi reads "id:<level>" as a thinking-level suffix (use `thinking` instead).
    else if (ex.model.includes(":")) p.push(`model: "${ex.model}" contains ":" which pi treats as a thinking-level suffix; set \`thinking\` separately`);
    return p;
  },

  buildCommand({ ex, prompt, env = {} }) {
    const o = { ...this.defaults, ...ex };
    const mp = modelProblem(o.model);
    if (mp) throw new Error(`pi ${mp}`);
    const args = ["--print", prompt, "--provider", o.provider, "--model", o.model, "--tools", o.tools, "--no-session",
      "--no-extensions", "--no-approve", "--no-mcp", "--extension", GUARD_EXT];
    if (o.thinking) args.push("--thinking", o.thinking);
    args.push(...(ex.args || []));
    // A custom key_env (e.g. per-project key) is exposed to pi under the name its provider reads.
    const setEnv = o.provider === "deepseek" && o.key_env !== PI_KEY_VAR && env[o.key_env] ? { [PI_KEY_VAR]: env[o.key_env] } : {};
    return { cmd: o.bin, args, passEnv: [o.key_env, PI_KEY_VAR], setEnv };
  },

  parseOutput(stdout) {
    return { text: stdout, session_id: null, is_error: false, usage: {}, parsed: false };
  },

  failureText({ stdout, stderr }) {
    return `${stderr.slice(-4000)}\n${stdout.slice(-2000)}`;
  },

  async liveCheck({ ex, env, fetchImpl }) {
    const o = { ...this.defaults, ...ex };
    if (o.provider !== "deepseek") return { ok: true, detail: `provider ${o.provider}: no live check` };
    return deepseekKeyCheck({ key: env[o.key_env], model: o.model, fetchImpl });
  },
};
