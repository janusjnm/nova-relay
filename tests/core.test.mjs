// core.test.mjs — util, leases, store journal/migration, failure classification, budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtLocal, globToRegExp, redact, scopesOverlap, writeJsonAtomic } from "../lib/util.mjs";
import { acquireLease, leaseStatus, readLease, releaseLease, renewLease } from "../lib/lock.mjs";
import { Store, migrate } from "../lib/store.mjs";
import { classifyFailure, parseReset } from "../lib/executors/index.mjs";
import { addUsage, overBudget, pauseExecutor, readPaused, unpauseExecutor } from "../lib/budget.mjs";
import { parseBrief, validateBrief } from "../lib/brief.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "nova-core-"));

test("display time is Asia/Singapore, storage is UTC", () => {
  assert.equal(fmtLocal("2026-01-01T00:00:00.000Z"), "2026-01-01 08:00:00 Asia/Singapore");
  assert.equal(fmtLocal("2026-01-01T00:00:00Z", "UTC"), "2026-01-01 00:00:00 UTC");
});

test("redact removes keys, tokens, bearer values and env secrets", () => {
  const s = redact("sk-abcdefghijklmnopqrstuvwx ghp_abcdefghijklmnopqrstuvwxyz0123 Authorization: Bearer abc.def.ghi123 mysecretvalue!", ["mysecretvalue!"]);
  assert.doesNotMatch(s, /sk-abc|ghp_abc|abc\.def|mysecretvalue/);
  assert.match(s, /Bearer \[REDACTED\]/);
});

test("globs and scope overlap", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/.env").test("a/b/.env"));
  assert.ok(globToRegExp("src/api").test("src/api/x.ts"), "bare dir covers children");
  assert.ok(scopesOverlap(["src/api/**"], ["src/**"]));
  assert.ok(!scopesOverlap(["src/api/**"], ["src/ui/**"]));
  assert.ok(scopesOverlap([], ["src/ui/**"]), "unknown scope = whole repo");
});

test("atomic write never leaves partial files", () => {
  const d = tmp();
  writeJsonAtomic(join(d, "a.json"), { x: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(d, "a.json"), "utf8")), { x: 1 });
});

test("lease: exclusive, idempotent, stale lease stolen exactly once", () => {
  const d = tmp();
  const p = join(d, "lease.json");
  const a = acquireLease(p, "w1", 60_000);
  assert.ok(a);
  assert.ok(acquireLease(p, "w1", 60_000), "same owner+pid re-acquire is idempotent");
  assert.equal(acquireLease(p, "w2", 60_000), null, "held lease cannot be taken");
  assert.ok(renewLease(p, "w1", 60_000));
  assert.equal(renewLease(p, "w2", 60_000), false);
  releaseLease(p, "w1");
  assert.ok(!existsSync(p));
  // Stale: dead pid on this host, expired.
  writeFileSync(p, JSON.stringify({ owner: "dead", host: readHost(), pid: 999999, ttl_ms: 1000, expires_at: new Date(Date.now() - 5000).toISOString() }));
  assert.equal(leaseStatus(readLease(p)), "stale");
  const results = [acquireLease(p, "w3", 60_000), acquireLease(p, "w4", 60_000)];
  assert.equal(results.filter(Boolean).length, 1, "two watchdogs: only one resume wins");
});

test("lease: expired but holder alive = frozen, not stolen by default", () => {
  const d = tmp();
  const p = join(d, "lease.json");
  writeFileSync(p, JSON.stringify({ owner: "me", host: readHost(), pid: process.pid, ttl_ms: 1000, expires_at: new Date(Date.now() - 5000).toISOString() }));
  assert.equal(leaseStatus(readLease(p)), "frozen");
  assert.equal(acquireLease(p, "other", 60_000), null);
});

function readHost() { return require_hostname(); }
import { hostname } from "node:os";
function require_hostname() { return hostname(); }

test("store: corrupt state.json is rebuilt from the journal", () => {
  const s = new Store(tmp());
  s.create({ id: "t-1", batch: "b-1", project: "PD", executor: "claude", host: "box" }, "brief");
  s.update("t-1", { state: "running", segments: 2 });
  writeFileSync(join(s.dir("t-1"), "state.json"), "{ torn");
  const t = s.get("t-1");
  assert.equal(t.state, "running");
  assert.equal(t.segments, 2);
  assert.equal(JSON.parse(readFileSync(join(s.dir("t-1"), "state.json"), "utf8")).segments, 2);
});

