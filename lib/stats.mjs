// stats.mjs — `nova-relay stats`: today's (UTC day) measured usage per executor, configured caps,
// pause state, and notification delivery counts on this host. Storage is UTC; times are shown in
// display_tz (default Asia/Singapore).
//
// What the numbers are NOT: subscription token usage reported by a CLI is not a bill and not the
// remaining quota; unknown usage is shown as unknown, never as 0; notification deliveries are
// webhooks/reports sent, not model consumption and not proof the planner ran.
import { join } from "node:path";
import { overBudgetUsage, readPaused, unenforceableCaps, usageDay } from "./budget.mjs";
import { deliveryCounts } from "./notify.mjs";
import { fmtLocal, readJson, utcDay } from "./util.mjs";
import { showMeasured } from "./usage.mjs";

export const STATS_NOTES = [
  "usage is what each provider reported per segment: null/unknown when it reported nothing (never counted as 0)",
  "subscription CLI token/cost figures (Claude Code, Codex) are not a bill and not the remaining subscription quota",
  "caps are checked before a new segment starts; segments already running can overshoot minutes/tokens/cost caps (not a hard billing cap)",
  "notification_deliveries/attempts count webhooks and host reports sent by this host's outbox — not model usage, not planner runs",
];

export function stats(cfg, { day = utcDay(), now = Date.now() } = {}) {
  const home = cfg.home;
  const ledger = usageDay(home, day);
  const paused = readPaused(home, now);
  const names = [...new Set([...Object.keys(cfg.executors), ...Object.keys(ledger)])];
  const executors = names.map((name) => {
    const ex = cfg.executors[name] || {};
    const u = ledger[name] || { segments: 0, minutes: 0, tokens: 0, tokens_measured: 0, tokens_unknown: 0, cost_usd: 0, cost_measured: 0, cost_unknown: 0, token_detail: {} };
    return {
      executor: name, adapter: ex.adapter ?? null, host: ex.host ?? null, configured: Boolean(cfg.executors[name]),
      segments: u.segments, minutes: Math.round(u.minutes * 100) / 100,
      tokens: { value: u.tokens_measured ? u.tokens : null, measured_segments: u.tokens_measured, unknown_segments: u.tokens_unknown, detail: u.token_detail },
      cost_usd: { value: u.cost_measured ? u.cost_usd : null, measured_segments: u.cost_measured, unknown_segments: u.cost_unknown },
      budget: ex.budget || {}, over_budget: overBudgetUsage(u, ex.budget || {}), unenforceable_caps: unenforceableCaps(u, ex.budget || {}),
      paused: paused[name] ? { reason: paused[name].reason, until: paused[name].until, since: paused[name].since } : null,
    };
  });
  const counts = deliveryCounts(home, day);
  const incidents = readJson(join(home, "run", "incidents.json"), {});
  const suppressed = Object.values(incidents).reduce((a, r) => a + (r.suppressed || 0), 0);
  return {
    host: cfg.self, day_utc: day, display_tz: cfg.display_tz,
    window: { from_utc: `${day}T00:00:00.000Z`, from_local: fmtLocal(`${day}T00:00:00.000Z`, cfg.display_tz) },
    executors,
    notifications: {
      planner_webhooks: counts.webhook || { notification_attempts: 0, notification_deliveries: 0, notification_failures: 0 },
      host_reports: counts.rpc || { notification_attempts: 0, notification_deliveries: 0, notification_failures: 0 },
      cooldown_suppressed_wakes: suppressed,
    },
    notes: STATS_NOTES,
  };
}

export function statsLines(s) {
  const out = [`stats ${s.host} — UTC day ${s.day_utc} (from ${s.window.from_local})`];
  for (const e of s.executors) {
    out.push(`  ${e.executor}${e.adapter ? ` (${e.adapter}@${e.host})` : ""}${e.paused ? ` PAUSED ${e.paused.reason} until ${e.paused.until ? fmtLocal(e.paused.until, s.display_tz) : "manual unpause"}` : ""}`);
    out.push(`    segments ${e.segments}, minutes ${e.minutes}`);
    out.push(`    tokens ${showMeasured(e.tokens.value, e.tokens.measured_segments, e.tokens.unknown_segments)}`);
    out.push(`    cost   ${showMeasured(e.cost_usd.value, e.cost_usd.measured_segments, e.cost_usd.unknown_segments, " USD (as reported)")}`);
    const caps = Object.entries(e.budget).map(([k, v]) => `${k}=${v}`).join(" ");
    out.push(`    caps   ${caps || "none"}${e.over_budget ? ` — OVER: ${e.over_budget}` : ""}${e.unenforceable_caps.length ? ` — cannot enforce: ${e.unenforceable_caps.join(", ")}` : ""}`);
  }
  const w = s.notifications.planner_webhooks, r = s.notifications.host_reports;
  out.push(`  planner webhooks: ${w.notification_deliveries} delivered (unique keys), ${w.notification_attempts} attempts, ${w.notification_failures} failed attempts`);
  out.push(`  host reports:     ${r.notification_deliveries} delivered, ${r.notification_attempts} attempts; wakes suppressed by cooldown: ${s.notifications.cooldown_suppressed_wakes}`);
  for (const n of s.notes) out.push(`  note: ${n}`);
  return out;
}
