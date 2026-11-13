// usage.mjs — normalized usage as reported by a provider: measured numbers or null (unknown).
//
// A field the provider did not report is null, never 0: a missing number is not a measured zero.
// Nothing here prices tokens or converts tokens to dollars. For subscription CLIs (Claude Code,
// Codex) reported cost/tokens are what the CLI prints for that run — not a bill and not the
// remaining subscription quota.
//
//   { cost_usd: number|null, tokens: number|null, detail: { <token field>: number } }
//   tokens = sum of the token fields the provider actually reported (null if none was).

export const UNKNOWN_USAGE = Object.freeze({ cost_usd: null, tokens: null, detail: Object.freeze({}) });

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function fromFields(src, fields, sumFields = fields) {
  const detail = {};
  for (const f of fields) if (num(src?.[f]) !== null) detail[f] = src[f];
  const reported = sumFields.filter((f) => f in detail);
  return { tokens: reported.length ? reported.reduce((a, f) => a + detail[f], 0) : null, detail };
}

// Claude Code stream-json `result` event: total_cost_usd and usage.{input,output,cache_*}_tokens.
// Anthropic reports cache creation/read separately from input_tokens, so the sum does not double count.
export const CLAUDE_TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
export function claudeUsage(result) {
  const { tokens, detail } = fromFields(result?.usage, CLAUDE_TOKEN_FIELDS);
  return { cost_usd: num(result?.total_cost_usd), tokens, detail };
}

// OpenAI-style chat completion usage (DeepSeek): total_tokens, else prompt + completion if reported.
export function chatUsage(u) {
  const { detail } = fromFields(u, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]);
  let tokens = detail.total_tokens ?? null;
  if (tokens === null && ("prompt_tokens" in detail || "completion_tokens" in detail)) tokens = (detail.prompt_tokens || 0) + (detail.completion_tokens || 0);
  return { cost_usd: null, tokens, detail };
}

// Codex `turn.completed` usage: input_tokens (cached_input_tokens is a subset of it) + output_tokens.
export function codexUsage(events) {
  const total = {};
  for (const u of events) for (const f of ["input_tokens", "cached_input_tokens", "output_tokens"]) if (num(u?.[f]) !== null) total[f] = (total[f] || 0) + u[f];
  const { tokens, detail } = fromFields(total, ["input_tokens", "cached_input_tokens", "output_tokens"], ["input_tokens", "output_tokens"]);
  return { cost_usd: null, tokens, detail };
}

// Accumulate one segment's usage into a running total that keeps measured vs unknown apart.
//   { tokens, tokens_measured, tokens_unknown, cost_usd, cost_measured, cost_unknown, token_detail }
export function emptyTotals() {
  return { tokens: 0, tokens_measured: 0, tokens_unknown: 0, cost_usd: 0, cost_measured: 0, cost_unknown: 0, token_detail: {} };
}

export function addToTotals(tot, usage = UNKNOWN_USAGE) {
  const t = { ...emptyTotals(), ...tot, token_detail: { ...(tot?.token_detail || {}) } };
  if (num(usage.tokens) !== null) { t.tokens += usage.tokens; t.tokens_measured++; } else t.tokens_unknown++;
  if (num(usage.cost_usd) !== null) { t.cost_usd = Math.round((t.cost_usd + usage.cost_usd) * 1e6) / 1e6; t.cost_measured++; } else t.cost_unknown++;
  for (const [k, v] of Object.entries(usage.detail || {})) if (num(v) !== null) t.token_detail[k] = (t.token_detail[k] || 0) + v;
  return t;
}

// Human view of one measured/unknown pair: "1234 (3 measured, 1 unknown)" / "unknown (2 segments)".
export function showMeasured(value, measured, unknown, unit = "") {
  if (!measured && !unknown) return "-";
  if (!measured) return `unknown (${unknown} segment${unknown === 1 ? "" : "s"} not reported)`;
  return `${value}${unit} measured over ${measured} segment${measured === 1 ? "" : "s"}${unknown ? `, ${unknown} not reported (unknown)` : ""}`;
}
