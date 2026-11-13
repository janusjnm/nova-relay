// isolation.mjs — opt-in OS process isolation (bubblewrap) for acceptance commands and agent
// executors. This is NOT nova-guard: nova-guard is a heuristic command/path check that runs before
// a tool call; this module puts the step in Linux namespaces with a minimal mount table.
//
//   isolation.mode "off" (default)  nothing is wrapped; behaviour is unchanged
//   isolation.mode "strict"         every step in `apply_to` runs inside bwrap, or does not run.
//                                   Missing bwrap, a failed probe, an adapter without a profile, a
//                                   path that cannot be bound safely: IsolationError. There is no
//                                   fallback to unsandboxed execution.
//
// Profile (strict): new user/pid/uts/ipc namespaces, --die-with-parent, --new-session; read-only
// /usr (+ /bin, /lib*, /sbin as on the host) and a few /etc files; private tmpfs /tmp and a private
// tmpfs over the host home directory; writable binds only for the step's workspace. Network is
// unshared for acceptance unless isolation.acceptance_network is true; the executor step keeps the
// host network (official CLIs must reach their vendor). Credential paths are bound read-only only
// for the executor adapter that declares them (claude: ~/.claude); the sandboxed process can read
// those files as the same user — this is not secret-proof isolation.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./util.mjs";

export const ISOLATION_ADAPTERS = ["bwrap"];
export const ISOLATION_STEPS = ["acceptance", "executor"];
export const ISOLATION_KEYS = ["mode", "adapter", "apply_to", "acceptance_network", "ro_binds"];
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class IsolationError extends Error {
  constructor(msg) { super(`strict isolation: ${msg}; the step was not run (no unsandboxed fallback)`); this.isolation = true; }
}

// Paths that must never be bound into a sandbox by config (`ro_binds`), nor be an ancestor of a bind.
// Only an executor adapter's own declared credential paths (claude: ~/.claude) are exempt.
const CREDENTIAL_PATHS = ["~/.ssh", "~/.gnupg", "~/.config/nova-relay", "~/.claude", "~/.claude.json", "~/.codex", "~/.pi",
  "~/.aws", "~/.config/gh", "~/.netrc", "~/.git-credentials", "~/.docker", "~/.kube", "~/.npmrc", "~/.pypirc"];

const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };

export function normalizeIsolation(raw, p = [], { novaHome } = {}) {
  const iso = { mode: "off", adapter: "bwrap", acceptance_network: false, ro_binds: [], ...(raw || {}) };
  if (!["off", "strict"].includes(iso.mode)) p.push(`isolation.mode: must be "off" or "strict"`);
  if (!ISOLATION_ADAPTERS.includes(iso.adapter)) p.push(`isolation.adapter: unknown adapter "${iso.adapter}" (known: ${ISOLATION_ADAPTERS.join(", ")})`);
  if (iso.apply_to === undefined) iso.apply_to = [...ISOLATION_STEPS];
  if (!Array.isArray(iso.apply_to) || !iso.apply_to.length || iso.apply_to.some((s) => !ISOLATION_STEPS.includes(s))) p.push(`isolation.apply_to: a non-empty list of ${ISOLATION_STEPS.map((s) => `"${s}"`).join(", ")}`);
  if (typeof iso.acceptance_network !== "boolean") p.push("isolation.acceptance_network: must be true or false");
  if (!Array.isArray(iso.ro_binds)) p.push("isolation.ro_binds: must be a list of absolute paths");
  else {
    iso.ro_binds = iso.ro_binds.map((b) => (typeof b === "string" ? expandHome(b) : b));
    for (const b of iso.ro_binds) {
      const why = typeof b === "string" ? unsafeBind(b, { novaHome }) : "not a string";
      if (why) p.push(`isolation.ro_binds: "${b}" ${why}`);
    }
  }
  return iso;
}

export const isolationApplies = (cfg, step) => cfg.isolation?.mode === "strict" && cfg.isolation.apply_to.includes(step);

