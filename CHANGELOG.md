# Changelog

All notable changes to nova-relay. Dates are UTC. 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## [0.1.0] — unreleased (draft)

First release of **nova-relay**, a rewrite of the GAP / grokbot-and-pi fork (MIT, originally based on
robbin/grokbot-local-agent; see [NOTICE](NOTICE)). Not tagged or published yet.

### What it is

A small, config-driven relay between a planner and coding executors:

- **Planner**: Grok Bot on a Linux "box" that may sleep. It writes a templated task brief (goal,
  scope, acceptance commands, forbidden actions), runs `nova-relay dispatch`, and ends its turn. It is
  woken by a webhook once per finished batch (or for approval / auth / blocked / repeated failure),
  reads a one-line verdict, spot-checks, and `ack`s.
- **Executors** (pluggable adapters, routed by task type): official Claude Code CLI (`claude -p`,
  subscription login, box only, never `--bare`), official Codex CLI (`codex exec`, ChatGPT login,
  always-on VPS / mm01), Pi coding agent with a DeepSeek key, and plain DeepSeek chat for text-only
  jobs. No third-party API gateways.
- **Task store on disk** is the source of truth: `~/.nova-relay/tasks/<id>/` (brief, state, journal,
  events, progress, result). Leases with TTL, journal replay, outbox for host → coordinator reports
  and webhooks. Host-to-host calls go over `ssh` (Tailscale); nova-relay opens no ports.
- **Acceptance is the only truth**: the brief's commands plus project checks run in a clean checkout
  of the task branch commit and print `PASS` or `FAIL <where>`. The executor's self-report is ignored.
  Failed acceptance is retried locally with the error; tampering is fatal.
- **nova-guard** (formerly pi-guard), approval flow (`needs_approval` / `approve` / `deny`),
  per-executor daily budgets, quota pause and optional reroute, `doctor` (opt-in `--live`).

### Setup requirements that will break an unedited or older config

- **Explicit DeepSeek model ids.** `pi` and `deepseek-text` have no default `model`. The example
  config ships the placeholder `<DEEPSEEK_MODEL_ID>`, which fails `nova-relay config-check` until you
  replace it with an id from DeepSeek `GET /models`. `nova-relay doctor --live` checks that the id is
  listed verbatim; an unreadable list is a FAIL. nova-relay never substitutes another id. pi model ids
  may not contain `:` (pi reads it as a thinking-level suffix; use `thinking`).
- **`acceptance_setup` for projects whose checks need dependencies.** Acceptance runs in a standalone
  temporary clone of the task commit with an empty HOME, so gitignored `node_modules/`, virtualenvs
  and package caches do not exist there. Add e.g. `"acceptance_setup": ["npm ci --silent"]`. It
  usually needs network access; if it fails, the verdict is `FAIL setup:<cmd>: <last line>`, the task
  fails and wakes the planner, and the executor is *not* asked to "fix" it. Host caches can be passed
  with `acceptance_env_pass` (e.g. `npm_config_cache`, `PIP_CACHE_DIR`, `GOMODCACHE`). Secret-looking
  names and configured secret names are rejected there.
- **Unknown config keys are errors** at every level (top level, hosts, limits, guard, routing and
  rules, webhook, projects, executors per adapter), so a typo such as `forbiden_paths`,
  `protected_branch` or `budgt` cannot silently drop a protection. Keys starting with `_` or `$` are
  comments. `hosts.<h>.role` must be `box` or `vps`.
- **Secrets** come only from environment variables or `~/.config/nova-relay/secrets.env` (mode 0600,
  otherwise refused). Project `env_file`s must be 0600 as well.
- Node.js >= 22 and git >= 2.38 (`merge-tree --write-tree`). `install.sh` records the absolute node
  path so ssh and systemd (short PATH) work, and writes systemd units pointing at the bin directory
  actually used (`NOVA_RELAY_BIN_DIR`). It never overwrites an existing `config.json`, `secrets.env`,
  or a unit you edited (the new unit is written beside it as `<unit>.nova-new`).

### What it is designed to provide (checked by local tests)

