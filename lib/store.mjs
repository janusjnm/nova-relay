// store.mjs — on-disk task store (the source of truth).
//
//   <home>/tasks/<id>/brief.md        the brief as written by the planner
//   <home>/tasks/<id>/state.json      current state (atomic tmp+rename writes)
//   <home>/tasks/<id>/journal.jsonl   append-only state patches; replayed if state.json is corrupt
//   <home>/tasks/<id>/events.jsonl    log lines (redacted, rotated)
//   <home>/tasks/<id>/progress.md     per-segment summaries carried into the next segment
//   <home>/tasks/<id>/result.md       final result text (redacted)
//   <home>/tasks/<id>/fenced.json     tombstone: this id may never be created (again) on this host.
//                                     Kept forever: a never-delivered id (fence) or a retired task
//                                     (gc). A keyed retry can recreate an id at any time.
//   <home>/batches/<id>.json          batch view (on the coordinator)
//   <home>/batches/tombstones/<id>.json  what is left of a gc'd batch (kept forever, see gc)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VERSION, appendJsonl, lastJsonlRecord, nowIso, readJson, readJsonl, redact, truncate, validId, withLock, writeFileAtomic, writeJsonAtomic } from "./util.mjs";

export const STATE_SCHEMA = 1;

export class FencedError extends Error {
  constructor(id) { super(`task ${id} was fenced (declared not delivered); refusing to create it`); this.fenced = true; }
}
// "abandoned" only ever appears in a coordinator batch view (operator gave up on an unreachable
// host); task hosts never write it.
export const TERMINAL = new Set(["done", "failed", "cancelled", "abandoned"]);
export const WAKE_STATES = new Set(["needs_approval", "needs_auth", "blocked"]);
// "moved": the task was handed over to another host (quota reroute); the local copy is inert.
export const STATES = new Set(["queued", "running", "paused", "moved", ...WAKE_STATES, ...TERMINAL]);

// Schema migrations: MIGRATIONS[n] upgrades a schema-n object to n+1. Running tasks written by
// an older nova-relay are upgraded on read; state from a newer version is refused, not mangled.
export const MIGRATIONS = {};

export function migrate(obj, kind = "state", target = STATE_SCHEMA, migrations = MIGRATIONS) {
  let o = obj;
  const from = o.schema ?? 1;
  if (from > target) throw new Error(`${kind} schema ${from} was written by a newer nova-relay (this is ${VERSION}, schema ${target}); upgrade before touching it`);
  for (let v = from; v < target; v++) {
    if (!migrations[v]) throw new Error(`no migration for ${kind} schema ${v} → ${v + 1}`);
    o = migrations[v](o);
    o.schema = v + 1;
  }
  return o;
}

