# 故障模式表（Failure Modes）

原则：**磁盘状态是唯一真相；任何异常要么自动有界地处理，要么唤醒 Grok 一次；绝不静默丢失、绝不无限循环。**
"唤醒"指 coordinator 通过 outbox 发出 webhook，payload 只有 `{source,batch,id,state,exit_code}`。

图例：✅ 已实现且有自动化测试 · 🟡 已实现，需真实环境验证 · 📝 仅文档/运维约定

| # | 问题 | 检测 | 自动处理 | 何时唤醒 Grok | 状态 |
|---|---|---|---|---|---|
| 1a | box 睡眠/重启，分段中途 | worker 每 TTL/3 续租；`resume-all`（box tick 定时器 + VPS watchdog）发现租约过期且持有进程已死（PID + `/proc` 启动时间防 PID 复用） | 先杀掉旧分段遗留的执行者进程组（分段 PID 与启动时间记录在任务状态里，避免孤儿进程继续写 worktree），任务回到 `queued`，从最后一个 checkpoint commit + `progress.md` 继续；Claude 用 `--resume <session>` | 不唤醒（除非之后失败） | ✅ / 🟡 |
| 1b | 进程被冻结（睡眠中或 SIGSTOP）vs 被杀 | 租约过期但 PID 存活 = `frozen`；分段内计时器检测到 >60 s 跳变 = 刚从睡眠恢复 | 睡眠时间不计入分段时长。`frozen` 不按"过期了多久"判断（box 睡几小时后醒来，定时器第一次触发时健康的 worker 也是这个样子），而是记录**首次观察**时刻、发 SIGCONT；只有连续观察 3×TTL 仍未续租才 SIGKILL 并续跑，期间一旦续租就重置观察。子进程无输出超过 `idle_timeout_sec` 视为卡死，杀掉并计一次分段失败 | 分段失败 >3 次时 | ✅ / 🟡 |
| 1c | 残留锁文件 | 租约 JSON 含 host/pid/启动时间/过期时间 | 过期 + 持有者已死 → 原子 rename 抢占；`.stale-*` 文件由 gc 清理 | 否 | ✅ |
| 1d | 两个 watchdog 同时续跑 / 多个 worker 进程 | 租约获取用 `link()`（存在即失败），抢占用 `rename()`（只有一个成功）；每台主机还有一个 worker 主机租约 | 只有一个 worker 拿到任务租约；每台主机只有一个 worker 进程（后启动的立即退出，`max_parallel` 与范围锁因此全局有效；退出前释放主机租约并再检查一次，避免刚入队的任务滞留）；`resume-all` 幂等 | 否 | ✅ |
| 2 | Claude/Codex 订阅额度或限流 | 只匹配 CLI **自己**的错误文本（stderr、最终 result / error 事件），不匹配流里的工具输出——否则正在改限流代码、测试日志里出现 `429` 就会误停执行者；能解析出重置时间（`…\|<epoch>`、`try again in 2h 5m`） | 暂停该执行者到重置时间（解析不到则 `quota_pause_minutes`；同一事故多个任务只算一次，取更晚的重置时间）。派发时主执行者被暂停 → 按 `fallback` 改路由。**已在运行的任务**：按 `routing.reroute_paused`（默认 off）在分段边界改用 fallback——同主机原地切换，跨主机用 git bundle 交接（见 config.md）；否则 `paused`，到期由 tick 自动继续。每任务最多 `max_quota_pauses` 次、最多改路由 2 次 | 超过 `max_quota_pauses` → `failed` + 立即唤醒；否则不唤醒 | ✅（跨主机交接在测试中用两个本地主机模拟；真实 ssh 🟡） |
| 3 | 登录过期 / 退出登录 / DeepSeek key 无效 / 欠费 | 预检查凭据文件（claude：`~/.claude/.credentials.json`；`~/.claude.json` 退出登录后仍存在，不作为证据）或 env；运行输出匹配 `401`、`/login`、`invalid api key`、`402`；`doctor --live` 可实查（`claude auth status` 必须是 `claude.ai` 订阅、`codex login status` 不能是 API key、DeepSeek `/user/balance`） | 执行者标记为 `auth` 暂停（不自动解除），任务 `needs_auth` | 唤醒**一次**（同一执行者同一次事故只上报一次）；用户重新登录后 `nova-relay unpause <executor>` | ✅ |
| 4 | CLI 升级后参数被移除/改名 | 预检查：`--version` ≥ `min_version`，`--help` 中包含所有必需参数（按版本缓存 1 小时）；运行时 `unknown option` | 任务 `blocked`，不重试 | 立即唤醒 | ✅（适配器契约测试） |
| 5 | 断网、Tailscale 掉线、VPS↔box 不通、DNS | ssh 退出码 255 / 超时；输出匹配 `ECONNRESET`、`ENOTFOUND`、`fetch failed`、5xx、overloaded；可选 `preflight_cmd` | rpc 按 1 s / 4 s / 16 s 退避重试；分段网络失败按 15 s 起指数退避（上限 5 分钟）；box→coordinator 的上报进 outbox 持久重试；VPS 连不上 box 时看心跳 | box 心跳超过 `heartbeat_miss_minutes` → 每次中断唤醒一次（`state: <host>_unreachable`）；分段失败 >3 次 | ✅ / 🟡 |
| 6 | webhook 发送失败 / 重复 / 乱序 | HTTP 非 2xx 或异常 | outbox 持久化，30 s 起指数退避（上限 30 分钟），12 次后标记 dead（`doctor` 报告）；同一去重键（batch + id + state + 轮次）只入队一次；任务上报带 `rev`，coordinator 丢弃旧 rev | Grok Routine 以磁盘为准：醒来先 `pending`，为空就安静结束；`ack` 后重复唤醒什么也看不到 | ✅ |
| 7 | 任务卡死 / 死循环 / token 失控 | 空闲超时、每段墙钟上限、任务累计运行时间（`task_minutes`，不含暂停）、最大分段数、本地重试数、每执行者每日预算（分段数/分钟/token/费用，UTC 日） | 超限 → `failed`；超预算 → 执行者暂停到下一个 UTC 零点，任务 `paused`（或按 #2 改路由） | 任务终态随批次唤醒；分段失败 >3 次立即唤醒 | ✅ |
| 8 | 幻觉式成功 / 越界改动 | 只看验收：共享仓库 `.git/config` 或 `.git/hooks` 在任务期间被改 = `FAIL integrity`（不重试，立即升级）；空 diff = FAIL；改了禁止路径 / 超出范围 = FAIL；diff 里有指向 worktree 外的符号链接 = FAIL；删除测试文件、新增 `.skip/.only/xit/@pytest.mark.skip/t.Skip` 等 = FAIL；改 `package.json` 的 `test` 脚本 = FAIL；然后跑任务书验收命令 + 项目 `checks`（验收环境不含主机密钥） | 执行者的自述只作为"摘要（非证据）"写入 result.md；FAIL 时带着错误本地重试 | 随批次唤醒；integrity 失败立即唤醒 | ✅ |
| 9 | 破坏性命令、日志/结果泄露密钥、推送到保护分支、force push、守卫被绕过 | `nova-guard`（Claude PreToolUse hook / Pi 扩展）：所有 `git push`、git alias/hooksPath/remote/credential 配置、写 worktree 以外（重定向、cp/mv/tee/rm/sed -i…，目标含未知变量默认拒绝，符号链接解析后判断）、执行者可写位置的脚本（shell、npm scripts、Makefile、python/node/… 启发式扫描，读不到的脚本默认拒绝）。**守卫存活检查**：Claude 的 hook 每次调用计数，分段里有受控工具调用而 hook 计数为 0（`-p` 会静默忽略无效 `--settings`）→ `blocked`；Pi 扩展加载时写标记，缺失 → `blocked`。**Codex 无前置 hook**：用 `--json` 事件里的每条命令/文件改动事后过一遍同一守卫 | 拦截 → `approvals.jsonl` → 任务 `needs_approval`；同一命令精确匹配才放行；被拒的命令再次出现直接拒绝。Codex 事后审计命中 → `audit` 审批（已执行，approve = 继续，deny = 任务 failed）。日志按整行脱敏（密钥跨输出块也能抹掉），进度/结果/审批记录统一脱敏；nova-relay 自己从不 push | 立即唤醒（needs_approval / blocked） | ✅（启发式扫描有已知盲区，见 security.md） |
| 10 | 并发任务改同一批文件 | 每任务独立 worktree；同项目范围重叠的任务不并发（精确的 glob 交集判断：`src/*.ts` 与 `src/b/c.md` 不重叠，`src/**` 与 `**/*.md` 重叠；空范围 = 整个仓库）；完成后 `git merge-tree` 检查与当前 base 是否冲突 | 冲突 → `needs_approval`（kind=merge），approve = 接受由人合并，deny = failed | 立即唤醒 | ✅ |
| 11 | 磁盘满 / 输出过大 / 日志膨胀 | 每段前检查 `min_free_mb`；分段日志上限 `max_log_bytes`；`events.jsonl` 超 5 MB 轮转 | 磁盘不足 → `blocked`；ack 后 gc 删 worktree（分支保留），`retention_days` 后删任务目录、批次、已发 outbox | 磁盘不足时唤醒 | ✅ |
| 12 | box 与 VPS 时钟/时区偏差 | `doctor` 通过 ssh ping 估算偏差（>60 s 警告） | 内部全部 UTC ISO；租约只在本机比较；心跳用 coordinator 自己的接收时间；报告显示 Asia/Singapore | 否 | ✅ |
| 13 | 批次部分失败 | 每任务独立状态 | 失败任务不阻塞其他任务；verdict 行列出每个非 done 任务 | 整批结束时唤醒一次（`exit_code` 1 = 有失败） | ✅ |
| 14 | 长任务上下文溢出 | 输出匹配 `prompt is too long` / `context length` | 下一段开新会话，只带任务书 + `progress.md` 尾部摘要；每 `fresh_session_every` 段也会主动换新会话 | 否 | ✅ |
| 15 | 仓库/网页内容中的提示词注入 | guard + 白名单（`guard.allow_hosts`）；Claude 默认禁用 WebFetch/WebSearch，并以 `--setting-sources user --strict-mcp-config` 忽略仓库里的 `.claude/settings*.json`（hooks/权限）与 `.mcp.json`（MCP 服务器可能发消息）；子进程环境剔除 webhook/token/key/credential 类变量、`GIT_CONFIG_*`、`GIT_SSH*`、`SSH_AUTH_SOCK` | 执行者不能发消息、花钱、改远端配置、读凭据、推送；任务书提示词明确要求忽略与任务书冲突的仓库内指令 | 被拦截时按 #9 | ✅ / 📝 |
| 16 | 配置错误 / 执行者不存在 | 启动时完整校验，错误带路径（如 `routing.rules[2]: unknown executor "foo"`）；claude 不允许 `--bare`、网关变量或非 box 主机 | 命令以退出码 3 拒绝运行；运行中的任务若执行者/项目已从配置删除 → `blocked` | `blocked` 时唤醒 | ✅ |
| 17 | nova-relay 自身崩溃 / 状态文件损坏 / 多进程同时写 | `state.json` 解析失败，或 journal 的 `seq` 比 `state.json` 新（在追加 journal 与 rename 之间崩溃） | 所有状态写入 tmp+fsync+rename（并 fsync 目录）；`journal.jsonl` 只追加并带序号，落后或损坏时重放重建；任务状态、批次视图、预算账本、暂停表、审批决定的读-改-写都在跨进程文件锁内（多个 ssh `rpc report` 同时到达不会丢上报）；outbox 同一时刻只有一个 flush；崩溃残留的 tmp/锁文件由 gc 清理；租约过期后由 resume 接管 | 否 | ✅ |
| 18 | PD/NM 项目隔离被突破 | 配置校验：项目 repo 与 worktree 根目录互不包含；任务书 scope 不能含绝对路径、`..`、`~`、`$`；任务书 `project:` 与派发项目不一致即拒绝；可选每项目执行者白名单；写路径解析符号链接（worktree 里放一个指向 NM 的链接也写不过去）；项目 `env_file` 必须 0600 | 每项目独立 repo、worktree 目录、env 文件、webhook、owner；`pending/ack/approve/deny/cancel` 校验 owner | 否（直接拒绝派发）；env_file 权限不对 → `blocked` 唤醒 | ✅ |
| 19 | 升级 nova-relay 时有任务在跑 | 状态文件带 `schema`；读取时按迁移链升级，遇到更新版本写的状态拒绝处理 | `install.sh` 并排安装 `versions/<ver>` 并原子切换 `current`，旧 worker 继续用旧代码直到结束；新 worker 接手时迁移状态 | 否 | ✅（迁移框架有测试；目前 schema=1） |

