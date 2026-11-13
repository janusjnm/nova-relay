// relay.mjs — coordinator + host logic: dispatch, reports, batch wakes, worker, resume, tick, gc.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, TERMINAL, WAKE_STATES } from "./store.mjs";
import { Outbox, batchWakeEvents, postWebhook } from "./notify.mjs";
import { call } from "./rpc.mjs";
import { parseBrief, validateBrief } from "./brief.mjs";
import { route } from "./routing.mjs";
import { runTask } from "./runner.mjs";
import { acquireLease, killConfirmed, killGroupConfirmed, leaseStatus, readLease, releaseLease, renewLease } from "./lock.mjs";
import { decide, pendingApprovals, readDecisions } from "./approvals.mjs";
import { pauseExecutor, readPaused, unpauseExecutor } from "./budget.mjs";
import { configSecretNames, projectPaths, webhookFor } from "./config.mjs";
import { git, removeWorktree } from "./git.mjs";
import { addSecretNames, addSecrets, fmtLocal, isSecretName, newId, nowIso, readJson, readJsonl, scopesOverlap, sleep, writeFileAtomic, writeJsonAtomic } from "./util.mjs";
import { ADAPTERS } from "./executors/index.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));

export function makeContext(cfg, { env = process.env, fetchImpl = fetch, sshCall, spawnWorker, backoffScale } = {}) {
  const ctx = { cfg, env, fetchImpl, sshCall, backoffScale, store: new Store(cfg.home), outbox: new Outbox(cfg.home), handlers: HANDLERS };
  // Secrets by declaration (config url_env/key_env, secrets.env names): stripped from executor and
  // acceptance envs, and their values redacted, whatever the variable is called.
  addSecretNames(configSecretNames(cfg));
  addSecrets(Object.entries(env).filter(([k]) => isSecretName(k)).map(([, v]) => v));
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

function reportPayload(ctx, t) {
  return { batch: t.batch, id: t.id, host: ctx.cfg.self, executor: t.executor, state: t.state, exit_code: t.exit_code,
    verdict: t.verdict, reason: t.reason, escalated: Boolean(t.escalated), wake_seq: t.wake_seq || 0, rev: t.rev || 0, auth_incident: t.state === "needs_auth" ? t.auth_incident || null : null,
    approvals: WAKE_STATES.has(t.state) ? pendingApprovals(ctx.store.dir(t.id)).map((a) => ({ req: a.req, category: a.category })) : [] };
}

export function report(ctx, t) {
  return sendToCoordinator(ctx, `report:${t.id}:${t.rev || 0}`, "report", reportPayload(ctx, t));
}

export async function flushOutbox(ctx, opts) {
  return ctx.outbox.flush(async (e) => {
    if (e.kind === "rpc") return call(ctx, e.host, e.method, e.payload, { tries: 1 });
    if (e.kind === "webhook") {
      if (e.payload?.batch && ctx.store.getBatch(e.payload.batch)?.acked) return; // already handled; drop
      const wh = webhookFor(ctx.cfg, e.project, ctx.env);
      if (wh.error) throw new Error(wh.error);
      return postWebhook(wh, e.payload, e.key, ctx.fetchImpl);
    }
    throw new Error(`unknown outbox kind ${e.kind}`);
  }, opts);
}

// ------------------------------------------------------------ coordinator side

// Printed by every `abandon` (dry run or not) and returned in its JSON.
export const abandonWarning = (host) => `WARNING: abandon only changes the coordinator's batch view. It does NOT stop anything on ${host}. ` +
  `If ${host} is running (asleep, partitioned, or merely unreachable from here), its task processes may still run detached and keep ` +
  `changing their worktrees and nova/<task> branches. A cancel is queued and delivered only if ${host} becomes reachable again; until ` +
  `then nothing is confirmed stopped. Late reports from ${host} for these entries are recorded but ignored for this batch.`;

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

  // Idempotent per batch id. An existing batch (or the tombstone of a gc'd one) is returned, never
  // overwritten: with a caller-supplied idempotency key the id is derived from the key, so a retry
  // lands here and resumes the batch instead of creating a second one.
  "batch-register": (ctx, { batch }) => {
    let existing = null;
    ctx.store.mutateBatch(batch.id, (cur) => {
      if (cur) { existing = cur; return null; }
      const tomb = ctx.store.getBatchTombstone(batch.id);
      if (tomb) { existing = { ...tomb, retired: true }; return null; }
      return { ...batch, acked: false, created_at: nowIso() };
    });
    return existing ? { ok: true, existing: true, batch: existing } : { ok: true };
  },

  "batch-lookup": (ctx, { batch }) => {
    const b = ctx.store.getBatch(batch);
    if (b) return { batch: b };
    const tomb = ctx.store.getBatchTombstone(batch);
    return { batch: tomb ? { ...tomb, retired: true } : null };
  },

  // A (re)submit of entries still "submitting" is about to happen: the tick's reconcile hint
  // counts from here, so it does not fence a resumed dispatch it could simply wait for.
  "submit-attempt": (ctx, { batch, ids }) => {
    ctx.store.mutateBatch(batch, (cur) => {
      if (!cur) return null;
      for (const id of ids) if (cur.tasks[id]?.state === "submitting" && !cur.tasks[id].reported) cur.tasks[id] = { ...cur.tasks[id], attempt_at: nowIso() };
      return cur;
    });
    return { ok: true };
  },

  // Out-of-order / duplicate reports are harmless: a report only applies if its rev is newer.
  // Concurrent reports (separate ssh rpc processes) are serialized by the batch lock.
  report: async (ctx, r) => {
    let stale = false, ignored = false;
    const b = ctx.store.mutateBatch(r.batch, (cur) => {
      const b = cur || { id: r.batch, project: null, owner: null, tasks: {}, acked: false, created_at: nowIso() };
      const prev = b.tasks[r.id];
      // The operator abandoned this entry: a late report is kept for the record only. It never
      // changes the entry or the batch verdict (no second life of the batch).
      if (prev?.abandoned) {
        ignored = true;
        if ((prev.late?.rev ?? -1) >= (r.rev || 0)) return null;
        b.tasks[r.id] = { ...prev, late: { state: r.state, verdict: r.verdict ?? null, rev: r.rev || 0, at: nowIso() } };
        return b;
      }
      // Only the registration placeholder (rev 0, never reported) yields to an equal rev. A task
      // that is legitimately "queued" again (approved, unpaused, rerouted) has a reported rev too,
      // and a delayed older report must not roll it back.
      if (prev && (prev.rev || 0) >= (r.rev || 0) && (prev.reported || !["queued", "submitting"].includes(prev.state))) { stale = true; return null; }
      b.tasks[r.id] = { ...prev, ...r, reported: true, updated_at: nowIso() };
      return b;
    });
    if (stale) return { ok: true, stale: true };
    if (ignored) return { ok: true, ignored: "abandoned" };
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
    // Acked tasks are never run again: acking a batch with unfinished tasks would strand them.
    const open = Object.entries(b.tasks).filter(([, t]) => !TERMINAL.has(t.state)).map(([id, t]) => `${id} ${t.state}`);
    if (open.length && !b.acked) throw new Error(`batch ${batch} is not finished (${open.join(", ")}); approve/deny, unpause or cancel those tasks first`);
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

  // Delivery confirmed by the task host (dispatch got a submit reply). Only unconfirmed,
  // never-reported entries change; a host report that already arrived is newer anyway.
  "submit-confirmed": (ctx, { batch, ids }) => {
    ctx.store.mutateBatch(batch, (cur) => {
      if (!cur) return null;
      let n = 0;
      for (const id of ids) {
        const e = cur.tasks[id];
        if (e && e.state === "submitting" && !e.reported) { cur.tasks[id] = { ...e, state: "queued", submit_unknown: false }; n++; }
      }
      return n ? cur : null;
    });
    return { ok: true };
  },

  // Delivery unknown (submit and the immediate fence both failed): the tick reconciles at once
  // instead of waiting for the grace period. The entries stay non-terminal until then.
  "submit-unknown": (ctx, { batch, ids, error }) => {
    ctx.store.mutateBatch(batch, (cur) => {
      if (!cur) return null;
      for (const id of ids) if (cur.tasks[id]?.state === "submitting") cur.tasks[id] = { ...cur.tasks[id], submit_unknown: true, submit_error: String(error || "").slice(0, 200) };
      return cur;
    });
    return { ok: true };
  },

  // Apply fence results from a task host: an existing task's real state (as a report), or a
  // fenced id as a definite "FAIL submit" (the host will refuse to create it from now on).
  "submit-reconciled": async (ctx, { batch, host, results }) => {
    for (const r of results) {
      if (r.report) await HANDLERS.report(ctx, r.report);
      else if (r.fenced) {
        await HANDLERS.report(ctx, { batch, id: r.id, host, state: "failed", exit_code: 1, verdict: "FAIL submit", fenced: true,
          reason: `not delivered to ${host} (fenced: the host will not create it)`, escalated: false, wake_seq: 0, rev: 1, auth_incident: null, approvals: [] });
      }
    }
    return { ok: true };
  },

  // Operator gives up on the unresolved entries of one unreachable host (`nova-relay abandon`).
  // Never automatic. It changes the coordinator's batch view only: nothing on that host is known
  // to have stopped. A cancel ("abandoned") is queued for the host and delivered if it ever comes
  // back; late reports for these entries are recorded but never applied (see report).
  abandon: async (ctx, { batch, host, owner, confirm }) => {
    const b = ctx.store.getBatch(batch);
    if (!b) throw new Error(`no such batch: ${batch}`);
    if (owner && b.owner !== owner) throw new Error(`batch ${batch} belongs to ${b.owner}, not ${owner}`);
    if (b.acked) throw new Error(`batch ${batch} is already acked`);
    if (!host) throw new Error("abandon needs --host");
    if (host === ctx.cfg.self) throw new Error(`${host} is the coordinator itself and reachable: use cancel <task> instead`);
    const warning = abandonWarning(host);
    const open = Object.entries(b.tasks).filter(([, e]) => e.host === host && !TERMINAL.has(e.state)).map(([id]) => id);
    if (!open.length) return { ok: true, batch, host, abandoned: [], warning, note: `no unresolved entries on ${host}` };
    if (!confirm) return { ok: true, batch, host, dry_run: true, would_abandon: open, warning };
    const done = [];
    const nb = ctx.store.mutateBatch(batch, (cur) => {
      for (const id of open) {
        const e = cur.tasks[id];
        if (!e || TERMINAL.has(e.state)) continue;
        cur.tasks[id] = { ...e, state: "abandoned", abandoned: true, abandoned_from: e.state, abandoned_at: nowIso(), verdict: "ABANDONED", exit_code: null,
          reason: `abandoned by operator: ${host} unreachable; remote work may still be running` };
        done.push(id);
      }
      return done.length ? cur : null;
    });
    if (done.length) ctx.outbox.enqueue(`abandoned:${batch}:${host}:${done.join(",")}`, { kind: "rpc", host, method: "abandoned", payload: { batch, ids: done } });
    if (nb.project) enqueueWakes(ctx, nb);
    await flushOutbox(ctx).catch(() => {});
    return { ok: true, batch, host, abandoned: done, warning, remote_cancel: "queued; delivered only if the host becomes reachable; not confirmed", line: verdictLine(nb) };
  },

  // ---------------------------------------------------------- task-host side
  // Idempotent per task id (the id is fixed at dispatch and stored in the batch view first): a
  // retry or a duplicate that arrives late returns the existing task; a fenced id is refused.
  submit: (ctx, { tasks }) => {
    const ids = [], refused = [];
    for (const { task, brief } of tasks) {
      try { ctx.store.create(task, brief); ids.push(task.id); } catch (e) { if (!e.fenced) throw e; refused.push(task.id); }
    }
    return { ok: true, ids, refused };
  },

  fence: (ctx, { batch, ids }) => {
    const results = ids.map((id) => {
      const r = ctx.store.fence(id, batch);
      return r.task ? { id, report: reportPayload(ctx, r.task) } : { id, fenced: true };
    });
    if (results.some((r) => r.report && r.report.state === "queued")) ctx.spawnWorker();
    return { ok: true, results };
  },

  "wake-worker": (ctx) => { ctx.spawnWorker(); return { ok: true }; },

  // Delivered (late) from the coordinator's outbox after `abandon`: a never-created id is fenced;
  // an existing unfinished task is cancelled (the worker kills its segment on the next renewal).
  // Its reports still go to the coordinator, which records them as late and ignores them.
  abandoned: async (ctx, { batch, ids }) => {
    const out = [];
    for (const id of ids) {
      const r = ctx.store.fence(id, batch);
      if (!r.task) { out.push({ id, fenced: true }); continue; }
      const nt = ctx.store.transition(id, (cur) => (TERMINAL.has(cur.state) || cur.state === "moved" ? null : { state: "cancelled", exit_code: 130, reason: "abandoned by operator on the coordinator", rev: (cur.rev || 0) + 1 }));
      if (nt.state === "cancelled" && nt.rev !== r.task.rev) await ctx.report(nt);
      out.push({ id, state: nt.state });
    }
    return { ok: true, results: out };
  },

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

function batchHead(b) {
  const tasks = Object.values(b.tasks || {});
  const allTerminal = tasks.length > 0 && tasks.every((t) => TERMINAL.has(t.state));
  return allTerminal ? (tasks.every((t) => t.state === "done") ? "PASS" : "FAIL") : "WAIT";
}

export function verdictLine(b) {
  if (b.retired) return b.final || `batch ${b.id} retired`;
  const tasks = Object.entries(b.tasks || {});
  const done = tasks.filter(([, t]) => t.state === "done").length;
  const attention = tasks.filter(([, t]) => t.state !== "done").map(([id, t]) => {
    const extra = t.approvals?.length ? ` req=${t.approvals.map((a) => a.req).join(",")}` : t.verdict && t.state === "failed" ? ` ${t.verdict}` : "";
    return `${id} ${t.state}${extra}`;
  });
  return `batch ${b.id} ${batchHead(b)} ${done}/${tasks.length}${attention.length ? ` | ${attention.join("; ")}` : ""}`.slice(0, 500);
}

// Delivery of one batch entry, as far as the coordinator knows:
//   unknown        not reconciled yet (submit not confirmed, not fenced): it may or may not exist
//   delivered      the host has the task (submit reply, fence found it, or a host report)
//   not_delivered  fenced: the host confirmed it never created it and never will
//   abandoned      the operator gave up on the host; what runs there is unknown
export function deliveryOf(e) {
  if (e.abandoned) return "abandoned";
  if (e.state === "submitting") return "unknown";
  if (e.fenced || (e.state === "failed" && e.verdict === "FAIL submit")) return "not_delivered";
  return "delivered";
}

// Machine-readable batch outcome (dispatch --json, batch --json). status:
//   unreconciled  some delivery is unknown (fail closed: retry with the same key, never re-dispatch)
//   in_progress   every task is accounted for, some are not finished
//   terminal      every entry is terminal: verdict PASS or FAIL
//   retired       acked and garbage-collected; only the final line is left
export function batchOutcome(b) {
  if (b.retired) return { schema: 1, batch: b.id, key: b.idempotency_key ?? null, status: "retired", verdict: null, acked: true, line: verdictLine(b), tasks: {} };
  const tasks = Object.fromEntries(Object.entries(b.tasks || {}).map(([id, e]) => [id, {
    delivery: deliveryOf(e), state: e.state, verdict: e.verdict ?? null, host: e.host, executor: e.executor,
    ...(e.submit_error ? { submit_error: e.submit_error } : {}), ...(e.late ? { late_report_ignored: e.late } : {}) }]));
  const verdict = batchHead(b);
  const status = verdict !== "WAIT" ? "terminal" : Object.values(tasks).some((t) => t.delivery === "unknown") ? "unreconciled" : "in_progress";
  return { schema: 1, batch: b.id, key: b.idempotency_key ?? null, status, verdict, acked: Boolean(b.acked), line: verdictLine(b), tasks };
}

// ------------------------------------------------------------ dispatch

export class KeyConflictError extends Error {}
const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
export const validKey = (k) => typeof k === "string" && /^[\x21-\x7e]{1,200}$/.test(k);

// With `key` (caller-supplied idempotency key) the batch and task ids are derived from
// (project, owner, key): any retry — after a timeout, a crash, exit 75, or days later — maps onto
// the same batch. An existing batch is returned and only its entries still "submitting" are
// resubmitted, on the host/executor recorded at registration; delivered, fenced, abandoned or
// finished entries are left alone. The same key with different briefs is refused (KeyConflictError).
// Without a key every call is a new batch (ids are random): a blind retry duplicates the work.
export async function dispatch(ctx, { project, owner, briefs, key }) {
  const { cfg } = ctx;
  if (key !== undefined && key !== null && !validKey(key)) throw new Error("invalid idempotency key: 1-200 printable ASCII characters, no spaces");
  const parsed = briefs.map(({ name, text }) => ({ name, text, brief: parseBrief(text) }));
  const problems = [];
  const textTypes = cfg.routing.rules.filter((r) => ADAPTERS[cfg.executors[r.executor]?.adapter]?.kind === "text").map((r) => r.type);
  for (const p of parsed) for (const msg of validateBrief(p.brief, { textTypes })) problems.push(`${p.name}: ${msg}`);
  if (problems.length) throw new Error(`invalid brief(s):\n  - ${problems.join("\n  - ")}`);

  const pr = cfg.projects[project];
  const own = owner || pr?.owner;
  const digest = sha([project, own ?? null, parsed.map((p) => p.text)]);
  const keyed = key !== undefined && key !== null;
  const h = keyed ? sha([project, own ?? null, key]).slice(0, 24) : null;
  const batchId = keyed ? `b-k-${h}` : newId("b");
  const taskIds = parsed.map((_, i) => (keyed ? `t-k-${h}-${i}` : newId("t")));

  let existing = keyed ? (await call(ctx, cfg.coordinator, "batch-lookup", { batch: batchId })).batch : null;
  let tasks = null;
  if (!existing) {
    const paused = await call(ctx, cfg.coordinator, "paused", {});
    tasks = parsed.map((p, i) => {
      const r = route(cfg, p.brief, { project, paused });
      return { task: { id: taskIds[i], batch: batchId, project, owner: own, type: p.brief.type, executor: r.executor, host: r.host, scope: p.brief.scope, rerouted: r.rerouted, pinned: r.pinned }, brief: p.text, name: p.name };
    });
    // Task ids are fixed here and recorded on the coordinator before any submit, as "submitting"
    // (not terminal, no wake). A batch can only become terminal once every task's delivery is known.
    const batch = { id: batchId, project, owner: own, expected: tasks.length, idempotency_key: keyed ? key : null, digest,
      tasks: Object.fromEntries(tasks.map(({ task, name }) => [task.id, { host: task.host, executor: task.executor, state: "submitting", rev: 0, name, rerouted: task.rerouted, pinned: task.pinned }])) };
    const reg = await call(ctx, cfg.coordinator, "batch-register", { batch });
    if (reg.existing) existing = reg.batch; // a concurrent retry with the same key registered first
  }
  if (existing) {
    if (existing.digest !== digest || existing.project !== project || (existing.owner ?? null) !== (own ?? null)) {
      throw new KeyConflictError(`idempotency key already used for batch ${batchId} with different briefs/project/owner; nothing was dispatched`);
    }
    if (existing.retired) return { batch: batchId, key, created: false, resumed: [], tasks: [], errors: [], outcome: batchOutcome(existing) };
    tasks = parsed.map((p, i) => {
      const e = existing.tasks[taskIds[i]];
      return { task: { id: taskIds[i], batch: batchId, project, owner: own, type: p.brief.type, executor: e.executor, host: e.host, scope: p.brief.scope, rerouted: e.rerouted, pinned: e.pinned },
        brief: p.text, name: p.name, skip: !(e.state === "submitting" && !e.reported && !e.abandoned) };
    });
  }

  const byHost = {};
  for (const t of tasks) if (!t.skip) (byHost[t.task.host] ||= []).push(t);
  const errors = [];
  const resumed = existing ? Object.values(byHost).flat().map((t) => t.task.id) : [];
  if (resumed.length) await call(ctx, cfg.coordinator, "submit-attempt", { batch: batchId, ids: resumed }).catch(() => { /* only a scheduling hint */ });
  for (const [host, list] of Object.entries(byHost)) {
    const ids = list.map(({ task }) => task.id);
    let reply;
    try {
      reply = await call(ctx, host, "submit", { tasks: list.map(({ task, brief }) => ({ task, brief })) });
    } catch (e) {
      // A timeout or a lost reply does not mean "not stored": the host may have the tasks and run
      // them. Never mark them failed on a guess; reconcile (fence) instead.
      errors.push(`${host}: ${e.message}; ${await reconcileSubmit(ctx, batchId, host, ids, e.message)}`);
      continue;
    }
    const refused = reply?.refused || [];
    const confirmed = ids.filter((id) => !refused.includes(id));
    if (confirmed.length) await call(ctx, cfg.coordinator, "submit-confirmed", { batch: batchId, ids: confirmed }).catch(() => { /* the tick reconciles */ });
    if (refused.length) {
      // Fenced on the host earlier (the tick reconciled while this dispatch was late). Record it
      // durably here too, in case the coordinator never got that fence result.
      await call(ctx, cfg.coordinator, "submit-reconciled", { batch: batchId, host, results: refused.map((id) => ({ id, fenced: true })) }).catch(() => { /* the tick re-fences */ });
      errors.push(`${host}: refused fenced ids ${refused.join(", ")} (not delivered: FAIL submit)`);
    }
    // Delivery is confirmed; starting the worker is best effort (the host's tick starts it too).
    if (confirmed.length) try { await call(ctx, host, "wake-worker", {}); } catch (e) { errors.push(`${host}: tasks delivered, wake-worker failed (${e.message}); the host's next tick starts them`); }
  }
  let outcome = null;
  try { outcome = batchOutcome((await call(ctx, cfg.coordinator, "batch-lookup", { batch: batchId })).batch); } catch (e) { errors.push(`coordinator: outcome unavailable (${e.message})`); }
  return { batch: batchId, key: keyed ? key : null, created: !existing, resumed, outcome, errors,
    tasks: tasks.map(({ task, name }) => ({ id: task.id, name, executor: task.executor, host: task.host, rerouted: task.rerouted })) };
}

// Exit status of `dispatch` (docs/cli.md). The JSON outcome is the real answer; this is a summary.
//   0 every task delivered (or the keyed batch was already acked and retired)
//   75 some delivery unknown, or the outcome could not be read: retry with the same --key
//   1 every delivery is known and some task was confirmed not delivered, or abandoned
export function dispatchExitCode(r) {
  const o = r.outcome;
  if (!o) return 75;
  if (o.status === "retired") return 0;
  const d = Object.values(o.tasks).map((t) => t.delivery);
  if (d.includes("unknown")) return 75;
  return d.every((x) => x === "delivered") ? 0 : 1;
}

// Ask the task host to fence ids whose delivery is unknown, and record the outcome on the
// coordinator. If the host cannot be reached, the entries stay "submitting" (batch WAIT, ack
// refused) and the coordinator's tick retries: fail closed, never a guessed terminal state.
async function reconcileSubmit(ctx, batch, host, ids, error) {
  const { cfg } = ctx;
  let res;
  try {
    res = await call(ctx, host, "fence", { batch, ids }, { tries: 1, timeoutMs: 20_000 });
  } catch (e) {
    await call(ctx, cfg.coordinator, "submit-unknown", { batch, ids, error }).catch(() => { /* grace period covers it */ });
    return `delivery unknown (fence failed: ${e.message}); the batch waits until the coordinator reconciles it`;
  }
  try { await call(ctx, cfg.coordinator, "submit-reconciled", { batch, host, results: res.results }); } catch (e) {
    return `host answered the fence but the coordinator could not record it (${e.message}); its tick re-fences after the grace period`;
  }
  const fenced = res.results.filter((r) => r.fenced).map((r) => r.id);
  const found = res.results.filter((r) => r.report).map((r) => r.id);
  return [found.length ? `delivered after all: ${found.join(", ")}` : "", fenced.length ? `not delivered (fenced, FAIL submit): ${fenced.join(", ")}` : ""].filter(Boolean).join("; ");
}

// Coordinator tick: reconcile entries still "submitting" — flagged unknown by dispatch, or with
// no submit attempt for SUBMIT_GRACE_MS (the dispatching process died or slept).
//
// SUBMIT_GRACE_MS is a scheduling hint, not a correctness assumption. Correctness comes from the
// host: fence and create of one id are serialized under the task lock (which is never taken from a
// live holder), and a fenced id is refused forever. So a dispatcher that resumes after any gap —
// minutes or days, with or without a key — either finds its task already created (idempotent
// submit, reconciled to "delivered") or is refused and records "not delivered"; it never creates a
// task the batch counted as failed, and never a second batch for the same key. A shorter hint only
// risks a spurious (but consistent) FAIL submit; a longer one only delays the verdict.
export const SUBMIT_GRACE_MS = 10 * 60_000;
export async function reconcileSubmits(ctx, now = Date.now()) {
  const out = [];
  for (const b of ctx.store.listBatches()) {
    if (b.acked) continue;
    const byHost = {};
    for (const [id, e] of Object.entries(b.tasks)) {
      if (e.state !== "submitting" || e.reported || e.abandoned) continue;
      const last = Math.max(Date.parse(b.created_at), e.attempt_at ? Date.parse(e.attempt_at) : 0);
      if (e.submit_unknown || now - last > SUBMIT_GRACE_MS) (byHost[e.host] ||= []).push(id);
    }
    for (const [host, ids] of Object.entries(byHost)) {
      try {
        const res = await call(ctx, host, "fence", { batch: b.id, ids }, { tries: 1, timeoutMs: 20_000 });
        await HANDLERS["submit-reconciled"](ctx, { batch: b.id, host, results: res.results });
        out.push({ batch: b.id, host, ids, ok: true });
      } catch (e) { out.push({ batch: b.id, host, ids, ok: false, error: e.message }); }
    }
  }
  return out;
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
//
// Split brain (old and new worker both writing one task) is prevented by replacing a holder only
// after its death is confirmed: SIGKILL to the verified instance (pid + start time + boot id), then
// a bounded wait until it — and the orphaned segment process group — can no longer run. If that
// cannot be confirmed (no start time recorded, uninterruptible sleep, EPERM), the task stays
// "running" and is reported under `unconfirmed`: fail closed, a human or a later definite death
// signal must resolve it. Availability is traded for never having two writers.
export async function resumeAll(ctx, now = Date.now()) {
  const out = { resumed: [], frozen: [], running: [], unconfirmed: [] };
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
        const k = await killConfirmed(lease.pid, lease.pid_start, lease.boot_id);
        if (k !== "dead") {
          ctx.store.log(t.id, "resume", `frozen worker pid ${lease.pid}: death not confirmed (${lease.pid_start ? "still alive after SIGKILL" : "no start time recorded; pid not verifiable, not killed"}); not replaced`);
          out.unconfirmed.push(t.id);
          continue;
        }
      }
      // The dead worker's executor runs in its own process group: do not leave it writing.
      const g = await killGroupConfirmed(t.segment_pid, t.segment_pid_start);
      if (g === "unconfirmed") {
        ctx.store.log(t.id, "resume", `orphaned segment process group ${t.segment_pid} still has running members (death not confirmed); not re-queued — check: ps -o pid,stat,cmd -g ${t.segment_pid}`);
        out.unconfirmed.push(t.id);
        continue;
      }
      rmSync(frozenPath, { force: true });
      if (g === "dead") ctx.store.log(t.id, "resume", `killed orphaned segment process group ${t.segment_pid}`);
      const nt = ctx.store.transition(t.id, (cur) => (cur.state === "running" ? { state: "queued", reason: `resumed after ${st} lease`, segment_pid: null, segment_pid_start: null } : null));
      if (nt.state !== "queued") continue;
      ctx.store.log(t.id, "resume", `lease ${st}; re-queued from segment ${t.segments}`);
      out.resumed.push(t.id);
    } else if (runnable(ctx, t, now)) out.resumed.push(t.id);
  }
  if (out.resumed.length) ctx.spawnWorker();
  return out;
}

