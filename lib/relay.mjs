// relay.mjs — coordinator + host logic: dispatch, reports, batch wakes, worker, resume, tick, gc.
import { spawn } from "node:child_process";
import { existsSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, TERMINAL, WAKE_STATES } from "./store.mjs";
import { Outbox, batchWakeEvents, postWebhook } from "./notify.mjs";
import { call } from "./rpc.mjs";
import { parseBrief, validateBrief } from "./brief.mjs";
import { route } from "./routing.mjs";
import { runTask } from "./runner.mjs";
import { acquireLease, killGroup, leaseStatus, readLease, releaseLease, renewLease } from "./lock.mjs";
import { decide, pendingApprovals, readDecisions } from "./approvals.mjs";
import { pauseExecutor, readPaused, unpauseExecutor } from "./budget.mjs";
import { projectPaths, webhookFor } from "./config.mjs";
import { git, removeWorktree } from "./git.mjs";
import { fmtLocal, newId, nowIso, readJson, readJsonl, scopesOverlap, sleep, writeFileAtomic, writeJsonAtomic } from "./util.mjs";
import { ADAPTERS } from "./executors/index.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));

export function makeContext(cfg, { env = process.env, fetchImpl = fetch, sshCall, spawnWorker, backoffScale } = {}) {
  const ctx = { cfg, env, fetchImpl, sshCall, backoffScale, store: new Store(cfg.home), outbox: new Outbox(cfg.home), handlers: HANDLERS };
  ctx.spawnWorker = spawnWorker || (() => spawnDetachedWorker(ctx));
  ctx.report = (t) => report(ctx, t);
  ctx.reportPause = (executor, info) => sendToCoordinator(ctx, `pause:${executor}:${info.incident}`, "executor-paused", { executor, info });
  return ctx;
}

// ------------------------------------------------------------ host → coordinator
// Durable: every message goes through the outbox (dedup key), then a best-effort flush.
async function sendToCoordinator(ctx, key, method, payload) {
  const { cfg } = ctx;
  if (cfg.coordinator === cfg.self) return HANDLERS[method](ctx, payload);
  ctx.outbox.enqueue(key, { kind: "rpc", host: cfg.coordinator, method, payload });
  await flushOutbox(ctx).catch(() => {});
}

export function report(ctx, t) {
  const payload = { batch: t.batch, id: t.id, host: ctx.cfg.self, executor: t.executor, state: t.state, exit_code: t.exit_code,
    verdict: t.verdict, reason: t.reason, escalated: Boolean(t.escalated), wake_seq: t.wake_seq || 0, rev: t.rev || 0, auth_incident: t.state === "needs_auth" ? t.auth_incident || null : null,
    approvals: WAKE_STATES.has(t.state) ? pendingApprovals(ctx.store.dir(t.id)).map((a) => ({ req: a.req, category: a.category })) : [] };
  return sendToCoordinator(ctx, `report:${t.id}:${t.rev || 0}`, "report", payload);
}

export async function flushOutbox(ctx) {
  return ctx.outbox.flush(async (e) => {
    if (e.kind === "rpc") return call(ctx, e.host, e.method, e.payload, { tries: 1 });
    if (e.kind === "webhook") {
      if (e.payload?.batch && ctx.store.getBatch(e.payload.batch)?.acked) return; // already handled; drop
      const wh = webhookFor(ctx.cfg, e.project, ctx.env);
      if (wh.error) throw new Error(wh.error);
      return postWebhook(wh, e.payload, e.key, ctx.fetchImpl);
    }
    throw new Error(`unknown outbox kind ${e.kind}`);
  });
}

// ------------------------------------------------------------ coordinator side

function enqueueWakes(ctx, batch) {
  let n = 0;
  for (const ev of batchWakeEvents(batch)) {
    if (ctx.outbox.enqueue(ev.key, { kind: "webhook", project: batch.project, payload: ev.payload })) n++;
  }
  return n;
}

