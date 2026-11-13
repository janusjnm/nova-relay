# 配置参考

位置：`$NOVA_RELAY_CONFIG`，默认 `~/.config/nova-relay/config.json`。纯 JSON。启动时完整校验，任何错误都会带字段路径列出并以退出码 3 拒绝运行（`nova-relay config-check`）。**任何一层出现未知的键都是错误**（顶层、`hosts.*`、`limits`、`guard`、`routing`、`routing.rules[*]`、`webhook`、`projects.*`、`executors.*` 按适配器），拼写错误不会悄悄回落到更弱的默认值（例如 `forbiden_paths`、`protected_branch`、`budgt`）。以 `_` 或 `$` 开头的键视为注释（如 `"_comment": "..."`）。完整示例：[config/nova-relay.example.json](../config/nova-relay.example.json)。

## 顶层

| 字段 | 默认 | 说明 |
|---|---|---|
| `schema` | `1` | 配置版本；比本程序新则拒绝 |
| `self` | `"local"` | 本机在 `hosts` 中的名字；可被 `NOVA_RELAY_HOST` 覆盖 |
| `coordinator` | `self` | 保存批次视图并发送 webhook 的主机（建议常开的 VPS） |
| `home` | `~/.nova-relay` | 任务库目录；可被 `NOVA_RELAY_HOME` 覆盖（测试套件会剥离该变量，见 README「开发」） |
| `display_tz` | `Asia/Singapore` | 报告显示时区（内部一律 UTC） |
| `hosts.<name>.ssh` | — | 远端主机必填：Tailscale MagicDNS 名或 ssh 别名 |
| `hosts.<name>.bin` | `nova-relay` | 远端 nova-relay 路径 |
| `hosts.<name>.role` | — | `box` / `vps`（其他值校验失败）；`claude` 只能在 `role: box` 的主机上 |
| `hosts.<name>.preflight_cmd` | — | 每段前执行的网络检查命令（如 `tailscale status --peers=false`），失败按网络错误退避。异步运行（≤120 s，超时算失败），期间租约照常续期；取消任务会杀掉它且不记录结论 |
| `webhook` | — | 全局默认 webhook（`url_env`、`key_env`），项目可覆盖 |
| `isolation` | `{"mode":"off"}` | 可选的**操作系统级进程隔离**（bubblewrap），默认关闭、行为不变；见下文「`isolation`」 |

## `limits`（全局默认，可在 `executors.<name>.limits` 覆盖）

| 字段 | 默认 | 说明 |
|---|---|---|
| `segment_minutes` | 12 | 每段墙钟上限（建议 10–15） |
| `idle_timeout_sec` | 300 | 无任何输出超过此时长视为卡死 |
| `task_minutes` | 180 | 任务累计**运行**时间上限（分段实际运行时间之和；额度暂停、等待审批、box 睡眠不计入） |
| `max_segments` | 10 | 最大分段数 |
| `max_local_retries` | 3 | 验收 FAIL 后带错误重试次数 |
| `max_segment_failures` | 3 | 连续分段失败（崩溃/网络/卡死）超过此数 → failed 并立即唤醒 |
| `max_quota_pauses` | 6 | 单任务最多因额度暂停次数 |
| `quota_pause_minutes` | 60 | CLI 未给出重置时间时的暂停时长 |
| `lease_ttl_sec` | 120 | 租约 TTL（每 TTL/3 续租） |
| `heartbeat_miss_minutes` | 15 | 心跳超时阈值 |
| `min_free_mb` | 2048 | 最低可用磁盘 |
| `retention_days` | 7 | ack 后保留任务目录的天数 |
| `max_log_bytes` | 2 MiB | 每段日志上限 |
| `max_parallel` | 2 | 每执行者并发任务数（每台主机只有一个 worker 进程，由主机租约保证） |
| `notify_cooldown_minutes` | 60 | 同一事故的唤醒合并窗口：同一批次里多个任务因**同一执行者级原因**被 `blocked`（CLI 参数、模型 id、守卫失效、严格隔离不可用、磁盘）或因网络反复失败而升级，只唤醒一次；同一主机对同一批次的 `<host>_unreachable` 两次通知之间至少隔这么久（链路抖动不会每次都唤醒）。第一次唤醒总是立即发出 |

## `executors.<name>`

公共字段：`adapter`（`claude` / `codex` / `pi` / `deepseek-text`）、`host`、`bin`、`model`、`min_version`、`args`（附加参数）、`env`（附加环境变量）、`budget`、`limits`、`preflight_cmd`、`credential_files`（覆盖凭据文件检查）。

