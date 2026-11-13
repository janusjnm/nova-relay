// notify.mjs — batch wake rules + webhook outbox.
//
// Wake rules (one wake per batch, plus exceptional early wakes):
//   * every task terminal (done/failed/cancelled)     → {id:"*", state:"batch_done", exit_code: 0 all PASS | 1}
//   * a task needs_approval / needs_auth / blocked    → {id, state} once per wake_seq
//   * a task escalated after > max segment failures   → {id, state:"failed"} immediately
//   * coordinator lost the box heartbeat               → {id:"*", state:"box_unreachable"} once per batch
// Payload is only {source,batch,id,state,exit_code}. Dedup key travels in a header.
import { existsSync, readdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { nowIso, readJson, writeJsonAtomic } from "./util.mjs";
import { TERMINAL, WAKE_STATES } from "./store.mjs";

export function batchWakeEvents(batch) {
  if (batch.acked) return [];
  const events = [];
  const tasks = Object.entries(batch.tasks || {});
  for (const [id, t] of tasks) {
    if (WAKE_STATES.has(t.state)) events.push({ key: `${batch.id}:${id}:${t.state}:${t.wake_seq || 0}`, id, state: t.state, exit_code: t.exit_code ?? null });
    if (t.state === "failed" && t.escalated) events.push({ key: `${batch.id}:${id}:escalated`, id, state: "failed", exit_code: t.exit_code ?? 1 });
  }
  if (tasks.length && tasks.length === (batch.expected ?? tasks.length) && tasks.every(([, t]) => TERMINAL.has(t.state))) {
    const allPass = tasks.every(([, t]) => t.state === "done");
    events.push({ key: `${batch.id}:batch_done`, id: "*", state: "batch_done", exit_code: allPass ? 0 : 1 });
  }
  return events.map((e) => ({ ...e, payload: { source: "nova-relay", batch: batch.id, id: e.id, state: e.state, exit_code: e.exit_code } }));
}

// ------------------------------------------------------------------ outbox
const keyFile = (key) => `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`;

export class Outbox {
  constructor(home) { this.dir = join(home, "outbox"); }

  // Idempotent: the same dedup key is only ever enqueued once (sent or not).
  enqueue(key, entry) {
    const p = join(this.dir, keyFile(key));
    if (existsSync(p) || existsSync(join(this.dir, "sent", keyFile(key)))) return false;
    writeJsonAtomic(p, { key, attempts: 0, next_at: nowIso(), created_at: nowIso(), ...entry });
    return true;
  }

  pending() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => ({ file: join(this.dir, f), ...readJson(join(this.dir, f), {}) }));
  }

  dead() { return this.pending().filter((e) => e.dead); }

  // send(entry) → resolves on success, throws on failure. Exponential backoff, capped.
  async flush(send, { now = Date.now(), maxAttempts = 12 } = {}) {
    const results = [];
    for (const e of this.pending()) {
      if (e.dead || Date.parse(e.next_at) > now) continue;
      const { file, ...rec } = e;
      try {
        await send(rec);
        writeJsonAtomic(file, { ...rec, sent_at: nowIso(), attempts: rec.attempts + 1 });
        const sentDir = join(this.dir, "sent");
        writeJsonAtomic(join(sentDir, ".keep"), {});
        renameSync(file, join(sentDir, file.split("/").pop()));
        results.push({ key: rec.key, ok: true });
      } catch (err) {
        const attempts = rec.attempts + 1;
        const delay = Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000);
        writeJsonAtomic(file, { ...rec, attempts, last_error: String(err?.message || err).slice(0, 200),
          next_at: new Date(now + delay).toISOString(), dead: attempts >= maxAttempts });
        results.push({ key: rec.key, ok: false, error: String(err?.message || err) });
      }
    }
    return results;
  }
}

export async function postWebhook({ url, key }, payload, dedupKey, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Idempotency-Key": dedupKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}
