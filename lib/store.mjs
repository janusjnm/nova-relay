// store.mjs — on-disk task store (the source of truth).
//
//   <home>/tasks/<id>/brief.md        the brief as written by the planner
//   <home>/tasks/<id>/state.json      current state (atomic tmp+rename writes)
//   <home>/tasks/<id>/journal.jsonl   append-only state patches; replayed if state.json is corrupt
//   <home>/tasks/<id>/events.jsonl    log lines (redacted, rotated)
//   <home>/tasks/<id>/progress.md     per-segment summaries carried into the next segment
//   <home>/tasks/<id>/result.md       final result text (redacted)
//   <home>/batches/<id>.json          batch view (on the coordinator)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VERSION, appendJsonl, nowIso, readJson, readJsonl, redact, truncate, validId, writeFileAtomic, writeJsonAtomic } from "./util.mjs";

export const STATE_SCHEMA = 1;
export const TERMINAL = new Set(["done", "failed", "cancelled"]);
export const WAKE_STATES = new Set(["needs_approval", "needs_auth", "blocked"]);
export const STATES = new Set(["queued", "running", "paused", ...WAKE_STATES, ...TERMINAL]);

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
    if (existsSync(join(dir, "journal.jsonl"))) return this.get(task.id); // idempotent submit
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = nowIso();
    const st = {
      schema: STATE_SCHEMA, relay_version: VERSION, state: "queued", reason: null, exit_code: null, verdict: null,
      created_at: now, updated_at: now, segments: 0, segment_failures: 0, local_retries: 0, quota_pauses: 0,
      session_id: null, session_segments: 0, resume_after: null, started_at: null, wake_seq: 0, acked: false,
      ...task,
    };
    writeFileAtomic(join(dir, "brief.md"), briefText);
    appendJsonl(join(dir, "journal.jsonl"), { ts: now, type: "created", state: st }, Infinity);
    writeJsonAtomic(join(dir, "state.json"), st);
    return st;
  }

  get(id) {
    const dir = this.dir(id);
    let st;
    try {
      st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    } catch {
      st = this.replay(id); // corrupt or missing state.json → rebuild from the journal
      if (!st) return null;
      writeJsonAtomic(join(dir, "state.json"), st);
      this.log(id, "recovered", "state.json rebuilt from journal");
    }
    return migrate(st);
  }

  replay(id) {
    let st = null;
    for (const rec of readJsonl(join(this.dir(id), "journal.jsonl"))) {
      if (rec.type === "created") st = { ...rec.state };
      else if (rec.type === "patch" && st) Object.assign(st, rec.patch);
    }
    return st;
  }

  update(id, patch) {
    const dir = this.dir(id);
    const cur = this.get(id);
    if (!cur) throw new Error(`no such task: ${id}`);
    const p = { ...patch, updated_at: nowIso() };
    appendJsonl(join(dir, "journal.jsonl"), { ts: p.updated_at, type: "patch", patch: p }, Infinity);
    const next = { ...cur, ...p };
    writeJsonAtomic(join(dir, "state.json"), next);
    return next;
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

  remove(id) { rmSync(this.dir(id), { recursive: true, force: true }); }

  // ------------------------------------------------------------ batches (coordinator)
  batchPath(id) { if (!validId(id)) throw new Error(`invalid batch id: ${id}`); return join(this.batches, `${id}.json`); }
  getBatch(id) { const b = readJson(this.batchPath(id), null); return b && migrate(b, "batch"); }
  putBatch(b) { writeJsonAtomic(this.batchPath(b.id), { schema: STATE_SCHEMA, ...b, updated_at: nowIso() }); return b; }
  listBatches() {
    return readdirSync(this.batches).filter((f) => f.endsWith(".json")).map((f) => this.getBatch(f.slice(0, -5))).filter(Boolean);
  }
}
