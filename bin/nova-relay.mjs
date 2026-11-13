#!/usr/bin/env node
// nova-relay — planner/executor relay CLI. Node >= 22, no dependencies. See docs/cli.md.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ConfigError, configPath, loadConfig } from "../lib/config.mjs";
import { HANDLERS, dispatch, flushOutbox, gc, makeContext, resumeAll, showTime, tick, verdictLine, watchdog, worker } from "../lib/relay.mjs";
import { call } from "../lib/rpc.mjs";
import { doctor } from "../lib/doctor.mjs";
import { accept } from "../lib/acceptance.mjs";
import { parseBrief, BRIEF_TEMPLATE } from "../lib/brief.mjs";
import { unpauseExecutor } from "../lib/budget.mjs";
import { VERSION } from "../lib/util.mjs";

const USAGE = `nova-relay ${VERSION}

planner (Grok) commands
  dispatch --project P [--owner O] <brief.md>... | -     create a batch, start workers, print batch id
  pending [--owner O]                                    batches that need the planner (one line each)
  verdict <batch>                                        one-line verdict: PASS|FAIL|WAIT n/m | details
  batch <batch> [--json]                                 per-task view of a batch
  status <task> [--json]   log <task> [-n N]             task detail / recent events
  approve <task> <req> [--owner O]   deny <task> <req> [--owner O]
  ack <batch> [--owner O]                                acknowledge after spot-checking (enables cleanup)
  cancel <task>            brief-template                print a brief template

operator commands
  doctor [--no-remote]     config-check     unpause <executor>     accept <task>
  worker [--once]          resume --all     tick     watchdog     heartbeat
  outbox [--flush]         gc               rpc <method> (JSON on stdin; used over ssh)
config: $NOVA_RELAY_CONFIG or ~/.config/nova-relay/config.json`;

function parseArgs(argv) {
  const pos = [], flags = {};
  const VALUE = new Set(["project", "owner", "n"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); if (VALUE.has(k)) flags[k] = argv[++i]; else flags[k] = true; }
    else if (a === "-n") flags.n = argv[++i];
    else pos.push(a);
  }
  return { pos, flags };
}

const out = (x) => process.stdout.write(typeof x === "string" ? `${x}\n` : `${JSON.stringify(x, null, 2)}\n`);
const need = (v, what) => { if (!v) { console.error(`missing ${what}\n\n${USAGE}`); process.exit(2); } return v; };
const readStdin = () => readFileSync(0, "utf8");