- State on disk with atomic writes; a journal with sequence numbers replayed after a crash; one
  worker per host; leases stolen only under a lock with a re-check (two watchdogs cannot both resume
  a task); orphaned executor process groups killed, and confirmed dead, before a resume.
- Long acceptance runs, `preflight_cmd` and the CLI contract checks (`--version` / `--help`) do not
  starve lease renewal (they run asynchronously). A cancel or a lost lease during any of them kills
  the command and records no verdict, failure count, pause or cached contract result.
- Dispatch delivery is reconciled, not guessed. Batch entries start as `submitting` (not terminal,
  no wake). A submit that times out or loses its reply makes the host *fence* each id under the task
  lock: an existing task reports its real state; an absent id is tombstoned, so a late or retried
  submit is refused, and only that becomes `FAIL submit`. While the host is unreachable the batch
  stays WAIT (`ack` refused) and the coordinator tick keeps reconciling (10 minutes after the last
  submit attempt if the dispatcher itself died or slept). Those 10 minutes are a scheduling hint, not
  a correctness assumption: fence and create are serialized under the task lock, which is never taken
  from a live holder, so a dispatcher resuming after any gap either finds its task (delivered) or is
  refused (not delivered). Tested with a dispatcher that resumes days later.
- **Caller-supplied idempotency key**: `dispatch --key K` derives the batch and task ids from
  (project, owner, K). A retry with the same key returns or resumes the same batch (only entries
  still `submitting` are resubmitted, on the host/executor recorded at registration) and never
  creates a second one; the same key with different briefs is refused (exit 4) without dispatching.
  Without a key every call is a new batch, as before.
- **Machine-readable delivery outcomes**: `dispatch --json` and `batch --json` report, per task,
  `delivery` = `unknown` / `delivered` / `not_delivered` / `abandoned`, and a batch `status` =
  `unreconciled` / `in_progress` / `terminal` / `retired` with verdict PASS / FAIL / WAIT.
  `dispatch` exit status: 0 all delivered, 75 some delivery unknown (retry with the same key),
  1 some confirmed not delivered or abandoned, 4 key conflict. (Previously: exit 1 on any
  `submit error:`, even when the tasks turned out to be delivered.)
- **Explicit abandon**: `nova-relay abandon <batch> --host H --yes` ends one unreachable host's
  unresolved entries as `abandoned` (batch FAIL, one wake). It always warns that work on that host may
  still be running; a cancel is queued and only delivered if the host returns. Late reports for
  abandoned entries are recorded (`late`) but never change the entry or the verdict. Nothing is
  abandoned automatically. Without `--yes` it is a dry run.
- **Tombstones are permanent**: a fenced id stays fenced forever, and gc now leaves a tombstone
  for every task and batch it deletes (written before the delete, under the same lock), so a late or
  keyed-retry create of that id can never succeed. Tombstones are never garbage-collected.
- Short file locks and leases record the holder's process instance (pid, `/proc` start time, boot
  id) and are taken over only when that instance is provably gone: pid gone or reused, zombie, or an
  earlier boot. A live same-host holder is never displaced for being old (the previous 120 s
  timeout steal is gone; `acquireLease` no longer has a `stealFrozen` option). A dead holder's lock
  is stolen only by the racer that creates a per-instance steal token and re-reads the lock, so a
  racer with a stale view cannot move a live holder's lock aside. Checked with forced interleavings,
  a multi-process stress test with injected delays and killed holders, a SIGSTOPped holder, and
  pid-reuse / boot-id / zombie cases.
- Frozen workers: killed only after 3×TTL of observed non-renewal, and the task is re-queued only
  after the worker instance and the orphaned executor process group are confirmed dead. If that
  cannot be confirmed (no start time recorded, still alive after SIGKILL, or a process-group leader
  that died while group members still run) nothing is killed or replaced: the task stays `running`
  and `resume-all` lists it under `unconfirmed`.
- Bounded work: segment wall-clock and idle caps, task run-time cap, max segments, max local retries,
  max segment failures, max quota pauses, and daily budgets per executor. No infinite loops.