// ------------------------------------------------------------ heartbeat check (coordinator)
// Detection + notification only: a missed heartbeat queues one `<host>_unreachable` webhook per
// outage (it wakes the Grok routine, not the host). Tasks resume once the host runs again.

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
    // A tombstone stays (forever): a late or keyed-retry submit of this id is refused.
    if (now - Date.parse(t.acked_at || t.moved_at || t.updated_at) > keepMs) { store.retire(t.id); removed.tasks++; }
  }
  // Batch views go too, but leave a tombstone (forever) so the id — derived from an idempotency
  // key — is never registered again. Tombstones of either kind are never garbage-collected.
  for (const b of store.listBatches()) {
    if (b.acked && now - Date.parse(b.acked_at || b.updated_at) > keepMs) { store.retireBatch(b, verdictLine(b)); removed.batches++; }
  }
  const sent = join(cfg.home, "outbox", "sent");
  if (existsSync(sent)) for (const f of readdirSync(sent)) {
    const p = join(sent, f);
    if (f !== ".keep" && now - statSync(p).mtimeMs > keepMs) { rmSync(p, { force: true }); removed.outbox++; }
  }
  for (const t of store.list()) {
    const d = store.dir(t.id);
    // Leftovers of crashes: lease candidates, stolen locks, tmp files of interrupted atomic writes.
    for (const f of readdirSync(d)) if (/\.(stale|cand|steal)-|\.tmp-\d+-/.test(f) && now - statSync(join(d, f)).mtimeMs > 3600_000) rmSync(join(d, f), { force: true });
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
    res.submits = await reconcileSubmits(ctx);
    res.heartbeat_wakes = checkHeartbeats(ctx);
    for (const b of ctx.store.listBatches()) if (b.project) enqueueWakes(ctx, b);
  }
  res.outbox = await flushOutbox(ctx).catch((e) => [{ ok: false, error: e.message }]);
  res.gc = gc(ctx);
  return res;
}

