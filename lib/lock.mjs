// lock.mjs — lease files with TTL. Acquire is atomic (link); stealing a stale lease happens
// under a short file lock with a re-check, so two watchdogs racing to resume the same task
// cannot both win.
//
// A lease is only ever taken over from a holder instance that is provably gone (pidAlive: pid
// gone or reused, zombie, earlier boot). An expired lease whose holder is alive is "frozen" and
// is never stolen here, whatever its age: two writers on one task would be a split brain. The
// resume path (relay.resumeAll) may end a frozen holder with SIGKILL, and only re-queues after
// it has confirmed the death.
import { existsSync, linkSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { pidAlive, procStart, selfInstance, sleep, withLock, writeJsonAtomic } from "./util.mjs";

export { pidAlive, procStart };

export function readLease(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// A lease is stale when it expired AND its holder is gone (or lives on another host and is
// long overdue). A live-but-overdue local holder is "frozen": the caller decides (see watchdog).
export function leaseStatus(lease, now = Date.now()) {
  if (!lease) return "free";
  if (now < Date.parse(lease.expires_at)) return "held";
  if (lease.host === hostname()) return pidAlive(lease.pid, lease.pid_start, lease.boot_id) ? "frozen" : "stale";
  return now - Date.parse(lease.expires_at) > 3 * (lease.ttl_ms || 0) ? "stale" : "held";
}

// SIGKILL one verified process instance and wait (bounded) until it is provably gone. Returns
// "dead" (gone now or already), or "unconfirmed": no pid start time to verify the instance with
// (never kill a pid that may have been reused), or still alive after the wait (uninterruptible
// sleep, EPERM). Callers must not replace an "unconfirmed" holder.
export async function killConfirmed(pid, start, boot, { waitMs = 3000 } = {}) {
  if (!pidAlive(pid, start, boot)) return "dead";
  if (!start) return "unconfirmed";
  try { process.kill(pid, "SIGKILL"); } catch { /* EPERM / gone: checked below */ }
  const end = Date.now() + waitMs;
  for (;;) {
    if (!pidAlive(pid, start, boot)) return "dead";
    if (Date.now() > end) return "unconfirmed";
    await sleep(25);
  }
}

export function acquireLease(path, owner, ttlMs, { now = Date.now() } = {}) {
  const { pid, host, pid_start, boot_id } = selfInstance();
  const lease = {
    owner, host, pid, pid_start, boot_id,
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
    if (st0 === "held" || st0 === "frozen") return null;
    // Steal under a mutex and re-check inside it: otherwise racer A could judge the old lease
    // stale, racer B steal it and link a fresh one, and A then move B's fresh lease away.
    return withLock(path, () => {
      const again = readLease(path);
      const st = leaseStatus(again, now);
      if (st === "held" || st === "frozen") return null;
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
  if (!pid || !start || !pidAlive(pid, start)) return false;
  try { process.kill(-pid, signal); return true; } catch { try { process.kill(pid, signal); return true; } catch { return false; } }
}

// Does process group `pgid` still have a member that can run (zombies excluded)? /proc scan on
// Linux; elsewhere kill(-pgid, 0), which also counts zombies (conservative).
export function groupAlive(pgid) {
  let pids;
  try { pids = readdirSync("/proc").filter((f) => /^\d+$/.test(f)); } catch {
    try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  }
  for (const p of pids) {
    let stat;
    try { stat = readFileSync(`/proc/${p}/stat`, "utf8"); } catch { continue; }
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(f[2]) === pgid && f[0] !== "Z" && f[0] !== "X") return true;
  }
  return false;
}

// killGroup, then wait (bounded) until no member of the group can run any more.
// "none": nothing of ours to kill; "dead": killed and confirmed; "unconfirmed": still running.
// Leader already dead but the group still has live members (the executor died, a child it spawned
// did not): the group id can no longer be verified as ours, so nothing is killed, and the answer
// is "unconfirmed" — the caller must not start a second writer next to them.
export async function killGroupConfirmed(pid, start, { waitMs = 3000 } = {}) {
  if (!pid || !start) return "none";
  if (!pidAlive(pid, start)) return groupAlive(pid) ? "unconfirmed" : "none";
  if (!killGroup(pid, start)) return "none";
  const end = Date.now() + waitMs;
  for (;;) {
    if (!groupAlive(pid)) return "dead";
    if (Date.now() > end) return "unconfirmed";
    await sleep(25);
  }
}
