# 故障模式表（Failure Modes）

原则：**磁盘状态是唯一真相；任何异常要么自动有界地处理，要么唤醒 Grok 一次；绝不静默丢失、绝不无限循环。**
"唤醒"指 coordinator 通过 outbox 发出 webhook，payload 只有 `{source,batch,id,state,exit_code}`。

图例：✅ 已实现且有自动化测试 · 🟡 已实现，需真实环境验证 · 📝 仅文档/运维约定

| # | 问题 | 检测 | 自动处理 | 何时唤醒 Grok | 状态 |
|---|---|---|---|---|---|
| 1a | box 睡眠/重启，分段中途 | **只有 box 重新运行之后**才能检测：worker 每 TTL/3 续租；`resume-all`（box 自己的 tick 定时器，或之后某次能连上 box 的 VPS watchdog）发现租约过期且持有进程已死（PID + `/proc` 启动时间防 PID 复用）。box 睡着时，VPS 只能看到"ssh 不通 / 心跳缺失"（见 1e） | box 运行后：先杀掉旧分段遗留的执行者进程组（分段 PID 与启动时间记录在任务状态里，避免孤儿进程继续写 worktree），任务回到 `queued`，从最后一个 checkpoint commit + `progress.md` 继续；Claude 用 `--resume <session>`。box 一直睡着 → 任务一直等待，没有任何东西能替它跑 claude | 不唤醒（除非之后失败；心跳缺失见 1e） | ✅ / 🟡 |
| 1b | 进程被冻结（睡眠中或 SIGSTOP）vs 被杀 | 租约过期但 PID 存活 = `frozen`；分段内计时器检测到 >60 s 跳变 = 刚从睡眠恢复 | 睡眠时间不计入分段时长。`frozen` 不按"过期了多久"判断（box 睡几小时后醒来，定时器第一次触发时健康的 worker 也是这个样子），而是记录**首次观察**时刻、发 SIGCONT；只有连续观察 3×TTL 仍未续租才 SIGKILL 并续跑，期间一旦续租就重置观察。子进程无输出超过 `idle_timeout_sec` 视为卡死，杀掉并计一次分段失败 | 分段失败 >3 次时 | ✅ / 🟡 |
| 1c | 残留锁文件 | 租约 JSON 含 host/pid/启动时间/过期时间 | 过期 + 持有者已死 → 在短文件锁内**重新检查**后 rename 抢占再 `link()`；`.stale-*` 文件由 gc 清理 | 否 | ✅ |
| 1d | 两个 watchdog 同时续跑 / 多个 worker 进程 | 租约获取用 `link()`（存在即失败）；抢占在文件锁内重新判断租约状态（否则 A 判定过期后、B 已抢到并写入新租约，A 会把 B 的新租约挪走，两者都以为自己持有——旧实现在 8 进程竞争测试里 15 轮出现 3 次双赢）；每台主机还有一个 worker 主机租约 | 只有一个 worker 拿到任务租约；每台主机只有一个 worker 进程（后启动的立即退出，`max_parallel` 与范围锁因此全局有效；退出前释放主机租约并再检查一次，避免刚入队的任务滞留）；`resume-all` 幂等 | 否 | ✅ |
| 1e | box 睡眠/关机/断网期间 | VPS watchdog：`ssh box … resume-all` 失败（退出码 255/超时）→ 记录到 `run/host-box.json`（`unreachable_since`），`doctor` 显示；coordinator：超过 `heartbeat_miss_minutes` 未收到 box 心跳 | **无法自动处理**：ssh 不能唤醒或解冻一台挂起的机器，watchdog 也不能。只做检测与通知；box 恢复运行后按 1a 续跑 | 每次中断通知一次（`state: box_unreachable`）。这只唤醒 Grok 的 Routine，**不会唤醒 box**；如果 Grok 本身也跑在这台睡着的 box 上，通知要等它醒来后才可能被处理（取决于 Grok 平台） | ✅（检测/通知）/ 🟡（真实睡眠） |
| 2 | Claude/Codex 订阅额度或限流 | 只匹配 CLI **自己**的错误文本（stderr、最终 result / error 事件），不匹配流里的工具输出——否则正在改限流代码、测试日志里出现 `429` 就会误停执行者；能解析出重置时间（`…\|<epoch>`、`try again in 2h 5m`） | 暂停该执行者到重置时间（解析不到则 `quota_pause_minutes`；同一事故多个任务只算一次，取更晚的重置时间）。派发时主执行者被暂停 → 按 `fallback` 改路由。**已在运行的任务**：按 `routing.reroute_paused`（默认 off）在分段边界改用 fallback——同主机原地切换，跨主机用 git bundle 交接（见 config.md）；否则 `paused`，到期由 tick 自动继续。每任务最多 `max_quota_pauses` 次、最多改路由 2 次 | 超过 `max_quota_pauses` → `failed` + 立即唤醒；否则不唤醒 | ✅（跨主机交接在测试中用两个本地主机模拟；真实 ssh 🟡） |
| 3 | 登录过期 / 退出登录 / DeepSeek key 无效 / 欠费 | 预检查凭据文件（claude：`~/.claude/.credentials.json`；`~/.claude.json` 退出登录后仍存在，不作为证据）或 env；运行输出匹配 `401`、`/login`、`invalid api key`、`402`；`doctor --live` 可实查（`claude auth status` 必须是 `claude.ai` 订阅、`codex login status` 不能是 API key、DeepSeek `/user/balance`） | 执行者标记为 `auth` 暂停（不自动解除），任务 `needs_auth` | 唤醒**一次**（同一执行者同一次事故只上报一次）；用户重新登录后 `nova-relay unpause <executor>` | ✅ |
| 4 | CLI 升级后参数被移除/改名 | 预检查：`--version` ≥ `min_version`，`--help` 中包含所有必需参数（按版本缓存 1 小时）；运行时 `unknown option` | 任务 `blocked`，不重试 | 立即唤醒 | ✅（适配器契约测试） |
| 5 | 断网、Tailscale 掉线、VPS↔box 不通、DNS | ssh 退出码 255 / 超时；输出匹配 `ECONNRESET`、`ENOTFOUND`、`fetch failed`、5xx、overloaded；可选 `preflight_cmd` | rpc 按 1 s / 4 s / 16 s 退避重试；分段网络失败按 15 s 起指数退避（上限 5 分钟）；box→coordinator 的上报进 outbox 持久重试；VPS 连不上 box 时只记录并等待心跳检查（见 1e） | box 心跳超过 `heartbeat_miss_minutes` → 每次中断通知一次（`state: <host>_unreachable`）；分段失败 >3 次 | ✅ / 🟡 |
| 6 | webhook 发送失败 / 重复 / 乱序 | HTTP 非 2xx 或异常 | outbox 持久化，30 s 起指数退避（上限 30 分钟）。webhook 12 次后标记 dead（`doctor` 报告，`outbox --flush` 重发）；主机→coordinator 的上报（rpc）**永不 dead**，一直按上限 30 分钟重试——它们是批次视图的唯一来源，丢了批次就永远不会结束；同一去重键（batch + id + state + 轮次）只入队一次；任务上报带 `rev`，coordinator 丢弃旧 rev | Grok Routine 以磁盘为准：醒来先 `pending`，为空就安静结束；`ack` 后重复唤醒什么也看不到 | ✅ |
| 7 | 任务卡死 / 死循环 / token 失控 | 空闲超时、每段墙钟上限、任务累计运行时间（`task_minutes`，不含暂停）、最大分段数、本地重试数、每执行者每日预算（分段数/分钟/token/费用，UTC 日） | 超限 → `failed`；超预算 → 执行者暂停到下一个 UTC 零点，任务 `paused`（或按 #2 改路由） | 任务终态随批次唤醒；分段失败 >3 次立即唤醒 | ✅ |
| 8 | 幻觉式成功 / 越界改动 / 篡改验收 | 只看验收，判定对象是任务分支的**提交**：分段结束后先杀掉执行者进程组的残留后台进程、checkpoint；然后在一个**全新的、无 hook 的 detached 检出**里跑验收命令（执行者 worktree 里被 gitignore 的文件、伪造的 `node_modules/.bin/*` 都不存在），环境是白名单变量 + 空 HOME + `bash --noprofile --norc`。篡改检查（**致命，不重试**）：共享 `.git/config`、`.git/hooks`、`.git/info` 变化；worktree 的 HEAD 不在 `nova/<id>` 上或 base 不是祖先；删除测试文件、新增 skip/only、测试用例数减少；改了验收框架文件（Makefile、jest/vitest/pytest 等配置、`.npmrc`、`tsconfig*`、验收命令直接引用的脚本、项目 `harness_paths`）或 `package.json` 的 `scripts`；符号链接指向 worktree 外、指向 `.git`、或替换了测试/框架文件。可重试的：空 diff、禁止路径、超出范围、checkpoint 之后又有未提交改动、验收命令失败 | 执行者的自述只作为"摘要（非证据）"写入 result.md；可重试的 FAIL 带着错误本地重试；篡改 → `failed` + 升级 | 随批次唤醒；篡改立即唤醒 | ✅ |
| 9 | 破坏性命令、日志/结果泄露密钥、推送到保护分支、force push、守卫被绕过 | `nova-guard`（Claude PreToolUse hook / Pi 扩展）：所有 `git push`、git alias/hooksPath/remote/credential 配置、写 worktree 以外（重定向、cp/mv/tee/rm/sed -i…，目标含未知变量默认拒绝，符号链接解析后判断；`cd`、`git -C/--git-dir/--work-tree`、`make -C`、`npm --prefix`、`env -C`、`tar -C` 等换目录参数会被跟踪，目录解析不了默认拒绝）、带参数的包装命令（`env -i`、`nice -n`、`timeout`、`xargs`、`sudo`、`eval`…）先解析再检查、注入代码的环境变量（`PATH` 含可写目录、`LD_*`、`NODE_OPTIONS`、`GIT_*`）、本地移动保护分支、执行者可写位置的脚本（shell、npm scripts、Makefile、python/node/… 启发式扫描，读不到的脚本默认拒绝）。**守卫存活检查**：Claude 的 hook 每次调用计数，分段里有受控工具调用而 hook 计数为 0（`-p` 会静默忽略无效 `--settings`）→ `blocked`；Pi 扩展加载时写标记，缺失 → `blocked`；Pi 固定 `--no-extensions --no-approve --no-mcp`，只加载 nova-guard（别的扩展可能在守卫放行后改写命令），未知工具一律拦截。**Codex 无前置 hook**：用 `--json` 事件里的每条命令/文件改动/MCP 调用事后过一遍同一守卫（同一 item 的 started/completed 只算一次）；分段成功却没有一条可解析事件 → `blocked` | 拦截 → `approvals.jsonl` → 任务 `needs_approval`；同一命令精确匹配才放行；被拒的命令再次出现直接拒绝。Codex 事后审计命中 → `audit` 审批（已执行，approve = 继续，deny = 任务 failed）。日志按整行脱敏（密钥跨输出块也能抹掉），进度/结果/审批记录统一脱敏；nova-relay 自己从不 push | 立即唤醒（needs_approval / blocked） | ✅（启发式扫描有已知盲区，见 security.md） |
| 10 | 并发任务改同一批文件 | 每任务独立 worktree；同项目范围重叠的任务不并发（精确的 glob 交集判断：`src/*.ts` 与 `src/b/c.md` 不重叠，`src/**` 与 `**/*.md` 重叠；空范围 = 整个仓库）；完成后 `git merge-tree` 检查与当前 base 是否冲突 | 冲突 → `needs_approval`（kind=merge），approve = 接受由人合并，deny = failed | 立即唤醒 | ✅ |
| 11 | 磁盘满 / 输出过大 / 日志膨胀 | 每段前检查 `min_free_mb`；分段日志上限 `max_log_bytes`；`events.jsonl` 超 5 MB 轮转 | 磁盘不足 → `blocked`；ack 后 gc 删 worktree（分支保留），`retention_days` 后删任务目录、批次、已发 outbox | 磁盘不足时唤醒 | ✅ |
| 12 | box 与 VPS 时钟/时区偏差 | `doctor` 通过 ssh ping 估算偏差（>60 s 警告） | 内部全部 UTC ISO；租约只在本机比较；心跳用 coordinator 自己的接收时间；报告显示 Asia/Singapore | 否 | ✅ |
| 13 | 批次部分失败 | 每任务独立状态 | 失败任务不阻塞其他任务；verdict 行列出每个非 done 任务；`ack` 拒绝还有未结束任务的批次（被 ack 的任务不会再运行，否则会被永远搁置） | 整批结束时唤醒一次（`exit_code` 1 = 有失败） | ✅ |
| 14 | 长任务上下文溢出 | 输出匹配 `prompt is too long` / `context length` | 下一段开新会话，只带任务书 + `progress.md` 尾部摘要；每 `fresh_session_every` 段也会主动换新会话 | 否 | ✅ |
| 15 | 仓库/网页内容中的提示词注入 | guard + 白名单（`guard.allow_hosts`）；Claude 默认禁用 WebFetch/WebSearch，并以 `--setting-sources user --strict-mcp-config` 忽略仓库里的 `.claude/settings*.json`（hooks/权限）与 `.mcp.json`（MCP 服务器可能发消息）；Codex 以 `--ignore-user-config --ignore-rules` 运行且不加 `--trust`；Pi 以 `--no-approve --no-mcp --no-extensions` 运行；子进程环境剔除 webhook/token/key/credential 类变量、`GIT_CONFIG_*`、`GIT_SSH*`、`SSH_AUTH_SOCK` | 执行者不能发消息、花钱、改远端配置、读凭据、推送；任务书提示词明确要求忽略与任务书冲突的仓库内指令 | 被拦截时按 #9 | ✅ / 📝 |
| 16 | 配置错误 / 执行者不存在 | 启动时完整校验，错误带路径（如 `routing.rules[2]: unknown executor "foo"`）；`limits`/`budget` 里的未知键（拼写错误）报错而不是悄悄用默认值；claude 不允许 `--bare`、网关变量或非 box 主机；codex/pi 不允许绕过沙箱或守卫的参数 | 命令以退出码 3 拒绝运行；运行中的任务若执行者/项目已从配置删除 → `blocked` | `blocked` 时唤醒 | ✅ |
| 17 | nova-relay 自身崩溃 / 状态文件损坏 / 多进程同时写 | `state.json` 解析失败，或 journal 的 `seq` 比 `state.json` 新（在追加 journal 与 rename 之间崩溃） | 所有状态写入 tmp+fsync+rename（并 fsync 目录）；`journal.jsonl` 只追加并带序号，落后或损坏时重放重建；任务状态、批次视图、预算账本、暂停表、审批决定的读-改-写都在跨进程文件锁内（多个 ssh `rpc report` 同时到达不会丢上报）；outbox 同一时刻只有一个 flush；崩溃残留的 tmp/锁文件由 gc 清理；租约过期后由 resume 接管 | 否 | ✅ |
| 18 | PD/NM 项目隔离被突破 | 配置校验：项目 repo 与 worktree 根目录互不包含；任务书 scope 不能含绝对路径、`..`、`~`、`$`；任务书 `project:` 与派发项目不一致即拒绝；可选每项目执行者白名单；写路径解析符号链接（worktree 里放一个指向 NM 的链接也写不过去）；项目 `env_file` 必须 0600 | 每项目独立 repo、worktree 目录、env 文件、webhook、owner；`pending/ack/approve/deny/cancel` 校验 owner | 否（直接拒绝派发）；env_file 权限不对 → `blocked` 唤醒 | ✅ |
| 19 | 升级 nova-relay 时有任务在跑 | 状态文件带 `schema`；读取时按迁移链升级，遇到更新版本写的状态拒绝处理 | `install.sh` 并排安装 `versions/<ver>` 并原子切换 `current`，旧 worker 继续用旧代码直到结束；新 worker 接手时迁移状态 | 否 | ✅（迁移框架有测试；目前 schema=1） |

