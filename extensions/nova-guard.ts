/**
 * nova-guard.ts — Pi coding agent extension (renamed from upstream pi-guard).
 * Every bash/edit/write tool call goes through lib/guard.mjs via the shared approval flow.
 * There is no off switch: disabling the guard requires changing the code.
 */
import { guardDecision } from "../lib/approvals.mjs";

export default function (pi: any) {
  pi.on("tool_call", async (event: any) => {
    const env = process.env;
    const base = {
      taskDir: env.NOVA_TASK_DIR,
      policy: JSON.parse(env.NOVA_GUARD_POLICY || "{}"),
      workdir: env.NOVA_WORKDIR,
      forbidden: JSON.parse(env.NOVA_FORBIDDEN || "[]"),
    };
    const input = event?.input ?? {};
    let d: any = { allow: true };
    if (event?.toolName === "bash" && typeof input.command === "string") {
      d = guardDecision({ ...base, kind: "bash", subject: input.command });
    } else if ((event?.toolName === "write" || event?.toolName === "edit") && typeof input.path === "string") {
      d = guardDecision({ ...base, kind: "write", subject: input.path });
    }
    if (d.allow) return undefined;
    process.stderr.write(`[nova-guard] ${d.reason}\n`);
    return { block: true, reason: d.reason };
  });
}
