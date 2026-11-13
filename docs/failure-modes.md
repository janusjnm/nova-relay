# 故障模式表（Failure Modes）

原则：**磁盘状态是唯一真相；任何异常要么自动有界地处理，要么唤醒 Grok 一次；绝不静默丢失、绝不无限循环。**
"唤醒"指 coordinator 通过 outbox 发出 webhook，payload 只有 `{source,batch,id,state,exit_code}`。

图例：✅ 已实现且有自动化测试 · 🟡 已实现，需真实环境验证 · 📝 仅文档/运维约定

| # | 问题 | 检测 | 自动处理 | 何时唤醒 Grok | 状态 |
|---|---|---|---|---|---|
| 1a | box 睡眠/重启，分段中途 | worker 每 TTL/3 续租；`resume-all`（box tick 定时器 + VPS watchdog）发现租约过期且持有进程已死（PID + `/proc` 启动时间防 PID 复用） | 任务回到 `queued`，从最后一个 checkpoint commit + `progress.md` 继续；Claude 用 `--resume <session>` | 不唤醒（除非之后失败） | ✅ / 🟡 |
| 1b | 进程被冻结（睡眠中或 SIGSTOP）vs 被杀 | 租约过期但 PID 存活 = `frozen`；分段内计时器检测到 >60 s 跳变 = 刚从睡眠恢复 | 睡眠时间不计入分段时长；`frozen` 先发 SIGCONT 并给 3×TTL 宽限，仍不续租则 SIGKILL 后续跑；子进程无输出超过 `idle_timeout_sec` 视为卡死，杀掉并计一次分段失败 | 分段失败 >3 次时 | ✅ / 🟡 |
| 1c | 残留锁文件 | 租约 JSON 含 host/pid/启动时间/过期时间 | 过期 + 持有者已死 → 原子 rename 抢占；`.stale-*` 文件由 gc 清理 | 否 | ✅ |
| 1d | 两个 watchdog 同时续跑 | 租约获取用 `link()`（存在即失败），抢占用 `rename()`（只有一个成功） | 只有一个 worker 拿到租约；`resume-all` 幂等，可随意重复调用 | 否 | ✅ |
| 2 | Claude/Codex 订阅额度或限流 | 退出码 + 输出匹配（`usage limit`、`429`、`rate limit`…），能解析出重置时间（`…\|<epoch>`、`try again in 2h 5m`） | 暂停该执行者到重置时间（解析不到则 `quota_pause_minutes`），任务 `paused`，到期由 tick 自动继续；派发时主执行者被暂停则按规则 `fallback` 改路由；每任务最多 `max_quota_pauses` 次 | 超过 `max_quota_pauses` → `failed` + 立即唤醒；否则不唤醒 | ✅ |
| 3 | 登录过期 / 退出登录 / DeepSeek key 无效 / 欠费 | 预检查凭据文件或 env；运行输出匹配 `401`、`/login`、`invalid api key`、`402` | 执行者标记为 `auth` 暂停（不自动解除），任务 `needs_auth` | 唤醒**一次**（同一执行者同一次事故只上报一次）；用户重新登录后 `nova-relay unpause <executor>` | ✅ |
| 4 | CLI 升级后参数被移除/改名 | 预检查：`--version` ≥ `min_version`，`--help` 中包含所有必需参数（按版本缓存 1 小时）；运行时 `unknown option` | 任务 `blocked`，不重试 | 立即唤醒 | ✅（适配器契约测试） |
| 5 | 断网、Tailscale 掉线、VPS↔box 不通、DNS | ssh 退出码 255 / 超时；输出匹配 `ECONNRESET`、`ENOTFOUND`、`fetch failed`、5xx、overloaded；可选 `preflight_cmd` | rpc 按 1 s / 4 s / 16 s 退避重试；分段网络失败按 15 s 起指数退避（上限 5 分钟）；box→coordinator 的上报进 outbox 持久重试；VPS 连不上 box 时看心跳 | box 心跳超过 `heartbeat_miss_minutes` → 每次中断唤醒一次（`state: <host>_unreachable`）；分段失败 >3 次 | ✅ / 🟡 |
| 6 | webhook 发送失败 / 重复 / 乱序 | HTTP 非 2xx 或异常 | outbox 持久化，30 s 起指数退避（上限 30 分钟），12 次后标记 dead（`doctor` 报告）；同一去重键（batch + id + state + 轮次）只入队一次；任务上报带 `rev`，coordinator 丢弃旧 rev | Grok Routine 以磁盘为准：醒来先 `pending`，为空就安静结束；`ack` 后重复唤醒什么也看不到 | ✅ |
| 7 | 任务卡死 / 死循环 / token 失控 | 空闲超时、每段墙钟上限、任务总时长、最大分段数、本地重试数、每执行者每日预算（分段数/分钟/token/费用，UTC 日） | 超限 → `failed`；超预算 → 执行者暂停到下一个 UTC 零点，任务 `paused` | 任务终态随批次唤醒；分段失败 >3 次立即唤醒 | ✅ |
| 8 | 幻觉式成功 | 只看验收：空 diff = FAIL；改了禁止路径 / 超出范围 = FAIL；删除测试文件、新增 `.skip/.only/xit/@pytest.mark.skip/t.Skip` 等 = FAIL；改 `package.json` 的 `test` 脚本 = FAIL；然后跑任务书验收命令 + 项目 `checks` | 执行者的自述只作为"摘要（非证据）"写入 result.md；FAIL 时带着错误本地重试 | 随批次唤醒 | ✅ |
| 9 | 破坏性命令、日志/结果泄露密钥、推送到保护分支、force push | `nova-guard`（Claude PreToolUse hook / Pi 扩展）；所有 `git push` 都拦截，force/删除/保护分支额外标注 | 拦截 → `approvals.jsonl` → 任务 `needs_approval`；同一命令精确匹配才放行；被拒的命令再次出现直接拒绝；日志/进度/结果/审批记录统一脱敏；nova-relay 自己从不 push | 立即唤醒（needs_approval） | ✅（Codex 依赖沙箱，见 security.md） |
| 10 | 并发任务改同一批文件 | 每任务独立 worktree；同项目范围（glob 静态前缀）重叠的任务不并发；完成后 `git merge-tree` 检查与当前 base 是否冲突 | 冲突 → `needs_approval`（kind=merge），approve = 接受由人合并，deny = failed | 立即唤醒 | ✅（范围重叠判断是保守近似） |
| 11 | 磁盘满 / 输出过大 / 日志膨胀 | 每段前检查 `min_free_mb`；分段日志上限 `max_log_bytes`；`events.jsonl` 超 5 MB 轮转 | 磁盘不足 → `blocked`；ack 后 gc 删 worktree（分支保留），`retention_days` 后删任务目录、批次、已发 outbox | 磁盘不足时唤醒 | ✅ |
| 12 | box 与 VPS 时钟/时区偏差 | `doctor` 通过 ssh ping 估算偏差（>60 s 警告） | 内部全部 UTC ISO；租约只在本机比较；心跳用 coordinator 自己的接收时间；报告显示 Asia/Singapore | 否 | ✅ |
| 13 | 批次部分失败 | 每任务独立状态 | 失败任务不阻塞其他任务；verdict 行列出每个非 done 任务 | 整批结束时唤醒一次（`exit_code` 1 = 有失败） | ✅ |
| 14 | 长任务上下文溢出 | 输出匹配 `prompt is too long` / `context length` | 下一段开新会话，只带任务书 + `progress.md` 尾部摘要；每 `fresh_session_every` 段也会主动换新会话 | 否 | ✅ |
| 15 | 仓库/网页内容中的提示词注入 | guard + 白名单（`guard.allow_hosts`）；Claude 默认禁用 WebFetch/WebSearch；子进程环境剔除 webhook/token/key 类变量与 `SSH_AUTH_SOCK` | 执行者不能发消息、花钱、改远端配置、读凭据、推送；任务书提示词明确要求忽略与任务书冲突的仓库内指令 | 被拦截时按 #9 | ✅ / 📝 |
| 16 | 配置错误 / 执行者不存在 | 启动时完整校验，错误带路径（如 `routing.rules[2]: unknown executor "foo"`）；claude 不允许 `--bare`、网关变量或非 box 主机 | 命令以退出码 3 拒绝运行；运行中的任务若执行者/项目已从配置删除 → `blocked` | `blocked` 时唤醒 | ✅ |
| 17 | nova-relay 自身崩溃 / 状态文件损坏 | `state.json` 解析失败 | 所有状态写入 tmp+fsync+rename；`journal.jsonl` 只追加，损坏时重放重建；租约过期后由 resume 接管 | 否 | ✅ |
| 18 | PD/NM 项目隔离被突破 | 配置校验：项目 repo 互不包含；任务书 scope 不能含绝对路径、`..`、`~`、`$`；任务书 `project:` 与派发项目不一致即拒绝；可选每项目执行者白名单 | 每项目独立 repo、worktree 目录、env 文件、webhook、owner；`pending/ack/approve` 校验 owner | 否（直接拒绝派发） | ✅ |
| 19 | 升级 nova-relay 时有任务在跑 | 状态文件带 `schema`；读取时按迁移链升级，遇到更新版本写的状态拒绝处理 | `install.sh` 并排安装 `versions/<ver>` 并原子切换 `current`，旧 worker 继续用旧代码直到结束；新 worker 接手时迁移状态 | 否 | ✅（迁移框架有测试；目前 schema=1） |

