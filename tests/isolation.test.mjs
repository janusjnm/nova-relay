// isolation.test.mjs — an operator's exported NOVA_RELAY_HOME / NOVA_RELAY_CONFIG / secrets must
// not redirect the real CLI spawned by tests into the operator (or integration) home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BRIEF, FAKE, isolatedEnv, tempRepo, testConfig, testContext } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));

test("tests isolate operator NOVA_RELAY_HOME/CONFIG/SECRETS and webhook keys: real CLI writes only the temp home", () => {
  const canary = join(mkdtempSync(join(tmpdir(), "nova-canary-")), "must-not-exist");
  const operator = {
    NOVA_RELAY_HOME: join(canary, "home"), NOVA_RELAY_CONFIG: join(canary, "config.json"),
    NOVA_RELAY_SECRETS: join(canary, "secrets.env"), NOVA_RELAY_HOST: "vps",
    NOVA_WEBHOOK_URL: "https://operator.example/hook", NOVA_WEBHOOK_KEY: "operator-live-key-zzzz",
    PD_URL: "https://operator.example/pd", PD_KEY: "operator-pd-key-zzzz", DEEPSEEK_API_KEY: "sk-operator-zzzz",
  };
  const saved = Object.fromEntries(Object.keys(operator).map((k) => [k, process.env[k]]));
  Object.assign(process.env, operator);
  try {
    const { root, repo } = tempRepo();
    const home = join(root, "home");
    const cfgPath = join(root, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      self: "box", coordinator: "box", home, hosts: { box: { role: "box" } },
      executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
      routing: { rules: [{ type: "code", executor: "claude" }] },
      projects: { PD: { repo, base: "main", owner: "grok", worktrees: join(root, "wt"), webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
    }));
    const env = isolatedEnv({ NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env"), PD_URL: "https://127.0.0.1:9/x", PD_KEY: "k".repeat(20), FAKE_MODE: "ok" });
    const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    const cc = cli("config-check");
    assert.equal(cc.status, 0, cc.stderr);
    assert.match(cc.stdout, /^OK /);
    writeFileSync(join(root, "a.md"), BRIEF());
    const d = cli("dispatch", "--project", "PD", "--key", "iso-1", "--json", join(root, "a.md"));
    assert.equal(d.status, 0, d.stderr);
    const j = JSON.parse(d.stdout);
    assert.ok(existsSync(join(home, "batches", `${j.batch}.json`)), "batch landed in the temp config's home");
    assert.equal(existsSync(canary), false, "operator NOVA_RELAY_HOME/CONFIG path was never created or written");
    assert.ok(readdirSync(join(home, "batches")).length >= 1);
    for (const k of ["NOVA_RELAY_HOME", "NOVA_RELAY_HOST", "NOVA_WEBHOOK_URL", "NOVA_WEBHOOK_KEY", "DEEPSEEK_API_KEY"]) assert.equal(k in env, false, `${k} stripped`);
    assert.equal(env.PD_KEY, "k".repeat(20), "explicit fixture wins over the operator value");

    const ctx = testContext(testConfig(root, repo));
    for (const k of ["NOVA_RELAY_HOME", "NOVA_RELAY_CONFIG", "NOVA_RELAY_SECRETS", "NOVA_WEBHOOK_KEY", "DEEPSEEK_API_KEY"]) assert.equal(k in ctx.env, false, `${k} not in testContext env`);
    assert.notEqual(ctx.env.PD_KEY, operator.PD_KEY);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
