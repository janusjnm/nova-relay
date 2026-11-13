// cli.test.mjs — the real CLI binary against a temp config: unpause re-queues + reports,
// outbox --flush revives dead letters, log reads events, cancel checks the owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../lib/store.mjs";
import { Outbox } from "../lib/notify.mjs";
import { pauseExecutor, readPaused } from "../lib/budget.mjs";
import { BRIEF, FAKE, tempRepo } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/nova-relay.mjs", import.meta.url));

test("CLI: unpause, outbox --flush revive, log, cancel owner check", () => {
  const { root, repo } = tempRepo();
  const home = join(root, "home");
  const cfgPath = join(root, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    self: "box", coordinator: "box", home, hosts: { box: { role: "box" } },
    executors: { claude: { adapter: "claude", host: "box", bin: FAKE, credential_files: [FAKE] } },
    routing: { rules: [{ type: "code", executor: "claude" }] },
    projects: { PD: { repo, base: "main", owner: "grok", webhook: { url_env: "PD_URL", key_env: "PD_KEY" } } },
  }));
  const env = { ...process.env, NOVA_RELAY_CONFIG: cfgPath, NOVA_RELAY_SECRETS: join(root, "none.env"), PD_URL: "https://127.0.0.1:9/x", PD_KEY: "k".repeat(20) };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });

  assert.match(cli("config-check").stdout, /^OK /);
  const store = new Store(home);
  store.create({ id: "t-1", batch: "b-1", project: "PD", owner: "grok", host: "box", executor: "claude", type: "code" }, BRIEF());
  store.update("t-1", { state: "needs_auth", rev: 3 });
  store.putBatch({ id: "b-1", project: "PD", owner: "grok", expected: 1, tasks: { "t-1": { host: "box", executor: "claude", state: "needs_auth", rev: 3 } }, acked: false });
  store.log("t-1", "note", "hello from the log");
  pauseExecutor(home, "claude", "auth", null);

  assert.match(cli("log", "t-1").stdout, /hello from the log/);
  const c = cli("cancel", "t-1", "--owner", "intruder");
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /belongs to grok/);

  // Worker spawned by unpause is detached; the task state change and report are synchronous.
  const u = cli("unpause", "claude");
  assert.equal(u.status, 0, u.stderr);
  assert.equal(readPaused(home).claude, undefined);
  assert.equal(new Store(home).getBatch("b-1").tasks["t-1"].rev, 4, "coordinator saw the re-queue");

  const ob = new Outbox(home);
  ob.enqueue("dead-1", { kind: "rpc", host: "nowhere", method: "ping", payload: {}, dead: true, attempts: 12 });
  const f = cli("outbox", "--flush");
  assert.match(f.stdout, /revived 1 dead letters/);
});