## doctor

`nova-relay doctor [--live]` 逐项检查上表依赖的前提：Node 版本、配置、secrets 文件权限、目录可写、磁盘、git ≥ 2.38、本机执行者 CLI 契约（版本 + 必需参数）、凭据存在性、执行者暂停状态与当日预算、项目 repo 与 base 分支、webhook 环境变量与 URL 规则、outbox 死信、任务库 schema 与失效租约、systemd 定时器、到其他主机的 ssh 可达性与时钟偏差。任何 FAIL → 退出码 1。

注意：默认的 `doctor` 只做本地检查，"凭据存在" ≠ "登录有效"。`doctor --live`（需显式加）会做真实检查：`claude auth status --json`（本地，必须是 `claude.ai` 订阅登录）、`codex login status`（不能是 API key 登录）、DeepSeek `GET /user/balance`（联网，不消耗 token）。都不调用模型、不发 webhook。登录失效仍可能在运行中才暴露，按 #3 处理。

## 必须实测的项目

以下行为依赖真实环境，**部署后请逐项实测并记录**，不要仅凭测试通过就认为可用：

1. box 合盖/睡眠 20 分钟后唤醒：Claude 分段是否继续或被续跑，任务最终 PASS。
2. 分段中途 `kill -9` worker：VPS watchdog 5 分钟内是否让 box 续跑。
3. 关闭 box 的 Tailscale：coordinator 是否在 `heartbeat_miss_minutes` 后发出一次 `box_unreachable` 唤醒。
4. 断开 Grok webhook 地址：outbox 是否重试并在恢复后送达，且 Grok 只处理一次。
5. 在 claude/codex 上触发真实限流（或用测试账号）：是否暂停到重置时间而不是循环。
6. `claude logout` 后派发：是否只唤醒一次 `needs_auth`。
7. Codex 实机：安装后 `nova-relay doctor` 的 `executor codex cli` 为 OK（必需参数都在 `codex exec --help` 里）；派一个会执行命令的小任务，确认 `events.jsonl`/审批里能看到 `--json` 事件中的命令（若 Codex 的事件格式变了，事后审计会看不到命令——这一项必须实测）。
8. Pi 实机：派一个小任务，确认任务目录出现 `guard-loaded` 且执行 `git push` 会被拦截；确认 `model` 名称在你的 pi 版本里可用。
9. 开启 `reroute_paused: "any"` 时，在 claude 限流状态下确认任务能经 ssh 交接到 VPS 并完成（真实 ssh 下 bundle 体积、超时）。

nova-relay **不承诺**持续可用；它承诺的是可恢复、可审计、有上限。
