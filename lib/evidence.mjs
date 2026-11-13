// evidence.mjs — local routing evidence and advisory recommendations. Never changes routing.
//
//   <home>/run/routing-evidence.jsonl   one record per task terminal verdict (done/failed) on this
//                                       host: type, executor, outcome, retries, elapsed time and the
//                                       measured cost/tokens (null when the provider reported none)
//
// `nova-relay recommend` summarizes it per task type and executor with the sample size and a
// conservative confidence label. It is advice for the operator; routing.rules and
// routing.reroute_paused are only ever changed by editing the config.
import { join } from "node:path";
import { appendJsonl, nowIso, readJsonl } from "./util.mjs";

export const evidencePath = (home) => join(home, "run", "routing-evidence.jsonl");
export const MIN_SAMPLES = 5;

export function recordEvidence(home, cfg, t, state) {
  if (!["done", "failed"].includes(state)) return null;
  const ex = cfg.executors[t.executor] || {};
  const u = t.usage || {};
  const start = Date.parse(t.started_at || t.created_at);
  const rec = {
    at: nowIso(), task: t.id, batch: t.batch ?? null, project: t.project ?? null, type: t.type ?? null, executor: t.executor,
    adapter: ex.adapter ?? null, model: ex.model ?? null, host: cfg.self, outcome: state === "done" ? "pass" : "fail", verdict: t.verdict ?? null,
    segments: t.segments || 0, local_retries: t.local_retries || 0, segment_failures: t.segment_failures || 0, quota_pauses: t.quota_pauses || 0,
    reroutes: t.reroutes || 0, rerouted_from: t.rerouted_from ?? null, active_minutes: round(t.active_minutes || 0),
    elapsed_minutes: Number.isFinite(start) ? round((Date.now() - start) / 60000) : null,
    // Known (measured) numbers only; *_unknown = segments whose provider reported nothing.
    cost_usd: u.cost_measured ? u.cost_usd : null, cost_measured: u.cost_measured || 0, cost_unknown: u.cost_unknown || 0,
    tokens: u.tokens_measured ? u.tokens : null, tokens_measured: u.tokens_measured || 0, tokens_unknown: u.tokens_unknown || 0,
  };
  try { appendJsonl(evidencePath(home), rec); } catch { /* evidence is advisory; never fails a task */ }
  return rec;
}

const round = (x) => Math.round(x * 100) / 100;

// Latest record per task (a task finishes once; a re-run after approval would overwrite).
export function readEvidence(home) {
  const p = evidencePath(home);
  const byTask = new Map();
  for (const r of [...readJsonl(`${p}.1`), ...readJsonl(p)]) if (r?.task) byTask.set(r.task, r);
  return [...byTask.values()];
}

// Wilson score interval (95%) for a pass rate: conservative with small samples.
export function wilson(pass, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = pass / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [round(Math.max(0, (c - m) / d)), round(Math.min(1, (c + m) / d))];
}

export function confidence(n) {
  if (n < MIN_SAMPLES) return "insufficient data";
  if (n < 15) return "low";
  if (n < 40) return "medium";
  return "high";
}

const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const mean = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    const k = `${r.type}\u0000${r.executor}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((rs) => {
    const n = rs.length, pass = rs.filter((r) => r.outcome === "pass").length;
    // Cost only from tasks whose every segment reported it.
    const costed = rs.filter((r) => r.cost_measured > 0 && !r.cost_unknown).map((r) => r.cost_usd);
    return {
      type: rs[0].type, executor: rs[0].executor, samples: n, pass, fail: n - pass, pass_rate: round(pass / n), pass_rate_95: wilson(pass, n),
      confidence: confidence(n), median_elapsed_minutes: median(rs.map((r) => r.elapsed_minutes)), median_active_minutes: median(rs.map((r) => r.active_minutes)),
      mean_local_retries: mean(rs.map((r) => r.local_retries)), mean_segment_failures: mean(rs.map((r) => r.segment_failures)),
      mean_cost_usd_measured: mean(costed), cost_samples: costed.length, cost_unknown_samples: n - costed.length,
    };
  });
}

// Advisory per task type: the configured primary vs the evidence. Suggests a different executor
// only when both have >= MIN_SAMPLES and the 95% intervals do not overlap (best lower bound above
// the primary's upper bound); otherwise says why not. Never edits config.
export function recommend(cfg, records) {
  const stats = summarize(records);
  const types = [...new Set([...stats.map((s) => s.type), ...cfg.routing.rules.map((r) => r.type)])].filter(Boolean).sort();
  const out = [];
  for (const type of types) {
    const rule = cfg.routing.rules.find((r) => r.type === type);
    const current = rule?.executor || cfg.routing.default || null;
    const rows = stats.filter((s) => s.type === type).sort((a, b) => b.pass_rate_95[0] - a.pass_rate_95[0] || (a.median_elapsed_minutes ?? Infinity) - (b.median_elapsed_minutes ?? Infinity));
    const cur = rows.find((s) => s.executor === current);
    const eligible = rows.filter((s) => s.samples >= MIN_SAMPLES);
    const best = eligible[0];
    let advice, suggested = null;
    if (!rows.length) advice = "no evidence yet";
    else if (!best) advice = `insufficient data (need >= ${MIN_SAMPLES} terminal tasks per executor)`;
    else if (!cur || cur.samples < MIN_SAMPLES) advice = `insufficient data for the configured executor ${current ?? "(none)"}; ${best.executor} has ${best.samples} samples, pass rate ${best.pass_rate}`;
    else if (best.executor === current) advice = `keep ${current} (best evidence, ${cur.confidence} confidence)`;
    else if (best.pass_rate_95[0] > cur.pass_rate_95[1]) { suggested = best.executor; advice = `consider ${best.executor}: pass rate ${best.pass_rate} (95% ${best.pass_rate_95.join("–")}) vs ${current} ${cur.pass_rate} (95% ${cur.pass_rate_95.join("–")})`; }
    else advice = `no clear difference between ${current} and ${best.executor} (95% intervals overlap); keep ${current}`;
    out.push({ type, configured: current, suggested, advice, executors: rows });
  }
  return { advisory: true, auto_routing: false, note: "advice only — nova-relay never changes routing; edit routing.rules yourself", min_samples: MIN_SAMPLES, records: records.length, types: out };
}