export const HANDLERS = {
  ping: () => ({ ok: true, now: nowIso() }),

  paused: (ctx) => readPaused(ctx.cfg.home),

  "executor-paused": (ctx, { executor, info }) => {
    if (info.reason === "auth") pauseExecutor(ctx.cfg.home, executor, "auth", null);
    else pauseExecutor(ctx.cfg.home, executor, info.reason, info.until);
    return { ok: true };
  },
  "executor-unpaused": (ctx, { executor }) => { unpauseExecutor(ctx.cfg.home, executor); return { ok: true }; },

  "batch-register": (ctx, { batch }) => {
    let existing = false;
    ctx.store.mutateBatch(batch.id, (cur) => {
      if (cur) { existing = true; return null; }
      return { ...batch, acked: false, created_at: nowIso() };
    });
    return existing ? { ok: true, existing: true } : { ok: true };
  },

  // Out-of-order / duplicate reports are harmless: a report only applies if its rev is newer.
  // Concurrent reports (separate ssh rpc processes) are serialized by the batch lock.
  report: async (ctx, r) => {
    let stale = false;
    const b = ctx.store.mutateBatch(r.batch, (cur) => {
      const b = cur || { id: r.batch, project: null, owner: null, tasks: {}, acked: false, created_at: nowIso() };
      const prev = b.tasks[r.id];
      if (prev && (prev.rev || 0) >= (r.rev || 0) && prev.state !== "queued") { stale = true; return null; }
      b.tasks[r.id] = { ...prev, ...r, updated_at: nowIso() };
      return b;
    });
    if (stale) return { ok: true, stale: true };
    if (b.project) enqueueWakes(ctx, b);
    await flushOutbox(ctx).catch(() => {});
    return { ok: true };
  },

  heartbeat: (ctx, { host }) => {
    // Coordinator's own clock: skew between box and VPS cannot fake a fresh heartbeat.
    writeJsonAtomic(join(ctx.cfg.home, "run", `heartbeat-${host}.json`), { host, received_at: nowIso() });
    return { ok: true, now: nowIso() };
  },

  pending: (ctx, { owner }) => ctx.store.listBatches()
    .filter((b) => !b.acked && (!owner || b.owner === owner) && batchWakeEvents(b).length)
    .map((b) => ({ batch: b.id, line: verdictLine(b) })),

  "batch-status": (ctx, { batch }) => {
    const b = ctx.store.getBatch(batch);
    if (!b) throw new Error(`no such batch: ${batch}`);
    return b;
  },

  locate: (ctx, { id }) => {
    for (const b of ctx.store.listBatches()) if (b.tasks[id]) return { host: b.tasks[id].host, batch: b.id };
    return { host: null };
  },

  ack: async (ctx, { batch, owner }) => {
    const b = ctx.store.getBatch(batch);
    if (!b) throw new Error(`no such batch: ${batch}`);
    if (owner && b.owner !== owner) throw new Error(`batch ${batch} belongs to ${b.owner}, not ${owner}`);
    ctx.store.mutateBatch(batch, (cur) => (cur.acked ? null : { ...cur, acked: true, acked_at: nowIso() }));
    const byHost = {};
    for (const [id, t] of Object.entries(b.tasks)) (byHost[t.host] ||= []).push(id);
    for (const [host, ids] of Object.entries(byHost)) {
      if (host === ctx.cfg.self) HANDLERS.acked(ctx, { ids });
      else ctx.outbox.enqueue(`acked:${batch}:${host}`, { kind: "rpc", host, method: "acked", payload: { ids } });
    }
    await flushOutbox(ctx).catch(() => {});
    return { ok: true, line: verdictLine(b) };
  },

  // ---------------------------------------------------------- task-host side
  submit: (ctx, { tasks }) => {
    const ids = [];
    for (const { task, brief } of tasks) { ctx.store.create(task, brief); ids.push(task.id); }
    return { ok: true, ids };
  },

  "wake-worker": (ctx) => { ctx.spawnWorker(); return { ok: true }; },

  // Quota reroute across hosts: adopt a task from another host, importing its branch from a
  // git bundle (a local file fetch, not a push). If the bundle cannot be applied (base commit
  // missing here), the task restarts from base with the progress summary.
  handoff: (ctx, { task, brief, progress, bundle }) => {
    if (ctx.store.exists(task.id)) return { ok: true, existing: true };
    let note = "no commits to import";
    const t = { ...task };
    if (bundle) {
      const { repo } = projectPaths(ctx.cfg, t.project);
      const f = join(ctx.cfg.home, "run", `handoff-${t.id}.bundle`);
      writeFileSync(f, Buffer.from(bundle, "base64"), { mode: 0o600 });
      try {
        git(repo, ["bundle", "verify", f]);
        git(repo, ["fetch", "--no-tags", f, `+refs/heads/nova/${t.id}:refs/heads/nova/${t.id}`]);
        note = "branch imported from bundle";
      } catch (e) {
        note = `bundle not applied (${e.message.slice(0, 160)}); restarting from base with the progress summary`;
        delete t.base_commit;
      } finally { rmSync(f, { force: true }); }
    } else delete t.base_commit;
    ctx.store.create({ ...t, state: "queued" }, brief);
    if (progress) writeFileAtomic(join(ctx.store.dir(t.id), "progress.md"), `${progress}\n`);
    ctx.store.log(t.id, "handoff", `${t.reason || "rerouted"}; ${note}`);
    ctx.spawnWorker();
    return { ok: true, note };
  },

  acked: (ctx, { ids }) => {
    for (const id of ids) if (ctx.store.exists(id)) {
      const t = ctx.store.get(id);
      if (!t.acked) ctx.store.update(id, { acked: true, acked_at: nowIso() });
    }
    return { ok: true };
  },

  status: (ctx, { id }) => ({ ...ctx.store.get(id), approvals: pendingApprovals(ctx.store.dir(id)) }),
  log: (ctx, { id, n = 30 }) => ctx.store.events(id, n),

  approve: (ctx, p) => decideTask(ctx, p, true),
  deny: (ctx, p) => decideTask(ctx, p, false),

  "resume-all": (ctx) => resumeAll(ctx),

  cancel: async (ctx, { id, owner }) => {
    const t = ctx.store.get(id);
    if (!t) throw new Error(`no such task: ${id}`);
    if (owner && t.owner !== owner) throw new Error(`task ${id} belongs to ${t.owner}, not ${owner}`);
    if (TERMINAL.has(t.state) || t.state === "moved") return { ok: true, state: t.state };
    // The worker sees the state on its next lease renewal and kills the segment.
    const nt = ctx.store.transition(id, (cur) => (TERMINAL.has(cur.state) ? null : { state: "cancelled", exit_code: 130, reason: "cancelled by owner", rev: (cur.rev || 0) + 1 }));
    if (nt.state === "cancelled") await ctx.report(nt);
    return { ok: true, state: nt.state };
  },
};

