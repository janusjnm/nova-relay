// usage.test.mjs — measured vs unknown usage, segment reservation, `nova-relay stats`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeUsage, chatUsage, codexUsage, addToTotals, UNKNOWN_USAGE } from "../lib/usage.mjs";
import { addUsage, overBudget, reserveSegment, unenforceableCaps, usageToday } from "../lib/budget.mjs";
import { ADAPTERS } from "../lib/executors/index.mjs";
import { dispatch, worker } from "../lib/relay.mjs";
import { stats } from "../lib/stats.mjs";
import { BRIEF, FAKE, isolatedEnv, tempRepo, testConfig, testContext } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));

test("claude result usage: reported numbers are measured, missing ones are null (never 0)", () => {
  assert.deepEqual(claudeUsage({ total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }),
    { cost_usd: 0.25, tokens: 115, detail: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } });
  assert.deepEqual(claudeUsage({ result: "x" }), { cost_usd: null, tokens: null, detail: {} });
  assert.deepEqual(claudeUsage({ total_cost_usd: 0, usage: { output_tokens: 7 } }), { cost_usd: 0, tokens: 7, detail: { output_tokens: 7 } }, "a reported 0 is a measured 0");
  const p = ADAPTERS.claude.parseOutput(`${JSON.stringify({ type: "result", result: "ok", session_id: "s" })}\n`);
  assert.equal(p.usage.cost_usd, null, "the old parser turned a missing total_cost_usd into 0");
  assert.equal(ADAPTERS.claude.parseOutput("not json").usage, UNKNOWN_USAGE);
});

test("deepseek / codex usage: total_tokens or reported fields; nothing reported → null", () => {
  assert.equal(chatUsage({ total_tokens: 42 }).tokens, 42);
  assert.equal(chatUsage({ prompt_tokens: 3, completion_tokens: 4 }).tokens, 7);
  assert.equal(chatUsage(undefined).tokens, null);
  assert.equal(chatUsage({}).cost_usd, null, "no price is invented");
  assert.equal(codexUsage([{ input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 }]).tokens, 120, "cached input is a subset of input");
  assert.equal(codexUsage([{}]).tokens, null);
  const out = ['{"type":"thread.started"}', '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'].join("\n");
  assert.equal(ADAPTERS.codex.parseOutput(out, {}).usage.tokens, 6);
});

test("ledger keeps measured and unknown apart; caps compare measured sums; blind caps are reported", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-usage-"));
  addUsage(home, "claude", { minutes: 3, usage: { cost_usd: 0.5, tokens: null, detail: {} } });
  addUsage(home, "claude", { minutes: 2, usage: UNKNOWN_USAGE });
  const u = usageToday(home, "claude");
  assert.equal(u.cost_usd, 0.5);
  assert.equal(u.cost_measured, 1);
  assert.equal(u.cost_unknown, 1);
  assert.equal(u.tokens_measured, 0);
  assert.equal(u.tokens_unknown, 2);
  assert.equal(overBudget(home, "claude", { cost_usd_per_day: 0.5 }), "cost_usd 0.5 >= 0.5/day");
  assert.equal(overBudget(home, "claude", { tokens_per_day: 1 }), null, "unknown tokens never count as usage");
  assert.deepEqual(unenforceableCaps(u, { tokens_per_day: 1 }), ["tokens_per_day (no token counts reported)"]);
  const t = addToTotals(addToTotals(undefined, { cost_usd: 0.1, tokens: 3, detail: { output_tokens: 3 } }), UNKNOWN_USAGE);
  assert.deepEqual([t.tokens, t.tokens_measured, t.tokens_unknown, t.token_detail.output_tokens], [3, 1, 1, 3]);
});

test("reserveSegment: the last slot of segments_per_day goes to exactly one caller", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-reserve-"));
  addUsage(home, "claude", { segments: 1 });
  const a = reserveSegment(home, "claude", { segments_per_day: 2 });
  const b = reserveSegment(home, "claude", { segments_per_day: 2 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.over, /segments 2 >= 2\/day/);
  assert.equal(usageToday(home, "claude").segments, 2, "no overshoot");
});

test("runner: two tasks, one segment left today → one runs, the other pauses on budget (no overshoot); usage measured/unknown recorded", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  cfg.executors.claude.budget = { segments_per_day: 1 };
  const ctx = testContext(cfg, { FAKE_MODE: "ok", FAKE_USAGE: JSON.stringify({ input_tokens: 12, output_tokens: 8 }) });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [
    { name: "a.md", text: BRIEF().replace("- src/**", "- src/a/**").replace("src/hello.txt", "src/a/x") },
    { name: "b.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const states = r.tasks.map((x) => ctx.store.get(x.id).state).sort();
  assert.ok(states.includes("paused"), `one task paused on budget (${states})`);
  const u = usageToday(cfg.home, "claude");
  assert.equal(u.segments, 1, "segments_per_day not overshot by the parallel task");
  assert.equal(u.tokens, 20);
  assert.equal(u.tokens_measured, 1);
  assert.equal(u.cost_usd, 0.01);
  const ran = r.tasks.map((x) => ctx.store.get(x.id)).find((x) => x.segments === 1);
  assert.equal(ran.usage.tokens, 20, "per-task totals kept for routing evidence");
});

test("stats: unknown shown as unknown, caps, pause state, notification attempts vs deliveries (CLI human + --json)", async () => {
  const { root, repo } = tempRepo();
  const home = join(root, "home");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    self: "box", coordinator: "box", home, hosts: { box: { role: "box" } },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE], budget: { tokens_per_day: 1000 } } },
    routing: { rules: [{ type: "code", executor: "claude" }] },
    projects: { PD: { repo, base: "main", owner: "grok", webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
  }));
  const cfg = testConfig(root, repo);
  let fail = 1;
  const ctx = testContext(cfg, { FAKE_MODE: "ok", FAKE_NO_COST: "1" }, {
    fetchImpl: async () => { if (fail-- > 0) throw new Error("ECONNRESET"); return { ok: true, status: 200, text: async () => "{}" }; } });
  await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const { flushOutbox } = await import("../lib/relay.mjs");
  await flushOutbox(ctx, { now: Date.now() + 60_000 });
  const s = stats(cfg);
  const c = s.executors.find((e) => e.executor === "claude");
  assert.equal(c.segments, 1);
  assert.equal(c.cost_usd.value, null, "missing cost is unknown, not 0");
  assert.equal(c.cost_usd.unknown_segments, 1);
  assert.equal(c.tokens.value, null);
  assert.equal(s.notifications.planner_webhooks.notification_attempts, 2);
  assert.equal(s.notifications.planner_webhooks.notification_deliveries, 1, "one batch_done delivered once");
  assert.equal(s.notifications.planner_webhooks.notification_failures, 1);
  assert.equal(s.display_tz, "Asia/Singapore");
  assert.match(s.window.from_local, /Asia\/Singapore$/);
  assert.ok(s.notes.some((n) => /not a bill and not the remaining subscription quota/.test(n)));

  const env = isolatedEnv({ NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env") });
  const human = spawnSync(process.execPath, [CLI, "stats"], { env, encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /tokens unknown \(1 segment not reported\)/);
  assert.match(human.stdout, /cannot enforce: tokens_per_day/);
  assert.match(human.stdout, /planner webhooks: 1 delivered \(unique keys\), 2 attempts/);
  const j = JSON.parse(spawnSync(process.execPath, [CLI, "stats", "--json"], { env, encoding: "utf8" }).stdout);
  assert.equal(j.executors[0].tokens.value, null);
  assert.equal(j.day_utc, new Date().toISOString().slice(0, 10));
});
