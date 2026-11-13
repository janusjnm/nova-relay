// routing.test.mjs — config validation and task routing (incl. project isolation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, normalizeConfig, webhookFor, webhookUrlAllowed } from "../lib/config.mjs";
import { route } from "../lib/routing.mjs";
import { parseBrief } from "../lib/brief.mjs";

const base = () => ({
  self: "box", coordinator: "vps",
  hosts: { box: { role: "box" }, vps: { role: "vps", ssh: "mm01" } },
  executors: {
    claude: { adapter: "claude", host: "box" },
    codex: { adapter: "codex", host: "vps" },
    pi: { adapter: "pi", host: "vps" },
    "deepseek-text": { adapter: "deepseek-text", host: "vps" },
  },
  routing: { rules: [
    { type: "long-code", executor: "claude", fallback: ["codex"] },
    { type: "code", executor: "codex", fallback: ["pi"] },
    { type: "edit", executor: "pi" },
    { type: "text", executor: "deepseek-text" },
  ], default: "pi" },
  projects: {
    PD: { repo: { box: "/srv/pd", vps: "/home/u/pd" }, webhook: { url_env: "PD_URL", key_env: "PD_KEY" } },
    NM: { repo: "/srv/nm", executors: ["pi", "deepseek-text"] },
  },
});
const cfg = normalizeConfig(base(), {});
const brief = (type, extra = "") => parseBrief(`---\ntype: ${type}\n${extra}---\n# Goal\nx\n# Scope\n- src/**\n# Acceptance\ntrue\n`);

const problems = (mut) => {
  const raw = base();
  mut(raw);
  try { normalizeConfig(raw, {}); return []; } catch (e) { assert.ok(e instanceof ConfigError); return e.problems; }
};

test("routes by task type to the configured executor/host", () => {
  assert.deepEqual(route(cfg, brief("long-code"), { project: "PD" }).executor, "claude");
  assert.equal(route(cfg, brief("long-code"), { project: "PD" }).host, "box");
  assert.equal(route(cfg, brief("code"), { project: "PD" }).executor, "codex");
  assert.equal(route(cfg, brief("text"), { project: "PD" }).executor, "deepseek-text");
  assert.equal(route(cfg, brief("unknown-type"), { project: "PD" }).executor, "pi", "default");
  assert.equal(route(cfg, brief("code", "executor: claude\n"), { project: "PD" }).executor, "claude", "explicit override");
});

test("paused primary → fallback; all paused → wait on primary", () => {
  const r = route(cfg, brief("long-code"), { project: "PD", paused: { claude: { reason: "quota" } } });
  assert.deepEqual([r.executor, r.rerouted], ["codex", true]);
  const w = route(cfg, brief("edit"), { project: "PD", paused: { pi: { reason: "quota" } } });
  assert.equal(w.executor, "pi");
  assert.ok(w.waiting);
});

test("project isolation: allowlist, mismatched project, cross-project paths", () => {
  assert.equal(route(cfg, brief("code"), { project: "NM" }).executor, "pi", "NM only allows pi/deepseek-text");
  assert.throws(() => route(cfg, brief("long-code", "executor: claude\n"), { project: "NM" }), /does not allow/);
  assert.throws(() => route(cfg, brief("code", "project: NM\n"), { project: "PD" }), /cross-project/);
  assert.throws(() => route(cfg, parseBrief("---\ntype: code\n---\n# Goal\nx\n# Scope\n- ../nm/**\n"), { project: "PD" }), /escapes/);
  assert.throws(() => route(cfg, brief("code"), { project: "XX" }), /unknown project/);
});

test("config validation gives clear, path-qualified errors", () => {
  assert.ok(problems((r) => { r.executors.claude.host = "vps"; }).some((p) => p.includes("claude runs only on the box")));
  assert.ok(problems((r) => { r.executors.claude.args = ["--bare"]; }).some((p) => p.includes("--bare")));
  assert.ok(problems((r) => { r.executors.claude.env = { ANTHROPIC_BASE_URL: "x" }; }).some((p) => p.includes("gateway")));
  assert.ok(problems((r) => { r.executors.codex.args = ["--dangerously-bypass-approvals-and-sandbox"]; }).some((p) => p.includes("sandbox bypass")));
  assert.ok(problems((r) => { r.executors.x = { adapter: "nope" }; }).some((p) => p.startsWith("executors.x.adapter")));
  assert.ok(problems((r) => { r.routing.rules[0].executor = "ghost"; }).some((p) => p.includes('unknown executor "ghost"')));
  assert.ok(problems((r) => { r.projects.NM.repo = "/srv/pd/sub"; r.projects.PD.repo = "/srv/pd"; }).some((p) => p.includes("projects must be isolated")));
  assert.ok(problems((r) => { r.projects.PD.repo = "relative/path"; }).some((p) => p.includes("absolute")));
  assert.ok(problems((r) => { r.hosts.vps = {}; }).some((p) => p.includes("hosts.vps.ssh")));
  assert.ok(problems((r) => { r.limits = { max_segments: 0 }; }).some((p) => p.includes("limits.max_segments")));
  assert.ok(problems((r) => { r.schema = 99; }).some((p) => p.includes("newer")));
  assert.ok(problems((r) => { r.display_tz = "Mars/Base"; }).some((p) => p.includes("timezone")));
  assert.deepEqual(problems(() => {}), []);
});

test("webhooks: only https or Tailscale; secrets only from env", () => {
  assert.ok(webhookUrlAllowed("https://x.example/hook"));
  assert.ok(webhookUrlAllowed("http://box.tail1234.ts.net:8080/h"));
  assert.ok(webhookUrlAllowed("http://100.101.1.2/h"));
  assert.ok(!webhookUrlAllowed("http://example.com/h"));
  assert.ok(!webhookUrlAllowed("http://100.20.1.2/h"), "not CGNAT range");
  assert.ok(webhookFor(cfg, "PD", {}).error);
  assert.ok(webhookFor(cfg, "PD", { PD_URL: "http://evil.example", PD_KEY: "k" }).error);
  assert.deepEqual(webhookFor(cfg, "PD", { PD_URL: "https://ok.example", PD_KEY: "k" }), { url: "https://ok.example", key: "k" });
  assert.ok(webhookFor(cfg, "NM", {}).error, "NM has no webhook and no global default");
});