// Watchdog (VPS): tick locally, then ask each executor host to resume its tasks over ssh.
//
// What it can and cannot do:
//   detection     ssh unreachable (Tailscale down, host asleep/off), and on the host itself: dead
//                 worker, expired lease, frozen process (resume-all)
//   notification  the coordinator's heartbeat check queues one `<host>_unreachable` webhook per
//                 outage. That wakes the Grok *routine*, not the machine.
//   resume        only once the host runs again: its own tick timer, or the next watchdog run that
//                 reaches it, re-queues tasks from the last checkpoint.
// ssh cannot wake or unfreeze a suspended host, and nothing here does. A box that stays asleep
// keeps its tasks waiting; no uptime is promised.
export function hostStatusPath(ctx, host) { return join(ctx.cfg.home, "run", `host-${host}.json`); }

export async function watchdog(ctx, now = () => Date.now()) {
  const res = await tick(ctx);
  res.hosts = {};
  const hosts = new Set(Object.values(ctx.cfg.executors).map((e) => e.host).filter((h) => h !== ctx.cfg.self));
  for (const h of hosts) {
    const p = hostStatusPath(ctx, h);
    const prev = readJson(p, null);
    try {
      const resumed = await call(ctx, h, "resume-all", {}, { tries: 3, baseMs: 2000 });
      writeJsonAtomic(p, { host: h, reachable: true, last_ok: new Date(now()).toISOString(), unreachable_since: null, back_after: prev?.unreachable_since || null });
      res.hosts[h] = { reachable: true, resume: resumed, ...(prev?.unreachable_since ? { back_after_outage_since: prev.unreachable_since } : {}) };
    } catch (e) {
      const since = prev?.unreachable_since || new Date(now()).toISOString();
      writeJsonAtomic(p, { host: h, reachable: false, last_ok: prev?.last_ok || null, unreachable_since: since, last_error: e.message });
      res.hosts[h] = { reachable: false, detected: e.message, unreachable_since: since,
        action: "none possible from here (ssh cannot wake a sleeping host); its tasks resume from the last checkpoint once it runs again; the coordinator notifies Grok after heartbeat_miss_minutes without a heartbeat" };
    }
  }
  return res;
}

export const showTime = (ctx, iso) => fmtLocal(iso, ctx.cfg.display_tz);
