// pi.mjs — Pi coding agent (pi.dev, npm @earendil-works/pi-coding-agent) with a DeepSeek API
// key, for multi-step code edits on the VPS. The nova-guard Pi extension is always loaded.
// Flags verified against the official CLI reference (pi.dev/docs/latest/cli.md); pi is not
// installed on the build machine, so preflight re-checks them against `pi --help` before use.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deepseekKeyCheck } from "./deepseek-check.mjs";

const GUARD_EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "nova-guard.ts");
// Pi's built-in DeepSeek provider reads this variable (pi.dev/docs/latest/providers.md).
const PI_KEY_VAR = "DEEPSEEK_API_KEY";

export default {
  name: "pi",
  kind: "agent",
  sessions: false,
  defaults: { bin: "pi", min_version: "0.1.0", provider: "deepseek", model: "deepseek-chat", key_env: "DEEPSEEK_API_KEY",
    tools: "read,grep,find,ls,bash,edit,write" },
  versionArgs: ["--version"],
  helpArgs: ["--help"],
  requiredFlags: ["--print", "--provider", "--model", "--tools", "--no-session", "--extension"],
  unsetEnv: [],
  credentialEnv: (ex) => [ex.key_env || "DEEPSEEK_API_KEY"],
  guardExtension: GUARD_EXT,
  // The extension writes <task>/guard-loaded when Pi loads it; no marker after a segment = the
  // guard was not active (extension failed to load) → task blocked.
  guardMarker: "guard-loaded",

  validate(ex) {
    return (ex.args || []).some((a) => a === "--no-extensions" || a === "-ne") ? ["--no-extensions would disable nova-guard"] : [];
  },

  buildCommand({ ex, prompt, env = {} }) {
    const o = { ...this.defaults, ...ex };
    const args = ["--print", prompt, "--provider", o.provider, "--model", o.model, "--tools", o.tools, "--no-session", "--extension", GUARD_EXT];
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
    return deepseekKeyCheck({ key: env[o.key_env], fetchImpl });
  },
};