async function onTaskHost(ctx, id, method, payload) {
  if (ctx.store.exists(id)) return HANDLERS[method](ctx, payload);
  const loc = await call(ctx, ctx.cfg.coordinator, "locate", { id });
  if (!loc.host) throw new Error(`unknown task ${id}`);
  return call(ctx, loc.host, method, payload);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || flags.help) return out(USAGE);
  if (cmd === "version" || cmd === "--version") return out(VERSION);
  if (cmd === "brief-template") return out(BRIEF_TEMPLATE);

  let cfg;
  try { cfg = loadConfig(); } catch (e) {
    if (cmd === "rpc") { out({ error: e.message }); process.exit(1); }
    console.error(e.message); process.exit(e instanceof ConfigError ? 3 : 1);
  }
  const ctx = makeContext(cfg);
  const coord = (method, payload) => call(ctx, cfg.coordinator, method, payload);

  switch (cmd) {
    case "config-check": return out(`OK ${configPath()}`);
    case "rpc": {
      const method = need(pos[0], "method");
      try {
        if (!HANDLERS[method]) throw new Error(`unknown rpc method ${method}`);
        out(JSON.stringify(await HANDLERS[method](ctx, JSON.parse(readStdin() || "{}")) ?? { ok: true }));
      } catch (e) { out(JSON.stringify({ error: String(e.message || e) })); process.exit(1); }
      return;
    }
    case "dispatch": {
      const project = need(flags.project, "--project");
      const files = need(pos.length ? pos : null, "brief files");
      const briefs = files.map((f) => ({ name: f === "-" ? "stdin" : basename(f), text: f === "-" ? readStdin() : readFileSync(f, "utf8") }));
      const r = await dispatch(ctx, { project, owner: flags.owner, briefs });
      out(`batch ${r.batch}`);
      for (const t of r.tasks) out(`  ${t.id} ${t.name} → ${t.executor}@${t.host}${t.rerouted ? " (rerouted: primary paused)" : ""}`);
      for (const e of r.errors) console.error(`submit error: ${e}`);
      return process.exit(r.errors.length ? 1 : 0);
    }
    case "pending": {
      for (const b of await coord("pending", { owner: flags.owner })) out(b.line);
      return;
    }
    case "verdict": return out(verdictLine(await coord("batch-status", { batch: need(pos[0], "batch id") })));
    case "batch": {
      const b = await coord("batch-status", { batch: need(pos[0], "batch id") });
      if (flags.json) return out(b);
      out(`${verdictLine(b)}\nproject ${b.project} owner ${b.owner} created ${showTime(ctx, b.created_at)}${b.acked ? " (acked)" : ""}`);
      for (const [id, t] of Object.entries(b.tasks)) out(`  ${id} ${t.state} ${t.executor}@${t.host} ${t.verdict || ""} ${t.reason ? `(${t.reason})` : ""}`);
      return;
    }
    case "ack": return out((await coord("ack", { batch: need(pos[0], "batch id"), owner: flags.owner })).line);
    case "status": {
      const id = need(pos[0], "task id");
      const t = await onTaskHost(ctx, id, "status", { id });
      if (flags.json) return out(t);
      out(`${t.id} ${t.state}${t.reason ? ` (${t.reason})` : ""}\n  batch ${t.batch} project ${t.project} executor ${t.executor}@${t.host}\n  verdict ${t.verdict || "-"}\n  segments ${t.segments} retries ${t.local_retries} failures ${t.segment_failures} quota-pauses ${t.quota_pauses}\n  branch ${t.branch || "-"} worktree ${t.worktree || "-"}\n  started ${showTime(ctx, t.started_at)} updated ${showTime(ctx, t.updated_at)}${t.resume_after ? `\n  resume after ${showTime(ctx, t.resume_after)}` : ""}`);
      for (const a of t.approvals || []) out(`  approval req=${a.req} [${a.category}] ${a.subject} — ${a.reason}`);
      return;
    }
    case "log": {
      const id = need(pos[0], "task id");
      for (const e of ctx.store.events(id, Number(flags.n || 30))) out(`${showTime(ctx, e.ts)} ${e.type} ${e.text}`);
      return;
    }
    case "approve": case "deny": {
      const [id, req] = [need(pos[0], "task id"), need(pos[1], "req")];
      return out(await onTaskHost(ctx, id, cmd, { id, req, owner: flags.owner }));
    }
    case "cancel": { const id = need(pos[0], "task id"); return out(await onTaskHost(ctx, id, "cancel", { id })); }
    case "accept": {
      const id = need(pos[0], "task id");
      const t = ctx.store.get(id);
      const r = accept({ workdir: t.worktree, base: t.base_commit, brief: parseBrief(ctx.store.brief(id)), project: cfg.projects[t.project] });
      out(r.line);
      return process.exit(r.pass ? 0 : 1);
    }
    case "unpause": {
      const ex = need(pos[0], "executor");
      unpauseExecutor(cfg.home, ex);
      if (cfg.coordinator !== cfg.self) await coord("executor-unpaused", { executor: ex }).catch((e) => console.error(`coordinator: ${e.message}`));
      for (const t of ctx.store.list()) if (t.executor === ex && ["needs_auth", "paused"].includes(t.state) && !t.acked) ctx.store.update(t.id, { state: "queued", resume_after: null });
      ctx.spawnWorker();
      return out(`unpaused ${ex}`);
    }
    case "worker": return worker(ctx, { once: Boolean(flags.once) });
    case "resume": return out(await resumeAll(ctx));
    case "tick": return out(await tick(ctx));
    case "watchdog": return out(await watchdog(ctx));
    case "heartbeat": return out(await coord("heartbeat", { host: cfg.self }));
    case "outbox": {
      if (flags.flush) out(await flushOutbox(ctx));
      for (const e of ctx.outbox.pending()) out(`${e.dead ? "DEAD" : "queued"} ${e.kind} ${e.key} attempts=${e.attempts} ${e.last_error || ""}`);
      return;
    }
    case "gc": return out(gc(ctx));
    case "doctor": {
      const res = await doctor(ctx, { remote: !flags["no-remote"] });
      for (const r of res) out(`${r.level.padEnd(4)} ${r.name}: ${r.detail}`);
      return process.exit(res.some((r) => r.level === "FAIL") ? 1 : 0);
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((e) => { console.error(`nova-relay: ${e.message || e}`); process.exit(1); });
