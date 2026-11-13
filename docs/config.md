# 配置参考

位置：`$NOVA_RELAY_CONFIG`，默认 `~/.config/nova-relay/config.json`。纯 JSON。启动时完整校验，任何错误都会带字段路径列出并以退出码 3 拒绝运行（`nova-relay config-check`）。完整示例：[config/nova-relay.example.json](../config/nova-relay.example.json)。

## 顶层

| 字段 | 默认 | 说明 |
|---|---|---|
| `schema` | `1` | 配置版本；比本程序新则拒绝 |
| `self` | `"local"` | 本机在 `hosts` 中的名字；可被 `NOVA_RELAY_HOST` 覆盖 |
| `coordinator` | `self` | 保存批次视图并发送 webhook 的主机（建议常开的 VPS） |
| `home` | `~/.nova-relay` | 任务库目录；可被 `NOVA_RELAY_HOME` 覆盖 |
| `display_tz` | `Asia/Singapore` | 报告显示时区（内部一律 UTC） |
| `hosts.<name>.ssh` | — | 远端主机必填：Tailscale MagicDNS 名或 ssh 别名 |
| `hosts.<name>.bin` | `nova-relay` | 远端 nova-relay 路径 |
| `hosts.<name>.role` | — | `box` / `vps`；`claude` 只能在 `role: box` 的主机上 |
| `hosts.<name>.preflight_cmd` | — | 每段前执行的网络检查命令（如 `tailscale status --peers=false`），失败按网络错误退避 |
| `webhook` | — | 全局默认 webhook（`url_env`、`key_env`），项目可覆盖 |

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

## `executors.<name>`

公共字段：`adapter`（`claude` / `codex` / `pi` / `deepseek-text`）、`host`、`bin`、`model`、`min_version`、`args`（附加参数）、`env`（附加环境变量）、`budget`、`limits`、`preflight_cmd`、`credential_files`（覆盖凭据文件检查）。

`budget`（按 UTC 日）：`segments_per_day`、`minutes_per_day`、`tokens_per_day`、`cost_usd_per_day`。超出 → 执行者暂停到下一个 UTC 零点。

| adapter | 额外字段 | 固定行为 |
|---|---|---|
| `claude` | `permission_mode`（默认 `acceptEdits`，禁止 `bypassPermissions`）、`setting_sources`（默认 `user`）、`allowed_tools`、`disallowed_tools`（默认禁 WebFetch/WebSearch）、`allow_web`、`fresh_session_every`（默认 4）、`min_version`（默认 `2.0.0`） | `claude --print <prompt> --output-format stream-json --verbose --permission-mode … --settings <PreToolUse hook> --setting-sources user --strict-mcp-config --allowedTools … --disallowedTools … --session-id <uuid>`（续段用 `--resume <uuid>`）；剔除 `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`/`CLAUDE_CODE_OAUTH_TOKEN`；禁止 `--bare`、`--dangerously-skip-permissions` |
| `codex` | `sandbox`（默认 `workspace-write`；`danger-full-access` 被拒绝） | `codex exec --json --sandbox … --cd <worktree> --skip-git-repo-check --output-last-message <file> [--model …] <prompt>`；剔除 `OPENAI_API_KEY/BASE_URL`、`CODEX_API_KEY`；禁止 `--dangerously-bypass-approvals-and-sandbox`/`--yolo`/开启网络的覆盖；每段新会话 + 进度摘要；`--json` 事件用于事后审计 |
| `pi` | `provider`（默认 `deepseek`）、`model`（默认 `deepseek-chat`，**未经实机验证**，请用 `pi --list-models` 或 pi 文档确认）、`key_env`（`DEEPSEEK_API_KEY`；若改名，会以 `DEEPSEEK_API_KEY` 的名字传给 pi）、`tools`、`thinking` | `pi --print <prompt> --provider … --model … --tools … --no-session --extension extensions/nova-guard.ts`；禁止 `--no-extensions` |
| `deepseek-text` | `endpoint`（必须 https）、`model`、`key_env`、`max_tokens`、`timeout_sec` | 单次 chat-completions 调用，无 shell、无文件访问 |

### 参数核验情况

| 执行者 | 核验方式 | 结论 |
|---|---|---|
| claude | 本机 Claude Code 2.1.308 的 `claude --help`，并实跑一次：构造出的完整参数被接受、PreToolUse hook 经 `--settings` 生效并拦下 `git push origin main`、`--session-id` 后 `--resume` 同一会话成功、`claude auth status --json` 返回 `authMethod: "claude.ai"` | ✅ 已验证 |
| codex | 官方 CLI 参考（`codex exec` 的 `--cd/-C`、`--sandbox/-s`、`--skip-git-repo-check`、`--output-last-message/-o`、`--json`、`--model/-m`；`codex login status` 有凭据时退出码 0） | 🟡 文档核验，本机未安装；`--json` 事件字段（`item.completed` + `command_execution`/`file_change`）按文档/源码习惯解析，未实机验证 |
| pi | 官方 CLI 参考 pi.dev/docs/latest/cli.md（`--print`、`--provider`、`--model`、`--tools`、`--no-session`、`--extension`）与扩展文档（`tool_call` 事件 `{toolName,input}`，返回 `{block,reason}`；内置 deepseek 读 `DEEPSEEK_API_KEY`） | 🟡 文档核验，本机未安装 |
| deepseek | DeepSeek 官方 API：`POST /chat/completions`、`GET /user/balance`（`doctor --live`） | 🟡 文档核验 |

无论哪种，运行前 preflight 都会对真实安装的 CLI 执行 `--version` ≥ `min_version` 和"`--help` 中包含全部必需参数"的检查（按版本缓存 1 小时），不满足则任务 `blocked` 并唤醒。

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
| `forbidden_paths` | 任何任务都不能改的 glob（默认 `.git/**`、`.github/workflows/**`、`**/.env`、`**/.env.*`） |
| `executors` | 可选，执行者白名单 |

## `guard`

| 字段 | 默认 | 说明 |
|---|---|---|
| `protected_branches` | `["main","master","release/*"]` | 推送目标属于这些分支时额外标注（任何 push 都会被拦截） |
| `allow_hosts` | `[]` | `curl/wget` 只读 GET 允许访问的主机（如包仓库） |

## 任务书（brief）

```markdown
---
type: code          # 路由键
project: PD         # 可选；与 dispatch --project 不一致则拒绝
executor: claude    # 可选；显式指定
allow_empty_diff: false
---
# Goal         一段话，可观测的"完成"标准
# Scope        - 仓库相对 glob（不允许绝对路径、..、~、$）
# Acceptance   每行一条命令，全部 exit 0 才算通过
# Forbidden    - 额外禁止事项
# Context      可选背景
```

标题也接受中文：目标 / 范围 / 验收 / 禁止 / 背景。`nova-relay brief-template` 打印模板。text 类任务（路由到 deepseek-text）只需要 Goal。
