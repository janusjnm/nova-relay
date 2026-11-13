// config.mjs — load, default and validate the nova-relay config. Fails fast with a clear path.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { addSecretNames, expandHome } from "./util.mjs";
import { ADAPTERS } from "./executors/index.mjs";

export const CONFIG_SCHEMA = 1;
// Same shape as runner ENV_DENY (kept here to avoid an import cycle).
const ENV_SECRET_NAME = /WEBHOOK|^NOVA_RELAY_|_KEY$|_TOKEN$|_KEY_|SECRET|PASSWORD|PASSWD|CREDENTIAL|^SSH_AUTH_SOCK$|^GH_|^GITHUB_TOKEN$/i;

export const DEFAULT_LIMITS = {
  segment_minutes: 12,         // wall-clock cap per segment (10-15 min recommended)
  idle_timeout_sec: 300,       // no output for this long = frozen, kill segment
  task_minutes: 180,           // wall-clock cap for the whole task
  max_segments: 10,
  max_local_retries: 3,        // acceptance FAIL → retry with the error, then escalate
  max_segment_failures: 3,     // consecutive crashes/network errors; > this = escalate
  max_quota_pauses: 6,         // never loop forever on a quota wall
  quota_pause_minutes: 60,     // used when the CLI does not tell us the reset time
  lease_ttl_sec: 120,
  heartbeat_miss_minutes: 15,
  min_free_mb: 2048,
  retention_days: 7,
  max_log_bytes: 2 * 1024 * 1024,
  max_parallel: 2,
};

const BUDGET_KEYS = ["segments_per_day", "minutes_per_day", "tokens_per_day", "cost_usd_per_day"];

// Known keys per section. A misspelt protective key ("forbiden_paths", "protected_branch",
// "budgt", "harness_path") would otherwise silently fall back to a weaker default: unknown keys
// are errors. Keys starting with "_" or "$" are free-form comments.
const KNOWN = {
  top: ["schema", "self", "coordinator", "home", "display_tz", "hosts", "limits", "guard", "executors", "projects", "routing", "webhook", "ssh_bin"],
  host: ["ssh", "bin", "role", "preflight_cmd"],
  guard: ["protected_branches", "allow_hosts"],
  routing: ["rules", "default", "reroute_paused"],
  rule: ["type", "executor", "fallback"],
  webhook: ["url_env", "key_env"],
  project: ["repo", "worktrees", "base", "owner", "env_file", "webhook", "checks", "acceptance_setup", "acceptance_env_pass", "harness_paths", "forbidden_paths", "executors"],
  executor: ["adapter", "host", "bin", "model", "min_version", "args", "env", "budget", "limits", "preflight_cmd", "credential_files"],
  claude: ["permission_mode", "setting_sources", "allowed_tools", "disallowed_tools", "allow_web", "fresh_session_every"],
  codex: ["sandbox"],
  pi: ["provider", "key_env", "tools", "thinking"],
  "deepseek-text": ["endpoint", "key_env", "max_tokens", "timeout_sec"],
};
function unknownKeys(obj, known, at, p) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) if (!known.includes(k) && !/^[_$]/.test(k)) p.push(`${at}${at ? "." : ""}${k}: unknown key (known: ${known.join(", ")})`);
}

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid nova-relay config:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

export function configPath(env = process.env) {
  return env.NOVA_RELAY_CONFIG || join(homedir(), ".config", "nova-relay", "config.json");
}

export function loadConfig(path = configPath(), env = process.env) {
  if (!existsSync(path)) throw new ConfigError([`config file not found: ${path} (copy config/nova-relay.example.json)`]);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError([`${path}: not valid JSON (${e.message})`]);
  }
  return normalizeConfig(raw, env);
}

// Webhooks only go to HTTPS or to Tailscale addresses (MagicDNS *.ts.net or 100.64.0.0/10).
export function webhookUrlAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  if (u.hostname.endsWith(".ts.net")) return true;
  const m = u.hostname.match(/^100\.(\d+)\.\d+\.\d+$/);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