`budget`（按 UTC 日）：`segments_per_day`、`minutes_per_day`、`tokens_per_day`、`cost_usd_per_day`。超出 → 执行者暂停到下一个 UTC 零点。

用量与上限的含义（`nova-relay stats` 可查看）：

- `segments`、`minutes` 由 nova-relay 自己计量，总是已知。`tokens`、`cost_usd` 只记录**提供方实际报告的数字**（Claude Code stream-json `result` 事件里的 `total_cost_usd` 与 `usage.*_tokens`；DeepSeek 的 `usage.total_tokens`；Codex `turn.completed` 的 `usage`）。没有报告的分段记为**未知**（`*_unknown` 计数），**不会当作 0**；nova-relay 不估价、不把 token 换算成美元。`tokens` 是已报告的 token 字段之和（Claude：input + output + cache_creation + cache_read）。
- 订阅 CLI（Claude Code、Codex）报告的 token/费用**不是账单**，也**不是剩余订阅额度**。
- 上限在**新分段开始前**检查：`segments_per_day` 在预检时原子地占用本分段的名额，并行任务不会超出；`minutes`/`tokens`/`cost_usd` 只有分段结束后才知道，**已在运行的分段可能超出上限**——这不是精确的硬性计费上限。`tokens_per_day`/`cost_usd_per_day` 只和已报告的数字比较；某执行者当天从未报告过该数字时，该上限无法执行（`doctor`、`stats` 会警告）。

`limits`、`executors.<name>.limits`、`budget` 以及其他各层里**未知的键**（拼写错误，如 `segment_minuts`），与 `projects.<P>.executors` 里不存在的执行者，都会让配置校验失败，而不是悄悄回落到默认值。执行者只接受公共字段加上本适配器的字段（下表），例如给 `codex` 写 `permission_mode` 会报错。

| adapter | 额外字段 | 固定行为 |
|---|---|---|
| `claude` | `permission_mode`（默认 `acceptEdits`，禁止 `bypassPermissions`）、`setting_sources`（默认 `user`）、`allowed_tools`、`disallowed_tools`（默认禁 WebFetch/WebSearch）、`allow_web`、`fresh_session_every`（默认 4）、`min_version`（默认 `2.0.0`） | `claude --print <prompt> --output-format stream-json --verbose --permission-mode … --settings <PreToolUse hook> --setting-sources user --strict-mcp-config --allowedTools … --disallowedTools … --session-id <uuid>`（续段用 `--resume <uuid>`）；剔除 `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`/`CLAUDE_CODE_OAUTH_TOKEN`；禁止 `--bare`、`--dangerously-skip-permissions` |
| `codex` | `sandbox`（`workspace-write` 默认或 `read-only`；其他值被拒绝） | `codex exec --json --sandbox … --cd <worktree> --skip-git-repo-check --ignore-user-config --ignore-rules --output-last-message <file> [--model …] <prompt>`：不读 `~/.codex/config.toml`（其中的 MCP 服务器可能发消息、配置可能放宽沙箱；登录仍用 `CODEX_HOME` 里的凭据，所以 `model` 等请写在本配置里）、不读 execpolicy `.rules`、不加 `--trust`（仓库里的 `.codex/` 配置不生效）；剔除 `OPENAI_API_KEY/BASE_URL`、`CODEX_API_KEY`；禁止 `--dangerously-*`/`--yolo`/`--trust`/`--add-dir`/开启网络的覆盖；每段新会话 + 进度摘要；`--json` 事件用于事后审计 |
| `pi` | `provider`（默认 `deepseek`）、**`model`（必填，无默认值）**、`key_env`（`DEEPSEEK_API_KEY`；若改名，会以 `DEEPSEEK_API_KEY` 的名字传给 pi）、`tools`、`thinking` | `pi --print <prompt> --provider … --model <model> --tools … --no-session --no-extensions --no-approve --no-mcp --extension extensions/nova-guard.ts`：只加载 nova-guard（全局/自动发现的扩展可能在守卫放行后改写工具参数）、不加载仓库 `.pi/` 下需信任的资源、无 MCP 工具；`args` 里出现 `-e/--extension`、`-a/--approve`、`--model/--models/--provider` 会校验失败 |
| `deepseek-text` | `endpoint`（必须 https）、**`model`（必填，无默认值）**、`key_env`、`max_tokens`、`timeout_sec` | 单次 chat-completions 调用，无 shell、无文件访问 |

