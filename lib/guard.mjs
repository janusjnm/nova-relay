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

// Re-quote argv for a nested check (the words are already unquoted).
const quoteJoin = (argv) => argv.map((x) => (x === "" || /[\s'"$`;&|<>()\\]/.test(x) ? `'${x.replace(/'/g, "'\\''")}'` : x)).join(" ");
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const here = (ctx) => (ctx.cwd === undefined ? ctx.workdir : ctx.cwd);

// Command wrappers: options are parsed (a value-taking option must not be mistaken for the
// command: `nice -n 10 rm -rf ~`, `env -i rm -rf ~`), then the wrapped command is checked.
//   a0 = flags, a1 = options taking a value, pos = positional args before the command
const WRAPPERS = {
  nohup: { a0: [], a1: [] },
  builtin: { a0: [], a1: [] },
  busybox: { a0: [], a1: [] },
  nice: { a0: [], a1: ["-n", "--adjustment"], num: true },
  time: { a0: ["-p", "-a", "-v", "-q", "--portability", "--append", "--verbose", "--quiet"], a1: ["-f", "--format", "-o", "--output"], out: ["-o", "--output"] },
  timeout: { a0: ["--foreground", "--preserve-status", "-v", "--verbose"], a1: ["-s", "--signal", "-k", "--kill-after"], pos: 1 },
  setsid: { a0: ["-c", "-f", "-w", "--ctty", "--fork", "--wait"], a1: [] },
  stdbuf: { a0: [], a1: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  ionice: { a0: ["-t", "--ignore"], a1: ["-c", "-n", "--class", "--classdata"] },
  taskset: { a0: ["-a", "--all-tasks", "-c", "--cpu-list"], a1: [], pos: 1 },
  command: { a0: ["-p"], a1: [] },
  exec: { a0: ["-c", "-l"], a1: ["-a"] },
  xargs: { a0: ["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x", "--exit", "-i", "-l", "-e"],
    a1: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"] },
  flock: { a0: ["-s", "-x", "-n", "-u", "-o", "-F", "--shared", "--exclusive", "--nonblock", "--unlock", "--close", "--no-fork", "--verbose"],
    a1: ["-w", "--timeout", "-E", "--conflict-exit-code"], pos: 1, posWrites: true, cmdFlag: ["-c", "--command"] },
  watch: { a0: ["-d", "--differences", "-t", "--no-title", "-b", "--beep", "-e", "--errexit", "-g", "--chgexit", "-c", "--color", "-x", "--exec", "-p", "--precise"],
    a1: ["-n", "--interval"], joined: true },
};
const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runuser"]);
const WRITE_BINS = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "chmod", "chown", "chgrp", "mv", "cp", "ln", "tee", "touch", "mkdir", "dd", "sed", "perl", "install", "rsync", "tar", "unzip"]);

// Strip assignments and wrappers. Returns { tokens, assigns, cwd, writes, stdinArgs, reparse } or { hit }.
function unwrap(tokens, ctx) {
  let t = tokens, cwd = ctx.cwd, stdinArgs = false;
  const assigns = [], writes = [];
  const bad = (w, a) => ({ hit: { category: "script", reason: `${w}: option ${a} not understood; denied by default` } });
  for (let round = 0; round < 16; round++) {
    let i = 0;
    while (i < t.length && ASSIGN.test(t[i])) assigns.push(t[i++]);
    t = t.slice(i);
    if (!t.length) break;
    const w = t[0].split("/").pop();
    if (PRIVILEGE.has(w)) {
      // Report what the wrapped command would do if that is worse (sudo rm -rf / = disaster).
      let k = 1;
      while (k < t.length && t[k].startsWith("-")) k += /^-[ugCDhprtUT]$/.test(t[k]) ? 2 : 1;
      return { hit: { category: "system", reason: `${w}: executors never change user or privileges` }, inner: t.slice(k) };
    }
    if (w === "env") {
      let k = 1, split = null;
      for (; k < t.length; k++) {
        const a = t[k];
        if (a === "--") { k++; break; }
        if (ASSIGN.test(a)) { assigns.push(a); continue; }
        if (a === "-" || ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(a)) continue;
        if (!a.startsWith("-")) break;
        if (a === "-u" || a === "--unset") { k++; continue; }
        if (a.startsWith("--unset=") || /^-u./.test(a)) continue;
        const dir = a === "-C" || a === "--chdir" ? t[++k] : a.startsWith("--chdir=") ? a.slice(8) : /^-C./.test(a) ? a.slice(2) : undefined;
        if (dir !== undefined) { cwd = resolveDir(dir, here({ ...ctx, cwd }), ctx); continue; }
        split = a === "-S" || a === "--split-string" ? t[++k] : a.startsWith("--split-string=") ? a.slice(15) : /^-S./.test(a) ? a.slice(2) : undefined;
        if (split !== undefined) { k++; break; }
        return bad("env", a);
      }
      const rest = t.slice(k);
      t = split != null ? [...tokenizeShell(split), ...rest] : rest;
      if (!t.length) return { hit: { category: "secrets", reason: "dumping the environment can leak secrets" } };
      continue;
    }
    if (w === "command" && t.slice(1).some((a) => a === "-v" || a === "-V")) return { tokens: [], assigns, cwd, writes };
    if (w === "eval") return { reparse: t.slice(1).join(" "), assigns, cwd, writes };
    const spec = WRAPPERS[w];
    if (!spec) break;
    let k = 1;
    for (; k < t.length; k++) {
      const a = t[k];
      if (a === "--") { k++; break; }
      if (!a.startsWith("-") || a === "-") break;
      if (spec.num && /^-\d+$/.test(a)) continue;
      if (spec.cmdFlag?.includes(a)) return { reparse: t[k + 1 + (spec.pos || 0)] ?? t[k + 1] ?? "", assigns, cwd, writes };
      if (spec.a0.includes(a)) continue;
      if (spec.a1.includes(a)) { if (spec.out?.includes(a)) writes.push(t[k + 1]); k++; continue; }
      const eq = a.indexOf("=");
      if (a.startsWith("--") && eq > 0 && spec.a1.includes(a.slice(0, eq))) { if (spec.out?.includes(a.slice(0, eq))) writes.push(a.slice(eq + 1)); continue; }
      if (/^-[A-Za-z]./.test(a) && spec.a1.includes(a.slice(0, 2))) { if (spec.out?.includes(a.slice(0, 2))) writes.push(a.slice(2)); continue; }
      if (/^-[A-Za-z]{2,}$/.test(a) && [...a.slice(1)].every((c) => spec.a0.includes(`-${c}`))) continue;
      return bad(w, a);
    }
    const pos = t.slice(k, k + (spec.pos || 0));
    if (spec.posWrites) writes.push(...pos);
    t = t.slice(k + (spec.pos || 0));
    if (w === "xargs") { stdinArgs = true; if (!t.length) break; }
    if (spec.joined) return { reparse: t.join(" "), assigns, cwd, writes };
  }
  return { tokens: t, assigns, cwd, writes, stdinArgs };
}

// Environment assignments (prefix `X=y cmd`, `export X=y`, `env X=y`) that change what later
// commands run or which repository/config git uses.
const GIT_ENV_OK = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$|^GIT_(TERMINAL_PROMPT|TRACE\w*|OPTIONAL_LOCKS|LITERAL_PATHSPECS|FLUSH|ADVICE|PROGRESS_DELAY|MERGE_VERBOSITY|REDACT_COOKIES)$/;
const CODE_INJECT_ENV = /^(LD_\w+|BASH_ENV|ENV|PROMPT_COMMAND|NODE_OPTIONS|PERL5OPT|RUBYOPT|PYTHONSTARTUP|PYTHONINSPECT|HOME|XDG_CONFIG_HOME|ZDOTDIR|SHELLOPTS|BASHOPTS)$|^npm_config_|^NPM_CONFIG_|^YARN_\w*PATH$/i;
function assignHit(a, ctx) {
  const eq = a.indexOf("=");
  const name = a.slice(0, eq), value = a.slice(eq + 1);
  if (/^GIT_/.test(name) && !GIT_ENV_OK.test(name)) return { category: "remote", reason: `${name}=… changes which repository/config/programs git uses; denied` };
  if (CODE_INJECT_ENV.test(name)) return { category: "script", reason: `${name}=… changes what later commands load or run; denied` };
  if (name === "PATH") {
    for (const part of value.split(":")) {
      if (/^\$\{?PATH\}?$/.test(part)) continue;
      const p = expandPath(part, ctx);
      if (p !== null && isAbsolute(p) && !executorWritable(p, ctx) && !isInside(realish(p), ctx.workdir || "/nonexistent")) continue;
      return { category: "script", reason: `PATH entry "${part}" would run programs by plain name from a directory the executor can write (not inspected); denied` };
    }
  }
  return null;
}

// Absolute directory for a -C / --directory / --prefix argument; null = cannot verify.
function resolveDir(arg, from, ctx) {
  if (arg === undefined || arg === null || arg === "") return null;
  const p = expandPath(arg, ctx);
  if (p === null) return null;
  if (isAbsolute(p)) return resolve(p);
  return from ? resolve(from, p) : null;
}

// A directory a command acts in (git -C, make -C, npm --prefix, tar -C, env -C …): the workdir,
// inside it, or inside an extra writable dir (/tmp). Unknown → denied.
function dirHit(dir, what, ctx) {
  if (!ctx.workdir) return null;
  if (dir === null) return { category: "path", reason: `${what}: directory cannot be verified (variable, substitution or unknown cwd); denied by default` };
  const abs = realish(dir);
  if (isInside(abs, ctx.workdir) || (ctx.extraWritable ?? ["/tmp"]).some((d) => isInside(abs, realish(d)))) return null;
  return { category: "path", reason: `${what} ${abs} is outside the task workdir` };
}
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
  if (isAbsolute(p)) return checkWritePath(p, ctx);
  const cwd = ctx.cwd === undefined ? ctx.workdir : ctx.cwd;
  if (cwd === null) return { category: "path", reason: `write target "${target}" after cd to an unknown directory; denied by default` };
  return checkWritePath(resolve(cwd, p), ctx);
}

// `cd X` / `pushd X` earlier in the same command line moves where relative write targets land.
// Returns undefined (not a cd), null (unknown directory) or the new absolute cwd.
function cdTarget(sub, ctx) {
  const t = tokenizeShell(sub);
  const w = t.length ? t[0].replace(/^[({]+/, "") : "";
  if (w === "popd") return null; // the directory stack is not modelled
  if (!["cd", "pushd"].includes(w)) return undefined;
  const arg = t.slice(1).find((a) => !a.startsWith("-") || a === "-");
  if (!arg || arg === "~") return ctx.home;
  return arg === "-" ? null : resolveDir(arg, here(ctx), ctx);
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
    case "rsync": return pos.length >= 2 ? [pos[pos.length - 1]] : [];
    case "curl": return optValues(args, ["-o", "--output", "--output-dir", "-D", "--dump-header", "-c", "--cookie-jar", "--trace", "--trace-ascii", "--stderr"]);
    case "wget": return optValues(args, ["-O", "--output-document", "-P", "--directory-prefix", "-o", "--output-file", "-a", "--append-output"]);
    default: return [];
  }
}

// Values of options (`-o X`, `-oX`, `--output=X`, `--output X`).
function optValues(args, names) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (names.includes(a)) { if (args[k + 1] !== undefined) out.push(args[++k]); continue; }
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0 && names.includes(a.slice(0, eq))) out.push(a.slice(eq + 1));
    else if (/^-[A-Za-z]./.test(a) && !a.startsWith("--") && names.includes(a.slice(0, 2))) out.push(a.slice(2));
  }
  return out;
}

// Is this file something the executor could have written (and so must be inspected)?
function executorWritable(p, ctx) {
  if (!ctx.workdir) return false;
  const base = here(ctx);
  if (!isAbsolute(p) && !base) return true; // relative to an unknown cwd: treat as executor-written
  const abs = resolve(base || ctx.workdir, p);
  if (/(^|\/)(node_modules|\.venv|venv|vendor)\//.test(relative(ctx.workdir, abs))) return false; // package-manager installs (documented gap)
  return isInside(abs, ctx.workdir) || isInside(abs, "/tmp");
}

function readScript(p, ctx) {
  const e = expandPath(p, ctx) ?? p;
  const base = here(ctx);
  if (!isAbsolute(e) && !base) return null;
  const abs = resolve(base || ".", e);
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
const PKG_DIR_OPTS = { npm: ["--prefix", "-C"], pnpm: ["-C", "--dir"], yarn: ["--cwd"], bun: ["--cwd"] };
// npm settings in a project .npmrc that change how scripts run (another shell, preloaded code).
const NPMRC_DANGEROUS = /^\s*(script-shell|shell|node-options|onload-script|init-module|globalconfig|userconfig|git)\s*=/m;

function packageScriptHit(bin, args, policy, ctx) {
  if (!ctx.workdir) return null;
  let dir = here(ctx);
  const dirs = optValues(args, PKG_DIR_OPTS[bin] || []);
  for (const d of dirs) dir = resolveDir(d, dir, ctx);
  if (dirs.length || dir === null) { const hit = dirHit(dir, `${bin} ${PKG_DIR_OPTS[bin].join("/")}`, ctx); if (hit) return hit; }
  const valued = new Set(PKG_DIR_OPTS[bin] || []);
  const pos = args.filter((a, k) => (!a.startsWith("-") || a === "-") && !valued.has(args[k - 1]));
  let name = null;
  if (["test", "start", "build", "stop", "restart"].includes(pos[0]) || pos[0] === "t") name = pos[0] === "t" ? "test" : pos[0];
  else if (["run", "run-script"].includes(pos[0])) name = pos[1];
  else if (bin === "yarn" && pos[0] && !["install", "add", "remove", "upgrade", "why", "info", "list"].includes(pos[0])) name = pos[0];
  // Nearest package.json from the directory upwards (npm's own lookup), within the workdir.
  let pkgDir = dir;
  while (!existsSync(join(pkgDir, "package.json")) && pkgDir !== ctx.workdir && isInside(pkgDir, ctx.workdir)) pkgDir = dirname(pkgDir);
  for (const d of new Set([pkgDir, ctx.workdir])) {
    let rc = "";
    try { rc = readFileSync(join(d, ".npmrc"), "utf8"); } catch { /* none */ }
    const m = rc.match(NPMRC_DANGEROUS);
    if (m) return { category: "script", reason: `.npmrc sets ${m[1]} (changes how package scripts run); denied` };
  }
  if (!name) return null;
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")); } catch { return null; }
  const c = { ...ctx, cwd: pkgDir, depth: ctx.depth + 1 }; // npm runs scripts in the package root
  for (const n of [`pre${name}`, name, `post${name}`]) {
    const sc = pkg.scripts?.[n];
    if (typeof sc !== "string") continue;
    const hit = checkCommandIn(sc, policy, c);
    if (hit) return { category: hit.category, reason: `package.json script "${n}": ${hit.reason}` };
  }
  return null;
}

// make -C dir (cumulative, also -Cdir / --directory=dir) changes directory before reading the
// makefile; -f is relative to that directory. Recipes run there.
function makefileHit(args, policy, ctx) {
  if (!ctx.workdir) return null;
  let dir = here(ctx), file = null, cd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    let d, f;
    if (a === "-C" || a === "--directory") d = args[++k] ?? "";
    else if (a.startsWith("--directory=")) d = a.slice(12);
    else if (/^-C./.test(a)) d = a.slice(2);
    else if (a === "-f" || a === "--file" || a === "--makefile") f = args[++k] ?? "";
    else if (/^--(file|makefile)=/.test(a)) f = a.slice(a.indexOf("=") + 1);
    else if (/^-f./.test(a)) f = a.slice(2);
    else if (["-I", "--include-dir", "-o", "--old-file", "-W", "--what-if", "--new-file", "--assume-new", "--assume-old", "-l"].includes(a)) k++;
    if (d !== undefined) { dir = resolveDir(d, dir, ctx); cd = true; }
    if (f !== undefined) file = f;
  }
  if (cd || dir === null) { const hit = dirHit(dir, "make -C", ctx); if (hit) return hit; }
  if (file === "-" || file === "/dev/stdin") return { category: "script", reason: "make reads its makefile from stdin (cannot inspect); denied" };
  const c = { ...ctx, cwd: dir, depth: ctx.depth + 1 };
  if (file === null) file = ["GNUmakefile", "makefile", "Makefile"].find((f) => existsSync(join(dir, f)));
  if (!file) return null;
  const read = (f) => {
    const t = readScript(f, c);
    if (t === null && executorWritable(expandPath(f, c) ?? f, c)) return { hit: { category: "script", reason: `cannot read makefile ${f} to inspect it; denied by default` } };
    return { text: t || "" };
  };
  const main = read(file);
  if (main.hit) return main.hit;
  let text = main.text;
  // Literal includes are scanned too (one level); includes built from variables are not (documented).
  for (const m of text.matchAll(/^\s*-?s?include\s+(.+)$/gm)) {
    for (const f of m[1].trim().split(/\s+/)) if (!f.includes("$")) { const r = read(f); if (r.hit) return r.hit; text += `\n${r.text}`; }
  }
  const recipes = text.split("\n").filter((l) => l.startsWith("\t")).map((l) => l.slice(1).replace(/^[@+-]+/, "").replace(/\$\(MAKE\)|\$\{MAKE\}/g, "make")).join("\n");
  const hit = checkCommandIn(recipes, policy, c);
  return hit && { category: hit.category, reason: `Makefile recipe: ${hit.reason}` };
}

// git global options before the subcommand. -C is cumulative; --git-dir/--work-tree/-C pointing
// outside the workdir would let a "harmless" git command reset/checkout/commit another tree.
const GIT_GLOBAL_FLAGS = new Set(["-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks",
  "--no-advice", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--version", "-v", "--help", "-h",
  "--html-path", "--man-path", "--info-path", "--exec-path"]);
const GIT_GLOBAL_VALUED = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source", "--list-cmds"]);

function gitGlobals(args, ctx) {
  let gi = 0, dir = here(ctx);
  const dirs = [];
  while (gi < args.length && args[gi].startsWith("-")) {
    const a = args[gi];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (GIT_GLOBAL_FLAGS.has(a)) { gi++; continue; }
    let val;
    if (GIT_GLOBAL_VALUED.has(name)) { val = eq > 0 ? a.slice(eq + 1) : args[gi + 1]; gi += eq > 0 ? 1 : 2; }
    else if (/^-C./.test(a)) { val = a.slice(2); gi++; }
    else if (name === "--exec-path") return { hit: { category: "script", reason: "git --exec-path=… runs git programs from another directory; denied" } };
    else return { hit: { category: "remote", reason: `git global option ${a} not understood; denied by default` } };
    if (name === "-c" || name === "--config-env") {
      const kv = val ?? "";
      if (GIT_DANGEROUS_KEY.test(kv)) return { hit: { category: "remote", reason: `git ${name} ${kv.split("=")[0]} (aliases/hooks/remotes/credentials can run or send anything)` } };
    } else if (name === "-C" || /^-C./.test(a)) { dir = resolveDir(val, dir, ctx); dirs.push(["git -C", dir]); }
    else if (name === "--git-dir" || name === "--work-tree") dirs.push([`git ${name}`, resolveDir(val, dir, ctx)]);
  }
  for (const [what, d] of dirs) { const hit = dirHit(d, what, ctx); if (hit) return { hit }; }
  return { gi, dir };
}

// Files and directories git subcommands write besides the repository itself.
function gitWriteTargets(sub, rest) {
  const pos = rest.filter((a, k) => !a.startsWith("-") && !["-b", "-B", "--reason", "-o", "--origin", "--template", "--separate-git-dir", "--reference", "--depth", "--branch", "-c", "--config"].includes(rest[k - 1]));
  const out = optValues(rest, ["--output", "--output-directory", "--separate-git-dir", "--template", "--reference"]);
  if (["format-patch", "archive"].includes(sub)) out.push(...optValues(rest, ["-o"]));
  if (sub === "worktree" && ["add", "move"].includes(pos[0])) out.push(pos[sub === "worktree" && pos[0] === "move" ? 2 : 1]);
  if (sub === "clone" && pos.length >= 2) out.push(pos[1]);
  if (sub === "init" && pos.length) out.push(pos[0]);
  if (sub === "bundle" && pos[0] === "create" && pos[1]) out.push(pos[1]);
  return out.filter((x) => x !== undefined);
}

function checkOne(sub, policy, ctx0) {
  const raw = tokenizeShell(sub);
  if (raw.length && ["env", "printenv", "export", "set", "declare", "typeset"].includes(raw[0]) && raw.slice(1).every((a) => a.startsWith("-"))) {
    return { category: "secrets", reason: "dumping the environment can leak secrets" };
  }
  const block = (category, reason) => ({ category, reason });
  for (const t of redirectTargets(sub)) { const hit = writeTargetHit(t, ctx0); if (hit) return hit; }
  const u = unwrap(stripRedirs(raw), ctx0);
  if (u.hit) return (u.inner?.length && ctx0.depth < MAX_DEPTH && checkOne(quoteJoin(u.inner), policy, { ...ctx0, depth: ctx0.depth + 1 })) || u.hit;
  for (const a of u.assigns) { const hit = assignHit(a, ctx0); if (hit) return hit; }
  for (const w of u.writes) { const hit = writeTargetHit(w, ctx0); if (hit) return hit; }
  // env -C dir: the wrapped command runs there.
  const ctx = u.cwd !== ctx0.cwd ? { ...ctx0, cwd: u.cwd } : ctx0;
  if (u.cwd !== ctx0.cwd) { const hit = dirHit(u.cwd, "env -C", ctx0); if (hit) return hit; }
  if (u.reparse !== undefined) {
    if (ctx.depth >= MAX_DEPTH) return block("script", `commands nested deeper than ${MAX_DEPTH}; denied by default`);
    return checkCommandIn(u.reparse, policy, { ...ctx, depth: ctx.depth + 1 });
  }
  const tokens = u.tokens;
  if (!tokens.length) return null;
  const bin = tokens[0].split("/").pop();
  const args = tokens.slice(1);
  if (["export", "declare", "typeset", "local", "readonly"].includes(bin)) {
    for (const a of args) if (ASSIGN.test(a)) { const hit = assignHit(a, ctx); if (hit) return hit; }
    return null;
  }
  // xargs supplies the arguments from stdin: the targets of a file-writing command are unknown.
  if (u.stdinArgs && WRITE_BINS.has(bin)) return block("path", `xargs ${bin}: targets come from stdin and cannot be verified; denied by default`);

  // --- disaster
  if (bin === "mkfs" || bin.startsWith("mkfs.")) return block("disaster", "filesystem format");
  if (bin === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return block("disaster", "raw device write");
  if (bin === "find") {
    const roots = [];
    for (const a of args) { if (a.startsWith("-") || a === "(" || a === "!") break; roots.push(a); }
    if (args.includes("-delete") && roots.some((a) => FIND_ROOTS.has(norm(a)) || FIND_ROOTS.has(a))) return block("disaster", "find -delete from / or ~");
    for (const t of optValues(args, ["-fprint", "-fprint0", "-fprintf", "-fls"])) { const hit = writeTargetHit(t, ctx); if (hit) return hit; }
    // -exec/-execdir/-ok: the inner command is checked; its {} targets live under the find roots.
    const writesUnderRoots = () => {
      for (const r of roots.length ? roots : ["."]) { const hit = dirHit(resolveDir(r, here(ctx), ctx), "find root", ctx); if (hit) return hit; }
      return null;
    };
    if (args.includes("-delete")) { const hit = writesUnderRoots(); if (hit) return hit; }
    for (let k = 0; k < args.length; k++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k])) continue;
      let e = k + 1;
      while (e < args.length && args[e] !== ";" && args[e] !== "+") e++;
      const inner = args.slice(k + 1, e);
      const innerHit = checkOne(quoteJoin(inner.map((x) => (x === "{}" ? "./found" : x))), policy, { ...ctx, depth: ctx.depth + 1 });
      if (innerHit) return innerHit;
      const ib = (inner[0] || "").split("/").pop();
      if (WRITE_BINS.has(ib) || SHELLS.has(ib)) { const hit = writesUnderRoots(); if (hit) return hit; }
      k = e;
    }
  }
  // Archive extraction into a directory.
  if (bin === "tar") {
    const isCluster = (a, k) => (k === 0 && /^[A-Za-z]+$/.test(a)) || /^-[A-Za-z]+$/.test(a);
    const clusters = args.filter(isCluster).map((a) => a.replace(/^-/, ""));
    const has = (re, longs) => clusters.some((c) => re.test(c)) || args.some((a) => longs.includes(a));
    if (has(/x/, ["--extract", "--get"])) for (const d of optValues(args, ["-C", "--directory"])) { const hit = dirHit(resolveDir(d, here(ctx), ctx), "tar -C", ctx); if (hit) return hit; }
    if (has(/[cru]/, ["--create", "--append", "--update"])) {
      const files = optValues(args, ["-f", "--file"]);
      args.forEach((a, k) => { if (isCluster(a, k) && a.replace(/^-/, "").length >= 2 && a.endsWith("f") && args[k + 1]) files.push(args[k + 1]); });
      for (const f of files) { const hit = writeTargetHit(f, ctx); if (hit) return hit; }
    }
  }
  if (bin === "unzip") for (const d of optValues(args, ["-d"])) { const hit = dirHit(resolveDir(d, here(ctx), ctx), "unzip -d", ctx); if (hit) return hit; }
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
    // -c key=value / --config-env key=ENVVAR, -C / --git-dir / --work-tree (see gitGlobals)
    const g = gitGlobals(args, ctx);
    if (g.hit) return g.hit;
    const gi = g.gi;
    const sub = args[gi];
    const rest = args.slice(gi + 1);
    const gctx = { ...ctx, cwd: g.dir };
    for (const t of gitWriteTargets(sub, rest)) { const hit = writeTargetHit(t, gctx); if (hit) return hit; }
    if (["send-email", "request-pull", "daemon", "svn", "p4", "imap-send"].includes(sub)) return block("egress", `git ${sub} talks to the outside`);
    if (sub === "push") {
      const force = rest.some((a) => a === "-f" || a.startsWith("--force") || a === "--mirror" || a === "--delete" || /^\+/.test(a));
      const refs = rest.filter((a) => !a.startsWith("-")).slice(1);
      const dest = refs.map((r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, ""));
      if (force) return block("push", "force/delete push is never allowed for executors");
      if (!dest.length || dest.some((d) => branchMatches(d, policy.protected_branches))) return block("push", "push to a protected (or implicit) branch");
      return block("push", "executors do not push; the owner merges task branches");
    }
    // Local ref writes to protected branches (the owner would later push/merge them).
    const prot = (r) => branchMatches(String(r).replace(/^\+/, "").replace(/^refs\/heads\//, ""), policy.protected_branches);
    const rpos = rest.filter((a) => !a.startsWith("-"));
    if (sub === "update-ref" && rpos.some(prot)) return block("push", "update-ref on a protected branch");
    if (sub === "branch" && rest.some((a) => /^(-[a-zA-Z]*[fDdMmCc]|--force|--delete|--move|--copy)$/.test(a)) && rpos.some(prot)) return block("push", "moving/deleting a protected branch");
    if (["fetch", "pull"].includes(sub) && rpos.some((r) => r.includes(":") && prot(r.split(":").pop()))) return block("push", "fetching into a protected branch");
    if (["checkout", "switch"].includes(sub) && (rest.includes("--ignore-other-worktrees") || rest.some((a, k) => ["-B", "-C", "--force-create"].includes(a) && prot(rest[k + 1])))) return block("push", "checking out / resetting a protected branch from a task worktree");
    if (sub === "symbolic-ref" && rpos.length >= 2) return block("push", "rewriting a symbolic ref");
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
  let c = ctx;
  for (const sub of splitCommands(command)) {
    const cd = c.workdir ? cdTarget(sub, c) : undefined;
    if (cd !== undefined) { c = { ...c, cwd: cd }; continue; }
    const r = checkOne(sub, policy, c);
    if (r) return r;
  }
  return null;
}

/**
 * @param {string} command  full shell command line
 * @param {object} policy   cfg.guard
 * @param {object} [where]  { workdir, forbidden } — enables write-target and script checks
 */
export function checkCommand(command, policy = {}, { workdir, forbidden = [], home = homedir(), extraWritable, cwd } = {}) {
  const pol = { protected_branches: ["main", "master", "release/*"], allow_hosts: [], ...policy };
  // cwd: the shell's current directory when the executor's shell persists it between calls
  // (Claude Code's Bash tool: `cd ..` in one call, `rm -rf x` in the next).
  const start = typeof cwd === "string" && isAbsolute(cwd) ? realish(cwd) : undefined;
  return checkCommandIn(command, pol, { workdir: workdir ? realish(workdir) : undefined, forbidden, home, extraWritable, depth: 0, ...(workdir && start ? { cwd: start } : {}) });
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
