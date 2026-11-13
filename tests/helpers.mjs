// Test helpers: temp git repo + single-host config wired to the fake executor.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeConfig } from "../lib/config.mjs";
import { makeContext } from "../lib/relay.mjs";

export const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
export const HOOK = fileURLToPath(new URL("../bin/nova-guard-hook.mjs", import.meta.url));

export function sh(cwd, cmd) {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

export function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "nova-test-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "keep.txt"), "keep\n");
  sh(repo, "git init -q -b main && git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm init");
  return { root, repo };
}

export function testConfig(root, repo, overrides = {}) {
  const raw = {
    self: "box", coordinator: "box",
    hosts: { box: { role: "box" } },
    home: join(root, "home"),
    limits: { min_free_mb: 1, segment_minutes: 1, idle_timeout_sec: 30, max_local_retries: 2, max_segment_failures: 3, lease_ttl_sec: 30 },
    executors: {
      claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] },
      "deepseek-text": { adapter: "deepseek-text", host: "box", model: "test-model" },
    },
    routing: { rules: [{ type: "code", executor: "claude" }, { type: "text", executor: "deepseek-text" }], default: "claude" },
    projects: { PD: { repo, base: "main", worktrees: join(root, "wt"), webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
    ...overrides,
  };
  return normalizeConfig(raw, {});
}

export function testContext(cfg, envExtra = {}, opts = {}) {
  const env = { ...process.env, HOME: process.env.HOME, PD_URL: "https://grok.example/hook", PD_KEY: "k".repeat(20), HOOK, ...envExtra };
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200, text: async () => "{}" }; };
  const ctx = makeContext(cfg, { env, fetchImpl, spawnWorker: () => {}, backoffScale: 0, ...opts });
  ctx.sent = sent;
  return ctx;
}

export const BRIEF = (extra = "") => `---
type: code
project: PD
---
# Goal
Create src/hello.txt containing hello.

# Scope
- src/**

# Acceptance
grep -qx hello src/hello.txt
${extra}`;