async function decideTask(ctx, { id, req, owner }, approve) {
  const t = ctx.store.get(id);
  if (!t) throw new Error(`no such task: ${id}`);
  if (owner && t.owner !== owner) throw new Error(`task ${id} belongs to ${t.owner}, not ${owner}`);
  const r = decide(ctx.store.dir(id), req, approve);
  if (!r) throw new Error(`no approval request ${req} on ${id}`);
  ctx.store.log(id, approve ? "approved" : "denied", `${r.category}: ${r.subject}`);
  if (pendingApprovals(ctx.store.dir(id)).length) return { ok: true, state: t.state, more: true };
  // Decisions on audit requests (operations an executor without a pre-hook already ran) only
  // take effect once all of them are decided: any deny fails the task.
  const decided = readJsonl(join(ctx.store.dir(id), "approvals.jsonl"));
  const deniedAudit = decided.some((a) => a.kind === "audit" && readDecisions(ctx.store.dir(id)).denied.includes(a.subject));
  let next;
  if (r.kind === "merge") next = approve ? { state: "done", exit_code: 0, reason: "merge conflict acknowledged by owner" } : { state: "failed", exit_code: 1, reason: "merge conflict; owner denied" };
  else if (deniedAudit) next = { state: "failed", exit_code: 1, reason: "owner rejected an operation the executor already ran" };
  else next = { state: "queued", reason: approve ? "approved; resuming" : "denied; resuming without it" };
  const nt = ctx.store.transition(id, (cur) => (cur.state === "needs_approval" ? { ...next, rev: (cur.rev || 0) + 1 } : null));
  if (nt.state !== next.state) return { ok: true, state: nt.state, note: `task is ${nt.state}, not waiting for approval` };
  await ctx.report(nt);
  if (next.state === "queued") ctx.spawnWorker();
  return { ok: true, state: next.state };
}

// ------------------------------------------------------------ verdict