### 模型名（pi / deepseek-text）

- `model` **必须显式填写**，nova-relay 不内置、不猜测、也不从 pi 的内置模型目录里取默认值（pi 的目录不代表 DeepSeek 实际提供哪些模型）。示例配置里是占位符 `<DEEPSEEK_MODEL_ID>`，不改就无法通过 `config-check`。
- 配置校验：缺失、占位符（`<…>`）、含空格/通配符等非法字符 → 报错并拒绝运行。pi 的 `--model` 接受"模式"并把 `id:<级别>` 解释为思考级别，所以 pi 的 `model` 里不允许 `:`（思考级别请用 `thinking` 字段）。
- `nova-relay doctor --live` 会调用 DeepSeek `GET /models`，配置的 id **必须原样出现在列表里**；列表读不到也算 FAIL（"未核验"），不会当作通过。
- 运行中供应商返回"模型不存在"（如 `Model Not Exist`、`invalid model`）→ 任务 `blocked` 并唤醒，不重试、**不换用其他模型 id**。请从 `GET /models` 的结果中选一个 id 写进配置。

### 参数核验情况

| 执行者 | 核验方式 | 结论 |
|---|---|---|
| claude | 本机 Claude Code 2.1.308 的 `claude --help`，并实跑一次：构造出的完整参数被接受、PreToolUse hook 经 `--settings` 生效并拦下 `git push origin main`、`--session-id` 后 `--resume` 同一会话成功、`claude auth status --json` 返回 `authMethod: "claude.ai"` | ✅ 已验证 |
| codex | 在临时目录安装 codex-cli 0.169.0（未登录、无 key）：用到的每个参数都在真实的 `codex exec --help` 里（快照见 `tests/fixtures/cli/`，契约测试对照它）；未登录时实跑一次，`--json` 输出 `thread.started`/`turn.started`/`error`/`item.completed`/`turn.failed`，与 `@openai/codex-sdk` 的 `ThreadEvent` 类型一致（`item.*` 的 `command_execution.command` 为字符串、`file_change.changes[].path`、`mcp_tool_call`）；同一 item 会先后出现在 `item.started` 与 `item.completed`，审计按 id 去重；`Reconnecting… n/5` 的 `error` 事件是重试中的临时错误，不参与失败分类；`codex login status` 未登录时输出 `Not logged in`、退出码 1 | ✅ 参数与事件信封已实机核验；登录后真实执行命令的事件 🟡 |
| pi | 在临时目录安装 pi 1.5.2（`@earendil-works/pi-coding-agent`），用本地模拟的 DeepSeek 接口（`~/.pi/agent/models.json` 覆盖 `baseUrl`）端到端实跑适配器构造的完整命令：扩展被加载并写出 `guard-loaded`，模型发起的 `git push origin main` 被拦下并生成审批，普通命令照常执行；去掉 `--no-extensions --no-approve` 时，全局与仓库 `.pi/extensions` 下的扩展都会被加载（能改写已放行的命令），加上后都不加载；无效 key 时输出 `401: {…authentication_error…}`（归类为 auth） | ✅ 已实机验证（用真实 DeepSeek key 的实跑 🟡） |
| deepseek | DeepSeek 官方 API：`POST /chat/completions`、`GET /user/balance`、`GET /models`（`doctor --live` 检查 key 与 `model` 是否在列表里） | 🟡 文档核验；本仓库**没有**用真实 key 核实过任何模型 id，模型名只以你自己的 `doctor --live`（`GET /models`）为准 |

无论哪种，运行前 preflight 都会对真实安装的 CLI 执行 `--version` ≥ `min_version` 和"`--help` 中包含全部必需参数"的检查（按版本缓存 1 小时），不满足则任务 `blocked` 并唤醒。

## `isolation`（可选，默认关闭）

