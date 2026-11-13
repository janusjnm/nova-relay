// budget.mjs — per-executor daily budget ledger + executor pause state (quota, auth, budget).
//   <home>/run/budget-<UTC day>.json   { <executor>: { segments, minutes, tokens, tokens_measured,
//                                        tokens_unknown, cost_usd, cost_measured, cost_unknown, token_detail } }
//   <home>/run/paused.json             { <executor>: { reason, until|null, since, incident } }
//
// segments and minutes are measured locally (always known). tokens and cost_usd are sums of what
// the provider reported; segments whose provider reported nothing are counted as *_unknown, never
// as 0. Caps are checked before a new segment starts (reserveSegment); a segment already running
// can overshoot minutes/tokens/cost caps — these are not exact hard billing caps.
import { join } from "node:path";
import { readJson, utcDay, withLock, writeJsonAtomic, nowIso } from "./util.mjs";
import { addToTotals, emptyTotals } from "./usage.mjs";

const ledgerPath = (home, day = utcDay()) => join(home, "run", `budget-${day}.json`);
const pausedPath = (home) => join(home, "run", "paused.json");
const empty = () => ({ segments: 0, minutes: 0, ...emptyTotals() });

// usage: { segments, minutes, usage: normalized usage (lib/usage.mjs) }. segments is normally 0
// here: the slot was taken by reserveSegment() when the segment started.
export function addUsage(home, executor, { segments = 0, minutes = 0, usage } = {}) {
  const p = ledgerPath(home);
  return withLock(p, () => {
    const l = readJson(p, {});
    let cur = { ...empty(), ...(l[executor] || {}) };
    cur.segments += Number(segments || 0);
    cur.minutes += Number(minutes || 0);
    if (usage) cur = addToTotals(cur, usage);
    l[executor] = cur;
    writeJsonAtomic(p, l);
    return cur;
  });
}

export function usageToday(home, executor, day = utcDay()) {
  return { ...empty(), ...(readJson(ledgerPath(home, day), {})[executor] || {}) };
}

export function usageDay(home, day = utcDay()) {
  const l = readJson(ledgerPath(home, day), {});
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { ...empty(), ...v }]));
}

const CAPS = [["segments_per_day", "segments"], ["minutes_per_day", "minutes"], ["tokens_per_day", "tokens"], ["cost_usd_per_day", "cost_usd"]];

// budget: { segments_per_day, minutes_per_day, tokens_per_day, cost_usd_per_day }. tokens/cost
// compare the measured sum only (unknown usage cannot count toward a cap; stats/doctor say so).
export function overBudgetUsage(u, budget = {}) {
  for (const [k, field] of CAPS) {
    if (budget[k] && u[field] >= budget[k]) return `${field} ${Math.round(u[field] * 100) / 100} >= ${budget[k]}/day`;
  }
  return null;
}

export function overBudget(home, executor, budget = {}) {
  return overBudgetUsage(usageToday(home, executor), budget);
}

// Preflight for a new segment, atomic under the ledger lock: either the cap is already reached
// (returns the reason, nothing reserved) or this segment's slot is counted now. Two workers that
// race for the last segment of segments_per_day cannot both get it. Minutes/tokens/cost of a
// running segment are only known afterwards, so those caps can be overshot by the segments in flight.
export function reserveSegment(home, executor, budget = {}) {
  const p = ledgerPath(home);
  return withLock(p, () => {
    const l = readJson(p, {});
    const cur = { ...empty(), ...(l[executor] || {}) };
    const over = overBudgetUsage(cur, budget);
    if (over) return { ok: false, over };
    cur.segments += 1;
    l[executor] = cur;
    writeJsonAtomic(p, l);
    return { ok: true, usage: cur };
  });
}

// Caps that cannot be enforced because the executor reported no number for that field today.
export function unenforceableCaps(u, budget = {}) {
  const out = [];
  if (budget.tokens_per_day && u.tokens_unknown && !u.tokens_measured) out.push("tokens_per_day (no token counts reported)");
  if (budget.cost_usd_per_day && u.cost_unknown && !u.cost_measured) out.push("cost_usd_per_day (no cost reported)");
  return out;
}

export const nextUtcMidnight = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

export function readPaused(home, now = Date.now()) {
  const all = readJson(pausedPath(home), {});
  const active = {};
  for (const [k, v] of Object.entries(all)) if (!v.until || Date.parse(v.until) > now) active[k] = v;
  return active;
}

export function pauseExecutor(home, executor, reason, until = null) {
  const p = pausedPath(home);
  return withLock(p, () => {
    const all = readJson(p, {});
    const prev = all[executor];
    const active = prev && (!prev.until || Date.parse(prev.until) > Date.now());
    // Same incident while still active (several tasks hit the same wall): not fresh, keep the later reset.
    if (active && prev.reason === reason && (reason === "auth" || !until || Date.parse(prev.until) >= Date.parse(until))) return { ...prev, fresh: false };
    if (active && prev.reason === reason) { all[executor] = { ...prev, until }; writeJsonAtomic(p, all); return { ...all[executor], fresh: false }; }
    all[executor] = { reason, until, since: nowIso(), incident: `${executor}-${reason}-${Date.now().toString(36)}` };
    writeJsonAtomic(p, all);
    return { ...all[executor], fresh: true };
  });
}

export function unpauseExecutor(home, executor) {
  const p = pausedPath(home);
  withLock(p, () => {
    const all = readJson(p, {});
    delete all[executor];
    writeJsonAtomic(p, all);
  });
}