export function verdictLine(b) {
  const tasks = Object.entries(b.tasks || {});
  const done = tasks.filter(([, t]) => t.state === "done").length;
  const attention = tasks.filter(([, t]) => t.state !== "done").map(([id, t]) => {
    const extra = t.approvals?.length ? ` req=${t.approvals.map((a) => a.req).join(",")}` : t.verdict && t.state === "failed" ? ` ${t.verdict}` : "";
    return `${id} ${t.state}${extra}`;
  });
  const allTerminal = tasks.length > 0 && tasks.every(([, t]) => TERMINAL.has(t.state));
  const head = allTerminal ? (done === tasks.length ? "PASS" : "FAIL") : "WAIT";
  return `batch ${b.id} ${head} ${done}/${tasks.length}${attention.length ? ` | ${attention.join("; ")}` : ""}`.slice(0, 500);
}

// ------------------------------------------------------------ dispatch

export async function dispatch(ctx, { project, owner, briefs }) {
  const { cfg } = ctx;
  const parsed = briefs.map(({ name, text }) => ({ name, text, brief: parseBrief(text) }));
  const problems = [];
  const textTypes = cfg.routing.rules.filter((r) => ADAPTERS[cfg.executors[r.executor]?.adapter]?.kind === "text").map((r) => r.type);
  for (const p of parsed) for (const msg of validateBrief(p.brief, { textTypes })) problems.push(`${p.name}: ${msg}`);
  if (problems.length) throw new Error(`invalid brief(s):\n  - ${problems.join("\n  - ")}`);

  const paused = await call(ctx, cfg.coordinator, "paused", {});
  const batchId = newId("b");
  const pr = cfg.projects[project];
  const tasks = parsed.map((p) => {
    const r = route(cfg, p.brief, { project, paused });
    return { task: { id: newId("t"), batch: batchId, project, owner: owner || pr?.owner, type: p.brief.type, executor: r.executor, host: r.host, scope: p.brief.scope, rerouted: r.rerouted, pinned: r.pinned }, brief: p.text, name: p.name };
  });
  const batch = { id: batchId, project, owner: owner || pr.owner, expected: tasks.length,
    tasks: Object.fromEntries(tasks.map(({ task }) => [task.id, { host: task.host, executor: task.executor, state: "queued", rev: 0 }])) };
  await call(ctx, cfg.coordinator, "batch-register", { batch });

  const byHost = {};
  for (const t of tasks) (byHost[t.task.host] ||= []).push(t);
  const errors = [];
  for (const [host, list] of Object.entries(byHost)) {
    try {
      await call(ctx, host, "submit", { tasks: list.map(({ task, brief }) => ({ task, brief })) });
      await call(ctx, host, "wake-worker", {});
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
      // Mark them failed so the batch can still complete and wake the planner.
      for (const { task } of list) await call(ctx, cfg.coordinator, "report", { batch: batchId, id: task.id, host, executor: task.executor, state: "failed", exit_code: 1, verdict: "FAIL submit", reason: `submit to ${host} failed`, rev: 1 }).catch(() => {});
    }
  }
  return { batch: batchId, tasks: tasks.map(({ task, name }) => ({ id: task.id, name, executor: task.executor, host: task.host, rerouted: task.rerouted })), errors };
}

// ------------------------------------------------------------ worker

export function spawnDetachedWorker(ctx) {
  const log = openSync(join(ctx.cfg.home, "run", "worker.log"), "a", 0o600);
  const child = spawn(process.execPath, [CLI, "worker"], { detached: true, stdio: ["ignore", log, log], env: ctx.env });
  child.unref();
}

function runnable(ctx, t, now = Date.now()) {
  if (t.acked || t.host !== ctx.cfg.self) return false;
  if (t.state === "queued") return true;
  return t.state === "paused" && (!t.resume_after || Date.parse(t.resume_after) <= now);
}

// One worker per host. dispatch, approve, resume and tick all call spawnWorker(); extra workers
// exit at once, so max_parallel and the file-scope locks are enforced by a single process.
// The running worker polls for new tasks; before exiting it releases the host lease and checks
// once more, so a task queued at that instant is never stranded.
export async function worker(ctx, { pollMs = 5000, once = false } = {}) {
  const leasePath = join(ctx.cfg.home, "run", "worker.lease");
  const owner = `${ctx.cfg.self}:worker:${process.pid}`;
  const ttl = ctx.cfg.limits.lease_ttl_sec * 1000;
  for (;;) {
    if (!acquireLease(leasePath, owner, ttl)) return "another worker is running";
    const renew = setInterval(() => renewLease(leasePath, owner, ttl), Math.max(1000, ttl / 3));
    try { await workLoop(ctx, { pollMs, once }); } finally { clearInterval(renew); releaseLease(leasePath, owner); }
    if (once || !ctx.store.list().some((t) => runnable(ctx, t))) return "idle";
  }
}

