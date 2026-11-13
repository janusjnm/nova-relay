// config.mjs — load, default and validate the nova-relay config. Fails fast with a clear path.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { expandHome } from "./util.mjs";
import { ADAPTERS } from "./executors/index.mjs";

export const CONFIG_SCHEMA = 1;

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

  try { new Intl.DateTimeFormat("en", { timeZone: cfg.display_tz }); } catch { p.push(`display_tz: unknown timezone "${cfg.display_tz}"`); }
  if (!cfg.hosts[cfg.coordinator]) p.push(`coordinator: "${cfg.coordinator}" is not in hosts`);
  for (const [h, hc] of Object.entries(cfg.hosts)) {
    if (h !== cfg.self && !hc.ssh) p.push(`hosts.${h}.ssh: required for remote hosts (Tailscale MagicDNS name or ssh alias)`);
  }
  for (const [k, v] of Object.entries(cfg.limits)) {
    if (!(typeof v === "number" && v > 0)) p.push(`limits.${k}: must be a positive number`);
  }

  for (const [name, ex] of Object.entries(cfg.executors)) {
    const at = `executors.${name}`;
    if (!ex || typeof ex !== "object") { p.push(`${at}: must be an object`); continue; }
    const adapter = ADAPTERS[ex.adapter];
    if (!adapter) { p.push(`${at}.adapter: unknown adapter "${ex.adapter}" (known: ${Object.keys(ADAPTERS).join(", ")})`); continue; }
    ex.host = ex.host || cfg.self;
    if (!cfg.hosts[ex.host]) p.push(`${at}.host: "${ex.host}" is not in hosts`);
    ex.limits = { ...cfg.limits, ...(ex.limits || {}) };
    for (const msg of adapter.validate?.(ex, cfg) ?? []) p.push(`${at}: ${msg}`);
  }

  const rules = cfg.routing.rules;
  rules.forEach((r, i) => {
    const at = `routing.rules[${i}]`;
    if (!r.type) p.push(`${at}.type: required`);
    for (const ex of [r.executor, ...(r.fallback || [])]) {
      if (!cfg.executors[ex]) p.push(`${at}: unknown executor "${ex}"`);
    }
  });
  if (cfg.routing.default && !cfg.executors[cfg.routing.default]) p.push(`routing.default: unknown executor "${cfg.routing.default}"`);

  const repos = [];
  for (const [name, pr] of Object.entries(cfg.projects)) {
    const at = `projects.${name}`;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) p.push(`${at}: project names must match [A-Za-z0-9_-]+`);
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
        if (field === "repo") repos.push({ name, host: h, path: resolve(abs) });
      }
    }
    if (pr.webhook && (!pr.webhook.url_env || !pr.webhook.key_env)) p.push(`${at}.webhook: needs url_env and key_env (env var names, never the values)`);
  }
  // PD/NM isolation: a project repo must never live inside another project's repo.
  for (const a of repos) for (const b of repos) {
    if (a !== b && a.name !== b.name && (a.host === b.host || a.host === "*" || b.host === "*") &&
        (a.path === b.path || a.path.startsWith(b.path + sep))) {
      p.push(`projects.${a.name}.repo: overlaps projects.${b.name}.repo (${a.path}); projects must be isolated`);
    }
  }
  if (cfg.webhook && (!cfg.webhook.url_env || !cfg.webhook.key_env)) p.push(`webhook: needs url_env and key_env`);

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
