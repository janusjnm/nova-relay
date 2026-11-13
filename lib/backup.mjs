// backup.mjs — metadata snapshot, restore drill and upgrade/rollback plan.
//
//   snapshot  copies the task store metadata (states, journals, briefs, progress, results, batch
//             views, tombstones, outbox, pause/budget/notification/evidence ledgers) and a redacted
//             config into a new 0700 directory (files 0600) with a sha256 manifest. Secrets are not
//             included (see EXCLUDED).
//   restore   validates a snapshot (manifest, hashes, path safety, batch↔task integrity) and only
//             then writes it into an explicit, empty destination that is not the live home. Nothing
//             is started; tasks that were queued/running/paused are blocked; pending outbox entries
//             are held (never sent) unless --replay-outbox.
//   plan      (`migrate --dry-run`) what this version can read, what it cannot, and the rollback plan.
//
// A metadata backup does NOT contain git repositories, task branches (nova/<id>) or worktrees.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { CONFIG_SCHEMA } from "./config.mjs";
import { STATE_SCHEMA, Store } from "./store.mjs";
import { VERSION, readJson, redact, validId } from "./util.mjs";

export const SNAPSHOT_FORMAT = "nova-relay-snapshot";
export const SNAPSHOT_VERSION = 1;

export const EXCLUDED = [
  "secrets.env and every secret value (webhook URL/key, DeepSeek/provider keys, project env_file contents)",
  "executor credentials (~/.claude, ~/.codex, credential_files, key files) and ssh keys",
  "git repositories, task branches nova/<id> and worktrees — a metadata backup does NOT restore them (back them up with git bundle/your repo backups)",
  "segment logs (tasks/*/logs), leases, locks, PIDs, worker/heartbeat/host status files, CLI contract cache, handoff bundles",
];