## doctor

`nova-relay doctor [--live]` 逐项检查上表依赖的前提：Node 版本、配置、secrets 文件权限、目录可写、磁盘、git ≥ 2.38、本机执行者 CLI 契约（版本 + 必需参数）、凭据存在性、执行者暂停状态与当日预算、项目 repo 与 base 分支、webhook 环境变量与 URL 规则、outbox 死信、任务库 schema 与失效租约、systemd 定时器、到其他主机的 ssh 可达性与时钟偏差。任何 FAIL → 退出码 1。

注意：默认的 `doctor` 只做本地检查，"凭据存在" ≠ "登录有效"。`doctor --live`（需显式加）会做真实检查：`claude auth status --json`（本地，必须是 `claude.ai` 订阅登录）、`codex login status`（不能是 API key 登录）、DeepSeek `GET /user/balance` 与 `GET /models`（联网，不消耗 token；确认 key 有效、余额可用、配置的 `model` 名称存在）。都不调用模型、不发 webhook。登录失效仍可能在运行中才暴露，按 #3 处理。

## 必须实测的项目

以下行为依赖真实环境，**部署后请逐项实测并记录**，不要仅凭测试通过就认为可用：

1. box 合盖/睡眠 20 分钟后**由人**唤醒：box 的 tick 定时器（或下一次 watchdog）是否续跑，任务最终 PASS；睡眠期间 `nova-relay watchdog` 是否显示 `reachable: false` 与 `unreachable_since`。
2. 分段中途 `kill -9` worker（box 保持运行）：VPS watchdog 5 分钟内是否让 box 续跑。
3. 关闭 box 的 Tailscale：coordinator 是否在 `heartbeat_miss_minutes` 后发出一次 `box_unreachable` 通知；Grok 跑在 box 上时，这条通知在你的 Grok 平台上何时被处理（box 睡着时可能根本不处理）。
4. 断开 Grok webhook 地址：outbox 是否重试并在恢复后送达，且 Grok 只处理一次。
5. 在 claude/codex 上触发真实限流（或用测试账号）：是否暂停到重置时间而不是循环。
6. `claude logout` 后派发：是否只唤醒一次 `needs_auth`。
7. Codex 实机（登录后）：`nova-relay doctor` 的 `executor codex cli` 为 OK；派一个会执行命令的小任务（例如让它运行 `git push origin main`），确认出现 `ran: …git push…` 的 audit 审批。参数与事件信封已用未登录的 codex-cli 0.169.0 核验，但"登录后真的执行了命令"的事件只能实测。
8. Pi 实机（真实 DeepSeek key）：`nova-relay doctor --live` 的 `executor pi live` 为 OK（key 有效、`model` 在 DeepSeek `/models` 里）；派一个小任务确认 PASS。守卫拦截已用 pi 1.5.2 + 本地模拟接口实测过。
9. 开启 `reroute_paused: "any"` 时，在 claude 限流状态下确认任务能经 ssh 交接到 VPS 并完成（真实 ssh 下 bundle 体积、超时）。

