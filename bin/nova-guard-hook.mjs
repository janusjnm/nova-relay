#!/usr/bin/env node
// nova-guard-hook — Claude Code PreToolUse hook. Reads the tool call JSON on stdin.
// Exit 0 = allow; exit 2 = block (stderr is shown to Claude as the reason).
import { readFileSync } from "node:fs";
import { guardDecision } from "../lib/approvals.mjs";

let ev = {};
try { ev = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
const tool = ev.tool_name || "";
const input = ev.tool_input || {};
const env = process.env;
const policy = JSON.parse(env.NOVA_GUARD_POLICY || "{}");
const base = { taskDir: env.NOVA_TASK_DIR, policy, workdir: env.NOVA_WORKDIR, forbidden: JSON.parse(env.NOVA_FORBIDDEN || "[]") };

let d = { allow: true };
if (tool === "Bash" && typeof input.command === "string") d = guardDecision({ ...base, kind: "bash", subject: input.command });
else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = input.file_path || input.notebook_path;
  if (p) d = guardDecision({ ...base, kind: "write", subject: p });
}
if (d.allow) process.exit(0);
process.stderr.write(`${d.reason}\n`);
process.exit(2);
