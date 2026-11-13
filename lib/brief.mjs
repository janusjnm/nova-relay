// brief.mjs — parse and validate the templated task brief the planner writes.
//
//   ---
//   type: code            # routing key (see config routing.rules)
//   project: PD
//   ---
//   # Goal        one paragraph: what "done" means
//   # Scope       - repo-relative globs the executor may change
//   # Acceptance  one shell command per line (exit 0 = pass)
//   # Forbidden   - actions the executor must not take (added to built-in rules)
//   # Context     optional notes

const SECTION_ALIASES = {
  goal: "goal", "目标": "goal",
  scope: "scope", "files in scope": "scope", "范围": "scope", "文件范围": "scope",
  acceptance: "acceptance", "acceptance command": "acceptance", "验收": "acceptance", "验收命令": "acceptance",
  forbidden: "forbidden", "forbidden actions": "forbidden", "禁止": "forbidden", "禁止事项": "forbidden",
  context: "context", "背景": "context", "notes": "context",
};

export function parseBrief(text) {
  const meta = {};
  let body = String(text ?? "").replace(/\r\n/g, "\n");
  const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
      if (m) meta[m[1]] = m[2] === "true" ? true : m[2] === "false" ? false : m[2];
    }
    body = body.slice(fm[0].length);
  }
  const sections = {};
  let cur = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (h) {
      cur = SECTION_ALIASES[h[1].toLowerCase()] ?? null;
      if (cur) sections[cur] = sections[cur] ?? [];
      continue;
    }
    if (cur) sections[cur].push(line);
  }
  const list = (lines = []) => lines.map((l) => l.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]).filter(Boolean).map((s) => s.replace(/^`(.*)`$/, "$1"));
  const commands = (lines = []) => lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("```") && !l.startsWith("#"))
    .map((l) => l.replace(/^[-*]\s+/, "").replace(/^`(.*)`$/, "$1"));
  return {
    type: meta.type || null,
    project: meta.project || null,
    executor: meta.executor || null,
    allow_empty_diff: meta.allow_empty_diff === true,
    allow_harness_changes: meta.allow_harness_changes === true,
    goal: (sections.goal || []).join("\n").trim(),
    scope: list(sections.scope),
    acceptance: commands(sections.acceptance),
    forbidden: list(sections.forbidden),
    context: (sections.context || []).join("\n").trim(),
  };
}

// Scope entries are repo-relative; anything that could escape the project workdir is refused.
export function unsafeScopePath(p) {
  return p.startsWith("/") || p.startsWith("~") || p.includes("\\") || p.split("/").includes("..") || /^[A-Za-z]:/.test(p) || p.includes("$");
}

export function validateBrief(b, { textTypes = ["text"] } = {}) {
  const problems = [];
  if (!b.type) problems.push("front matter `type:` is required");
  if (!b.goal) problems.push("# Goal section is required");
  for (const s of b.scope) if (unsafeScopePath(s)) problems.push(`scope path "${s}" must be repo-relative without .. / ~ / $ (cross-project paths are refused)`);
  const isText = textTypes.includes(b.type);
  if (!isText) {
    if (!b.scope.length) problems.push("# Scope needs at least one repo-relative path/glob for code tasks");
    if (!b.acceptance.length) problems.push("# Acceptance needs at least one command for code tasks");
  }
  return problems;
}

export const BRIEF_TEMPLATE = `---
type: code
project: PD
# allow_harness_changes: true   # only if this task must change test config / acceptance scripts / package.json scripts
---
# Goal
<one paragraph: the observable outcome that means "done">

# Scope
- src/<module>/**
- tests/<module>/**

# Acceptance
npm test -- <module>

# Forbidden
- do not change public API signatures
- do not touch CI config

# Context
<optional: links, decisions already made, gotchas>
`;