export class Store {
  constructor(home) {
    this.home = home;
    this.tasks = join(home, "tasks");
    this.batches = join(home, "batches");
    for (const d of [this.tasks, this.batches, join(home, "outbox"), join(home, "run")]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  dir(id) {
    if (!validId(id)) throw new Error(`invalid task id: ${id}`);
    return join(this.tasks, id);
  }

  exists(id) {
    if (!validId(id)) return false;
    const d = join(this.tasks, id);
    return existsSync(join(d, "state.json")) || existsSync(join(d, "journal.jsonl"));
  }

  create(task, briefText) {
    const dir = this.dir(task.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return withLock(join(dir, "state"), () => {
      // A fenced id was declared "not delivered" to the coordinator: a late or retried submit must
      // not bring it to life after the batch already counted it as failed.
      if (existsSync(join(dir, "fenced.json"))) throw new FencedError(task.id);
      if (existsSync(join(dir, "journal.jsonl"))) { // idempotent submit (retry / late duplicate)
        const cur = this.get(task.id);
        if (cur && task.batch && cur.batch !== task.batch) throw new Error(`task id ${task.id} already belongs to batch ${cur.batch}`);
        return cur;
      }
      const now = nowIso();
      const st = {
        schema: STATE_SCHEMA, relay_version: VERSION, state: "queued", reason: null, exit_code: null, verdict: null,
        created_at: now, updated_at: now, segments: 0, segment_failures: 0, local_retries: 0, quota_pauses: 0,
        session_id: null, session_segments: 0, resume_after: null, started_at: null, active_minutes: 0, wake_seq: 0, acked: false,
        ...task, seq: 0,
      };
      writeFileAtomic(join(dir, "brief.md"), briefText);
      appendJsonl(join(dir, "journal.jsonl"), { ts: now, type: "created", seq: 0, state: st }, Infinity);
      writeJsonAtomic(join(dir, "state.json"), st);
      return st;
    });
  }

  // Submit reconciliation (host side). Under the same lock as create(): either the task exists
  // (returned) or the id is tombstoned so it can never be created later. Idempotent.
  fence(id, batch) {
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return withLock(join(dir, "state"), () => {
      if (existsSync(join(dir, "journal.jsonl"))) return { task: this.get(id) };
      if (!existsSync(join(dir, "fenced.json"))) writeJsonAtomic(join(dir, "fenced.json"), { id, batch, fenced_at: nowIso() });
      return { fenced: true };
    });
  }

  // state.json is a cache of the journal. It is rebuilt when it is corrupt/missing, or when the
  // journal is ahead of it (crash between the journal append and the state.json rename).
  get(id) {
    const dir = this.dir(id);
    let st = null;
    try { st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { /* corrupt or missing */ }
    const last = lastJsonlRecord(join(dir, "journal.jsonl"));
    if (!st || (last && typeof last.seq === "number" && last.seq > (st.seq ?? 0))) {
      const why = st ? `journal seq ${last.seq} ahead of state.json seq ${st.seq ?? 0}` : "state.json unreadable";
      st = this.replay(id);
      if (!st) return null;
      writeJsonAtomic(join(dir, "state.json"), st);
      this.log(id, "recovered", `state.json rebuilt from journal (${why})`);
    }
    return migrate(st);
  }

  replay(id) {
    let st = null;
    for (const rec of readJsonl(join(this.dir(id), "journal.jsonl"))) {
      if (rec.type === "created") st = { ...rec.state, seq: rec.seq ?? 0 };
      else if (rec.type === "patch" && st) Object.assign(st, rec.patch, typeof rec.seq === "number" ? { seq: rec.seq } : {});
    }
    return st;
  }

  update(id, patch) {
    return this.transition(id, () => patch);
  }

  // Atomic read-modify-write under the task lock. fn(cur) returns a patch, or null for "no change".
  transition(id, fn) {
    const dir = this.dir(id);
    return withLock(join(dir, "state"), () => {
      const cur = this.get(id);
      if (!cur) throw new Error(`no such task: ${id}`);
      const patch = fn(cur);
      if (!patch) return cur;
      const seq = (cur.seq ?? 0) + 1;
      const p = { ...patch, updated_at: nowIso() };
      appendJsonl(join(dir, "journal.jsonl"), { ts: p.updated_at, type: "patch", seq, patch: p }, Infinity);
      const next = { ...cur, ...p, seq };
      writeJsonAtomic(join(dir, "state.json"), next);
      return next;
    });
  }

  log(id, type, text) {
    appendJsonl(join(this.dir(id), "events.jsonl"), { ts: nowIso(), type, text: truncate(redact(text), 2000) });
  }

  events(id, n = 50) { return readJsonl(join(this.dir(id), "events.jsonl")).slice(-n); }
  brief(id) { return readFileSync(join(this.dir(id), "brief.md"), "utf8"); }

  appendProgress(id, segment, text) {
    const p = join(this.dir(id), "progress.md");
    const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
    writeFileAtomic(p, `${prev}\n## segment ${segment} (${nowIso()})\n${truncate(redact(text), 3000)}\n`);
  }

  // Only the tail goes into the next segment's prompt: progress summary, not full history.
  progressSummary(id, maxChars = 6000) {
    const p = join(this.dir(id), "progress.md");
    if (!existsSync(p)) return "";
    const s = readFileSync(p, "utf8");
    return s.length > maxChars ? `…\n${s.slice(-maxChars)}` : s;
  }

  writeResult(id, text) { writeFileAtomic(join(this.dir(id), "result.md"), `${redact(text).trimEnd()}\n`); }

  list() {
    if (!existsSync(this.tasks)) return [];
    return readdirSync(this.tasks).filter(validId).map((id) => {
      try { return this.get(id); } catch (e) { return { id, state: "corrupt", reason: String(e.message) }; }
    }).filter(Boolean);
  }

  // gc: drop a finished task's files but leave a tombstone, under the task lock, so a late or
  // retried submit of this id can never create it again. Tombstone first, then the rest.
  retire(id) {
    const dir = this.dir(id);
    withLock(join(dir, "state"), () => {
      writeJsonAtomic(join(dir, "fenced.json"), { id, reason: "retired by gc", fenced_at: nowIso() });
      for (const f of readdirSync(dir)) if (f !== "fenced.json" && !f.startsWith("state.lock")) rmSync(join(dir, f), { recursive: true, force: true });
    });
  }

  fenced(id) { return validId(id) && existsSync(join(this.tasks, id, "fenced.json")); }

  // ------------------------------------------------------------ batches (coordinator)
  batchPath(id) { if (!validId(id)) throw new Error(`invalid batch id: ${id}`); return join(this.batches, `${id}.json`); }
  getBatch(id) { const b = readJson(this.batchPath(id), null); return b && migrate(b, "batch"); }
  putBatch(b) { writeJsonAtomic(this.batchPath(b.id), { schema: STATE_SCHEMA, ...b, updated_at: nowIso() }); return b; }
  // Concurrent reports for one batch arrive from separate ssh rpc processes: never lose one.
  mutateBatch(id, fn) {
    return withLock(this.batchPath(id), () => {
      const cur = this.getBatch(id);
      const next = fn(cur);
      if (next) this.putBatch(next);
      return next || cur;
    });
  }
  tombstonePath(id) { return join(this.batches, "tombstones", `${validId(id) ? id : "_"}.json`); }
  getBatchTombstone(id) { return validId(id) ? readJson(this.tombstonePath(id), null) : null; }
  // gc of a batch view: the tombstone is written before the view goes, under the batch lock, so
  // batch-register can never recreate a gc'd id (an idempotency-key retry after retention).
  retireBatch(b, finalLine) {
    withLock(this.batchPath(b.id), () => {
      writeJsonAtomic(this.tombstonePath(b.id), { id: b.id, project: b.project, owner: b.owner, idempotency_key: b.idempotency_key ?? null,
        digest: b.digest ?? null, final: finalLine, acked_at: b.acked_at || null, retired_at: nowIso() });
      rmSync(this.batchPath(b.id), { force: true });
    });
  }
  listBatches() {
    return readdirSync(this.batches).filter((f) => f.endsWith(".json") && validId(f.slice(0, -5))).map((f) => this.getBatch(f.slice(0, -5))).filter(Boolean);
  }
}
