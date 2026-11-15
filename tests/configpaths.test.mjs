// Config/secrets path precedence (lib/paths.mjs): NOVA_RELAY_CONFIG / NOVA_RELAY_SECRETS, then an
// absolute $XDG_CONFIG_HOME, then $HOME/.config — the same directory install.sh writes to. Every
// install here goes into a temp HOME; nothing touches the operator's ~/.config or ~/.nova-relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfigError, configPath, loadConfig, loadSecrets, normalizeConfig, secretsPath } from "../lib/config.mjs";
import { normalizeIsolation, policyOf, unsafeBind } from "../lib/isolation.mjs";
import { isolatedEnv } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin", "nova-relay.mjs");

// Child env with no operator nova-relay vars and no inherited XDG_CONFIG_HOME.
function cleanEnv(extra = {}) {
  const env = isolatedEnv();
  delete env.XDG_CONFIG_HOME;
  return { ...env, ...extra };
}
const minimalConfig = (home) => `${JSON.stringify({ self: "vps", hosts: { vps: { role: "vps" } }, home }, null, 2)}\n`;
const mode = (p) => statSync(p).mode & 0o777;

test("paths: default is $HOME/.config/nova-relay when XDG_CONFIG_HOME is unset, blank or relative", () => {
  const home = "/h/u";
  for (const xdg of [undefined, "", "   ", "rel/cfg", "./cfg"]) {
    const env = { HOME: home, ...(xdg === undefined ? {} : { XDG_CONFIG_HOME: xdg }) };
    assert.equal(configPath(env), "/h/u/.config/nova-relay/config.json", `XDG_CONFIG_HOME=${JSON.stringify(xdg)}`);
    assert.equal(secretsPath(env), "/h/u/.config/nova-relay/secrets.env");
  }
});

test("paths: absolute XDG_CONFIG_HOME is used for both files; explicit overrides win, independently", () => {
  const env = { HOME: "/h/u", XDG_CONFIG_HOME: "/x/cfg" };
  assert.equal(configPath(env), "/x/cfg/nova-relay/config.json");
  assert.equal(secretsPath(env), "/x/cfg/nova-relay/secrets.env");
  const c = { ...env, NOVA_RELAY_CONFIG: "/etc/nr/c.json" };
  assert.equal(configPath(c), "/etc/nr/c.json");
  assert.equal(secretsPath(c), "/x/cfg/nova-relay/secrets.env", "NOVA_RELAY_CONFIG alone does not move secrets");
  const s = { ...env, NOVA_RELAY_SECRETS: "/etc/nr/s.env" };
  assert.equal(secretsPath(s), "/etc/nr/s.env");
  assert.equal(configPath(s), "/x/cfg/nova-relay/config.json", "NOVA_RELAY_SECRETS alone does not move config");
  // blank overrides are unset; a leading ~ is expanded against HOME (as NOVA_RELAY_SECRETS always was)
  assert.equal(configPath({ ...env, NOVA_RELAY_CONFIG: "  " }), "/x/cfg/nova-relay/config.json");
  assert.equal(secretsPath({ ...env, NOVA_RELAY_SECRETS: "~/s.env" }), "/h/u/s.env");
});

test("paths: relative NOVA_RELAY_CONFIG / NOVA_RELAY_SECRETS is a ConfigError, never cwd-relative", () => {
  for (const v of ["c.json", "./c.json", "../c.json", " /lead-space"]) {
    assert.throws(() => configPath({ HOME: "/h", NOVA_RELAY_CONFIG: v }), (e) => e instanceof ConfigError && /NOVA_RELAY_CONFIG.*absolute/.test(e.message), v);
    assert.throws(() => secretsPath({ HOME: "/h", NOVA_RELAY_SECRETS: v }), (e) => e instanceof ConfigError && /NOVA_RELAY_SECRETS.*absolute/.test(e.message), v);
  }
  assert.throws(() => loadSecrets({ HOME: "/h", NOVA_RELAY_SECRETS: "s.env" }), ConfigError);
  assert.throws(() => loadConfig(undefined, { HOME: "/h", NOVA_RELAY_CONFIG: "c.json" }), ConfigError);
});

