// notify.mjs — batch wake rules + webhook outbox.
//
// Wake rules (one wake per batch, plus exceptional early wakes):
//   * every task terminal (done/failed/cancelled)     → {id:"*", state:"batch_done", exit_code: 0 all PASS | 1}
//   * a task needs_approval / needs_auth / blocked    → {id, state} once per wake_seq
//   * a task escalated after > max segment failures   → {id, state:"failed"} immediately
//   * coordinator lost the box heartbeat               → {id:"*", state:"box_unreachable"} once per outage,
//                                                         at most once per notify_cooldown_minutes per batch+host
// Payload is only {source,batch,id,state,exit_code}. Dedup key travels in a header.
//
// Incidents: one cause that hits several tasks of a batch wakes the planner once, not once per task:
//   needs_auth  per auth incident (executor logged out)
//   blocked     per block incident (executor-wide cause: CLI flags, model id, guard inactive, strict
//               isolation unavailable, disk) — the same cause within notify_cooldown_minutes reuses
//               the incident id
//   failed      escalations caused by repeated network failures share an incident the same way
// The first wake of an incident is enqueued and flushed immediately; later ones map to the same
// outbox key and are dropped by the outbox's dedup.
//
// Delivery counters (`nova-relay stats`): <home>/run/notify-<UTC day>.json per outbox kind —
// attempts (every send try) and deliveries (unique outbox keys sent successfully). These count
// notifications, not model usage, and a delivered webhook is not proof the planner ran.
import { existsSync, readdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { nowIso, readJson, tryLock, unlock, utcDay, withLock, writeJsonAtomic } from "./util.mjs";
import { TERMINAL, WAKE_STATES } from "./store.mjs";

export function batchWakeEvents(batch) {
  if (batch.acked) return [];
  const events = [];
  const tasks = Object.entries(batch.tasks || {});
  for (const [id, t] of tasks) {
    if (t.state === "needs_auth" && t.auth_incident) {
      // One wake per auth incident (an executor logged out), not one per affected task.
      events.push({ key: `${batch.id}:needs_auth:${t.auth_incident}`, id, state: t.state, exit_code: null });
    } else if (t.state === "blocked" && t.block_incident) {
      events.push({ key: `${batch.id}:blocked:${t.block_incident}`, id, state: t.state, exit_code: t.exit_code ?? null });
    } else if (WAKE_STATES.has(t.state)) events.push({ key: `${batch.id}:${id}:${t.state}:${t.wake_seq || 0}`, id, state: t.state, exit_code: t.exit_code ?? null });
    if (t.state === "failed" && t.escalated) {
      const key = t.escalation_incident ? `${batch.id}:escalated:${t.escalation_incident}` : `${batch.id}:${id}:escalated`;
      events.push({ key, id, state: "failed", exit_code: t.exit_code ?? 1 });
    }
  }
  if (tasks.length && tasks.length === (batch.expected ?? tasks.length) && tasks.every(([, t]) => TERMINAL.has(t.state))) {
    const allPass = tasks.every(([, t]) => t.state === "done");
    events.push({ key: `${batch.id}:batch_done`, id: "*", state: "batch_done", exit_code: allPass ? 0 : 1 });
  }
  return events.map((e) => ({ ...e, payload: { source: "nova-relay", batch: batch.id, id: e.id, state: e.state, exit_code: e.exit_code } }));
}

// ------------------------------------------------------------------ incidents (durable, per host)
//   <home>/run/incidents.json   { <class>: { id, first_at, count } | { token, at, suppressed } }
const incidentsPath = (home) => join(home, "run", "incidents.json");
const safeId = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);

// Incident id for a cause class (e.g. "claude:cli"): reused while the first occurrence is younger
// than cooldownMs, a new id afterwards.
export function incidentFor(home, cls, cooldownMs, now = Date.now()) {
  const p = incidentsPath(home);
  return withLock(p, () => {
    const all = readJson(p, {});
    const rec = all[cls];
    if (rec?.id && now - Date.parse(rec.first_at) < cooldownMs) {
      all[cls] = { ...rec, count: (rec.count || 1) + 1, last_at: new Date(now).toISOString() };
      writeJsonAtomic(p, all);
      return { id: rec.id, fresh: false };
    }
    const id = `${safeId(cls)}-${now.toString(36)}`;
    all[cls] = { id, first_at: new Date(now).toISOString(), last_at: new Date(now).toISOString(), count: 1 };
    writeJsonAtomic(p, all);
    return { id, fresh: true };
  });
}

// Cooldown gate for a recurring wake (e.g. host unreachable for one batch). `token` names the
// occurrence (the outage); the same token is always admitted (the outbox dedups it), a new token
// only once cooldownMs has passed since the last admitted one. Suppressions are counted.
export function admitWake(home, cls, token, cooldownMs, now = Date.now()) {
  const p = incidentsPath(home);
  return withLock(p, () => {
    const all = readJson(p, {});
    const rec = all[cls];
    if (rec && rec.token !== token && now - Date.parse(rec.at) < cooldownMs) {
      all[cls] = { ...rec, suppressed: (rec.suppressed || 0) + 1 };
      writeJsonAtomic(p, all);
      return false;
    }
    if (!rec || rec.token !== token) { all[cls] = { token, at: new Date(now).toISOString(), suppressed: rec?.suppressed || 0 }; writeJsonAtomic(p, all); }
    return true;
  });
}