## doctor

`nova-relay doctor` 逐项检查上表依赖的前提：Node 版本、配置、secrets 文件权限、目录可写、磁盘、git ≥ 2.38、本机执行者 CLI 契约（版本 + 必需参数）、凭据存在性、执行者暂停状态与当日预算、项目 repo 与 base 分支、webhook 环境变量与 URL 规则、outbox 死信、任务库 schema 与失效租约、systemd 定时器、到其他主机的 ssh 可达性与时钟偏差。任何 FAIL → 退出码 1。

注意：`doctor` 不做真实的登录调用（不消耗额度），"凭据存在" ≠ "登录有效"；登录失效会在第一次运行时按 #3 处理。

## 必须实测的项目

以下行为依赖真实环境，**部署后请逐项实测并记录**，不要仅凭测试通过就认为可用：

1. box 合盖/睡眠 20 分钟后唤醒：Claude 分段是否继续或被续跑，任务最终 PASS。
2. 分段中途 `kill -9` worker：VPS watchdog 5 分钟内是否让 box 续跑。
3. 关闭 box 的 Tailscale：coordinator 是否在 `heartbeat_miss_minutes` 后发出一次 `box_unreachable` 唤醒。
4. 断开 Grok webhook 地址：outbox 是否重试并在恢复后送达，且 Grok 只处理一次。
5. 在 claude/codex 上触发真实限流（或用测试账号）：是否暂停到重置时间而不是循环。
6. `claude logout` 后派发：是否只唤醒一次 `needs_auth`。

nova-relay **不承诺**持续可用；它承诺的是可恢复、可审计、有上限。
