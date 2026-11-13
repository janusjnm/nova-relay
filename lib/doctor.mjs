// doctor.mjs — check every prerequisite the failure-mode table relies on. Read-only.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "./executors/index.mjs";
import { cliContract, credentialsPresent, freeMb } from "./runner.mjs";
import { loadSecrets, projectPaths, webhookFor } from "./config.mjs";
import { readPaused, usageToday, overBudget } from "./budget.mjs";
import { leaseStatus, readLease } from "./lock.mjs";
import { call } from "./rpc.mjs";
import { git } from "./git.mjs";
import { readJson } from "./util.mjs";
import { STATE_SCHEMA } from "./store.mjs";

export async function doctor(ctx, { remote = true } = {}) {
  const { cfg } = ctx;
  const out = [];
  const add = (level, name, detail = "") => out.push({ level, name, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 22 ? "OK" : "FAIL", "node", `v${process.versions.node} (need >= 22)`);
  add("OK", "config", `self=${cfg.self} coordinator=${cfg.coordinator} executors=${Object.keys(cfg.executors).join(",") || "none"}`);
  if (!Object.keys(cfg.executors).length) add("FAIL", "executors", "no executors configured");

  const sec = loadSecrets({ ...ctx.env });
  add(sec.error ? "FAIL" : "OK", "secrets file", sec.error || `${sec.path}${existsSync(sec.path) ? "" : " (absent; using environment only)"}`);
  try { accessSync(cfg.home, constants.W_OK); add("OK", "home", cfg.home); } catch { add("FAIL", "home", `${cfg.home} not writable`); }
  const mb = freeMb(cfg.home);
  add(mb >= cfg.limits.min_free_mb ? "OK" : "FAIL", "disk", `${mb} MB free (min ${cfg.limits.min_free_mb})`);

  const gv = git(cfg.home, ["--version"], { allowFail: true }).out;
  const gm = gv.match(/(\d+)\.(\d+)/);
  add(gm && (Number(gm[1]) > 2 || Number(gm[2]) >= 38) ? "OK" : "FAIL", "git", `${gv || "missing"} (need >= 2.38 for merge-tree)`);

  // Executors that run on this host.
  const paused = readPaused(cfg.home);
  for (const [name, ex] of Object.entries(cfg.executors)) {
    if (ex.host !== cfg.self) continue;
    const a = ADAPTERS[ex.adapter];
    const c = cliContract(cfg.home, name, ex, a, { force: true, env: ctx.env });
    add(c.ok ? "OK" : "FAIL", `executor ${name} cli`, c.ok ? (c.version || a.kind) : c.why);
    const cred = credentialsPresent(a, ex, ctx.env);
    add(cred ? "FAIL" : "OK", `executor ${name} auth`, cred || "credentials present (not a live login test)");
    if (paused[name]) add("WARN", `executor ${name} paused`, `${paused[name].reason} until ${paused[name].until || "manual unpause"}`);
    const over = overBudget(cfg.home, name, ex.budget);
    const u = usageToday(cfg.home, name);
    add(over ? "WARN" : "OK", `executor ${name} budget`, over || `today: ${u.segments} segments, ${Math.round(u.minutes)} min, ${u.tokens} tokens`);
  }

  // Projects (paths for this host).
  for (const name of Object.keys(cfg.projects)) {
    try {
      const { repo, worktrees } = projectPaths(cfg, name);
      if (!existsSync(repo)) { add("WARN", `project ${name}`, `repo ${repo} not on this host`); continue; }
      const base = cfg.projects[name].base;
      const ok = git(repo, ["rev-parse", "--verify", `${base}^{commit}`], { allowFail: true }).ok;
      add(ok ? "OK" : "FAIL", `project ${name}`, ok ? `${repo} @ ${base}, worktrees ${worktrees}` : `base branch ${base} missing in ${repo}`);
    } catch (e) { add("FAIL", `project ${name}`, e.message); }
  }

  // Webhooks are sent by the coordinator only.
  if (cfg.coordinator === cfg.self) {
    for (const name of Object.keys(cfg.projects).length ? Object.keys(cfg.projects) : [null]) {
      const w = webhookFor(cfg, name, ctx.env);
      add(w.error ? "FAIL" : "OK", `webhook ${name ?? "default"}`, w.error || "url + key present (values not shown)");
    }
  }
  const dead = ctx.outbox.dead();
  add(dead.length ? "WARN" : "OK", "outbox", dead.length ? `${dead.length} undeliverable messages (see ${join(cfg.home, "outbox")})` : `${ctx.outbox.pending().length} queued`);

  // Task store health: schema, stale leases.
  let bad = 0, stale = 0, newer = 0;
  for (const id of existsSync(ctx.store.tasks) ? readdirSync(ctx.store.tasks) : []) {
    const st = readJson(join(ctx.store.tasks, id, "state.json"), null);
    if (!st) { bad++; continue; }
    if ((st.schema ?? 1) > STATE_SCHEMA) newer++;
    if (st.state === "running" && ["stale", "free"].includes(leaseStatus(readLease(join(ctx.store.tasks, id, "lease.json"))))) stale++;
  }
  add(bad || newer ? "WARN" : "OK", "task store", `${bad} unreadable state.json (journal replay will repair), ${newer} from a newer version`);
  add(stale ? "WARN" : "OK", "leases", stale ? `${stale} running tasks without a live lease (run: nova-relay resume --all)` : "no stale leases");

  // Timers (best effort; systemd user units).
  const unit = cfg.hosts[cfg.self]?.role === "vps" ? "nova-relay-watchdog.timer" : "nova-relay-tick.timer";
  const timer = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" });
  if (!timer.error) add(timer.stdout.trim() === "active" ? "OK" : "WARN", "timer", `${unit}: ${timer.stdout.trim() || "unknown"} (cron fallback: see docs/setup-vps.md)`);

  // Other hosts: reachability over Tailscale ssh and clock skew.
  if (remote) {
    for (const host of Object.keys(cfg.hosts)) {
      if (host === cfg.self) continue;
      const t0 = Date.now();
      try {
        const r = await call(ctx, host, "ping", {}, { tries: 1, timeoutMs: 20_000 });
        const skew = Math.abs(Date.parse(r.now) - (t0 + Date.now()) / 2) / 1000;
        add(skew > 60 ? "WARN" : "OK", `host ${host}`, `reachable, clock skew ~${Math.round(skew)}s (UTC used internally)`);
      } catch (e) {
        add("WARN", `host ${host}`, `${e.message} — heartbeat fallback will be used`);
      }
    }
  }
  return out;
}