// ------------------------------------------------------------------ delivery counters
const countsPath = (home, day = utcDay()) => join(home, "run", `notify-${day}.json`);

// Best effort: a counter that cannot be written never turns a sent message into a retry.
export function recordDelivery(home, kind, key, ok, now = new Date()) {
  const p = countsPath(home, utcDay(now));
  try { withLock(p, () => {
    const all = readJson(p, {});
    const c = all[kind] || { attempts: 0, failures: 0, delivered: {} };
    c.attempts++;
    if (ok) c.delivered[keyFile(key).slice(0, -5)] = now.toISOString(); else c.failures++;
    all[kind] = c;
    writeJsonAtomic(p, all);
  }); } catch { /* stats only */ }
}

// { webhook: { notification_attempts, notification_deliveries, notification_failures }, rpc: … }
export function deliveryCounts(home, day = utcDay()) {
  const all = readJson(countsPath(home, day), {});
  return Object.fromEntries(Object.entries(all).map(([kind, c]) => [kind, {
    notification_attempts: c.attempts || 0, notification_deliveries: Object.keys(c.delivered || {}).length, notification_failures: c.failures || 0 }]));
}

// ------------------------------------------------------------------ outbox
const keyFile = (key) => `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`;

export class Outbox {
  constructor(home) { this.home = home; this.dir = join(home, "outbox"); }

  // Idempotent: the same dedup key is only ever enqueued once (sent or not).
  enqueue(key, entry) {
    const p = join(this.dir, keyFile(key));
    if (existsSync(p) || existsSync(join(this.dir, "sent", keyFile(key)))) return false;
    writeJsonAtomic(p, { key, attempts: 0, next_at: nowIso(), created_at: nowIso(), ...entry });
    return true;
  }

  pending() {
    if (!existsSync(this.dir)) return [];
    // Oldest first (file names are hashes): reports from one host arrive in the order they were made.
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => ({ file: join(this.dir, f), ...readJson(join(this.dir, f), {}) }))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.key).localeCompare(String(b.key)));
  }

  dead() { return this.pending().filter((e) => e.dead); }

  // Manual retry after the operator fixed the cause (`nova-relay outbox --flush`).
  reviveDead() {
    let n = 0;
    for (const { file, ...rec } of this.dead()) { writeJsonAtomic(file, { ...rec, dead: false, attempts: 0, next_at: nowIso() }); n++; }
    return n;
  }

  // send(entry) → resolves on success, throws on failure. Exponential backoff, capped.
  // Only one flusher at a time (tick, report handler and CLI may overlap): a concurrent flush
  // returns immediately instead of sending the same entry twice.
  async flush(send, { now = Date.now(), maxAttempts = 12 } = {}) {
    const lockPath = join(this.dir, "flush");
    const me = tryLock(lockPath);
    if (!me) return [{ ok: true, skipped: "another flush is running" }];
    try { return await this.#flush(send, now, maxAttempts); } finally { unlock(lockPath, me); }
  }

  async #flush(send, now, maxAttempts) {
    const results = [];
    for (const e of this.pending()) {
      if (e.dead || Date.parse(e.next_at) > now) continue;
      const { file, ...rec } = e;
      try {
        // send() returns "dropped" when it decided not to send (e.g. the batch was acked meanwhile).
        const res = await send(rec);
        if (res !== "dropped") recordDelivery(this.home, rec.kind, rec.key, true);
        writeJsonAtomic(file, { ...rec, sent_at: nowIso(), attempts: rec.attempts + 1, ...(res === "dropped" ? { dropped: true } : {}) });
        const sentDir = join(this.dir, "sent");
        writeJsonAtomic(join(sentDir, ".keep"), {});
        renameSync(file, join(sentDir, file.split("/").pop()));
        results.push({ key: rec.key, ok: true });
      } catch (err) {
        recordDelivery(this.home, rec.kind, rec.key, false);
        const attempts = rec.attempts + 1;
        const delay = Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000);
        writeJsonAtomic(file, { ...rec, attempts, last_error: String(err?.message || err).slice(0, 200),
          // Host→coordinator reports are the batch's source of truth: they never go dead, they
          // keep retrying (capped backoff) until the coordinator is reachable again.
          next_at: new Date(now + delay).toISOString(), dead: rec.kind !== "rpc" && attempts >= maxAttempts });
        results.push({ key: rec.key, ok: false, error: String(err?.message || err) });
      }
    }
    return results;
  }
}

// Redirects are not followed: the target would bypass the https/Tailscale check, and fetch drops
// the Authorization header across origins, so a "successful" redirected POST would mark the wake
// as sent although the routine never got it. A 3xx stays in the outbox (retry, then dead letter).
// Errors carry the status only — never the URL or the key.
export async function postWebhook({ url, key }, payload, dedupKey, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Idempotency-Key": dedupKey },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new Error(`webhook HTTP ${res.status || "3xx"}: redirect refused (configure the final URL)`);
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}
