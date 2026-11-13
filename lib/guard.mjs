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
//   path       writes outside the task workdir or into forbidden paths (redirections, cp/mv/tee/
//              rm/sed -i/…, file tools); unresolvable targets ($VAR) are denied by default
//   script     scripts the executor could have written (inside the workdir or /tmp) are read and
//              checked too: shell scripts line by line, npm scripts, Makefile recipes, and a
//              heuristic scan of python/node/perl/ruby code (shell-outs, writes outside the
//              workdir, outbound sends, obfuscated exec). Unreadable scripts are denied.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
    if (!inS && !inD && ch === "&" && (full[i - 1] === ">" || full[i - 1] === "<" || full[i + 1] === ">")) { cur += ch; continue; } // 2>&1, &>file
    if (!inS && !inD && ch === "|" && full[i - 1] === ">") { cur += ch; continue; } // >| file
    if (!inS && !inD && (ch === ";" || ch === "\n" || ch === "&" || ch === "|")) {
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
    // -c, or a short-flag cluster containing c (bash -lc, sh -ec, bash -xc …), after any shell options
    const si = t.findIndex((x) => /(^|\/)(ba|z|da|k)?sh$/.test(x));
    let ci = -1;
    if (si >= 0) for (let k = si + 1; k < t.length && t[k].startsWith("-"); k++) if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(t[k])) { ci = k; break; }
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

const GIT_DANGEROUS_KEY = /^(alias\.|core\.(hookspath|sshcommand|fsmonitor|editor|pager|gitproxy|askpass)|credential|remote\.|url\.|include\.|includeif\.|filter\.|diff\..*\.textconv|http\.|protocol\.|gpg\.|sendemail\.)/i;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set(["python", "python3", "python2", "node", "perl", "ruby", "php", "deno", "bun", "tsx", "ts-node"]);
const SAFE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const MAX_DEPTH = 3;

