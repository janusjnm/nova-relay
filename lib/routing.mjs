// routing.mjs — pick an executor for a brief: explicit override > rule by type > default.
// Paused executors (quota/auth/budget) are skipped in favour of the rule's fallbacks.
import { unsafeScopePath } from "./brief.mjs";

export class RoutingError extends Error {}

export function route(cfg, brief, { project, paused = {} } = {}) {
  const proj = project || brief.project;
  if (!proj || !cfg.projects[proj]) throw new RoutingError(`unknown project "${proj}" (known: ${Object.keys(cfg.projects).join(", ")})`);
  if (brief.project && project && brief.project !== project) throw new RoutingError(`brief says project "${brief.project}" but dispatch is for "${project}" — refusing cross-project task`);
  for (const s of brief.scope || []) if (unsafeScopePath(s)) throw new RoutingError(`scope "${s}" escapes the project workdir — refusing cross-project path`);
  const allowed = cfg.projects[proj].executors; // optional per-project allowlist

  let candidates;
  if (brief.executor) {
    if (!cfg.executors[brief.executor]) throw new RoutingError(`brief asks for unknown executor "${brief.executor}"`);
    candidates = [brief.executor];
  } else {
    const rule = cfg.routing.rules.find((r) => r.type === brief.type);
    candidates = rule ? [rule.executor, ...(rule.fallback || [])] : cfg.routing.default ? [cfg.routing.default] : [];
  }
  if (!candidates.length) throw new RoutingError(`no routing rule for type "${brief.type}" and no routing.default`);
  if (allowed) candidates = candidates.filter((c) => allowed.includes(c));
  if (!candidates.length) throw new RoutingError(`project "${proj}" does not allow any executor for type "${brief.type}"`);

  for (const name of candidates) {
    if (!paused[name]) return { executor: name, host: cfg.executors[name].host, project: proj, rerouted: name !== candidates[0] };
  }
  // Every candidate is paused: keep the primary; the task waits (state paused) instead of looping.
  return { executor: candidates[0], host: cfg.executors[candidates[0]].host, project: proj, rerouted: false, waiting: paused[candidates[0]] };
}
