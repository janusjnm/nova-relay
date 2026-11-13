#!/usr/bin/env node
// nova-guard-hook — Claude Code PreToolUse hook. Reads the tool call JSON on stdin.
// Exit 0 = allow; exit 2 = block (stderr is shown to Claude as the reason).
// Every invocation is counted in <task>/hook-calls so the runner can tell that the hook is live.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guardDecision } from "../lib/approvals.mjs";

const env = process.env;
if (env.NOVA_TASK_DIR) { try { appendFileSync(join(env.NOVA_TASK_DIR, "hook-calls"), "1\n"); } catch { /* ignore */ } }
let ev = {};
// Unparseable input: fail closed (block) rather than silently allowing.
try { ev = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.stderr.write("nova-guard: unreadable hook input; blocked\n"); process.exit(2); }
const tool = ev.tool_name || "";
const input = ev.tool_input || {};
const policy = JSON.parse(env.NOVA_GUARD_POLICY || "{}");
const base = { taskDir: env.NOVA_TASK_DIR, policy, workdir: env.NOVA_WORKDIR, forbidden: JSON.parse(env.NOVA_FORBIDDEN || "[]") };

let d = { allow: true };
// ev.cwd = the Bash tool's current directory (it persists across calls), so relative targets and
// scripts are resolved where the shell really is.
if (tool === "Bash" && typeof input.command === "string") d = guardDecision({ ...base, kind: "bash", subject: input.command, cwd: ev.cwd });
else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = input.file_path || input.notebook_path;
  d = p ? guardDecision({ ...base, kind: "write", subject: p }) : { allow: false, reason: "nova-guard: write tool call without a path; blocked" };
}
if (d.allow) process.exit(0);
process.stderr.write(`${d.reason}\n`);
process.exit(2);