test("paths: a missing file at the XDG location is not looked up in ~/.config (no mixing)", () => {
  const t = mkdtempSync(join(tmpdir(), "nova-cfgp-"));
  const home = join(t, "home"), xdg = join(t, "xdg");
  mkdirSync(join(home, ".config", "nova-relay"), { recursive: true });
  writeFileSync(join(home, ".config", "nova-relay", "config.json"), minimalConfig(join(t, "nh")));
  writeFileSync(join(home, ".config", "nova-relay", "secrets.env"), "NR_TEST_ONLY_X=1\n", { mode: 0o600 });
  const env = { HOME: home, XDG_CONFIG_HOME: xdg };
  assert.throws(() => loadConfig(undefined, env), (e) => e.message.includes(`config file not found: ${join(xdg, "nova-relay", "config.json")}`));
  const s = loadSecrets(env);
  assert.equal(s.path, join(xdg, "nova-relay", "secrets.env"));
  assert.equal(s.loaded, 0);
});

test("isolation: the bind policy protects the secrets file the CLI actually loads (XDG / override)", () => {
  const cfg = { home: "/nova-home" };
  assert.equal(policyOf({ cfg, env: { HOME: "/h", XDG_CONFIG_HOME: "/x/cfg" } }).secretsFile, "/x/cfg/nova-relay/secrets.env");
  assert.equal(policyOf({ cfg, env: { HOME: "/h", XDG_CONFIG_HOME: "/x/cfg", NOVA_RELAY_SECRETS: "/etc/nr/s.env" } }).secretsFile, "/etc/nr/s.env");
  const pol = policyOf({ cfg, env: { HOME: "/h", XDG_CONFIG_HOME: "/x/cfg" } });
  assert.match(unsafeBind("/x/cfg", pol), /secrets file/, "binding the custom XDG dir would expose secrets.env");
  // The resolved config dir is a credential path like ~/.config/nova-relay (regression: config.json was bindable).
  assert.equal(pol.configDir, "/x/cfg/nova-relay");
  assert.match(unsafeBind("/x/cfg/nova-relay/config.json", pol), /credential\/secret path \(\/x\/cfg\/nova-relay\)/);
  assert.match(unsafeBind("/x/cfg/nova-relay", pol), /secrets file|credential/);
  assert.match(unsafeBind(join(homedir(), ".config", "nova-relay", "config.json"), pol), /credential|secrets/, "default dir still refused");
  assert.equal(unsafeBind("/x/cfg/other", pol), null);
});

test("isolation: config ro_binds may not reach the custom XDG config dir (normalizeIsolation uses env)", () => {
  const env = { HOME: "/h", XDG_CONFIG_HOME: "/x/cfg" };
  for (const b of ["/x/cfg/nova-relay/config.json", "/x/cfg/nova-relay", "/x/cfg"]) {
    const p = [];
    normalizeIsolation({ ro_binds: [b] }, p, { novaHome: "/nova-home", env });
    assert.equal(p.length, 1, `${b}: ${JSON.stringify(p)}`);
  }
  const p = [];
  normalizeIsolation({ ro_binds: ["/opt/tools"] }, p, { novaHome: "/nova-home", env });
  assert.deepEqual(p, []);
  // and loadConfig/normalizeConfig pass the caller's env through
  const raw = { self: "vps", hosts: { vps: { role: "vps" } }, home: "/nova-home", isolation: { ro_binds: ["/x/cfg/nova-relay/config.json"] } };
  assert.throws(() => normalizeConfig(raw, env), (e) => e instanceof ConfigError && /ro_binds.*credential/.test(e.message));
});

// ------------------------------------------------------------------ CLI (old bug: XDG ignored)

function install(env, role = "vps") {
  return spawnSync("bash", [join(ROOT, "install.sh"), "--systemd", role], { env, encoding: "utf8" });
}

