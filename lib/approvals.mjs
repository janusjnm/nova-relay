// approvals.mjs — needs_approval flow shared by the guard hooks and the CLI.
//   approvals.jsonl  requests {req, kind, subject, category, reason, ts}
//   decisions.json   { approved: [subject...], denied: [subject...] }   (exact match)
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { appendJsonl, nowIso, readJson, readJsonl, redact, withLock, writeJsonAtomic } from "./util.mjs";
import { checkCommand, checkWritePath } from "./guard.mjs";

export const decisionsPath = (taskDir) => join(taskDir, "decisions.json");
export const readDecisions = (taskDir) => ({ approved: [], denied: [], ...readJson(decisionsPath(taskDir), {}) });

export function pendingApprovals(taskDir) {
  const d = readDecisions(taskDir);
  const seen = new Set();
  return readJsonl(join(taskDir, "approvals.jsonl")).filter((r) => {
    if (d.approved.includes(r.subject) || d.denied.includes(r.subject) || seen.has(r.subject)) return false;
    seen.add(r.subject);
    return true;
  });
}

export function requestApproval(taskDir, rec) {
  return withLock(join(taskDir, "approvals"), () => {
    const existing = pendingApprovals(taskDir).find((r) => r.subject === rec.subject);
    if (existing) return existing;
    const r = { req: randomBytes(4).toString("hex"), ts: nowIso(), ...rec, subject: rec.subject };
    appendJsonl(join(taskDir, "approvals.jsonl"), r, Infinity);
    return r;
  });
}

export function decide(taskDir, req, approve) {
  return withLock(join(taskDir, "approvals"), () => {
    const r = readJsonl(join(taskDir, "approvals.jsonl")).find((x) => x.req === req);
    if (!r) return null;
    const d = readDecisions(taskDir);
    if (!d.approved.includes(r.subject) && !d.denied.includes(r.subject)) (approve ? d.approved : d.denied).push(r.subject);
    writeJsonAtomic(decisionsPath(taskDir), d);
    return r;
  });
}

// The single decision function every hook calls. `subject` is a bash command or a write path.
export function guardDecision({ taskDir, kind, subject, policy = {}, workdir, forbidden }) {
  const key = redact(subject); // never persist secrets that appear inside a command
  if (taskDir) {
    const d = readDecisions(taskDir);
    if (d.approved.includes(key)) return { allow: true };
    if (d.denied.includes(key)) return { allow: false, reason: "the owner denied this exact operation; do not retry it or rephrase it — find another way or skip it" };
  }
  const hit = kind === "bash" ? checkCommand(subject, policy, { workdir, forbidden }) : checkWritePath(subject, { workdir, forbidden });
  if (!hit) return { allow: true };
  let req = "-";
  if (taskDir) {
    try { req = requestApproval(taskDir, { kind, subject: key, category: hit.category, reason: hit.reason }).req; } catch { /* still block */ }
  }
  return {
    allow: false, category: hit.category, req,
    reason: `nova-guard blocked (${hit.category}: ${hit.reason}). Approval requested (req=${req}). Skip this step and continue with the rest; do not work around it with a different command.`,
  };
}