async function workLoop(ctx, { pollMs, once }) {
  const running = new Map(); // id → { promise, task }
  for (;;) {
    const all = ctx.store.list();
    const tasks = all.filter((t) => !running.has(t.id) && runnable(ctx, t))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const t of tasks) {
      const ex = ctx.cfg.executors[t.executor];
      const sameExec = [...running.values()].filter((r) => r.task.executor === t.executor).length;
      if (ex && sameExec >= ex.limits.max_parallel) continue;
      // File-scope lock: overlapping scopes in the same project never run concurrently.
      const clash = [...running.values()].some((r) => r.task.project === t.project && scopesOverlap(r.task.scope, t.scope)) ||
        all.some((o) => o.id !== t.id && o.project === t.project && o.state === "running" && !running.has(o.id) &&
          ["held", "frozen"].includes(leaseStatus(readLease(join(ctx.store.dir(o.id), "lease.json")))) && scopesOverlap(o.scope, t.scope));
      if (clash) continue;
      const p = runTask(ctx, t.id).catch((e) => { ctx.store.log(t.id, "error", `runner crashed: ${e.stack || e}`); return "error"; })
        .finally(() => running.delete(t.id));
      running.set(t.id, { promise: p, task: t });
    }
    if (!running.size) return;
    if (once) { await Promise.all([...running.values()].map((r) => r.promise)); return; }
    await Promise.race([sleep(pollMs), ...[...running.values()].map((r) => r.promise)]);
  }
}

// Idempotent: safe to run from a timer, the watchdog, after a reboot, or twice at once.
//
// "frozen" = lease expired but the holder process is alive. That is exactly what a healthy
// worker looks like in the first seconds after the box wakes from sleep (its renew timer has not
// fired yet), so wall-clock overdue time is meaningless here. Instead the first observation is
// recorded and the holder is only killed if it is *still* not renewing 3×TTL later, as measured
// by consecutive checks.
export async function resumeAll(ctx, now = Date.now()) {
  const out = { resumed: [], frozen: [], running: [] };
  for (const t of ctx.store.list()) {
    if (t.host !== ctx.cfg.self || t.acked) continue;
    if (t.state === "running") {
      const dir = ctx.store.dir(t.id);
      const leasePath = join(dir, "lease.json");
      const frozenPath = join(dir, "lease.frozen.json");
      const lease = readLease(leasePath);
      const st = leaseStatus(lease, now);
      if (st === "held") { rmSync(frozenPath, { force: true }); out.running.push(t.id); continue; }
      if (st === "frozen") {
        const seen = readJson(frozenPath, null);
        if (!seen || seen.expires_at !== lease.expires_at) {
          writeJsonAtomic(frozenPath, { expires_at: lease.expires_at, first_seen: new Date(now).toISOString() });
          try { process.kill(lease.pid, "SIGCONT"); } catch { /* gone */ }
          out.frozen.push(t.id);
          continue;
        }
        if (now - Date.parse(seen.first_seen) < 3 * lease.ttl_ms) { out.frozen.push(t.id); continue; }
        try { process.kill(lease.pid, "SIGKILL"); } catch { /* gone */ }
      }
      rmSync(frozenPath, { force: true });
      // The dead worker's executor runs in its own process group: do not leave it writing.
      if (killGroup(t.segment_pid, t.segment_pid_start)) ctx.store.log(t.id, "resume", `killed orphaned segment process group ${t.segment_pid}`);
      const nt = ctx.store.transition(t.id, (cur) => (cur.state === "running" ? { state: "queued", reason: `resumed after ${st} lease`, segment_pid: null, segment_pid_start: null } : null));
      if (nt.state !== "queued") continue;
      ctx.store.log(t.id, "resume", `lease ${st}; re-queued from segment ${t.segments}`);
      out.resumed.push(t.id);
    } else if (runnable(ctx, t, now)) out.resumed.push(t.id);
  }
  if (out.resumed.length) ctx.spawnWorker();
  return out;
}

// ------------------------------------------------------------ heartbeat fallback (coordinator)

