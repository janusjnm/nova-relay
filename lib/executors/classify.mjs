// classify.mjs — map an executor failure (exit code + output) to what the runner should do.
//   model    the provider rejected the configured model id → blocked, wake (fix the config;
//            no other id is ever substituted)
//   cli      flags removed/renamed → blocked, wake (needs a human / upgrade)
//   auth     logged out, key invalid, billing → needs_auth, wake once
//   quota    subscription/rate limit → pause executor until reset, never loop silently
//   context  context window overflow → next segment starts a fresh session from progress.md
//   network  transient (DNS, socket, 5xx, overloaded) → retry with backoff, counts as segment failure
//   error    anything else → segment failure
const RULES = [
  ["model", /model[ _]not[ _]exists?|model (?:"[^"\n]*" |'[^'\n]*' |\S+ )?(?:does not exist|not found|is not supported|not available)|(?:invalid|unknown|unsupported) model|model not configured/i],
  ["cli", /unknown (option|argument|flag)|unrecognized (option|argument)|unexpected argument|invalid option|no such option|error: option '/i],
  ["auth", /not logged in|please run \/login|\/login to|invalid api key|invalid x-api-key|authentication[_ ]?error|unauthori[sz]ed|\b401\b|token (has )?expired|login required|re-?authenticate|refresh token|insufficient balance|\b402\b|payment required/i],
  ["quota", /usage limit|rate[ _-]?limit|too many requests|\b429\b|quota exceeded|insufficient_quota|limit reached|limit will reset|hit your .*limit/i],
  ["context", /prompt is too long|context[ _]length|context window|maximum context|too many tokens|context_length_exceeded/i],
  ["network", /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|UND_ERR_\w+|socket hang up|network error|fetch failed|getaddrinfo|connection (reset|refused|closed)|overloaded|\b50[0234]\b|\b529\b|temporarily unavailable/i],
];

export function classifyFailure(output, extraRules = []) {
  const text = String(output ?? "");
  for (const [kind, re] of [...extraRules, ...RULES]) if (re.test(text)) return { kind, reset_at: kind === "quota" ? parseReset(text) : null };
  return { kind: "error", reset_at: null };
}

// "usage limit reached|1731500000" (epoch secs) or "try again in 2h 5m" / "resets in 37 minutes".
export function parseReset(text, now = Date.now()) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const m = text.match(/(?:try again|retry|resets?|reset)\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?\s*)?(?:(\d+)\s*s(?:ec(?:onds?|s)?)?)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
    return new Date(now + ms).toISOString();
  }
  return null;
}
