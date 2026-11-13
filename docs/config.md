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
| `task_minutes` | 180 | 任务总墙钟上限 |
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
| `max_parallel` | 2 | 每执行者并发任务数 |

## `executors.<name>`

公共字段：`adapter`（`claude` / `codex` / `pi` / `deepseek-text`）、`host`、`bin`、`model`、`min_version`、`args`（附加参数）、`env`（附加环境变量）、`budget`、`limits`、`preflight_cmd`、`credential_files`（覆盖凭据文件检查）。

`budget`（按 UTC 日）：`segments_per_day`、`minutes_per_day`、`tokens_per_day`、`cost_usd_per_day`。超出 → 执行者暂停到下一个 UTC 零点。

| adapter | 额外字段 | 固定行为 |
|---|---|---|
| `claude` | `permission_mode`（默认 `acceptEdits`）、`allowed_tools`、`disallowed_tools`（默认禁 WebFetch/WebSearch）、`allow_web`、`fresh_session_every`（默认 4） | `claude --print … --output-format stream-json --verbose --settings <PreToolUse hook> --session-id/--resume`；剔除 `ANTHROPIC_*` 网关/API key 变量；禁止 `--bare` |
| `codex` | `sandbox`（默认 `workspace-write`） | `codex exec --sandbox … --cd <worktree> --skip-git-repo-check --output-last-message …`；剔除 `OPENAI_API_KEY/BASE_URL`；禁止沙箱绕过参数；每段新会话 + 进度摘要 |
| `pi` | `provider`（默认 `deepseek`）、`model`（`deepseek-chat`）、`key_env`（`DEEPSEEK_API_KEY`）、`tools`、`thinking` | `pi -p … --no-session -e extensions/nova-guard.ts` |
| `deepseek-text` | `endpoint`（必须 https）、`model`、`key_env`、`max_tokens`、`timeout_sec` | 单次 chat-completions 调用，无 shell、无文件访问 |

## `routing`

```json
{ "rules": [ { "type": "long-code", "executor": "claude", "fallback": ["codex"] } ], "default": "pi" }
```

选择顺序：任务书 `executor:` 显式指定 → 按 `type` 匹配规则 → `default`。派发时主执行者处于暂停（额度/登录/预算）就按 `fallback` 顺序改路由；全部暂停则留在主执行者上等待（`paused`）。项目可用 `projects.<P>.executors` 白名单限制可用执行者。

## `projects.<P>`

| 字段 | 说明 |
|---|---|
| `repo` | 绝对路径，或按主机 `{ "box": "...", "vps": "..." }`；不同项目的 repo 不能互相包含 |
| `worktrees` | 任务 worktree 根目录（默认 `<home>/worktrees/<P>`） |
| `base` | 基准分支（默认 `main`）；任务分支 `nova/<task-id>` 从这里切出，nova-relay 从不向它推送或合并 |
| `owner` | Grok Bot 标识，用于 `pending/ack/approve --owner` |
| `env_file` | 项目私有 env（0600），只注入本项目任务，值也会被脱敏 |
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
