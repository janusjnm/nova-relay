// evidence.test.mjs — routing evidence after terminal verdicts; `recommend` is advisory only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readEvidence, recommend, wilson } from "../lib/evidence.mjs";
import { dispatch, worker } from "../lib/relay.mjs";
import { BRIEF, FAKE, isolatedEnv, tempRepo, testConfig, testContext } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));

test("evidence recorded once per terminal task with outcome, retries, elapsed and measured (or null) cost", async () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo);
  const ctx = testContext(cfg, { FAKE_MODE: "fail-then-ok" });
  const r = await dispatch(ctx, { project: "PD", owner: "grok", briefs: [{ name: "a.md", text: BRIEF() }] });
  await worker(ctx, { once: true });
  const ev = readEvidence(cfg.home);
  assert.equal(ev.length, 1);
  const e = ev[0];
  assert.equal(e.task, r.tasks[0].id);
  assert.deepEqual([e.type, e.executor, e.outcome, e.local_retries, e.segments], ["code", "claude", "pass", 1, 2]);
  assert.equal(e.cost_usd, 0.02, "fake CLI reports 0.01 per segment: measured");
  assert.equal(e.tokens, null, "tokens not reported: unknown, not 0");
  assert.equal(e.tokens_unknown, 2);
  assert.equal(typeof e.elapsed_minutes, "number");
});

const rec = (executor, n, pass, type = "code") => Array.from({ length: n }, (_, i) => ({ task: `${executor}-${type}-${i}`, type, executor, outcome: i < pass ? "pass" : "fail", elapsed_minutes: 10, active_minutes: 5, local_retries: 0, segment_failures: 0, cost_usd: null, cost_measured: 0, cost_unknown: 1 }));

test("recommend: insufficient data below the minimum sample; suggests only when 95% intervals separate; never edits config", () => {
  const { root, repo } = tempRepo();
  const cfg = testConfig(root, repo, { executors: {
    claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] },
    alt: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
  routing: { rules: [{ type: "code", executor: "claude", fallback: ["alt"] }], default: "claude" } });
  const before = JSON.stringify(cfg);
  const few = recommend(cfg, [...rec("claude", 3, 1), ...rec("alt", 4, 4)]);
  assert.match(few.types[0].advice, /insufficient data/);
  assert.equal(few.types[0].suggested, null);
  assert.equal(few.auto_routing, false);
  const overlap = recommend(cfg, [...rec("claude", 6, 4), ...rec("alt", 6, 6)]);
  assert.match(overlap.types[0].advice, /no clear difference/);
  assert.equal(overlap.types[0].suggested, null, "6/6 vs 4/6 is not enough evidence");
  const clear = recommend(cfg, [...rec("claude", 40, 10), ...rec("alt", 40, 39)]);
  assert.equal(clear.types[0].suggested, "alt");
  assert.equal(clear.types[0].executors.find((x) => x.executor === "alt").confidence, "high");
  assert.equal(JSON.stringify(cfg), before, "recommend never changes routing");
  assert.equal(cfg.routing.rules[0].executor, "claude");
  const [lo, hi] = wilson(5, 5);
  assert.ok(lo < 0.6 && hi === 1, "5/5 is not '100% reliable'");
});

test("CLI recommend --json and human output (isolated env)", () => {
  const { root, repo } = tempRepo();
  const home = join(root, "home");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ self: "box", coordinator: "box", home, hosts: { box: { role: "box" } },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
    routing: { rules: [{ type: "code", executor: "claude" }] }, projects: { PD: { repo, base: "main" } } }));
  const env = isolatedEnv({ NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env") });
  const j = JSON.parse(spawnSync(process.execPath, [CLI, "recommend", "--json"], { env, encoding: "utf8" }).stdout);
  assert.equal(j.advisory, true);
  assert.equal(j.records, 0);
  assert.equal(j.types[0].advice, "no evidence yet");
  const h = spawnSync(process.execPath, [CLI, "recommend"], { env, encoding: "utf8" });
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /never changes routing/);
});