// Paths are resolved the way the executor's shell would resolve them, as far as we can.
function expandPath(p, ctx) {
  let s = p.replace(/^~(?=\/|$)/, ctx.home).replace(/^\$\{?HOME\}?(?=\/|$)/, ctx.home)
    .replace(/^\$\{?(PWD|NOVA_WORKDIR)\}?(?=\/|$)/, ctx.workdir).replace(/^\$\{?TMPDIR\}?(?=\/|$)/, "/tmp");
  if (/[$`]/.test(s)) return null; // unknown variable / command substitution: cannot verify
  return s;
}

function writeTargetHit(target, ctx) {
  if (!ctx.workdir || !target || SAFE_SINKS.has(target) || /^\/dev\/fd\//.test(target) || /^&?\d*$/.test(target)) return null;
  const p = expandPath(target, ctx);
  if (p === null) return { category: "path", reason: `write target "${target}" cannot be verified (variable/substitution); denied by default` };
  return checkWritePath(p, ctx);
}

// Unquoted > >> &> >| targets in one simple command.
export function redirectTargets(sub) {
  const out = [];
  let inS = false, inD = false;
  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i];
    if (ch === "\\" && !inS) { i++; continue; }
    if (ch === "'" && !inD) { inS = !inS; continue; }
    if (ch === '"' && !inS) { inD = !inD; continue; }
    if (inS || inD || ch !== ">") continue;
    if (sub[i - 1] === "<" || sub[i - 1] === "=") continue; // <> or a literal "=>"
    let j = i + 1;
    if (sub[j] === ">" || sub[j] === "|") j++;
    if (sub[j] === "&") continue; // fd duplication (2>&1)
    while (sub[j] === " " || sub[j] === "\t") j++;
    // One shell word: unquoted run up to whitespace or an operator, quotes removed.
    let word = "", q = null;
    for (; j < sub.length; j++) {
      const c = sub[j];
      if (q) { if (c === q) q = null; else word += c; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === "\\") { word += sub[++j] ?? ""; continue; }
      if (/[\s;&|<>]/.test(c)) break;
      word += c;
    }
    if (word) out.push(word);
    i = j - 1;
  }
  return out;
}

const nonOpts = (args) => args.filter((a) => !a.startsWith("-") || a === "-");

// Destinations of the common file-writing commands.
function writeTargets(bin, args) {
  const pos = nonOpts(args);
  switch (bin) {
    case "cp": case "mv": case "install": case "ln": {
      const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
      if (t >= 0) return [args[t + 1]];
      const td = args.find((a) => a.startsWith("--target-directory="));
      if (td) return [td.split("=")[1]];
      return pos.length >= 2 ? [pos[pos.length - 1]] : [];
    }
    case "tee": case "touch": case "mkdir": case "rmdir": case "rm": case "unlink": case "shred": case "truncate":
      return pos;
    case "chmod": case "chown": case "chgrp": return pos.slice(1);
    case "sed": case "perl": {
      if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) return [];
      const hasE = args.some((a) => a === "-e" || a === "--expression");
      let files = args.filter((a, k) => !a.startsWith("-") && !(k > 0 && (args[k - 1] === "-e" || args[k - 1] === "--expression")));
      if (!hasE) files = files.slice(1); // first non-option is the script
      return files;
    }
    case "dd": return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    default: return [];
  }
}

// Is this file something the executor could have written (and so must be inspected)?
function executorWritable(p, ctx) {
  if (!ctx.workdir) return false;
  const abs = resolve(ctx.workdir, p);
  if (/(^|\/)(node_modules|\.venv|venv|vendor)\//.test(relative(ctx.workdir, abs))) return false; // package-manager installs (documented gap)
  return isInside(abs, ctx.workdir) || isInside(abs, "/tmp");
}

function readScript(p, ctx) {
  const abs = resolve(ctx.workdir || ".", expandPath(p, ctx) ?? p);
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8").slice(0, 512 * 1024);
  } catch { return null; }
}

function scanShell(text, policy, ctx) {
  const body = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  return checkCommandIn(body, policy, { ...ctx, depth: ctx.depth + 1 });
}

const LITERAL = /'((?:[^'\\\n]|\\.){2,})'|"((?:[^"\\\n]|\\.){2,})"|`([^`]{2,})`/g;
const SHELL_START = /^\s*(?:sudo\s+)?(git|rm|curl|wget|ssh|scp|sftp|rsync|nc|ncat|socat|telnet|gh|npm|pnpm|yarn|cargo|twine|systemctl|crontab|mkfs\S*|dd|tailscale|chmod|chown|bash|sh|zsh|mail|sendmail|shutdown|reboot|find|env|printenv)\b/;
const WRITE_API = /\bopen\s*\([^)]*['"][wax+]|write_text|write_bytes|shutil\.(copy\w*|move|rmtree)|os\.(remove|unlink|rename|replace|makedirs|mkdir|rmdir|chmod|symlink)|\.unlink\(|writeFile|appendFile|createWriteStream|\brmSync\b|\brm\(|\bunlink(Sync)?\(|\brename(Sync)?\(|copyFile|\bmkdir(Sync)?\(|\bsymlink(Sync)?\(|File\.(write|open|delete)|FileUtils\.|\bunlink\b|open\s*\(\s*\w+\s*,\s*['"][>+]/;
const HOME_REF = /expanduser|os\.environ\[['"]HOME|getenv\(['"]HOME|homedir\(\)|process\.env\.HOME|\$ENV\{HOME\}|Dir\.home|ENV\[['"]HOME/;
const SEND_API = /smtplib|\brequests\.(post|put|patch|delete)\b|\bmethod\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]|\bsocket\.connect\b|\bnet\.(connect|createConnection)\b|\bdgram\b|Net::SMTP|Net::HTTP::Post|LWP::UserAgent|IO::Socket/;
const OBFUSCATED = /(b64decode|atob\(|Buffer\.from\([^)]*['"]base64|decode_base64|unpack\(['"]m)/;
const SHELL_OUT = /subprocess|os\.(system|popen|exec\w*|spawn\w*)|child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|\bsystem\s*\(|popen|\bqx[{(\/]|Open3|IO\.popen|Deno\.(run|Command)|Bun\.(spawn|\$)|`/;
const DYN_EXEC = /\b(exec|eval|system|popen|execSync|spawnSync|spawn|execFile|Function)\s*\(/;

function scanCode(text, policy, ctx) {
  if (OBFUSCATED.test(text) && DYN_EXEC.test(text)) return { category: "script", reason: "script decodes and executes hidden code" };
  const send = text.match(SEND_API);
  if (send) return { category: "egress", reason: `script can send data out (${send[0].trim()})` };
  // String literals are only commands in code that can shell out at all (else: plain text).
  const shellsOut = SHELL_OUT.test(text);
  for (const line of text.split("\n")) {
    if (/^\s*(#|\/\/)/.test(line)) continue;
    const lits = [...line.matchAll(LITERAL)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const cand of shellsOut ? [...lits, lits.join(" ")] : []) {
      if (!SHELL_START.test(cand)) continue;
      const hit = checkCommandIn(cand, policy, { ...ctx, depth: ctx.depth + 1 });
      if (hit) return { category: hit.category, reason: `script runs: ${hit.reason}` };
    }
    if (WRITE_API.test(line)) {
      if (HOME_REF.test(line)) return { category: "path", reason: "script writes into the home directory" };
      for (const l of lits) {
        if (!/^(\/|~|\.\.\/)/.test(l) && !l.includes("/../")) continue;
        const hit = writeTargetHit(l, ctx);
        if (hit) return { category: hit.category, reason: `script ${hit.reason}` };
      }
    }
  }
  return null;
}

function scriptHit(kind, path, policy, ctx) {
  if (!executorWritable(expandPath(path, ctx) ?? path, ctx)) return null;
  if (ctx.depth >= MAX_DEPTH) return { category: "script", reason: `scripts nested deeper than ${MAX_DEPTH}; denied by default` };
  const text = readScript(path, ctx);
  if (text === null) return { category: "script", reason: `cannot read script ${path} to inspect it; denied by default` };
  let k = kind;
  if (k === "auto") {
    const she = text.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
    const interp = she ? basename(she[1] === "/usr/bin/env" || basename(she[1]) === "env" ? she[2] || "" : she[1]) : "sh";
    k = SHELLS.has(interp) ? "shell" : "code";
  }
  return k === "shell" ? scanShell(text, policy, ctx) : scanCode(text, policy, ctx);
}

// npm/pnpm/yarn run <script> and npm test: the package.json script (and pre/post) is shell.
function packageScriptHit(bin, args, policy, ctx) {
  if (!ctx.workdir) return null;
  const pos = nonOpts(args);
  let name = null;
  if (["test", "start", "build"].includes(pos[0]) || pos[0] === "t") name = pos[0] === "t" ? "test" : pos[0];
  else if (["run", "run-script"].includes(pos[0])) name = pos[1];
  else if (bin === "yarn" && pos[0] && !["install", "add", "remove", "upgrade", "why", "info", "list"].includes(pos[0])) name = pos[0];
  if (!name) return null;
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(ctx.workdir, "package.json"), "utf8")); } catch { return null; }
  for (const n of [`pre${name}`, name, `post${name}`]) {
    const sc = pkg.scripts?.[n];
    if (typeof sc !== "string") continue;
    const hit = checkCommandIn(sc, policy, { ...ctx, depth: ctx.depth + 1 });
    if (hit) return { category: hit.category, reason: `package.json script "${n}": ${hit.reason}` };
  }
  return null;
}

function makefileHit(args, policy, ctx) {
  if (!ctx.workdir) return null;
  const fi = args.findIndex((a) => a === "-f" || a === "--file");
  const file = fi >= 0 ? args[fi + 1] : ["GNUmakefile", "makefile", "Makefile"].find((f) => existsSync(join(ctx.workdir, f)));
  if (!file) return null;
  const text = readScript(file, ctx);
  if (text === null) return null;
  const recipes = text.split("\n").filter((l) => l.startsWith("\t")).map((l) => l.slice(1).replace(/^[@+-]+/, "").replace(/\$\(MAKE\)/g, "make")).join("\n");
  const hit = checkCommandIn(recipes, policy, { ...ctx, depth: ctx.depth + 1 });
  return hit && { category: hit.category, reason: `Makefile recipe: ${hit.reason}` };
}

function checkOne(sub, policy, ctx) {
  const raw = tokenizeShell(sub);
  if (raw.length && ["env", "printenv", "export", "set", "declare"].includes(raw[0]) && raw.slice(1).every((a) => a.startsWith("-"))) {
    return { category: "secrets", reason: "dumping the environment can leak secrets" };
  }
  const tokens = stripRedirs(stripPrefix(raw));
  const block = (category, reason) => ({ category, reason });
  for (const t of redirectTargets(sub)) { const hit = writeTargetHit(t, ctx); if (hit) return hit; }
  if (!tokens.length) return null;
  const bin = tokens[0].split("/").pop();
  const args = tokens.slice(1);

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
    while (gi < args.length && args[gi].startsWith("-")) {
      if (args[gi] === "-c" && GIT_DANGEROUS_KEY.test(args[gi + 1] || "")) return block("remote", `git -c ${String(args[gi + 1]).split("=")[0]} (aliases/hooks/remotes/credentials can run or send anything)`);
      gi += args[gi] === "-C" || args[gi] === "-c" ? 2 : 1;
    }
    const sub = args[gi];
    const rest = args.slice(gi + 1);
    if (["send-email", "request-pull", "daemon", "svn", "p4", "imap-send"].includes(sub)) return block("egress", `git ${sub} talks to the outside`);
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
    if (sub === "config") {
      const keys = rest.filter((a) => !a.startsWith("-"));
      const writes = keys.length >= 2 || rest.some((a) => /^--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)$|^-e$/.test(a)) || ["set", "unset", "edit", "rename-section", "remove-section"].includes(keys[0]);
      const key = ["set", "unset"].includes(keys[0]) ? keys[1] : keys[0];
      if (writes && (GIT_DANGEROUS_KEY.test(key || "") || rest.includes("--edit") || rest.includes("-e") || keys[0] === "edit")) return block("remote", `git config ${key || "--edit"} (aliases/hooks/remotes/credentials can run or send anything)`);
    }
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

  // --- writes outside the workdir (deny by default when the target cannot be resolved)
  for (const t of writeTargets(bin, args)) { const hit = writeTargetHit(t, ctx); if (hit) return hit; }

  // --- scripts the executor may have written
  const inline = (flag) => { const k = args.indexOf(flag); return k >= 0 ? args[k + 1] : null; };
  if (SHELLS.has(bin) && !args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) {
    const script = args.find((a) => !a.startsWith("-"));
    if (script) return scriptHit("shell", script, policy, ctx);
  }
  if (bin === "source" || bin === ".") return args[0] ? scriptHit("shell", args[0], policy, ctx) : null;
  if (INTERPRETERS.has(bin) || /^python3\.\d+$/.test(bin)) {
    const code = inline("-c") ?? inline("-e") ?? inline("--eval") ?? inline("-E");
    if (code !== null) return scanCode(code, policy, { ...ctx, depth: ctx.depth + 1 });
    if (args.includes("-m")) return null; // installed module (pytest, pip, …)
    const script = args.find((a) => !a.startsWith("-"));
    if (script) return scriptHit("code", script, policy, ctx);
  }
  if (tokens[0].includes("/") && !bin.includes(".")) return scriptHit("auto", tokens[0], policy, ctx);
  if (tokens[0].includes("/") && /\.(sh|bash)$/.test(bin)) return scriptHit("shell", tokens[0], policy, ctx);
  if (tokens[0].includes("/") && /\.(py|js|mjs|cjs|ts|pl|rb|php)$/.test(bin)) return scriptHit("code", tokens[0], policy, ctx);
  if (["npm", "pnpm", "yarn", "bun"].includes(bin)) return packageScriptHit(bin, args, policy, ctx);
  if (bin === "make" || bin === "gmake") return makefileHit(args, policy, ctx);
  return null;
}

// Drop redirection operators and their targets (checked separately) from the argv.
function stripRedirs(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(\d*|&)(>>?|>\||<)$/.test(t)) { i++; continue; }
    if (/^(\d*|&)(>>?|>\||<)./.test(t)) continue;
    out.push(t);
  }
  return out;
}

function checkCommandIn(command, policy, ctx) {
  if (typeof command !== "string" || !command.trim()) return null;
  for (const sub of splitCommands(command)) {
    const r = checkOne(sub, policy, ctx);
    if (r) return r;
  }
  return null;
}

/**
 * @param {string} command  full shell command line
 * @param {object} policy   cfg.guard
 * @param {object} [where]  { workdir, forbidden } — enables write-target and script checks
 */
export function checkCommand(command, policy = {}, { workdir, forbidden = [], home = homedir(), extraWritable } = {}) {
  const pol = { protected_branches: ["main", "master", "release/*"], allow_hosts: [], ...policy };
  return checkCommandIn(command, pol, { workdir: workdir ? realish(workdir) : undefined, forbidden, home, extraWritable, depth: 0 });
}

const isInside = (abs, dir) => abs === dir || abs.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

// realpath of the deepest existing ancestor + the rest: follows symlinks the executor planted
// (src/link -> /home/box/work/nm) for paths that do not exist yet.
export function realish(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch { /* does not exist (yet) */ }
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.push(basename(cur));
    cur = parent;
  }
}

// File-write tools (Edit/Write) and shell write targets: only inside the workdir (or /tmp),
// never into forbidden paths, symlinks resolved.
export function checkWritePath(path, { workdir, forbidden = [], extraWritable = ["/tmp"] } = {}) {
  extraWritable ??= ["/tmp"];
  if (!path || !workdir) return null;
  const wd = realish(workdir);
  const p = String(path).replace(/^@/, "");
  const abs = realish(isAbsolute(p) ? p : resolve(wd, p));
  if (SECRET_PATHS.some((re) => re.test(abs))) return { category: "secrets", reason: "credential store write" };
  const rel = relative(wd, abs);
  const inside = rel && !rel.startsWith("..") && !isAbsolute(rel);
  if (!inside) {
    if (rel === "") return { category: "path", reason: "write to the workdir root itself" };
    if (extraWritable.some((d) => isInside(abs, realish(d)))) return null;
    return { category: "path", reason: `write outside the task workdir: ${abs}` };
  }
  if (matchesAny(rel, forbidden)) return { category: "path", reason: `write to forbidden path: ${rel}` };
  return null;
}
