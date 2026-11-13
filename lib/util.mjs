// util.mjs — small shared helpers: UTC time, atomic writes, jsonl, ids, redaction.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.1.0";

// All timestamps are stored as ISO-8601 UTC. Only reports are rendered in the display timezone.
export const nowIso = () => new Date().toISOString();
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function fmtLocal(iso, tz = "Asia/Singapore") {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
  return `${s} ${tz}`;
}

export const expandHome = (p) => (typeof p === "string" && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newId(prefix) {
  const d = new Date();
  const ts = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${prefix}-${ts}-${randomBytes(3).toString("hex")}`;
}

export const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id);

// Atomic JSON write: tmp file + fsync + rename, so a crash never leaves a half-written state file.
export function writeJsonAtomic(path, obj) {
  writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`);
}

export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

// Append-only journal with size-based rotation (keeps one .1 generation).
export function appendJsonl(path, rec, maxBytes = 5 * 1024 * 1024) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch { /* rotation is best effort */ }
  appendFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line from a crash */ }
  }
  return out;
}

export function truncate(text, max = 4000) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

// ------------------------------------------------------------- redaction

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|WEBHOOK)/i;

export function secretValuesFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v);
}

// Extra secret values (e.g. from a project env file) that must never reach logs or results.
const EXTRA_SECRETS = new Set();
export function addSecrets(values) { for (const v of values) if (typeof v === "string" && v.length >= 8) EXTRA_SECRETS.add(v); }

export function redact(text, extraSecrets = [...secretValuesFromEnv(), ...EXTRA_SECRETS]) {
  let s = String(text ?? "");
  for (const v of extraSecrets) if (v) s = s.split(v).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, p1) => (typeof p1 === "string" && /^Bearer/i.test(p1) ? `${p1}[REDACTED]` : "[REDACTED]"));
  }
  return s;
}

// Minimal glob → RegExp (supports **, *, ?). Paths are repo-relative with forward slashes.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A bare directory ("src/foo" or "src/foo/") covers everything below it.
  if (!/[*?]/.test(glob)) re = `${re.replace(/\/$/, "")}(?:/.*)?`;
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path, globs = []) => globs.some((g) => globToRegExp(g).test(path));

// Static prefix of a glob ("src/a/**/*.ts" → "src/a/"), used for cheap overlap detection.
export function globPrefix(glob) {
  const i = glob.search(/[*?]/);
  return i < 0 ? glob.replace(/\/?$/, "/") : glob.slice(0, i);
}

export function scopesOverlap(a = [], b = []) {
  if (!a.length || !b.length) return true; // unknown scope = whole repo
  for (const x of a) for (const y of b) {
    const px = globPrefix(x), py = globPrefix(y);
    if (px.startsWith(py) || py.startsWith(px)) return true;
  }
  return false;
}