// Why a path may not be bound (null = fine). `allow` lists credential paths the caller declared.
// `novaHome`: binding the nova-relay home itself (or an ancestor) is refused; specific paths inside
// it (a worktree, a task's hook-calls file) are passed with `internal: true`.
export function unsafeBind(path, { home = homedir(), novaHome, secretsFile, allow = [], internal = false } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) return "must be an absolute path";
  if (normalize(path).replace(/\/+$/, "") !== path.replace(/\/+$/, "")) return "must be a normalized path (no ., .. or //)";
  const real = realOr(path);
  const homes = [home, realOr(home)];
  for (const p of [path, real]) {
    if (p === "/") return "is the root directory";
    for (const h of homes) if (inside(h, p)) return `is the home directory ${h} or an ancestor of it (never a broad $HOME mount)`;
    if (novaHome) for (const n of [novaHome, realOr(novaHome)]) {
      if (inside(n, p)) return `is the nova-relay home ${n} or an ancestor of it`;
      if (!internal && inside(p, n)) return `is inside the nova-relay home ${n}`;
    }
    if (secretsFile && (inside(p, secretsFile) || inside(secretsFile, p) || inside(realOr(secretsFile), p))) return "contains the nova-relay secrets file";
    for (const c of CREDENTIAL_PATHS) {
      const cp = expandHome(c);
      if (allow.includes(cp)) continue;
      if (inside(p, cp) || inside(cp, p) || inside(realOr(cp), p) || inside(p, realOr(cp))) return `contains or is inside a credential/secret path (${c})`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ probe (read-only, cached)

export function findBwrap(env = process.env) {
  const dirs = [...String(env.PATH || "").split(":").filter(isAbsolute), "/usr/bin", "/usr/local/bin", "/bin"];
  for (const d of dirs) {
    const p = join(d, "bwrap");
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

const PROBES = new Map();
export function resetProbeCache() { PROBES.clear(); }

// Can bwrap create the strict profile here (bwrap present, unprivileged user namespaces allowed)?
// Runs `true` inside the base profile with nothing writable bound. No host state is changed.
export function probeIsolation({ bin, env = process.env } = {}) {
  const b = bin === undefined ? findBwrap(env) : bin;
  const key = b || "(none)";
  if (PROBES.has(key)) return PROBES.get(key);
  let res;
  if (process.platform !== "linux") res = { ok: false, adapter: "bwrap", why: `bwrap isolation needs Linux (this is ${process.platform})` };
  else if (!b || !existsSync(b)) res = { ok: false, adapter: "bwrap", why: "bwrap not found (install bubblewrap; nova-relay does not install it)" };
  else {
    const truth = ["/usr/bin/true", "/bin/true"].find((p) => existsSync(p));
    const r = spawnSync(b, [...baseArgs({ network: false }), "--", truth || "true"], { encoding: "utf8", timeout: 15_000, env: { PATH: "/usr/bin:/bin" } });
    const v = spawnSync(b, ["--version"], { encoding: "utf8", timeout: 5_000 });
    const version = (v.stdout || "").trim() || null;
    res = r.status === 0 ? { ok: true, adapter: "bwrap", bin: b, version }
      : { ok: false, adapter: "bwrap", bin: b, version, why: `bwrap could not create the sandbox (${r.error?.code || `exit ${r.status}`}: ${String(r.stderr || "").trim().slice(0, 200)}) — unprivileged user namespaces may be disabled` };
  }
  PROBES.set(key, res);
  return res;
}

// ------------------------------------------------------------------ profile

function systemArgs(network) {
  const a = ["--ro-bind", "/usr", "/usr"];
  for (const d of ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]) {
    let st;
    try { st = lstatSync(d); } catch { continue; }
    if (st.isSymbolicLink()) a.push("--symlink", realpathSync(d).replace(/^\//, ""), d);
    else if (st.isDirectory()) a.push("--ro-bind", d, d);
  }
  for (const f of ["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/localtime", "/etc/alternatives"]) a.push("--ro-bind-try", f, f);
  // Trust store and name resolution only where the step may use the network.
  if (network) for (const f of ["/etc/resolv.conf", "/etc/hosts", "/etc/host.conf", "/etc/gai.conf", "/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/etc/crypto-policies"]) a.push("--ro-bind-try", f, f);
  return a;
}

function baseArgs({ network, home = homedir() }) {
  return ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--unshare-cgroup-try",
    ...(network ? [] : ["--unshare-net"]), ...systemArgs(network),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", home, "--hostname", "nova-sandbox"];
}

// Is `p` reachable inside a profile with these binds (system dirs + bind destinations)?
function visible(p, dests) {
  const roots = ["/usr", ...["/bin", "/sbin", "/lib", "/lib64"].filter((d) => existsSync(d)), ...dests];
  return roots.some((r) => inside(p, r));
}

export function resolveCommand(cmd, path) { return which(cmd, path); }

function which(cmd, path) {
  if (cmd.includes("/")) return isAbsolute(cmd) ? cmd : null;
  for (const d of String(path || "").split(":").filter(isAbsolute)) {
    const p = join(d, cmd);
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Build the bwrap argv for one step. Throws IsolationError instead of returning a weaker profile.
 * @param {object} o
 * @param {string} o.bin        bwrap binary (from a successful probe)
 * @param {string} o.cmd        command (absolute, or looked up in env.PATH)
 * @param {string[]} o.args
 * @param {string} o.cwd        must be inside a writable bind
 * @param {object} o.env        child environment (PATH is extended with the node bin dir)
 * @param {string[]} o.rw       writable directory binds (the workspace)
 * @param {string[]} [o.rwFiles] writable single-file binds (created if missing)
 * @param {Array<string|{src,dest}>} [o.ro] read-only binds
 * @param {boolean} o.network   false → --unshare-net
 * @param {object} [o.policy]   { home, novaHome, secretsFile, allow } for unsafeBind
 */
export function buildSandbox({ bin, cmd, args = [], cwd, env = {}, rw = [], rwFiles = [], ro = [], network, policy = {} }) {
  const home = policy.home || homedir();
  const out = [];
  const dests = [];
  const check = (p, internal) => { const why = unsafeBind(p, { ...policy, home, internal }); if (why) throw new IsolationError(`cannot bind ${p}: ${why}`); };
  for (const r of ro) {
    const { src, dest } = typeof r === "string" ? { src: r, dest: r } : r;
    if (!existsSync(src)) throw new IsolationError(`read-only bind ${src} does not exist`);
    check(dest, true); check(realpathSync(src), true);
    out.push("--ro-bind", realpathSync(src), dest); dests.push(dest);
  }
  for (const d of rw) {
    if (!existsSync(d) || !statSync(d).isDirectory()) throw new IsolationError(`workspace ${d} is not a directory`);
    check(d, true); check(realpathSync(d), true);
    out.push("--bind", realpathSync(d), d); dests.push(d);
  }
  for (const f of rwFiles) {
    if (!existsSync(f)) writeFileSync(f, "", { mode: 0o600 });
    if (!lstatSync(f).isFile()) throw new IsolationError(`${f} is not a regular file`);
    check(f, true);
    out.push("--bind", f, f); dests.push(f);
  }
  if (!rw.some((d) => inside(cwd, d))) throw new IsolationError(`working directory ${cwd} is not inside the writable workspace`);
  const node = dirname(process.execPath);
  const path = [...String(env.PATH || "").split(":").filter(Boolean), ...(String(env.PATH || "").split(":").includes(node) ? [] : [node])].join(":");
  const abs = which(cmd, path);
  if (!abs) throw new IsolationError(`command ${cmd} not found`);
  const execDests = [...dests, node];
  if (!visible(abs, execDests) && !visible(realOr(abs), execDests)) throw new IsolationError(`command ${abs} is not visible inside the sandbox (add its directory to isolation.ro_binds)`);
  const childEnv = { ...env, PATH: path };
  // A TMPDIR outside the binds does not exist in the sandbox: use the private /tmp.
  if (childEnv.TMPDIR && !rw.some((d) => inside(childEnv.TMPDIR, d))) childEnv.TMPDIR = "/tmp";
  // The node running nova-relay (hook script interpreter): its install prefix, read-only.
  // If that prefix is not a safe bind (e.g. node lives directly in $HOME/bin), only the binary.
  const nodePrefix = node.endsWith("/bin") ? dirname(node) : node;
  let nodeBind = [];
  if (!visible(process.execPath, [])) {
    nodeBind = unsafeBind(nodePrefix, { ...policy, home, internal: true }) ? ["--ro-bind", process.execPath, process.execPath] : ["--ro-bind", realOr(nodePrefix), nodePrefix];
  }
  const argv = [...baseArgs({ network, home }), ...nodeBind, ...out, "--chdir", cwd, "--", abs, ...args];
  return { cmd: bin, args: argv, env: childEnv, profile: { network, rw, rwFiles, ro: ro.map((r) => (typeof r === "string" ? r : r.dest)) } };
}

// ------------------------------------------------------------------ steps

function ready(ctx) {
  const iso = ctx.cfg.isolation;
  if (iso.adapter !== "bwrap") throw new IsolationError(`unknown adapter ${iso.adapter}`);
  const pr = probeIsolation({ bin: ctx.bwrapBin, env: ctx.env });
  if (!pr.ok) throw new IsolationError(pr.why);
  return pr;
}

const policyOf = (ctx, allow = []) => ({ home: homedir(), novaHome: ctx.cfg.home, allow,
  secretsFile: expandHome(ctx.env?.NOVA_RELAY_SECRETS || "~/.config/nova-relay/secrets.env") });

// Acceptance: the standalone scratch clone + its private HOME are writable; the shared git object
// store is read-only (the clone is --shared). No network unless isolation.acceptance_network.
export function acceptanceSandbox(ctx, { cmd, args, cwd, env, rw, gitCommon }) {
  const pr = ready(ctx);
  const iso = ctx.cfg.isolation;
  return buildSandbox({ bin: pr.bin, cmd, args, cwd, env, rw, ro: [...(gitCommon ? [gitCommon] : []), ...iso.ro_binds], network: iso.acceptance_network, policy: policyOf(ctx) });
}

// The `isolate` option for accept(): undefined unless strict isolation applies to acceptance.
export function acceptanceIsolator(ctx) {
  if (!isolationApplies(ctx.cfg, "acceptance")) return undefined;
  const f = (o) => acceptanceSandbox(ctx, o);
  f.network = ctx.cfg.isolation.acceptance_network;
  return f;
}

// Executor: only adapters that declare a sandbox profile. The worktree and its private git dir are
// writable, the shared git dir read-only; the task's hook-calls/approvals files are the only
// writable paths in the task dir; declared credential paths and the CLI binary are read-only.
export function executorSandbox(ctx, { adapter, ex, built, env, workdir, taskDir, gitDir, gitCommon }) {
  const pr = ready(ctx);
  const sb = adapter.sandbox;
  if (!sb) throw new IsolationError(`executor adapter "${adapter.name}" has no strict isolation profile in this version (supported: claude)`);
  const allow = [], ro = [];
  for (const c of sb.credentialPaths || []) {
    const p = expandHome(c.path);
    if (!existsSync(p)) { if (c.required) throw new IsolationError(`${c.path} (official ${adapter.name} login) is missing`); continue; }
    allow.push(p);
    ro.push(p);
  }
  const binPath = which(built.cmd, env.PATH);
  if (!binPath) throw new IsolationError(`${adapter.name} binary ${built.cmd} not found`);
  ro.push({ src: binPath, dest: binPath });
  if (sb.hookRoot) ro.push(PACKAGE_ROOT);
  if (gitCommon) ro.push(gitCommon);
  ro.push(...ctx.cfg.isolation.ro_binds);
  const rw = [workdir, ...(gitDir && gitDir !== gitCommon && !inside(gitDir, workdir) ? [gitDir] : [])];
  const rwFiles = (sb.taskFiles || []).map((f) => join(taskDir, f));
  return buildSandbox({ bin: pr.bin, cmd: binPath, args: built.args, cwd: workdir, env, rw, rwFiles, ro, network: true, policy: policyOf(ctx, allow) });
}

// Checked before a segment starts (no usage reserved, nothing spawned): null or the reason the
// executor step cannot run under the strict profile on this host.
export function executorIsolationProblem(ctx, adapter) {
  try {
    ready(ctx);
    if (!adapter.sandbox) throw new IsolationError(`executor adapter "${adapter.name}" has no strict isolation profile in this version (supported: claude)`);
    for (const c of adapter.sandbox.credentialPaths || []) if (c.required && !existsSync(expandHome(c.path))) throw new IsolationError(`${c.path} (official ${adapter.name} login) is missing`);
    return null;
  } catch (e) { return e.message; }
}

// For doctor: can the configured strict profile run on this host? (Read-only.)
export function isolationReport(ctx) {
  const iso = ctx.cfg.isolation;
  if (iso.mode !== "strict") return { mode: "off" };
  return { mode: "strict", apply_to: iso.apply_to, probe: probeIsolation({ bin: ctx.bwrapBin, env: ctx.env }) };
}
