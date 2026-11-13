// guard.mjs — command/path policy shared by every executor hook (Pi extension, Claude
// PreToolUse hook). Returns null (allow) or { category, reason } (block → approval request).
//
// Categories:
//   disaster   rm -r of system/home/workspace roots, find / -delete, mkfs, dd of=/dev/*
//   push       any git push (executors never push; protected branches / force always blocked)
//   remote     git remote add/set-url, git config --global, gh mutations, npm publish
//   egress     curl/wget/nc/ssh/scp/rsync to hosts not in guard.allow_hosts; uploads (-d, -T, -F)
//   system     crontab, systemctl, tailscale, shutdown/reboot, chmod/chown on / or ~
//   secrets    reading credential stores or dumping the environment
//   path       writes outside the task workdir or into forbidden paths

import { isAbsolute, relative, resolve } from "node:path";
import { matchesAny } from "./util.mjs";

const DANGEROUS_RM_TARGETS = new Set(["/", "/*", "~", "~/", "$HOME", "${HOME}", "/home", "/root", "/etc", "/usr",
  "/var", "/boot", "/opt", "/bin", "/lib", "/workspace", "..", "*", ".", "./", "./*"]);
const FIND_ROOTS = new Set(["/", "~", "~/", "$HOME", "${HOME}"]);
const SECRET_PATHS = [/\.claude\/\.credentials/, /\.codex\/auth\.json/, /\.pi\/agent\/auth\.json/, /\.ssh\//, /\.nova-relay\/secrets/,
  /\.config\/nova-relay\/.*\.env/, /\/etc\/shadow/, /\.aws\/credentials/, /\.netrc/, /\.git-credentials/];

export function tokenizeShell(cmd) {
  const tokens = [];
  let cur = "", inS = false, inD = false, esc = false, has = false;
  for (const ch of cmd) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\" && !inS) { esc = true; continue; }
    if (ch === "'" && !inD) { inS = !inS; has = true; continue; }
    if (ch === '"' && !inS) { inD = !inD; has = true; continue; }
    if (/\s/.test(ch) && !inS && !inD) { if (cur || has) tokens.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (cur || has) tokens.push(cur);
  return tokens;
}

// Split on ; && || | & and newlines (outside quotes); also descend into $(...) and `...`.
export function splitCommands(full) {
  const parts = [];
  let cur = "", inS = false, inD = false, esc = false;
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ""; };
  for (let i = 0; i < full.length; i++) {
    const ch = full[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\" && !inS) { cur += ch; esc = true; continue; }
    if (ch === "'" && !inD) { inS = !inS; cur += ch; continue; }
    if (ch === '"' && !inS) { inD = !inD; cur += ch; continue; }
    if (!inS && (ch === ";" || ch === "\n" || ch === "&" || ch === "|")) {
      if ((ch === "&" || ch === "|") && full[i + 1] === ch) i++;
      push();
      continue;
    }
    cur += ch;
  }
  push();
  const nested = [];
  for (const m of full.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push(...splitCommands(m[1] ?? m[2]));
  // bash -c / sh -c "<script>" → inspect the inner script too
  for (const p of parts) {
    const t = tokenizeShell(p);
    const ci = t.findIndex((x, i) => i > 0 && x === "-c" && /(^|\/)(ba|z|da)?sh$/.test(t[i - 1]));
    if (ci > 0 && t[ci + 1]) nested.push(...splitCommands(t[ci + 1]));
  }
  return [...parts, ...nested];
}

const stripPrefix = (tokens) => {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || ["sudo", "nohup", "exec", "env", "command", "time", "nice"].includes(tokens[i]))) i++;
  return tokens.slice(i);
};
const norm = (t) => (t.length > 1 && t.endsWith("/") && t !== "~/" && t !== "./" ? t.slice(0, -1) : t);
const hostOf = (s) => { try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname; } catch { return null; } };

function branchMatches(branch, patterns) {
  return patterns.some((p) => (p.endsWith("/*") ? branch.startsWith(p.slice(0, -1)) : branch === p));
}

