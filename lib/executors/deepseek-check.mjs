// deepseek-check.mjs — doctor --live check for a DeepSeek key: GET /user/balance (official
// DeepSeek API endpoint; costs nothing, needs network). Opt-in only.
export async function deepseekKeyCheck({ key, origin = "https://api.deepseek.com", fetchImpl = fetch }) {
  if (!key) return { ok: false, detail: "key not set" };
  try {
    const res = await fetchImpl(`${origin}/user/balance`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `key rejected (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const j = JSON.parse(await res.text());
    return j.is_available === false ? { ok: false, detail: "key valid but balance unavailable (top up)" } : { ok: true, detail: "key accepted, balance available" };
  } catch (e) {
    return { ok: false, detail: `request failed: ${e.message}` };
  }
}
