// pi.mjs — Pi coding agent (pi.dev) with a DeepSeek API key, for multi-step code edits on the VPS.
// The nova-guard Pi extension is always loaded.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const GUARD_EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "nova-guard.ts");

export default {
  name: "pi",
  kind: "agent",
  sessions: false,
  defaults: { bin: "pi", min_version: "0.1.0", provider: "deepseek", model: "deepseek-chat", key_env: "DEEPSEEK_API_KEY",
    tools: "read,grep,find,ls,bash,edit,write" },
  versionArgs: ["--version"],
  helpArgs: ["--help"],
  requiredFlags: ["--provider", "--model", "--tools", "--no-session"],
  unsetEnv: [],
  credentialEnv: (ex) => [ex.key_env || "DEEPSEEK_API_KEY"],
  guardExtension: GUARD_EXT,

  validate(ex) {
    return (ex.args || []).includes("--no-extensions") ? ["--no-extensions would disable nova-guard"] : [];
  },

  buildCommand({ ex, prompt }) {
    const o = { ...this.defaults, ...ex };
    const args = ["-p", prompt, "--provider", o.provider, "--model", o.model, "--tools", o.tools, "--no-session", "-e", GUARD_EXT];
    if (o.thinking) args.push("--thinking", o.thinking);
    args.push(...(ex.args || []));
    return { cmd: o.bin, args, passEnv: [o.key_env] };
  },

  parseOutput(stdout) {
    return { text: stdout, session_id: null, is_error: false, usage: {} };
  },
};