// Relative paths (under the nova home) a snapshot may contain — the same list gates restore.
const TASK_FILES = "state\\.json|journal\\.jsonl(?:\\.1)?|brief\\.md|progress\\.md|result\\.md|events\\.jsonl(?:\\.1)?|approvals\\.jsonl|decisions\\.json|fenced\\.json";
const ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,80}";
export const ALLOWED = [
  new RegExp(`^tasks/${ID}/(?:${TASK_FILES})$`),
  new RegExp(`^batches/${ID}\\.json$`),
  new RegExp(`^batches/tombstones/${ID}\\.json$`),
  /^outbox\/[0-9a-f]{24}\.json$/,
  /^outbox\/sent\/[0-9a-f]{24}\.json$/,
  /^run\/(?:paused\.json|incidents\.json|routing-evidence\.jsonl(?:\.1)?|budget-\d{4}-\d{2}-\d{2}\.json|notify-\d{4}-\d{2}-\d{2}\.json)$/,
];
const allowed = (rel) => ALLOWED.some((re) => re.test(rel));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
// Real path of a path that may not exist yet: the nearest existing ancestor resolved (symlinks
// followed) + the rest, so a symlinked parent cannot hide where a new directory would land.
function realOfNew(p) {
  let cur = resolve(p), rest = [];
  while (!existsSync(cur) && dirname(cur) !== cur) { rest.unshift(cur.slice(dirname(cur).length).replace(/^\//, "")); cur = dirname(cur); }
  return join(realOr(cur), ...rest);
}

export class SnapshotError extends Error {
  constructor(msg, problems = []) { super(problems.length ? `${msg}:\n  - ${problems.join("\n  - ")}` : msg); this.problems = problems; }
}

// Config without values that could be secret: executor env values are dropped, then the whole text
// goes through redact(). The config only holds env var *names* for webhooks and keys.
export function redactConfig(cfg) {
  const c = structuredClone(cfg);
  for (const ex of Object.values(c.executors || {})) if (ex.env) ex.env = Object.fromEntries(Object.keys(ex.env).map((k) => [k, "[REDACTED]"]));
  return JSON.parse(redact(JSON.stringify(c)));
}

function walk(root, rel = "", out = [], skipped = []) {
  let names;
  try { names = readdirSync(join(root, rel)); } catch { return { out, skipped }; }
  for (const n of names.sort()) {
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(join(root, r));
    if (st.isSymbolicLink()) { if (allowed(r)) skipped.push(`${r} (symlink, not followed)`); continue; }
    if (st.isDirectory()) { if (!/^(?:worktrees|snapshots)$/.test(r) && !/\/logs$/.test(r)) walk(root, r, out, skipped); continue; }
    if (st.isFile() && allowed(r)) out.push(r);
  }
  return { out, skipped };
}

function emptyDir(p) {
  if (!existsSync(p)) return true;
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  return readdirSync(p).length === 0;
}

export function snapshot(cfg, { out, now = new Date() } = {}) {
  const home = realOr(cfg.home);
  const id = `snap-${now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${randomBytes(3).toString("hex")}`;
  const dest = resolve(out || join(cfg.home, "snapshots", id));
  if (!emptyDir(dest)) throw new SnapshotError(`${dest} exists and is not an empty directory`);
  if (inside(realOfNew(dest), home) && !inside(realOfNew(dest), join(home, "snapshots"))) throw new SnapshotError(`${dest} is inside the nova-relay home; use a path outside it or the default <home>/snapshots`);
  mkdirSync(join(dest, "home"), { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const { out: files, skipped } = walk(home);
  const entries = [];
  for (const rel of files) {
    const buf = readFileSync(join(home, rel));
    const target = join(dest, "home", rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, buf, { mode: 0o600, flag: "wx" });
    entries.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
  }
  writeFileSync(join(dest, "config.redacted.json"), `${JSON.stringify(redactConfig(cfg), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const manifest = { format: SNAPSHOT_FORMAT, format_version: SNAPSHOT_VERSION, id, created_at: now.toISOString(), relay_version: VERSION,
    state_schema: STATE_SCHEMA, config_schema: CONFIG_SCHEMA, self: cfg.self, coordinator: cfg.coordinator, source_home: cfg.home,
    excluded: EXCLUDED, skipped, files: entries };
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { id, dir: dest, files: entries.length, bytes: entries.reduce((a, e) => a + e.bytes, 0), skipped, excluded: EXCLUDED };
}

// ------------------------------------------------------------------ restore

function readManifest(src) {
  const p = join(src, "manifest.json");
  if (!existsSync(p) || !lstatSync(p).isFile()) throw new SnapshotError(`${src}: no manifest.json (not a nova-relay snapshot)`);
  let m;
  try { m = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new SnapshotError(`${p}: unreadable (${e.message})`); }
  if (m.format !== SNAPSHOT_FORMAT) throw new SnapshotError(`${p}: not a nova-relay snapshot`);
  if (!(m.format_version <= SNAPSHOT_VERSION)) throw new SnapshotError(`snapshot format ${m.format_version} is newer than this nova-relay (${VERSION}) supports (${SNAPSHOT_VERSION}); upgrade first`);
  if (!(m.state_schema <= STATE_SCHEMA)) throw new SnapshotError(`snapshot state schema ${m.state_schema} is newer than this nova-relay (${VERSION}, schema ${STATE_SCHEMA}); restore it with the version that wrote it`);
  if (!Array.isArray(m.files)) throw new SnapshotError(`${p}: no file list`);
  return m;
}

// Every manifest entry: a safe relative path from the allowlist, a regular file (no symlink) that
// really lies inside the snapshot, with the recorded hash. Returns { rel → Buffer } or throws.
function verifiedFiles(src, m) {
  const root = realOr(join(src, "home"));
  const problems = [], data = new Map();
  for (const f of m.files) {
    const rel = f?.path;
    if (typeof rel !== "string" || !rel || rel.includes("\0") || isAbsolute(rel) || rel.includes("\\") || normalize(rel) !== rel || rel.split("/").some((x) => x === ".." || x === "." || x === "")) { problems.push(`unsafe path in manifest: ${JSON.stringify(rel)}`); continue; }
    if (!allowed(rel)) { problems.push(`path not allowed in a snapshot: ${rel}`); continue; }
    if (data.has(rel)) { problems.push(`duplicate entry: ${rel}`); continue; }
    const p = join(root, rel);
    let st;
    try { st = lstatSync(p); } catch { problems.push(`missing file: ${rel}`); continue; }
    if (!st.isFile()) { problems.push(`not a regular file (symlink?): ${rel}`); continue; }
    if (!inside(realOr(p), root)) { problems.push(`resolves outside the snapshot: ${rel}`); continue; }
    const buf = readFileSync(p);
    if (sha256(buf) !== f.sha256) { problems.push(`hash mismatch: ${rel}`); continue; }
    data.set(rel, buf);
  }
  if (problems.length) throw new SnapshotError("snapshot failed verification; nothing was restored", problems);
  return data;
}

function taskState(data, id) {
  const s = data.get(`tasks/${id}/state.json`);
  if (s) { try { return JSON.parse(s.toString("utf8")); } catch { /* fall back to the journal */ } }
  const j = data.get(`tasks/${id}/journal.jsonl`);
  if (!j) return null;
  let st = null;
  for (const line of j.toString("utf8").split("\n")) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "created") st = { ...r.state }; else if (r.type === "patch" && st) Object.assign(st, r.patch);
  }
  return st;
}

// Referential integrity between batch views and tasks (only checkable on the coordinator, which
// holds the batch views): tasks point at a batch (or its tombstone); a batch entry delivered to
// this host has a task (or its tombstone) here.
export function integrityProblems(m, data) {
  const problems = [];
  const taskIds = new Set(), fenced = new Set(), batches = new Map(), tombs = new Set();
  for (const rel of data.keys()) {
    let x;
    if ((x = rel.match(/^tasks\/([^/]+)\/(state\.json|journal\.jsonl)$/))) taskIds.add(x[1]);
    else if ((x = rel.match(/^tasks\/([^/]+)\/fenced\.json$/))) fenced.add(x[1]);
    else if ((x = rel.match(/^batches\/tombstones\/([^/]+)\.json$/))) tombs.add(x[1]);
    else if ((x = rel.match(/^batches\/([^/]+)\.json$/))) {
      try { batches.set(x[1], JSON.parse(data.get(rel).toString("utf8"))); } catch { problems.push(`batch ${x[1]}: unreadable JSON`); }
    }
  }
  for (const id of taskIds) {
    const t = taskState(data, id);
    if (!t) { problems.push(`task ${id}: no readable state or journal`); continue; }
    if (t.id !== id) problems.push(`task ${id}: state says id ${t.id}`);
    if ((t.schema ?? 1) > STATE_SCHEMA) problems.push(`task ${id}: schema ${t.schema} is newer than this nova-relay`);
    if (m.coordinator === m.self && t.batch && !batches.has(t.batch) && !tombs.has(t.batch)) problems.push(`task ${id}: batch ${t.batch} is missing from the snapshot`);
  }
  for (const [bid, b] of batches) {
    if (b.id !== bid) problems.push(`batch ${bid}: file says id ${b.id}`);
    for (const [tid, e] of Object.entries(b.tasks || {})) {
      if (!validId(tid)) { problems.push(`batch ${bid}: invalid task id ${JSON.stringify(tid)}`); continue; }
      const delivered = e.host === m.self && !["submitting", "abandoned"].includes(e.state) && !e.fenced && e.verdict !== "FAIL submit";
      if (delivered && !taskIds.has(tid) && !fenced.has(tid)) problems.push(`batch ${bid}: task ${tid} on ${m.self} (${e.state}) is missing from the snapshot`);
    }
  }
  return problems;
}

export function restore(cfg, { from, dest, replayOutbox = false, now = new Date() } = {}) {
  if (!from) throw new SnapshotError("restore needs --from <snapshot dir>");
  if (!dest) throw new SnapshotError("restore needs --dest <empty dir> (it never restores into the live home implicitly)");
  const src = realOr(from);
  const target = resolve(dest);
  const live = realOr(cfg.home);
  for (const t of [target, realOfNew(target)]) {
    if (inside(t, live) || inside(live, t)) throw new SnapshotError(`--dest ${target} is the live nova-relay home ${live}, inside it, or contains it; restore into an isolated directory`);
    if (inside(t, src) || inside(src, t)) throw new SnapshotError(`--dest ${target} overlaps the snapshot ${src}`);
  }
  if (!emptyDir(target)) throw new SnapshotError(`--dest ${target} exists and is not an empty directory`);
  const m = readManifest(src);
  const data = verifiedFiles(src, m);
  const problems = integrityProblems(m, data);
  if (problems.length) throw new SnapshotError("snapshot failed the batch/task integrity check; nothing was restored", problems);

  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const realTarget = realpathSync(target);
  if (inside(realTarget, live) || inside(live, realTarget)) throw new SnapshotError(`--dest ${target} resolves into the live nova-relay home ${live}`);
  for (const [rel, buf] of data) {
    const p = join(realTarget, rel);
    if (!inside(p, realTarget)) throw new SnapshotError(`refusing to write outside --dest: ${rel}`);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    // The parent chain was created here; still never follow a symlink into place.
    if (!inside(realpathSync(dirname(p)), realTarget)) throw new SnapshotError(`refusing to write outside --dest: ${rel}`);
    writeFileSync(p, buf, { mode: 0o600, flag: "wx" });
  }

  // Restored tasks are inert: no lease/PID survives, and nothing is runnable until a human looks.
  const store = new Store(realTarget);
  const blocked = [], held = [];
  for (const t of store.list()) {
    if (!t?.id || t.state === "corrupt") continue;
    store.transition(t.id, (cur) => {
      const patch = { segment_pid: null, segment_pid_start: null, restored_from: m.id, restored_at: now.toISOString() };
      if (["queued", "running", "paused"].includes(cur.state)) {
        Object.assign(patch, { state: "blocked", restored_from_state: cur.state, resume_after: null,
          reason: `restored from snapshot ${m.id} (was ${cur.state}); not resumed automatically — the worktree and branch nova/${cur.id} are not part of the snapshot` });
        blocked.push(cur.id);
      }
      return patch;
    });
  }
  // Pending notifications are held, never replayed by default (no duplicate planner wakes).
  const ob = join(realTarget, "outbox");
  if (!replayOutbox && existsSync(ob)) {
    for (const f of readdirSync(ob).filter((x) => x.endsWith(".json"))) {
      mkdirSync(join(ob, "held"), { recursive: true, mode: 0o700 });
      renameSync(join(ob, f), join(ob, "held", f));
      held.push(f);
    }
  }
  const info = { restored_at: now.toISOString(), snapshot: m.id, from: src, relay_version: VERSION, files: data.size, blocked, held_outbox: held.length,
    replay_outbox: replayOutbox, worker_started: false, note: "metadata only; git branches/worktrees are not restored" };
  writeFileSync(join(realTarget, "RESTORED.json"), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { ...info, dest: realTarget };
}

// ------------------------------------------------------------------ upgrade plan (migrate --dry-run)

function schemaCounts(objs) {
  const c = {};
  for (const o of objs) { const v = o?.schema ?? 1; c[v] = (c[v] || 0) + 1; }
  return c;
}

export function migrationPlan(cfg, { from } = {}) {
  let tasks = [], batches = [], source, snap = null;
  if (from) {
    const src = realOr(from);
    snap = readManifest(src);
    const data = verifiedFiles(src, snap);
    for (const rel of data.keys()) {
      let x;
      if ((x = rel.match(/^tasks\/([^/]+)\/state\.json$/))) tasks.push(taskState(data, x[1]));
      else if (/^batches\/[^/]+\.json$/.test(rel)) { try { batches.push(JSON.parse(data.get(rel).toString("utf8"))); } catch { batches.push(null); } }
    }
    source = `snapshot ${snap.id} (nova-relay ${snap.relay_version})`;
  } else {
    const home = cfg.home;
    const tdir = join(home, "tasks");
    for (const id of existsSync(tdir) ? readdirSync(tdir).filter(validId) : []) tasks.push(readJson(join(tdir, id, "state.json"), null));
    const bdir = join(home, "batches");
    for (const f of existsSync(bdir) ? readdirSync(bdir).filter((x) => x.endsWith(".json")) : []) batches.push(readJson(join(bdir, f), null));
    source = `live home ${home}`;
  }
  const t = tasks.filter(Boolean), b = batches.filter(Boolean);
  const newer = [...t, ...b].filter((o) => (o.schema ?? 1) > STATE_SCHEMA).length;
  const unreadable = tasks.length - t.length + batches.length - b.length;
  const cannot = [];
  if (newer) cannot.push(`${newer} task/batch files with state schema > ${STATE_SCHEMA} (written by a newer nova-relay): refused, never rewritten`);
  if (snap && snap.format_version > SNAPSHOT_VERSION) cannot.push(`snapshot format ${snap.format_version}`);
  return {
    dry_run: true, source, relay_version: VERSION, state_schema: STATE_SCHEMA, config_schema: CONFIG_SCHEMA, snapshot_format: SNAPSHOT_VERSION,
    found: { tasks: schemaCounts(t), batches: schemaCounts(b), newer, unreadable },
    can_read: [`state/batch schema 1..${STATE_SCHEMA}`, `config schema <= ${CONFIG_SCHEMA}`, `snapshot format <= ${SNAPSHOT_VERSION}`],
    cannot_read: cannot.length ? cannot : ["nothing found that this version cannot read"],
    migrations: STATE_SCHEMA === 1 ? "none needed (schema 1 is the only schema; nothing is rewritten)" : `schema 1 → ${STATE_SCHEMA} on read`,
    rollback: [
      "1. before upgrading: `nova-relay snapshot --out <dir>` on every host (workers idle for a consistent copy)",
      "2. back up project repositories / nova/<task> branches separately (git bundle or your normal repo backup) — the snapshot does not contain them",
      "3. upgrade; run `nova-relay config-check` and `nova-relay doctor`",
      "4. to roll back: reinstall the previous nova-relay version; state written by a newer schema is refused by the older version, so restore the pre-upgrade snapshot into an empty directory (`nova-relay restore --from <dir> --dest <new dir>`), inspect it, and point NOVA_RELAY_HOME at it only deliberately",
      "5. restored queued/running/paused tasks are blocked and their outbox entries held; re-dispatch with the same --key or by hand after checking the branches",
    ],
    excluded: EXCLUDED,
  };
}