```json
"isolation": { "mode": "strict", "adapter": "bwrap", "apply_to": ["acceptance", "executor"], "acceptance_network": false, "ro_binds": [] }
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `"off"` | `off`：不包装任何进程，行为与之前完全相同。`strict`：`apply_to` 里的步骤**只能**在 bubblewrap 里运行；bwrap 不存在、探测失败（如禁用了非特权 user namespace）、适配器没有隔离配置、或某个路径无法安全绑定 → 该步骤**不运行**，任务 `blocked` 并唤醒（同一原因合并为一次）。**绝不退回到无隔离运行** |
| `adapter` | `"bwrap"` | 目前唯一的适配器；其他值是配置错误 |
| `apply_to` | `["acceptance","executor"]` | `acceptance`：验收命令（含 `acceptance_setup`、文本任务的验收命令、`nova-relay accept`）。`executor`：agent 执行者的分段进程。本版本只有 `claude` 适配器有执行者隔离配置；`codex`/`pi` 在 strict + `executor` 下会 fail closed（`blocked`）。`deepseek-text` 是进程内的 HTTP 调用，没有子进程可隔离 |
| `acceptance_network` | `false` | strict 验收默认 `--unshare-net`（无网络）。需要网络的 `acceptance_setup`（`npm ci` 等）会 `FAIL setup`（错误里注明是隔离导致无网络），不会悄悄联网；`doctor` 对有 `acceptance_setup` 的项目给出 WARN。设为 `true` 是显式选择：验收有网络（并绑定只读 DNS/CA 文件），仍然不挂载 HOME 与密钥 |
| `ro_binds` | `[]` | 额外只读绑定的绝对路径（工具链，如 `/opt/go`）。拒绝：`/`、HOME 本身或其祖先、nova-relay home、`secrets.env`、凭据/密钥目录（`~/.ssh`、`~/.config/nova-relay`、`~/.claude`、`~/.codex`、`~/.aws`、`~/.npmrc` …）及其祖先 |

严格配置（profile）：新的 user/pid/uts/ipc namespace、`--die-with-parent`、`--new-session`；只读 `/usr`（及主机上的 `/bin`、`/lib*`、`/sbin`）和少量 `/etc` 文件（passwd、group、ld.so 缓存；有网络时才加 resolv.conf 与 CA 证书）；私有 tmpfs `/tmp`；HOME 路径上是私有 tmpfs（主机 HOME 里的东西都看不到）；运行 nova-relay 的 node 安装目录只读（并追加到 PATH）。可写的只有本步骤的工作区：

- 验收：独立临时 clone 及其空 HOME；共享仓库的 git 目录只读（clone 是 `--shared`）。文本任务的验收命令在私有 HOME 里运行，`result.md` 只读，任务目录其他文件不可见。
- 执行者（claude）：任务 worktree 与它私有的 git 目录（`.git/worktrees/<id>`）可写，共享 `.git` 只读（执行者在沙箱里不能创建提交对象；分段结束后由 nova-relay 在沙箱外 checkpoint）；任务目录里**只有** `hook-calls` 与 `approvals.jsonl` 两个文件可写；`~/.claude` 只读**绑定**（不是复制；`~/.claude.json` 存在时也只读绑定）、CLI 二进制只读、nova-relay 包目录只读（hook 脚本）。**不隔离网络**（订阅登录需要访问 Anthropic）。`~/.claude` 只读，会话记录无法保存，所以 strict 下每个分段都开新会话（只带进度摘要，不 `--resume`）。

注意：只绑定 `bin` 解析后的那**一个文件**。本机的 `~/.local/bin/claude` 若是 `exec "$HOME/.local/bin/claude.real"` 之类的包装脚本，在沙箱里会找不到真正的程序（分段失败，不会退回无隔离运行）；`doctor` 会对脚本形式的 `bin` 给出 WARN，请把 `executors.claude.bin` 设为 `readlink -f` 得到的真实二进制的绝对路径。安全含义与局限见 [security.md](security.md)「进程隔离（可选）」。

## `routing`

```json
{ "rules": [ { "type": "long-code", "executor": "claude", "fallback": ["codex"] } ], "default": "pi" }
```

选择顺序：任务书 `executor:` 显式指定 → 按 `type` 匹配规则 → `default`。派发时主执行者处于暂停（额度/登录/预算）就按 `fallback` 顺序改路由；全部暂停则留在主执行者上等待（`paused`）。项目可用 `projects.<P>.executors` 白名单限制可用执行者。

`reroute_paused`（默认 `"off"`）：**已在运行**的任务碰到额度/预算暂停时，是否在分段边界改用 fallback：

| 值 | 行为 |
|---|---|
| `off` | 不改路由，任务 `paused` 到重置时间后继续 |
| `same-host` | 只改到同一主机上的 fallback：原地切换执行者，worktree、checkpoint 提交、`progress.md` 都保留 |
| `any` | 也可以跨主机：用 `git bundle` 把任务分支 `nova/<id>` 交给目标主机（目标主机本地 `git fetch` 这个文件，不是 push），连同任务书与进度摘要；目标仓库缺少 base 提交时退化为"从 base 重新开始 + 进度摘要"。原主机上的任务变为 `moved` |

限制：任务书显式写了 `executor:` 的不改路由；只改到同类（agent↔agent，text↔text）且项目白名单允许的执行者；每个任务最多改路由 2 次。登录失效（`needs_auth`）不改路由。

## `projects.<P>`

| 字段 | 说明 |
|---|---|
| `repo` | 绝对路径，或按主机 `{ "box": "...", "vps": "..." }`；不同项目的 repo / worktree 根目录不能互相包含 |
| `worktrees` | 任务 worktree 根目录（默认 `<home>/worktrees/<P>`）；不能位于其他项目的 repo 或 worktree 根目录内 |
| `base` | 基准分支（默认 `main`）；任务分支 `nova/<task-id>` 从这里切出，nova-relay 从不向它推送或合并 |
| `owner` | Grok Bot 标识，用于 `pending/ack/approve --owner` |
| `env_file` | 项目私有 env，**必须 0600**（否则任务 `blocked`），只注入本项目任务与验收命令，值也会被脱敏 |
| `webhook` | `{ "url_env": "...", "key_env": "..." }` —— 只写**变量名** |
| `checks` | 每个任务都要跑的验收命令（追加在任务书验收命令之后） |
| `acceptance_setup` | 可选：验收前在**干净检出**（独立的临时 clone）里先跑的命令（如 `npm ci`、`pip install -e .`）。验收不在执行者的 worktree 里跑，被 gitignore 的依赖目录不存在，需要在这里装。HOME 是空的（没有 `~/.npmrc`、没有包缓存），所以通常需要网络；失败 → `FAIL setup:<命令>: …`，任务 `failed` 并唤醒，**不**交给执行者重试。想复用主机缓存可在 `acceptance_env_pass` 里传 `npm_config_cache`、`PIP_CACHE_DIR`、`GOMODCACHE` 等。setup 里的 git 命令（如 husky 的 `git config core.hooksPath`）只影响临时 clone |
| `acceptance_env_pass` | 可选：额外传给验收命令的主机环境变量名（如 `GOCACHE`、`GOMODCACHE`、`npm_config_cache`、`PIP_CACHE_DIR`、`PIP_INDEX_URL`）。看起来像密钥的名字（`*_KEY`、`*_TOKEN`、`SECRET`…）和配置里声明的密钥变量名（`webhook.url_env/key_env`、执行者 `key_env`）会被配置校验拒绝；`secrets.env` 里的名字即使列出也不会传入；项目密钥请放 `env_file` |
| `harness_paths` | 可选：额外的"验收/测试框架"文件 glob；改动它们 = 篡改（见 security.md） |
| `forbidden_paths` | 任何任务都不能改的 glob（默认 `.git/**`、`.github/workflows/**`、`**/.env`、`**/.env.*`） |
| `executors` | 可选，执行者白名单 |

## `guard`

| 字段 | 默认 | 说明 |
|---|---|---|
| `protected_branches` | `["main","master","release/*"]` | 推送目标属于这些分支时额外标注（任何 push 都会被拦截）；本地移动这些分支（`update-ref`、`branch -f/-D`、`fetch . x:main`、`checkout -B main`）也会被拦截 |
| `allow_hosts` | `[]` | `curl/wget` 只读 GET 允许访问的主机（如包仓库） |

## 任务书（brief）

```markdown
---
type: code          # 路由键
project: PD         # 可选；与 dispatch --project 不一致则拒绝
executor: claude    # 可选；显式指定
allow_empty_diff: false
allow_harness_changes: false   # true = 本任务本来就要改测试框架/验收脚本/package.json scripts
---
# Goal         一段话，可观测的"完成"标准
# Scope        - 仓库相对 glob（不允许绝对路径、..、~、$）
# Acceptance   每行一条命令，全部 exit 0 才算通过
# Forbidden    - 额外禁止事项
# Context      可选背景
```

`allow_harness_changes: true` 只放开"框架文件被改"和"测试用例数减少"两项检查；删除测试文件、新增 skip/only、符号链接、`.git` 篡改仍然失败。

标题也接受中文：目标 / 范围 / 验收 / 禁止 / 背景。`nova-relay brief-template` 打印模板。text 类任务（路由到 deepseek-text）只需要 Goal。