export function checkHeartbeats(ctx, now = Date.now()) {
  const { cfg } = ctx;
  const fired = [];
  const missMs = cfg.limits.heartbeat_miss_minutes * 60_000;
  for (const b of ctx.store.listBatches()) {
    if (b.acked) continue;
    for (const host of new Set(Object.values(b.tasks).filter((t) => !TERMINAL.has(t.state)).map((t) => t.host))) {
      if (host === cfg.self) continue;
      const hb = readJson(join(cfg.home, "run", `heartbeat-${host}.json`), null);
      const last = hb ? Date.parse(hb.received_at) : Date.parse(b.created_at);
      if (now - last > missMs) {
        const key = `${b.id}:${host}:unreachable:${hb?.received_at || "never"}`;
        if (ctx.outbox.enqueue(key, { kind: "webhook", project: b.project, payload: { source: "nova-relay", batch: b.id, id: "*", state: `${host}_unreachable`, exit_code: null } })) fired.push(key);
      }
    }
  }
  return fired;
}

// ------------------------------------------------------------ gc

export function gc(ctx, now = Date.now()) {
  const { cfg, store } = ctx;
  const keepMs = cfg.limits.retention_days * 86400_000;
  const removed = { worktrees: 0, tasks: 0, batches: 0, outbox: 0 };
  for (const t of store.list()) {
    // Never delete unacknowledged work. A task moved to another host (quota reroute) lives on
    // there; its branch here is kept, its worktree and task dir are not needed any more.
    if (!t.acked && t.state !== "moved") continue;
    if (t.worktree && existsSync(t.worktree)) {
      try { removeWorktree(projectPaths(cfg, t.project).repo, t.worktree); removed.worktrees++; } catch { /* project gone */ }
    }
    if (now - Date.parse(t.acked_at || t.moved_at || t.updated_at) > keepMs) { store.remove(t.id); removed.tasks++; }
  }
  for (const b of store.listBatches()) {
    if (b.acked && now - Date.parse(b.acked_at || b.updated_at) > keepMs) { rmSync(store.batchPath(b.id), { force: true }); removed.batches++; }
  }
  const sent = join(cfg.home, "outbox", "sent");
  if (existsSync(sent)) for (const f of readdirSync(sent)) {
    const p = join(sent, f);
    if (f !== ".keep" && now - statSync(p).mtimeMs > keepMs) { rmSync(p, { force: true }); removed.outbox++; }
  }
  for (const t of store.list()) {
    const d = store.dir(t.id);
    // Leftovers of crashes: lease candidates, stolen locks, tmp files of interrupted atomic writes.
    for (const f of readdirSync(d)) if (/\.(stale|cand)-|\.tmp-\d+-/.test(f) && now - statSync(join(d, f)).mtimeMs > 3600_000) rmSync(join(d, f), { force: true });
  }
  return removed;
}

// ------------------------------------------------------------ tick (timer on every host)

export async function tick(ctx) {
  const { cfg } = ctx;
  const res = { host: cfg.self, at: nowIso() };
  if (cfg.coordinator !== cfg.self) {
    try { await call(ctx, cfg.coordinator, "heartbeat", { host: cfg.self }); res.heartbeat = "ok"; } catch (e) { res.heartbeat = e.message; }
  }
  res.resume = await resumeAll(ctx);
  if (cfg.coordinator === cfg.self) {
    res.heartbeat_wakes = checkHeartbeats(ctx);
    for (const b of ctx.store.listBatches()) if (b.project) enqueueWakes(ctx, b);
  }
  res.outbox = await flushOutbox(ctx).catch((e) => [{ ok: false, error: e.message }]);
  res.gc = gc(ctx);
  return res;
}

// Watchdog (VPS): tick locally, then ask each executor host to resume its tasks over ssh.
export async function watchdog(ctx) {
  const res = await tick(ctx);
  res.hosts = {};
  const hosts = new Set(Object.values(ctx.cfg.executors).map((e) => e.host).filter((h) => h !== ctx.cfg.self));
  for (const h of hosts) {
    try { res.hosts[h] = await call(ctx, h, "resume-all", {}, { tries: 3, baseMs: 2000 }); }
    catch (e) { res.hosts[h] = { unreachable: e.message, fallback: "heartbeat" }; }
  }
  return res;
}

export const showTime = (ctx, iso) => fmtLocal(iso, ctx.cfg.display_tz);
