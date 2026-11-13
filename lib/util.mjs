// util.mjs — small shared helpers: UTC time, atomic writes, jsonl, ids, redaction.
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
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
  fsyncDir(dirname(path));
}

// Make the rename itself durable (a crash right after rename must not resurrect the old file).
function fsyncDir(dir) {
  let fd;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* not supported everywhere; best effort */ } finally { if (fd !== undefined) closeSync(fd); }
}

// ------------------------------------------------------------- short-lived file locks
// Read-modify-write of shared JSON files (task state, batch view, budget ledger, decisions)
// happens from several processes at once (worker, ssh rpc handlers, timers). Every such
// update runs under withLock(). Locks are held for milliseconds; a lock whose holder process
// is gone (crash mid-update) is stolen.
//
// Protocol (no compare-and-swap rename exists, so stealers are serialized per lock *instance*):
//   acquire  link(cand, lock): exclusive, a lock file is always complete (cand written first).
//   steal    1. read the lock; gone → retry later (never "dead"); live holder → retry later.
//            2. claim the instance: link(cand, lock.steal-<instance>.<g>). Only one racer can create
//               a given token; a token whose holder died is skipped by moving to g+1.
//            3. re-read: if the lock is no longer that instance, someone already stole/released it.
//            4. rename it aside, link(cand, lock) (may lose to a plain acquire: fine), drop tokens.
// Invariant: between 3 and 4 the instance can only leave `lock` by our rename: its holder is dead
// and every other stealer needs our token. So a stealer never moves a live holder's lock aside.
// The one remaining window is inherent to any timeout-based lock: a holder that is alive but makes
// no progress for >120 s (same host; >60 s cross-host) inside a millisecond critical section — a
// SIGSTOP or a suspend at exactly that point — is treated as dead (documented in failure-modes).
const SAB = new Int32Array(new SharedArrayBuffer(4));
const pause = (ms) => Atomics.wait(SAB, 0, 0, ms);

function lockHolderDead(info, now) {
  if (!info) return true; // torn lock file: only after a power loss (lock files are linked complete)
  if (info.host !== hostname()) return now - info.at > 60_000;
  try { process.kill(info.pid, 0); } catch (e) { if (e.code !== "EPERM") return true; }
  return now - info.at > 120_000; // alive but holding a millisecond lock for minutes: frozen (box slept)
}

// { info, id } of a lock/token file, or null if it does not exist. id names this instance:
// the holder's nonce, or inode+mtime for a torn file.
function readLockFile(p) {
  let raw;
  try { raw = readFileSync(p, "utf8"); } catch { return null; }
  try { const info = JSON.parse(raw); if (info && typeof info.nonce === "string" && /^[0-9a-f]+$/.test(info.nonce)) return { info, id: info.nonce }; } catch { /* torn */ }
  try { const st = statSync(p, { bigint: true }); return { info: null, id: `t${st.ino}-${st.mtimeNs}` }; } catch { return null; }
}

// Claim the right to steal one lock instance. Returns the token generation, or -1.
function claimSteal(lock, id, cand, now) {
  for (let g = 0; g < 8; g++) {
    try { linkSync(cand, `${lock}.steal-${id}.${g}`); return g; } catch (e) { if (e.code !== "EEXIST") throw e; }
    const tok = readLockFile(`${lock}.steal-${id}.${g}`);
    if (!tok || !lockHolderDead(tok.info, now)) return -1; // a live stealer is on it (or just finished)
  }
  return -1;
}

let lockHook = null; // tests only: called between protocol steps to force interleavings / delays
export function __setLockHook(fn) { lockHook = fn; }

