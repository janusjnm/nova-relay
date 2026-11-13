// lock.mjs — lease files with TTL. Acquire is atomic (link); stealing a stale lease happens
// under a short file lock with a re-check, so two watchdogs racing to resume the same task
// cannot both win.
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { withLock, writeJsonAtomic } from "./util.mjs";

// Linux: process start time (clock ticks since boot) guards against PID reuse after reboot.
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}

export function pidAlive(pid, start) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  if (start) { const now = procStart(pid); if (now && now !== start) return false; }
  return true;
}

export function readLease(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// A lease is stale when it expired AND its holder is gone (or lives on another host and is
// long overdue). A live-but-overdue local holder is "frozen": the caller decides (see watchdog).
export function leaseStatus(lease, now = Date.now()) {
  if (!lease) return "free";
  if (now < Date.parse(lease.expires_at)) return "held";
  if (lease.host === hostname()) return pidAlive(lease.pid, lease.pid_start) ? "frozen" : "stale";
  return now - Date.parse(lease.expires_at) > 3 * (lease.ttl_ms || 0) ? "stale" : "held";
}

export function acquireLease(path, owner, ttlMs, { now = Date.now(), stealFrozen = false } = {}) {
  const lease = {
    owner, host: hostname(), pid: process.pid, pid_start: procStart(process.pid),
    ttl_ms: ttlMs, acquired_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMs).toISOString(),
  };
  const tmp = `${path}.cand-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
  const link = () => { try { linkSync(tmp, path); return true; } catch (e) { if (e.code !== "EEXIST") throw e; return false; } };
  try {
    if (link()) return lease;
    const cur = readLease(path);
    if (cur && cur.owner === owner && cur.pid === process.pid) return cur; // idempotent re-acquire
    const st0 = leaseStatus(cur, now);
    if (st0 === "held" || (st0 === "frozen" && !stealFrozen)) return null;
    // Steal under a mutex and re-check inside it: otherwise racer A could judge the old lease
    // stale, racer B steal it and link a fresh one, and A then move B's fresh lease away.
    return withLock(path, () => {
      const again = readLease(path);
      const st = leaseStatus(again, now);
      if (st === "held" || (st === "frozen" && !stealFrozen)) return null;
      try { renameSync(path, `${path}.stale-${randomBytes(3).toString("hex")}`); } catch { /* already gone */ }
      return link() ? lease : null;
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function renewLease(path, owner, ttlMs, now = Date.now()) {
  const cur = readLease(path);
  if (!cur || cur.owner !== owner || cur.pid !== process.pid) return false; // stolen
  cur.expires_at = new Date(now + ttlMs).toISOString();
  writeJsonAtomic(path, cur);
  return true;
}

export function releaseLease(path, owner) {
  const cur = readLease(path);
  if (cur && cur.owner === owner && cur.pid === process.pid && existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

// Kill a segment's whole process group (the executor and everything it spawned), but only if
// the recorded leader is still the same process (start time) — never a recycled PID.
export function killGroup(pid, start, signal = "SIGKILL") {
  if (!pid || !pidAlive(pid, start)) return false;
  try { process.kill(-pid, signal); return true; } catch { try { process.kill(pid, signal); return true; } catch { return false; } }
}
