// budget.mjs — per-executor daily budget ledger + executor pause state (quota, auth, budget).
//   <home>/run/budget-<UTC day>.json   { <executor>: { segments, minutes, tokens, cost_usd } }
//   <home>/run/paused.json             { <executor>: { reason, until|null, since, incident } }
import { join } from "node:path";
import { readJson, utcDay, writeJsonAtomic, nowIso } from "./util.mjs";

const ledgerPath = (home, day = utcDay()) => join(home, "run", `budget-${day}.json`);
const pausedPath = (home) => join(home, "run", "paused.json");

export function addUsage(home, executor, usage) {
  const p = ledgerPath(home);
  const l = readJson(p, {});
  const cur = l[executor] || { segments: 0, minutes: 0, tokens: 0, cost_usd: 0 };
  for (const k of Object.keys(cur)) cur[k] += Number(usage[k] || 0);
  l[executor] = cur;
  writeJsonAtomic(p, l);
  return cur;
}

export function usageToday(home, executor) {
  return readJson(ledgerPath(home), {})[executor] || { segments: 0, minutes: 0, tokens: 0, cost_usd: 0 };
}

// budget: { segments_per_day, minutes_per_day, tokens_per_day, cost_usd_per_day }
export function overBudget(home, executor, budget = {}) {
  const u = usageToday(home, executor);
  for (const [k, field] of [["segments_per_day", "segments"], ["minutes_per_day", "minutes"], ["tokens_per_day", "tokens"], ["cost_usd_per_day", "cost_usd"]]) {
    if (budget[k] && u[field] >= budget[k]) return `${field} ${Math.round(u[field] * 100) / 100} >= ${budget[k]}/day`;
  }
  return null;
}

export const nextUtcMidnight = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

export function readPaused(home, now = Date.now()) {
  const all = readJson(pausedPath(home), {});
  const active = {};
  for (const [k, v] of Object.entries(all)) if (!v.until || Date.parse(v.until) > now) active[k] = v;
  return active;
}

export function pauseExecutor(home, executor, reason, until = null) {
  const all = readJson(pausedPath(home), {});
  const prev = all[executor];
  if (prev && prev.reason === reason && (prev.until || null) === (until || null)) return { ...prev, fresh: false };
  all[executor] = { reason, until, since: nowIso(), incident: `${executor}-${reason}-${Date.now().toString(36)}` };
  writeJsonAtomic(pausedPath(home), all);
  return { ...all[executor], fresh: true };
}

export function unpauseExecutor(home, executor) {
  const all = readJson(pausedPath(home), {});
  delete all[executor];
  writeJsonAtomic(pausedPath(home), all);
}
