// deepseek-check.mjs — doctor --live check for a DeepSeek key and model id: GET /user/balance and
// GET /models (official DeepSeek API endpoints; cost nothing, need network). Opt-in only.

// Model ids are never defaulted or guessed: the configured id must be explicit, well-formed and
// (doctor --live) listed by the provider. A missing/invalid id fails closed; nothing is substituted.
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,127}$/;
export function modelProblem(model, where = "model") {
  if (model === undefined || model === null || model === "") return `${where}: required — set it explicitly to an id your provider lists (DeepSeek: GET /models; \`nova-relay doctor --live\` checks it). No default is assumed`;
  if (typeof model === "string" && /^<.*>$/.test(model)) return `${where}: "${model}" is a placeholder — replace it with an id your provider lists (DeepSeek: GET /models)`;
  if (typeof model !== "string" || !MODEL_ID.test(model)) return `${where}: "${model}" is not a valid model id (letters, digits, . _ : / @ + -)`;
  return null;
}

export async function deepseekKeyCheck({ key, model, origin = "https://api.deepseek.com", fetchImpl = fetch }) {
  if (!key) return { ok: false, detail: "key not set" };
  const mp = modelProblem(model);
  if (mp) return { ok: false, detail: mp };
  const get = async (path) => {
    const res = await fetchImpl(`${origin}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return { status: res.status, ok: res.ok, json: res.ok ? JSON.parse(await res.text()) : null };
  };
  try {
    const bal = await get("/user/balance");
    if (bal.status === 401 || bal.status === 403) return { ok: false, detail: `key rejected (HTTP ${bal.status})` };
    if (!bal.ok) return { ok: false, detail: `HTTP ${bal.status}` };
    if (bal.json.is_available === false) return { ok: false, detail: "key valid but balance unavailable (top up)" };
    // The configured id must be in the provider's own list; an unreadable list is not a pass.
    const m = await get("/models");
    const ids = m.ok && Array.isArray(m.json?.data) ? m.json.data.map((x) => x.id) : null;
    if (!ids) return { ok: false, detail: `could not read the model list (GET /models: HTTP ${m.status}); model "${model}" not verified` };
    if (!ids.includes(model)) return { ok: false, detail: `model "${model}" not offered by the API (available: ${ids.join(", ") || "none"}); nothing is substituted — fix the config` };
    return { ok: true, detail: `key accepted, balance available, model ${model} listed by /models` };
  } catch (e) {
    return { ok: false, detail: `request failed: ${e.message}` };
  }
}