nova-relay **不承诺**持续可用、不承诺零停机，也**不能唤醒睡眠中的 box**；它承诺的是：状态在磁盘上、能检测并通知、主机恢复运行后可从 checkpoint 续跑、可审计、有上限。

## box 睡眠：检测 / 通知 / 恢复后续跑

| 阶段 | 能做什么 | 不能做什么 |
|---|---|---|
| 检测 | VPS watchdog 每 5 分钟 `ssh box … resume-all`，失败即记录 `unreachable_since`（`run/host-box.json`，`doctor` 可见）；coordinator 检查 box 心跳；box 运行时自己的 tick 检测死进程、过期租约、冻结进程；分段内计时器检测到睡眠造成的时间跳变（不计入分段时长） | 分辨"睡眠""关机""断网"——从 VPS 看都是 ssh 不通 |
| 通知 | 心跳缺失超过 `heartbeat_miss_minutes` → 每次中断一条 `box_unreachable` webhook（只唤醒 Grok Routine，告诉用户 box 不可用） | 唤醒或解冻 box：ssh 做不到，watchdog 做不到，webhook 也做不到。nova-relay 不发 Wake-on-LAN，也不改电源设置 |
| 恢复后续跑 | box 重新运行后，它的 tick 定时器（`Persistent=true`）或下一次连上它的 watchdog 运行 `resume-all`：杀孤儿进程组 → 任务回到 `queued` → 从最后一个 checkpoint + `progress.md` 继续；VPS 上的任务不受影响 | 保证"多久之内"恢复；保证睡眠瞬间正在写的内容不丢（最多丢一个分段的未提交工作） |

如果需要 box 上的任务在无人值守时也能完成，请把 box 设置为不睡眠，或者用路由规则（`routing.rules`）把这类任务派给常开的 VPS 执行者（`reroute_paused` 只在额度/预算暂停时生效，不处理睡眠）——nova-relay 本身不会让一台睡着的机器跑起来。