test("store: create is idempotent; invalid ids refused", () => {
  const s = new Store(tmp());
  s.create({ id: "t-2", batch: "b" }, "x");
  s.update("t-2", { state: "running" });
  assert.equal(s.create({ id: "t-2", batch: "b" }, "x").state, "running");
  assert.throws(() => s.dir("../etc"));
});

test("schema migration: applies chain, refuses newer", () => {
  const migs = { 1: (o) => ({ ...o, renamed: o.old }), 2: (o) => ({ ...o, extra: true }) };
  const m = migrate({ schema: 1, old: 5 }, "state", 3, migs);
  assert.deepEqual([m.schema, m.renamed, m.extra], [3, 5, true]);
  assert.throws(() => migrate({ schema: 9 }, "state", 1), /newer nova-relay/);
});

test("classify executor failures", () => {
  assert.equal(classifyFailure("Claude AI usage limit reached|1900000000").kind, "quota");
  assert.equal(classifyFailure("Claude AI usage limit reached|1900000000").reset_at, new Date(1900000000 * 1000).toISOString());
  assert.equal(classifyFailure("You've hit your usage limit. Try again in 2h 30m").kind, "quota");
  assert.equal(classifyFailure("HTTP 429 Too Many Requests").kind, "quota");
  assert.equal(classifyFailure("Invalid API key · Please run /login").kind, "auth");
  assert.equal(classifyFailure("HTTP 402 Insufficient Balance").kind, "auth");
  assert.equal(classifyFailure("error: unknown option '--session-id'").kind, "cli");
  assert.equal(classifyFailure("prompt is too long: 220000 tokens").kind, "context");
  assert.equal(classifyFailure("TypeError: fetch failed (ENOTFOUND api)").kind, "network");
  assert.equal(classifyFailure("529 overloaded_error").kind, "network");
  assert.equal(classifyFailure("SyntaxError somewhere").kind, "error");
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseReset("try again in 1h 5m", now), "2026-01-01T01:05:00.000Z");
  assert.equal(parseReset("resets in 30 minutes", now), "2026-01-01T00:30:00.000Z");
});

test("budget ledger and executor pause", () => {
  const home = tmp();
  addUsage(home, "claude", { segments: 1, minutes: 12 });
  addUsage(home, "claude", { segments: 1, minutes: 12 });
  assert.equal(overBudget(home, "claude", { segments_per_day: 3 }), null);
  assert.match(overBudget(home, "claude", { minutes_per_day: 20 }), /minutes 24 >= 20/);
  const p1 = pauseExecutor(home, "claude", "quota", new Date(Date.now() + 60_000).toISOString());
  assert.equal(p1.fresh, true);
  assert.equal(pauseExecutor(home, "claude", "quota", p1.until).fresh, false, "same incident is not re-reported");
  assert.ok(readPaused(home).claude);
  pauseExecutor(home, "codex", "quota", new Date(Date.now() - 1000).toISOString());
  assert.equal(readPaused(home).codex, undefined, "expired pause is inactive");
  unpauseExecutor(home, "claude");
  assert.equal(readPaused(home).claude, undefined);
});

test("brief parsing and validation", () => {
  const b = parseBrief("---\ntype: code\nproject: PD\n---\n# 目标\nDo X\n# Scope\n- `src/**`\n# Acceptance\n```\nnpm test\n```\n# Forbidden\n- no API change\n");
  assert.deepEqual([b.type, b.project, b.goal, b.scope, b.acceptance, b.forbidden], ["code", "PD", "Do X", ["src/**"], ["npm test"], ["no API change"]]);
  assert.deepEqual(validateBrief(b), []);
  const bad = parseBrief("---\ntype: code\n---\n# Goal\nx\n# Scope\n- ../NM/src/**\n- /etc\n");
  const p = validateBrief(bad);
  assert.ok(p.some((m) => m.includes("../NM")));
  assert.ok(p.some((m) => m.includes("/etc")));
  assert.ok(p.some((m) => m.includes("Acceptance")));
  assert.deepEqual(validateBrief(parseBrief("---\ntype: text\n---\n# Goal\nTranslate\n")), []);
});