export function normalizeConfig(raw, env = process.env) {
  const p = [];
  const cfg = structuredClone(raw ?? {});
  if (cfg.schema !== undefined && cfg.schema > CONFIG_SCHEMA) p.push(`schema: ${cfg.schema} is newer than this nova-relay supports (${CONFIG_SCHEMA}); upgrade nova-relay`);
  cfg.schema = CONFIG_SCHEMA;
  cfg.home = resolve(expandHome(env.NOVA_RELAY_HOME || cfg.home || "~/.nova-relay"));
  cfg.self = env.NOVA_RELAY_HOST || cfg.self || "local";
  cfg.hosts = cfg.hosts || {};
  if (!cfg.hosts[cfg.self]) cfg.hosts[cfg.self] = {};
  cfg.coordinator = cfg.coordinator || cfg.self;
  cfg.display_tz = cfg.display_tz || "Asia/Singapore";
  cfg.limits = { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
  cfg.guard = { protected_branches: ["main", "master", "release/*"], allow_hosts: [], ...(cfg.guard || {}) };
  cfg.executors = cfg.executors || {};
  cfg.projects = cfg.projects || {};
  cfg.routing = cfg.routing || { rules: [] };
  cfg.routing.rules = cfg.routing.rules || [];
  cfg.routing.reroute_paused = cfg.routing.reroute_paused || "off";

  unknownKeys(raw ?? {}, KNOWN.top, "", p);
  unknownKeys(cfg.guard, KNOWN.guard, "guard", p);
  unknownKeys(cfg.routing, KNOWN.routing, "routing", p);
  if (cfg.webhook) unknownKeys(cfg.webhook, KNOWN.webhook, "webhook", p);
  try { new Intl.DateTimeFormat("en", { timeZone: cfg.display_tz }); } catch { p.push(`display_tz: unknown timezone "${cfg.display_tz}"`); }
  if (!cfg.hosts[cfg.coordinator]) p.push(`coordinator: "${cfg.coordinator}" is not in hosts`);
  for (const [h, hc] of Object.entries(cfg.hosts)) {
    unknownKeys(hc, KNOWN.host, `hosts.${h}`, p);
    if (hc?.role !== undefined && !["box", "vps"].includes(hc.role)) p.push(`hosts.${h}.role: must be "box" or "vps"`);
    if (h !== cfg.self && !hc.ssh) p.push(`hosts.${h}.ssh: required for remote hosts (Tailscale MagicDNS name or ssh alias)`);
  }
  // A typo ("segment_minuts") would otherwise silently fall back to the default.
  const checkLimits = (lim, at) => {
    for (const [k, v] of Object.entries(lim || {})) {
      if (!(k in DEFAULT_LIMITS)) p.push(`${at}.${k}: unknown limit (known: ${Object.keys(DEFAULT_LIMITS).join(", ")})`);
      else if (!(typeof v === "number" && v > 0)) p.push(`${at}.${k}: must be a positive number`);
    }
  };
  checkLimits(cfg.limits, "limits");

  for (const [name, ex] of Object.entries(cfg.executors)) {
    const at = `executors.${name}`;
    if (!ex || typeof ex !== "object") { p.push(`${at}: must be an object`); continue; }
    const adapter = ADAPTERS[ex.adapter];
    if (!adapter) { p.push(`${at}.adapter: unknown adapter "${ex.adapter}" (known: ${Object.keys(ADAPTERS).join(", ")})`); continue; }
    unknownKeys(ex, [...KNOWN.executor, ...(KNOWN[ex.adapter] || [])], at, p);
    ex.host = ex.host || cfg.self;
    if (!cfg.hosts[ex.host]) p.push(`${at}.host: "${ex.host}" is not in hosts`);
    checkLimits(ex.limits, `${at}.limits`);
    ex.limits = { ...cfg.limits, ...(ex.limits || {}) };
    for (const [k, v] of Object.entries(ex.budget || {})) {
      if (!BUDGET_KEYS.includes(k)) p.push(`${at}.budget.${k}: unknown (known: ${BUDGET_KEYS.join(", ")})`);
      else if (!(typeof v === "number" && v > 0)) p.push(`${at}.budget.${k}: must be a positive number`);
    }
    for (const msg of adapter.validate?.(ex, cfg) ?? []) p.push(`${at}: ${msg}`);
  }

  const rules = cfg.routing.rules;
  rules.forEach((r, i) => {
    const at = `routing.rules[${i}]`;
    unknownKeys(r, KNOWN.rule, at, p);
    if (!r.type) p.push(`${at}.type: required`);
    for (const ex of [r.executor, ...(r.fallback || [])]) {
      if (!cfg.executors[ex]) p.push(`${at}: unknown executor "${ex}"`);
    }
  });
  if (cfg.routing.default && !cfg.executors[cfg.routing.default]) p.push(`routing.default: unknown executor "${cfg.routing.default}"`);
  if (!["off", "same-host", "any"].includes(cfg.routing.reroute_paused)) p.push(`routing.reroute_paused: must be "off", "same-host" or "any"`);

  const repos = [], roots = [];
  for (const [name, pr] of Object.entries(cfg.projects)) {
    const at = `projects.${name}`;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) p.push(`${at}: project names must match [A-Za-z0-9_-]+`);
    unknownKeys(pr, KNOWN.project, at, p);
    if (pr.webhook) unknownKeys(pr.webhook, KNOWN.webhook, `${at}.webhook`, p);
    pr.base = pr.base || "main";
    pr.owner = pr.owner || name;
    pr.checks = pr.checks || [];
    pr.forbidden_paths = pr.forbidden_paths || [".git/**", ".github/workflows/**", "**/.env", "**/.env.*"];
    for (const field of ["repo", "worktrees"]) {
      const v = pr[field];
      if (v === undefined) { if (field === "repo") p.push(`${at}.repo: required`); continue; }
      const perHost = typeof v === "object" ? v : { "*": v };
      for (const [h, path] of Object.entries(perHost)) {
        const abs = expandHome(path);
        if (!isAbsolute(abs)) p.push(`${at}.${field}${h === "*" ? "" : `.${h}`}: must be an absolute path`);
        (field === "repo" ? repos : roots).push({ name, host: h, path: resolve(abs) });
      }
    }
    if (pr.worktrees === undefined) roots.push({ name, host: "*", path: resolve(cfg.home, "worktrees", name) });
    for (const e of pr.executors || []) if (!cfg.executors[e]) p.push(`${at}.executors: unknown executor "${e}"`);
    for (const k of ["checks", "forbidden_paths", "harness_paths", "acceptance_setup", "acceptance_env_pass"]) {
      if (pr[k] !== undefined && !(Array.isArray(pr[k]) && pr[k].every((x) => typeof x === "string" && x))) p.push(`${at}.${k}: must be a list of non-empty strings`);
    }
    for (const k of pr.acceptance_env_pass || []) if (ENV_SECRET_NAME.test(k)) p.push(`${at}.acceptance_env_pass: "${k}" looks like a secret; acceptance never gets host secrets (use the project env_file)`);
    if (pr.webhook && (!pr.webhook.url_env || !pr.webhook.key_env)) p.push(`${at}.webhook: needs url_env and key_env (env var names, never the values)`);
  }
  // PD/NM isolation: a project's repo or worktree root must never live inside another project's
  // repo or worktree root (an executor of one project would otherwise reach the other's files).
  const sameHost = (a, b) => a.host === b.host || a.host === "*" || b.host === "*";
  const inside = (a, b) => a.path === b.path || a.path.startsWith(b.path + sep);
  const all = [...repos.map((r) => ({ ...r, field: "repo" })), ...roots.map((r) => ({ ...r, field: "worktrees" }))];
  const seen = new Set();
  for (const a of all) for (const b of all) {
    if (a.name === b.name || !sameHost(a, b) || !inside(a, b)) continue;
    const msg = `projects.${a.name}.${a.field}: ${a.path} is inside projects.${b.name}.${b.field}; projects must be isolated`;
    if (!seen.has(msg)) { seen.add(msg); p.push(msg); }
  }
  if (cfg.webhook && (!cfg.webhook.url_env || !cfg.webhook.key_env)) p.push(`webhook: needs url_env and key_env`);
  const declared = configSecretNames(cfg);
  for (const [name, pr] of Object.entries(cfg.projects)) {
    for (const k of pr.acceptance_env_pass || []) if (declared.has(k)) p.push(`projects.${name}.acceptance_env_pass: "${k}" is a configured secret (webhook/executor key); acceptance never gets it`);
  }

  if (p.length) throw new ConfigError(p);
  return cfg;
}