test("install + CLI with only HOME and a custom XDG_CONFIG_HOME: config-check, doctor and watchdog use <XDG>/nova-relay (regression)", () => {
  const t = mkdtempSync(join(tmpdir(), "nova cfgp-"));
  const home = join(t, "my home"), xdg = join(t, "x dg%cfg"), bin = join(t, "my bin"), prefix = join(t, "pre fix");
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: xdg, NOVA_RELAY_BIN_DIR: bin, NOVA_RELAY_PREFIX: prefix };
  const r = install(env);
  assert.equal(r.status, 0, r.stderr);
  const conf = join(xdg, "nova-relay", "config.json"), sec = join(xdg, "nova-relay", "secrets.env");
  assert.ok(existsSync(conf) && existsSync(sec));
  assert.equal(mode(sec), 0o600);
  assert.equal(existsSync(join(home, ".config", "nova-relay")), false, "nothing written under $HOME/.config");

  const cli = (args, extra = {}) => spawnSync(join(bin, "nova-relay"), args, { env: { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: xdg, ...extra }, encoding: "utf8" });
  // The untouched example is found (its placeholder error names the XDG file, not ~/.config).
  let c = cli(["config-check"]);
  assert.equal(c.status, 3);
  assert.ok(c.stderr.includes(`invalid nova-relay config ${conf}:`), c.stderr);
  assert.ok(!c.stderr.includes(join(home, ".config")), c.stderr);
  // After the operator edits it, config-check succeeds against the installed file.
  writeFileSync(conf, minimalConfig(join(t, "nova home")));
  c = cli(["config-check"]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stdout.trim(), `OK ${conf}`);
  const d = cli(["doctor", "--no-remote"]);
  assert.match(d.stdout, new RegExp(`config.*${conf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: self=vps`));
  assert.ok(d.stdout.includes(sec), d.stdout);
  const w = cli(["watchdog", "--json"]);
  assert.ok(!/config file not found/.test(w.stderr), w.stderr);
  assert.ok(existsSync(join(t, "nova home", "run", "watchdog.log")), "watchdog ran against the XDG config's home");
  // Without XDG_CONFIG_HOME the same HOME reads ~/.config, which does not exist: the error names it.
  const n = spawnSync(join(bin, "nova-relay"), ["config-check"], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
  assert.equal(n.status, 3);
  assert.ok(n.stderr.includes(join(home, ".config", "nova-relay", "config.json")));
  // An explicit absolute override still wins over XDG.
  const alt = join(t, "alt.json");
  writeFileSync(alt, minimalConfig(join(t, "alt home")));
  assert.equal(cli(["config-check"], { NOVA_RELAY_CONFIG: alt }).stdout.trim(), `OK ${alt}`);
  const rel = cli(["config-check"], { NOVA_RELAY_CONFIG: "alt.json" });
  assert.equal(rel.status, 3);
  assert.match(rel.stderr, /NOVA_RELAY_CONFIG="alt\.json": must be an absolute path/);
  const rels = cli(["config-check"], { NOVA_RELAY_SECRETS: "s.env" });
  assert.equal(rels.status, 3);
  assert.match(rels.stderr, /NOVA_RELAY_SECRETS="s\.env": must be an absolute path/);
});

test("CLI: relative or empty XDG_CONFIG_HOME is ignored (falls back to $HOME/.config)", () => {
  const t = mkdtempSync(join(tmpdir(), "nova-cfgp-"));
  const home = join(t, "home");
  mkdirSync(join(home, ".config", "nova-relay"), { recursive: true });
  const conf = join(home, ".config", "nova-relay", "config.json");
  writeFileSync(conf, minimalConfig(join(t, "nh")));
  mkdirSync(join(t, "rel", "nova-relay"), { recursive: true });
  writeFileSync(join(t, "rel", "nova-relay", "config.json"), "{ not json");
  for (const xdg of ["", "rel"]) {
    const c = spawnSync(process.execPath, [CLI, "config-check"], { cwd: t, env: cleanEnv({ HOME: home, XDG_CONFIG_HOME: xdg }), encoding: "utf8" });
    assert.equal(c.status, 0, `XDG_CONFIG_HOME=${JSON.stringify(xdg)}: ${c.stderr}`);
    assert.equal(c.stdout.trim(), `OK ${conf}`);
  }
});

// ------------------------------------------------------------------ install.sh

