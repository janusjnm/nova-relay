// deepseek-check.mjs — doctor --live check for a DeepSeek key and model id: GET /user/balance and
// GET /models (official DeepSeek API endpoints; cost nothing, need network). Opt-in only.
export async function deepseekKeyCheck({ key, model, origin = "https://api.deepseek.com", fetchImpl = fetch }) {
  if (!key) return { ok: false, detail: "key not set" };
  const get = async (path) => {
    const res = await fetchImpl(`${origin}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return { status: res.status, ok: res.ok, json: res.ok ? JSON.parse(await res.text()) : null };
  };
  try {
    const bal = await get("/user/balance");
    if (bal.status === 401 || bal.status === 403) return { ok: false, detail: `key rejected (HTTP ${bal.status})` };
    if (!bal.ok) return { ok: false, detail: `HTTP ${bal.status}` };
    if (bal.json.is_available === false) return { ok: false, detail: "key valid but balance unavailable (top up)" };
    if (model) {
      const m = await get("/models");
      const ids = m.ok && Array.isArray(m.json?.data) ? m.json.data.map((x) => x.id) : null;
      if (ids && !ids.includes(model)) return { ok: false, detail: `model "${model}" not offered by the API (available: ${ids.join(", ")})` };
    }
    return { ok: true, detail: `key accepted, balance available${model ? `, model ${model}` : ""}` };
  } catch (e) {
    return { ok: false, detail: `request failed: ${e.message}` };
  }
}