// Per-host value lookup: "path" or { box: "path", vps: "path" }.
export function hostValue(v, host) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") return expandHome(v);
  return expandHome(v[host] ?? v["*"]);
}

export function projectPaths(cfg, project, host = cfg.self) {
  const pr = cfg.projects[project];
  if (!pr) throw new ConfigError([`unknown project "${project}" (known: ${Object.keys(cfg.projects).join(", ") || "none"})`]);
  const repo = hostValue(pr.repo, host);
  if (!repo) throw new ConfigError([`projects.${project}.repo: no path for host "${host}"`]);
  const worktrees = hostValue(pr.worktrees, host) || join(cfg.home, "worktrees", project);
  return { repo: resolve(repo), worktrees: resolve(worktrees) };
}

// Webhook URL/key come only from env vars (or a 0600 env file loaded by the caller).
export function webhookFor(cfg, project, env = process.env) {
  const w = cfg.projects[project]?.webhook || cfg.webhook;
  if (!w) return { error: "no webhook configured" };
  const url = env[w.url_env], key = env[w.key_env];
  if (!url || !key) return { error: `env ${w.url_env}/${w.key_env} not set` };
  if (!webhookUrlAllowed(url)) return { error: `${w.url_env} must be https:// or a Tailscale address` };
  return { url, key };
}

