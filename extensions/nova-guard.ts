/**
 * nova-guard.ts — Pi coding agent extension (renamed from upstream pi-guard).
 * Every bash/edit/write tool call goes through lib/guard.mjs via the shared approval flow;
 * read-only built-ins pass; any other tool is blocked (fail closed).
 * There is no off switch: disabling the guard requires changing the code.
 * On load it writes <task>/guard-loaded; the runner blocks the task if that marker is missing.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { guardDecision } from "../lib/approvals.mjs";

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

export default function (pi: any) {
  const env = process.env;
  if (env.NOVA_TASK_DIR) {
    try { appendFileSync(join(env.NOVA_TASK_DIR, "guard-loaded"), `${process.pid}\n`); } catch { /* runner will notice */ }
  }
  pi.on("tool_call", async (event: any) => {
    const base = {
      taskDir: env.NOVA_TASK_DIR,
      policy: JSON.parse(env.NOVA_GUARD_POLICY || "{}"),
      workdir: env.NOVA_WORKDIR,
      forbidden: JSON.parse(env.NOVA_FORBIDDEN || "[]"),
    };
    const tool = event?.toolName;
    const input = event?.input ?? {};
    let d: any;
    if (READ_ONLY.has(tool)) d = { allow: true };
    else if (tool === "bash" && typeof input.command === "string") {
      d = guardDecision({ ...base, kind: "bash", subject: input.command });
    } else if ((tool === "write" || tool === "edit") && typeof input.path === "string") {
      // Pi's built-in tools strip a leading "@" before resolving the path; so does the guard.
      d = guardDecision({ ...base, kind: "write", subject: input.path.replace(/^@/, "") });
    } else d = { allow: false, reason: `nova-guard: tool "${tool}" is not allowed for executors` };
    if (d.allow) return undefined;
    process.stderr.write(`[nova-guard] ${d.reason}\n`);
    return { block: true, reason: d.reason };
  });
}
