#!/usr/bin/env node
// Fake executor CLI for tests. Behaviour is chosen by FAKE_MODE (env), counted per task dir.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
if (args[0] === "--version") { console.log(mode === "oldversion" ? "0.0.1 (fake)" : "9.9.9 (fake)"); process.exit(0); }
if (args.includes("--help")) {
  const flags = "--print --output-format --verbose --resume --session-id --settings --permission-mode --allowedTools --disallowedTools --provider --model --tools --no-session --sandbox --output-last-message --cd --skip-git-repo-check";
  console.log(mode === "badflags" ? "--print --output-format" : flags);
  process.exit(0);
}
const taskDir = process.env.NOVA_TASK_DIR || ".";
const countFile = join(taskDir, "fake-count");
const n = (existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;
writeFileSync(countFile, String(n));
appendFileSync(join(taskDir, "fake-args.jsonl"), JSON.stringify(args) + "\n");
const result = (text, isError = false) => {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: isError, result: text, session_id: "sess-" + n, total_cost_usd: 0.01 }));
};
const write = (p, s) => { mkdirSync(join(process.cwd(), p, ".."), { recursive: true }); writeFileSync(join(process.cwd(), p), s); };
const hook = (tool, input) => spawnSync(process.execPath, [process.env.HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: input }), encoding: "utf8", env: process.env });

switch (mode === "fail-then-ok" ? (n === 1 ? "wrong" : "ok") : mode === "net-then-ok" ? (n === 1 ? "net" : "ok") : mode) {
  case "ok": write("src/hello.txt", "hello\n"); result("PROGRESS: wrote hello | REMAINING: none | NEXT: -"); break;
  case "wrong": write("src/hello.txt", "nope\n"); result("done!"); break;
  case "liar": result("All done, tests pass!"); break;  // claims success, changes nothing
  case "skip-tests": write("src/hello.txt", "hello\n"); write("tests/a.test.js", "it.skip('x', () => {})\n"); result("done"); break;
  case "out-of-scope": write("src/hello.txt", "hello\n"); write("other/x.txt", "x"); result("done"); break;
  case "quota": console.log("Claude AI usage limit reached|" + Math.floor(Date.now() / 1000 + 3600)); process.exit(1);
  case "auth": console.error("Invalid API key · Please run /login"); process.exit(1);
  case "net": console.error("Error: socket hang up ECONNRESET"); process.exit(1);
  case "badflag-run": console.error("error: unknown option '--session-id'"); process.exit(1);
  case "hang": setInterval(() => {}, 1000); break;
  case "guard": {
    const r = hook("Bash", { command: "rm -rf /" });
    write("src/hello.txt", "hello\n");
    result(`blocked=${r.status === 2} ${r.stderr.trim()}`);
    break;
  }
  case "secret": write("src/hello.txt", "hello\n"); result("my key is sk-abcdefghijklmnopqrstuvwxyz123456"); break;
  default: console.error("unknown FAKE_MODE " + mode); process.exit(1);
}