// KEY=VALUE env file (project secrets). Never stored in the repo or the task store.
export function readEnvFile(path) {
  const out = {};
  const p = expandHome(path);
  if (!p || !existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

// Project env file: holds project secrets, so it must not be readable by group/others.
export function readSecretEnvFile(path) {
  const p = expandHome(path);
  if (!p || !existsSync(p)) return {};
  if (statSync(p).mode & 0o077) throw new Error(`${p} is readable by group/others; chmod 600 it`);
  return readEnvFile(p);
}

// Host secrets (webhook URL/key, DEEPSEEK_API_KEY, ...) for processes started over ssh or by
// timers, which do not get an interactive shell environment. Refused unless mode is 0600-ish.
export function loadSecrets(env = process.env) {
  const p = expandHome(env.NOVA_RELAY_SECRETS || "~/.config/nova-relay/secrets.env");
  if (!existsSync(p)) return { loaded: 0, path: p };
  if (statSync(p).mode & 0o077) return { loaded: 0, path: p, error: `${p} is readable by group/others; chmod 600 it` };
  let n = 0;
  const vars = readEnvFile(p);
  // Everything in secrets.env is a secret by definition: never passed to executors or acceptance.
  addSecretNames(Object.keys(vars));
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined) { env[k] = v; n++; }
  return { loaded: n, path: p };
}

// Env var names the config declares as secrets: webhook url_env/key_env, executors' key_env
// (including the adapter default, e.g. DEEPSEEK_API_KEY).
export function configSecretNames(cfg) {
  const names = new Set();
  for (const w of [cfg.webhook, ...Object.values(cfg.projects || {}).map((p) => p.webhook)]) if (w) { names.add(w.url_env); names.add(w.key_env); }
  for (const ex of Object.values(cfg.executors || {})) {
    const k = ex.key_env || ADAPTERS[ex.adapter]?.defaults?.key_env;
    if (k) names.add(k);
  }
  names.delete(undefined);
  return names;
}