export function tryLock(path) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const me = { pid: process.pid, host: hostname(), at: Date.now(), nonce: randomBytes(6).toString("hex") };
  const cand = `${lock}.cand-${me.nonce}`;
  writeFileSync(cand, JSON.stringify(me), { mode: 0o600 });
  try {
    try { linkSync(cand, lock); return me; } catch (e) { if (e.code !== "EEXIST") throw e; }
    lockHook?.("contended");
    const cur = readLockFile(lock);
    if (!cur || !lockHolderDead(cur.info, Date.now())) return null; // gone (just released) or held
    lockHook?.("judged");
    const g = claimSteal(lock, cur.id, cand, Date.now());
    if (g < 0) return null;
    try {
      lockHook?.("claimed");
      if (readLockFile(lock)?.id !== cur.id) return null; // already stolen or released: our view is old
      const aside = `${lock}.stale-${me.nonce}`;
      try { renameSync(lock, aside); } catch { return null; }
      lockHook?.("moved");
      // By the invariant above this is the instance we judged dead. If it is not (a "dead" holder
      // was in fact frozen and released meanwhile), put it back and give up.
      if (readLockFile(aside)?.id !== cur.id) { try { linkSync(aside, lock); } catch { /* taken */ } try { unlinkSync(aside); } catch { /* ignore */ } return null; }
      try { unlinkSync(aside); } catch { /* ignore */ }
      try { linkSync(cand, lock); return me; } catch { return null; }
    } finally {
      // The instance has left `lock` for good (nonces are unique), so its tokens are no longer
      // needed: a late racer that re-creates one fails the re-read in step 3.
      for (let i = 0; i <= g; i++) try { unlinkSync(`${lock}.steal-${cur.id}.${i}`); } catch { /* ignore */ }
    }
  } finally {
    try { unlinkSync(cand); } catch { /* ignore */ }
  }
}

export function unlock(path, me) {
  const lock = `${path}.lock`;
  try { if (JSON.parse(readFileSync(lock, "utf8")).nonce === me.nonce) unlinkSync(lock); } catch { /* gone */ }
}

export function withLock(path, fn, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let me;
  while (!(me = tryLock(path))) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for lock ${path}.lock`);
    pause(5 + Math.floor(Math.random() * 20));
  }
  try { return fn(); } finally { unlock(path, me); }
}

// Last complete JSON line of a (possibly large) jsonl file, reading only the tail.
export function lastJsonlRecord(path, tailBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* torn tail line */ } }
    return null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
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
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT (OAuth access/refresh tokens)
  /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{4,}(?=@)/gi,        // password in https://user:pass@host
  /\bAIza[0-9A-Za-z_-]{30,}/g,
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

// Env var *names* known to hold secrets whatever they are called: every name in secrets.env and
// every url_env/key_env the config declares (a webhook key named "PD_BEARER" matches no pattern).
const SECRET_NAMES = new Set();
export function addSecretNames(names) { for (const n of names) if (typeof n === "string" && n) SECRET_NAMES.add(n); }
export const isSecretName = (name) => SECRET_NAMES.has(name);

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

// Do two segment patterns (*, ?, literals; no "/") match at least one common string?
function segmentsIntersect(p, q) {
  const memo = new Map();
  const f = (i, j) => {
    const k = i * (q.length + 1) + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === p.length && j === q.length) r = true;
    else if (p[i] === "*") r = f(i + 1, j) || (j < q.length && f(i, j + 1));
    else if (q[j] === "*") r = f(i, j + 1) || (i < p.length && f(i + 1, j));
    else if (i === p.length || j === q.length) r = false;
    else r = (p[i] === "?" || q[j] === "?" || p[i] === q[j]) && f(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return f(0, 0);
}

const globSegments = (g) => {
  const segs = g.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter(Boolean).map((x) => (x.includes("**") && x !== "**" ? x.replace(/\*\*+/g, "*") : x));
  if (!/[*?]/.test(g)) segs.push("**"); // a bare path covers everything below it (as in globToRegExp)
  return segs;
};

// Exact: is there a path both globs match? ("src/*.ts" vs "src/b/c.md" → no; "src/**" vs "**/*.md" → yes)
export function globsIntersect(a, b) {
  const A = globSegments(a), B = globSegments(b);
  const memo = new Map();
  const g = (i, j) => {
    const k = i * (B.length + 1) + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (A[i] === "**") r = g(i + 1, j) || (j < B.length && g(i, j + 1));
    else if (B[j] === "**") r = g(i, j + 1) || (i < A.length && g(i + 1, j));
    else if (i === A.length || j === B.length) r = false;
    else r = segmentsIntersect(A[i], B[j]) && g(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return g(0, 0);
}

// File-scope lock decision for two tasks of the same project.
export function scopesOverlap(a = [], b = []) {
  if (!a.length || !b.length) return true; // unknown scope = whole repo
  return a.some((x) => b.some((y) => globsIntersect(x, y)));
}
