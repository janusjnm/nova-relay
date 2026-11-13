// deepseek-text.mjs — plain DeepSeek chat-completions call for text-only jobs
// (copy, translation, summaries). No agent shell, no tools, no file access.
import { deepseekKeyCheck } from "./deepseek-check.mjs";
export default {
  name: "deepseek-text",
  kind: "text",
  sessions: false,
  defaults: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", key_env: "DEEPSEEK_API_KEY", max_tokens: 4000, timeout_sec: 300 },
  credentialEnv: (ex) => [ex.key_env || "DEEPSEEK_API_KEY"],

  validate(ex) {
    const e = ex.endpoint || this.defaults.endpoint;
    return /^https:\/\//.test(e) ? [] : ["endpoint must be https://"];
  },

  async liveCheck({ ex, env, fetchImpl }) {
    const o = { ...this.defaults, ...ex };
    return deepseekKeyCheck({ key: env[o.key_env], origin: new URL(o.endpoint).origin, fetchImpl });
  },

  async run({ ex, prompt, env = process.env, fetchImpl = fetch, signal }) {
    const o = { ...this.defaults, ...ex };
    const key = env[o.key_env];
    if (!key) { const e = new Error(`401 missing ${o.key_env}`); e.output = e.message; throw e; }
    const res = await fetchImpl(o.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: o.model, max_tokens: o.max_tokens, messages: [
        { role: "system", content: "You complete text-only jobs (copywriting, translation, summaries). Output only the deliverable." },
        { role: "user", content: prompt }] }),
      signal: signal ?? AbortSignal.timeout(o.timeout_sec * 1000),
    });
    const body = await res.text();
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.output = `HTTP ${res.status} ${body.slice(0, 500)}`; throw e; }
    const j = JSON.parse(body);
    return { text: j.choices?.[0]?.message?.content ?? "", usage: { tokens: j.usage?.total_tokens ?? 0 } };
  },
};
