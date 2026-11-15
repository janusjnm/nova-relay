// paths.mjs — where the config and host secrets files live. One rule for every caller (CLI,
// doctor, isolation policy) and the same directory install.sh writes to:
//   1. NOVA_RELAY_CONFIG / NOVA_RELAY_SECRETS, each independently, if non-blank. Must be absolute
//      (a leading ~ is expanded against HOME, as before); anything else is a ConfigError, never
//      resolved against the current directory.
//   2. else $XDG_CONFIG_HOME/nova-relay/{config.json,secrets.env} if XDG_CONFIG_HOME is absolute
//      (a relative or blank value is ignored, per the XDG Base Directory spec).
//   3. else $HOME/.config/nova-relay/...
// The chosen path is final: a missing file there is not looked up in another location.
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export class ConfigError extends Error {
  constructor(problems, path) {
    super(`invalid nova-relay config${path ? ` ${path}` : ""}:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
    this.path = path;
  }
}

const blank = (v) => typeof v !== "string" || !v.trim();
const homeOf = (env) => (!blank(env.HOME) && isAbsolute(env.HOME) ? env.HOME : homedir());

function explicit(env, name) {
  const v = env[name];
  if (blank(v)) return null;
  const p = v === "~" || v.startsWith("~/") ? join(homeOf(env), v.slice(1)) : v;
  if (!isAbsolute(p)) throw new ConfigError([`${name}=${JSON.stringify(v)}: must be an absolute path (not resolved against the current directory)`]);
  return p;
}

export function configDir(env = process.env) {
  const x = env.XDG_CONFIG_HOME;
  return join(!blank(x) && isAbsolute(x) ? x : join(homeOf(env), ".config"), "nova-relay");
}

export const configPath = (env = process.env) => explicit(env, "NOVA_RELAY_CONFIG") ?? join(configDir(env), "config.json");
export const secretsPath = (env = process.env) => explicit(env, "NOVA_RELAY_SECRETS") ?? join(configDir(env), "secrets.env");