function checkOne(sub, policy) {
  const raw = tokenizeShell(sub);
  if (raw.length && ["env", "printenv", "export", "set", "declare"].includes(raw[0]) && raw.slice(1).every((a) => a.startsWith("-"))) {
    return { category: "secrets", reason: "dumping the environment can leak secrets" };
  }
  const tokens = stripPrefix(raw);
  if (!tokens.length) return null;
  const bin = tokens[0].split("/").pop();
  const args = tokens.slice(1);
  const block = (category, reason) => ({ category, reason });

  // --- disaster
  if (bin === "mkfs" || bin.startsWith("mkfs.")) return block("disaster", "filesystem format");
  if (bin === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return block("disaster", "raw device write");
  if (bin === "find" && args.includes("-delete")) {
    for (const a of args) { if (a.startsWith("-")) break; if (FIND_ROOTS.has(norm(a)) || FIND_ROOTS.has(a)) return block("disaster", "find -delete from / or ~"); }
  }
  if (bin === "rm") {
    let rec = false, end = false;
    const targets = [];
    for (const a of args) {
      if (!end && a === "--") { end = true; continue; }
      if (!end && a.startsWith("--")) { if (a === "--recursive") rec = true; continue; }
      if (!end && a.startsWith("-") && a.length > 1) { if (/[rR]/.test(a)) rec = true; continue; }
      targets.push(a);
    }
    if (rec && targets.some((t) => DANGEROUS_RM_TARGETS.has(t) || DANGEROUS_RM_TARGETS.has(norm(t)))) return block("disaster", "recursive delete of a root/home/workspace path");
  }
  if ((bin === "chmod" || bin === "chown") && args.some((a) => /^-.*R/.test(a)) && args.some((a) => ["/", "~", "$HOME", "/home"].includes(norm(a)))) {
    return block("system", "recursive permission change on / or ~");
  }

  // --- git
  if (bin === "git") {
    let gi = 0;
    while (gi < args.length && args[gi].startsWith("-")) gi += args[gi] === "-C" || args[gi] === "-c" ? 2 : 1;
    const sub = args[gi];
    const rest = args.slice(gi + 1);
    if (sub === "push") {
      const force = rest.some((a) => a === "-f" || a.startsWith("--force") || a === "--mirror" || a === "--delete" || /^\+/.test(a));
      const refs = rest.filter((a) => !a.startsWith("-")).slice(1);
      const dest = refs.map((r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, ""));
      if (force) return block("push", "force/delete push is never allowed for executors");
      if (!dest.length || dest.some((d) => branchMatches(d, policy.protected_branches))) return block("push", "push to a protected (or implicit) branch");
      return block("push", "executors do not push; the owner merges task branches");
    }
    if (sub === "remote" && ["add", "set-url", "rename", "remove", "rm"].includes(rest[0])) return block("remote", "changing git remotes");
    if (sub === "config" && rest.some((a) => a === "--global" || a === "--system")) return block("remote", "changing global git config");
    if (sub === "filter-branch" || (sub === "reset" && rest.includes("--hard") && rest.some((a) => /origin\//.test(a)))) return block("disaster", "history rewrite");
  }
  if (bin === "gh" && args[0] && !["status", "auth"].includes(args[0]) && !(["pr", "issue", "run", "repo"].includes(args[0]) && ["view", "list", "diff", "status", "checks"].includes(args[1]))) {
    return block("remote", "gh write operations (PRs, releases, repo settings) are owner-only");
  }
  if ((bin === "npm" || bin === "pnpm" || bin === "yarn") && args.includes("publish")) return block("remote", "publishing packages");
  if (["cargo", "twine", "gem"].includes(bin) && args.some((a) => a === "publish" || a === "upload" || a === "push")) return block("remote", "publishing packages");

  // --- egress / messaging
  if (["ssh", "scp", "sftp", "nc", "ncat", "telnet", "socat", "mail", "sendmail"].includes(bin)) return block("egress", `${bin} is not available to executors`);
  if (bin === "rsync" && args.some((a) => /^[^/]*:/.test(a) && !a.startsWith("-"))) return block("egress", "rsync to a remote host");
  if (bin === "curl" || bin === "wget") {
    const upload = args.some((a) => /^(-d|--data.*|-F|--form|-T|--upload-file|-X|--request|--post-data|--post-file|--method)$/.test(a) || /^-[a-zA-Z]*[dFT]$/.test(a));
    const hosts = args.filter((a) => !a.startsWith("-") && /[.:]/.test(a)).map(hostOf).filter(Boolean);
    const allowed = hosts.length > 0 && hosts.every((h) => policy.allow_hosts.some((a) => h === a || h.endsWith(`.${a}`)));
    if (upload) return block("egress", "HTTP uploads/POSTs can send data out (messages, money, config)");
    if (!allowed) return block("egress", `network fetch to non-allowlisted host (${hosts.join(", ") || "?"})`);
  }

  // --- system
  if (["crontab", "systemctl", "launchctl", "tailscale", "shutdown", "reboot", "poweroff", "iptables", "ufw"].includes(bin)) return block("system", `${bin} changes the host`);

  // --- secrets
  if (bin === "printenv") return block("secrets", "reading environment secrets");
  if (SECRET_PATHS.some((re) => re.test(sub))) return block("secrets", "credential store access");
  return null;
}

export function checkCommand(command, policy = {}) {
  const pol = { protected_branches: ["main", "master", "release/*"], allow_hosts: [], ...policy };
  if (typeof command !== "string" || !command.trim()) return null;
  for (const sub of splitCommands(command)) {
    const r = checkOne(sub, pol);
    if (r) return r;
  }
  return null;
}

// File-write tools (Edit/Write): only inside the workdir, never into forbidden paths.
export function checkWritePath(path, { workdir, forbidden = [], extraWritable = ["/tmp"] } = {}) {
  if (!path || !workdir) return null;
  const abs = isAbsolute(path) ? resolve(path) : resolve(workdir, path);
  const rel = relative(workdir, abs);
  const inside = rel && !rel.startsWith("..") && !isAbsolute(rel);
  if (!inside) {
    if (extraWritable.some((d) => abs === d || abs.startsWith(`${d}/`))) return null;
    return { category: "path", reason: `write outside the task workdir: ${abs}` };
  }
  if (matchesAny(rel, forbidden)) return { category: "path", reason: `write to forbidden path: ${rel}` };
  if (SECRET_PATHS.some((re) => re.test(abs))) return { category: "secrets", reason: "credential store write" };
  return null;
}