- Webhooks: payload is only `{source,batch,id,state,exit_code}`; URL and key come from env vars only;
  HTTPS or Tailscale addresses only; redirects are not followed; a dedup key per event; a durable
  outbox sent oldest first; no wake after `ack`; `ack` of an unfinished batch is refused; older
  reports never roll back a newer task state in the batch view.
- Executor environment hygiene: secret-looking names, every name in `secrets.env`, and every env name
  the config declares as a secret (webhook `url_env`/`key_env`, executor `key_env`) are withheld from
  executor and acceptance processes, and their values are redacted from logs and results.
- Acceptance isolation: a standalone clone, so git commands run by setup or tests change only that
  clone. It has a private TMPDIR and a PATH without relative or repo/worktree entries. The shared
  `.git` config/hooks/info and the task branch are re-checked after the commands. Tampering is fatal
  and never retried.

### What it does not do (non-guarantees)

- **No uptime guarantee and no zero-downtime claim.** nova-relay cannot wake or unfreeze a sleeping
  or suspended host: not ssh, not the watchdog, not the webhook. It *detects* an unreachable box,
  *notifies* once per outage (`box_unreachable`, which wakes the Grok routine, not the machine), and
  *resumes* tasks from the last checkpoint only after the box runs again and its own timer (or the
  watchdog) runs.
- **nova-guard is a heuristic, not a sandbox.** It parses commands, wrappers, directory changes and
  scripts, but deliberately obfuscated code can get past it. Acceptance runs code the executor wrote,
  as the same user: the empty HOME, private TMPDIR and standalone clone are defence in depth, and code
  can still read or write files by absolute path. Use containers or a separate system user for
  high-risk projects. Codex is audited after the fact, not blocked beforehand. Known gaps are listed
  in [docs/security.md](docs/security.md).
- Tamper checks do not detect weakened assertions; spot-check test diffs.
- **Fail closed means stalls, by design.** A same-host lock holder that is alive but stopped
  (SIGSTOP, suspend, debugger, uninterruptible sleep) is never stolen from: every update of that file
  waits and times out with an error naming the holder pid until it resumes or dies. A frozen worker
  whose death cannot be confirmed keeps its task `running`, and an idle frozen worker keeps the
  host's worker lease, so no task on that host starts. A human (or a definite death signal) has to
  resolve it. There is no flock/fcntl in Node core, so the kernel cannot release these locks.
- Locks and leases whose holder is on *another* host cannot be checked; they are still taken over by
  age (60 s for locks; 3×TTL past expiry for leases). nova-relay keeps them on local disk, so this
  only arises after a hostname change or on a shared filesystem, which is not supported.
- A batch whose task host never comes back stays `submitting` / WAIT; nothing marks it failed on a
  guess. Only an operator's `abandon` ends it, and that does not stop anything on the host.
- Tombstones (one small file plus a directory per fenced or gc'd task, one file per gc'd batch) are
  kept forever; the task directory count only grows.
- `dispatch` without `--key` is not idempotent: a blind retry creates a second batch.
- Not protected against disk loss or a host that never comes back.

### Verified vs. still to verify on real machines

- Verified locally: the full test suite (`npm test`, 166 tests); `install.sh` run twice into an
  isolated temporary HOME; Claude Code 2.1.308 flags and hook (live, earlier review); codex-cli 0.169.0
  and pi 1.5.2 flags/event envelopes against the real CLIs without login (fixtures in
  `tests/fixtures/cli/`).
- **Must be tested in place** (checklist at the end of [docs/failure-modes.md](docs/failure-modes.md)):
  real sleep / reboot / Tailscale loss and the resume timing after a human wakes the box; whether the
  Grok platform handles a `box_unreachable` webhook while the box is asleep; webhook delivery to the
  real Grok routine; a dispatch whose ssh session drops mid-submit (batch stays WAIT, then reconciles;
  with `--key`, exit 75 and a same-key retry resumes the same batch); `abandon` against a really
  unreachable host and the late cancel when it returns; `kill -STOP` on a running worker;
  Codex logged in (command events in the audit); pi with a real DeepSeek key and the
  model id you chose (`doctor --live`, then one small task); cross-host quota reroute over real ssh;
  `acceptance_setup` timing and network needs on your real projects.