test("install.sh twice keeps edited config.json and secrets.env (default and custom XDG, custom PREFIX/BIN_DIR with spaces)", () => {
  for (const custom of [false, true]) {
    const t = mkdtempSync(join(tmpdir(), "nova inst2-"));
    const home = join(t, "h o m e");
    const base = custom ? join(t, "x d g") : join(home, ".config");
    const env = { PATH: process.env.PATH, HOME: home, NOVA_RELAY_BIN_DIR: join(t, "b i n"), NOVA_RELAY_PREFIX: join(t, "p r e"), ...(custom ? { XDG_CONFIG_HOME: base } : {}) };
    assert.equal(install(env, "box").status, 0);
    const conf = join(base, "nova-relay", "config.json"), sec = join(base, "nova-relay", "secrets.env");
    writeFileSync(conf, '{"_marker":"edited"}\n');
    writeFileSync(sec, "MARKER_KEY=keep\n", { mode: 0o600 });
    const r = install(env, "box");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept existing/);
    assert.equal(readFileSync(conf, "utf8"), '{"_marker":"edited"}\n', `custom=${custom}`);
    assert.equal(readFileSync(sec, "utf8"), "MARKER_KEY=keep\n");
    assert.equal(mode(sec), 0o600);
    const unit = readFileSync(join(base, "systemd", "user", "nova-relay-tick.service"), "utf8");
    assert.match(unit, new RegExp(`ExecStart="${join(t, "b i n")}/nova-relay" tick`));
    if (custom) assert.ok(unit.includes(`Environment="XDG_CONFIG_HOME=${base}"`), unit);
    else assert.ok(!/^Environment=/m.test(unit), "no Environment= line for the default config dir");
    const v = spawnSync(join(t, "b i n", "nova-relay"), ["version"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(v.status, 0, v.stderr);
  }
});

test("install.sh custom XDG: unit gets a quoted Environment=XDG_CONFIG_HOME, cron line sets it and quotes the binary", () => {
  const t = mkdtempSync(join(tmpdir(), "nova inst3-"));
  const xdg = join(t, "x dg%cfg"), bin = join(t, "my bin");
  const r = install({ PATH: process.env.PATH, HOME: join(t, "home"), XDG_CONFIG_HOME: xdg, NOVA_RELAY_BIN_DIR: bin });
  assert.equal(r.status, 0, r.stderr);
  const unit = readFileSync(join(xdg, "systemd", "user", "nova-relay-watchdog.service"), "utf8");
  // systemd: the whole assignment double-quoted, % doubled (specifier escape); it precedes ExecStart.
  assert.match(unit, new RegExp(`\\nEnvironment="XDG_CONFIG_HOME=${join(t, "x dg%%cfg")}"\\nExecStart="${bin}/nova-relay" watchdog`));
  const esc = (s) => s.replace(/ /g, "\\ ");
  const cron = r.stdout.split("\n").find((l) => l.includes("with cron instead"));
  // cron: shell-quoted, % escaped as \% (cron turns a bare % into a newline)
  assert.ok(cron.includes(`*/5 * * * * XDG_CONFIG_HOME=${esc(xdg).replace("%", "\\%")} ${esc(bin)}/nova-relay watchdog`), cron);
  assert.doesNotMatch(cron, /watchdog\s+>>/);
  // default XDG: no XDG_CONFIG_HOME in the cron line
  const t2 = mkdtempSync(join(tmpdir(), "nova inst4-"));
  const r2 = install({ PATH: process.env.PATH, HOME: join(t2, "home"), XDG_CONFIG_HOME: join(t2, "home", ".config") });
  assert.equal(r2.status, 0, r2.stderr);
  assert.doesNotMatch(r2.stdout, /XDG_CONFIG_HOME=/);
  assert.ok(!/^Environment=/m.test(readFileSync(join(t2, "home", ".config", "systemd", "user", "nova-relay-watchdog.service"), "utf8")));
});

test("install.sh refuses a relative XDG_CONFIG_HOME or NOVA_RELAY_CONFIG/SECRETS and creates nothing under cwd", () => {
  const t = mkdtempSync(join(tmpdir(), "nova inst5-"));
  const home = join(t, "home");
  for (const extra of [{ XDG_CONFIG_HOME: "rel" }, { NOVA_RELAY_CONFIG: "c.json" }, { NOVA_RELAY_SECRETS: "s.env" }]) {
    const r = spawnSync("bash", [join(ROOT, "install.sh")], { cwd: t, env: { PATH: process.env.PATH, HOME: home, ...extra }, encoding: "utf8" });
    assert.equal(r.status, 2, JSON.stringify(extra));
    assert.match(r.stderr, /not an absolute path/);
  }
  assert.equal(existsSync(join(t, "rel")), false);
  assert.equal(existsSync(home), false, "refused before any mkdir");
  // empty XDG_CONFIG_HOME falls back to $HOME/.config
  const r = spawnSync("bash", [join(ROOT, "install.sh")], { cwd: t, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, ".config", "nova-relay", "config.json")));
});
