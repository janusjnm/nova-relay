# 故障模式表（Failure Modes）

原则：**磁盘状态是唯一真相；任何异常要么自动有界地处理，要么唤醒 Grok 一次；绝不静默丢失、绝不无限循环。**
"唤醒"指 coordinator 通过 outbox 发出 webhook，payload 只有 `{source,batch,id,state,exit_code}`。

图例：✅ 已实现且有自动化测试 · 🟡 已实现，需真实环境验证 · 📝 仅文档/运维约定

| # | 问题 | 检测 | 自动处理 | 何时唤醒 Grok | 状态 |
|---|---|---|---|---|---|
| 1a | box 睡眠/重启，分段中途 | **只有 box 重新运行之后**才能检测：worker 每 TTL/3 续租；`resume-all`（box 自己的 tick 定时器，或之后某次能连上 box 的 VPS watchdog）发现租约过期且持有进程已死（PID + `/proc` 启动时间防 PID 复用）。box 睡着时，VPS 只能看到"ssh 不通 / 心跳缺失"（见 1e） | box 运行后：先杀掉旧分段遗留的执行者进程组（分段 PID 与启动时间记录在任务状态里，避免孤儿进程继续写 worktree），任务回到 `queued`，从最后一个 checkpoint commit + `progress.md` 继续；Claude 用 `--resume <session>`。box 一直睡着 → 任务一直等待，没有任何东西能替它跑 claude | 不唤醒（除非之后失败；心跳缺失见 1e） | ✅ / 🟡 |
| 1b | 进程被冻结（睡眠中或 SIGSTOP）vs 被杀 | 租约过期但 PID 存活 = `frozen`；分段内计时器检测到 >60 s 跳变 = 刚从睡眠恢复 | 睡眠时间不计入分段时长。`frozen` 不按"过期了多久"判断（box 睡几小时后醒来，定时器第一次触发时健康的 worker 也是这个样子），而是记录**首次观察**时刻、发 SIGCONT；只有连续观察 3×TTL 仍未续租才对**经验证的那个进程实例**（PID + 启动时间 + boot id）发 SIGKILL，并且**确认它已经不能再运行**（进程消失、或成为僵尸）之后才把任务放回 `queued`；旧分段的执行者进程组也一样，要确认组里没有还能运行的成员。确认不了（租约里没有启动时间、无法验证 PID；SIGKILL 后仍存活，例如不可中断睡眠；进程组领头进程已死但组里还有成员，组 id 已无法验证归属）→ **不杀、不替换**，任务保持 `running`，`resume-all` 在 `unconfirmed` 里列出，事件日志写明原因：宁可停住等人处理，也不让两个 worker 同时写一个任务（可用性换正确性）。期间一旦续租就重置观察。空闲时被冻结的 worker 会一直占着本机的 worker 租约，本机任务都不会开始，直到它恢复或被人杀掉（同一取舍）。验收命令（`npm ci`、整套测试，可能十几分钟）、`preflight_cmd`（≤120 s）与 CLI 契约检查（`--version`/`--help`，各 ≤20 s）都异步运行，worker 期间照常续租，不会因此被误判为冻结；取消或失去租约时这些命令被杀掉，不记录任何结论（不计失败次数、不暂停、不缓存契约结果）。子进程无输出超过 `idle_timeout_sec` 视为卡死，杀掉并计一次分段失败 | 分段失败 >3 次时 | ✅ / 🟡 |
| 1c | 残留锁文件 | 租约 JSON 与短文件锁（毫秒级）都记录持有者**进程实例**：host、pid、`/proc` 启动时间、boot id（锁还有 nonce） | 只在持有者实例**可确定已死**时抢占：PID 不存在、PID 被复用（启动时间不同）、僵尸进程、上一次开机（boot id 不同）。**活着的同主机持有者永远不会因为“太久了”被抢**——SIGSTOP、挂起、调试器暂停的持有者也一样；锁的等待者 30 s 后报错（错误里写明持有者 pid，提示恢复或杀掉它），租约显示为 `frozen`（见 1b）。只有 pid、没有启动时间的旧锁文件，PID 活着就当作活着。Node 没有 flock/fcntl 绑定，内核不会替我们释放锁，所以这是失败即停（fail closed）：被停住的持有者会让相关文件的更新停住，直到它恢复或死掉。租约：过期 + 持有者实例已死 → 在短文件锁内**重新检查**后 rename 抢占再 `link()`，没有任何选项能抢活着的持有者。短文件锁：锁文件刚好消失视为“重试”而不是“已死”；抢占某个锁实例前必须先 `link()` 出该实例专属的抢占令牌（`.steal-<nonce>.<n>`，同一时刻只有一个抢占者，令牌持有者死了就用下一代），再重新读一次确认还是那个实例，因此视图过时的抢占者不会把活着的持有者的锁挪走。跨主机的持有者无法检查：锁文件在本地磁盘上，只有改主机名后才会出现，仍按 60 s 超时处理。`.stale-*`/`.steal-*` 残留由 gc 清理 | 否 | ✅（交错、压力、SIGSTOP、实例身份测试） |
| 1d | 两个 watchdog 同时续跑 / 多个 worker 进程 | 租约获取用 `link()`（存在即失败）；抢占在文件锁内重新判断租约状态（否则 A 判定过期后、B 已抢到并写入新租约，A 会把 B 的新租约挪走，两者都以为自己持有——旧实现在 8 进程竞争测试里 15 轮出现 3 次双赢）；每台主机还有一个 worker 主机租约 | 只有一个 worker 拿到任务租约；每台主机只有一个 worker 进程（后启动的立即退出，`max_parallel` 与范围锁因此全局有效；退出前释放主机租约并再检查一次，避免刚入队的任务滞留）；`resume-all` 幂等 | 否 | ✅ |
| 1e | box 睡眠/关机/断网期间 | VPS watchdog：`ssh box … resume-all` 失败（退出码 255/超时）→ 记录到 `run/host-box.json`（`unreachable_since`），`doctor` 显示；coordinator：超过 `heartbeat_miss_minutes` 未收到 box 心跳 | **无法自动处理**：ssh 不能唤醒或解冻一台挂起的机器，watchdog 也不能。只做检测与通知；box 恢复运行后按 1a 续跑 | 每次中断通知一次（`state: box_unreachable`）；同一批次同一主机的两次通知之间至少隔 `notify_cooldown_minutes`（默认 60，链路抖动、box 醒一下又睡不会每次都唤醒；冷却期过后仍不可达会再通知一次）。这只唤醒 Grok 的 Routine，**不会唤醒 box**；如果 Grok 本身也跑在这台睡着的 box 上，通知要等它醒来后才可能被处理（取决于 Grok 平台） | ✅（检测/通知）/ 🟡（真实睡眠） |
| 2 | Claude/Codex 订阅额度或限流 | 只匹配 CLI **自己**的错误文本（stderr、最终 result / error 事件），不匹配流里的工具输出——否则正在改限流代码、测试日志里出现 `429` 就会误停执行者；能解析出重置时间（`…\|<epoch>`、`try again in 2h 5m`） | 暂停该执行者到重置时间（解析不到则 `quota_pause_minutes`；同一事故多个任务只算一次，取更晚的重置时间）。派发时主执行者被暂停 → 按 `fallback` 改路由。**已在运行的任务**：按 `routing.reroute_paused`（默认 off）在分段边界改用 fallback——同主机原地切换，跨主机用 git bundle 交接（见 config.md）；否则 `paused`，到期由 tick 自动继续。每任务最多 `max_quota_pauses` 次、最多改路由 2 次 | 超过 `max_quota_pauses` → `failed` + 立即唤醒；否则不唤醒 | ✅（跨主机交接在测试中用两个本地主机模拟；真实 ssh 🟡） |
| 3 | 登录过期 / 退出登录 / DeepSeek key 无效 / 欠费 | 预检查凭据文件（claude：`~/.claude/.credentials.json`；`~/.claude.json` 退出登录后仍存在，不作为证据）或 env；运行输出匹配 `401`、`/login`、`invalid api key`、`402`；`doctor --live` 可实查（`claude auth status` 必须是 `claude.ai` 订阅、`codex login status` 不能是 API key、DeepSeek `/user/balance`） | 执行者标记为 `auth` 暂停（不自动解除），任务 `needs_auth` | 唤醒**一次**（同一执行者同一次事故只上报一次）；用户重新登录后 `nova-relay unpause <executor>` | ✅ |
| 4 | CLI 升级后参数被移除/改名 | 预检查：`--version` ≥ `min_version`，`--help` 中包含所有必需参数（按版本缓存 1 小时）；运行时 `unknown option` | 任务 `blocked`，不重试 | 立即唤醒 | ✅（适配器契约测试） |
| 5 | 断网、Tailscale 掉线、VPS↔box 不通、DNS | ssh 退出码 255 / 超时；输出匹配 `ECONNRESET`、`ENOTFOUND`、`fetch failed`、5xx、overloaded；可选 `preflight_cmd` | rpc 按 1 s / 4 s / 16 s 退避重试；分段网络失败按 15 s 起指数退避（上限 5 分钟）；box→coordinator 的上报进 outbox 持久重试；VPS 连不上 box 时只记录并等待心跳检查（见 1e） | box 心跳超过 `heartbeat_miss_minutes` → 每次中断通知一次（`state: <host>_unreachable`）；分段失败 >3 次 | ✅ / 🟡 |
| 5b | `dispatch` 提交到执行主机超时 / 回复丢失（主机其实已经存好任务） | ssh 超时、退出码 255、回复无法解析或报错 | 任务 id 在提交前就登记到 coordinator 的批次视图，状态 `submitting`（非终态、不唤醒）；重试用同一个 id（幂等）。提交出错时**不猜**：让主机在任务锁内对每个 id 做 fence——任务已存在就把它的真实状态写回批次，不存在就写墓碑，之后迟到/重试的 submit 一律拒绝，只有这种 id 才判 `FAIL submit`。主机连不上 → 保持 `submitting`（批次 WAIT，`ack` 被拒），coordinator 的 tick 继续 fence（dispatch 标记过的立即重试；其余的在最近一次提交尝试 10 分钟后）。这 10 分钟**只是调度提示，不是正确性假设**：fence 与 create 在主机上由同一个任务锁串行化（这个锁不会从活着的持有者手里被抢，见 1c），墓碑永久有效（见 5c），所以不管 dispatch 进程睡了多久才回来，它要么发现任务已经存在（幂等提交 → `delivered`），要么被拒绝并记录 `not_delivered`；不会出现批次算失败但任务被创建。提示太短只会造成一次一致的 `FAIL submit`，太长只会推迟结论。调用方传 `--key` 时可安全重试：同一个键 = 同一个批次、同样的任务 id，只重新提交仍未对账的任务；`dispatch --json` 给出每个任务的 `delivery`（`unknown`/`delivered`/`not_delivered`/`abandoned`），退出码 75 = 送达未知。提交成功但 `wake-worker` 失败不算失败，主机的 tick 会启动任务 | 只有确定未送达（已 fence）时才可能让批次结束并唤醒；主机长期不可达时批次一直 WAIT（另有心跳通知） | ✅（模拟丢失回复的测试；真实 ssh 时序待实测） |
| 5c | 执行主机一直不回来，批次永远 WAIT | `batch`/`pending` 显示 `submitting` 或未结束的条目；心跳缺失通知（1e） | **不自动放弃**（没有任何超时替运维员放弃）。运维员显式运行 `nova-relay abandon <batch> --host H --yes`：这些条目在 coordinator 上变成终态 `abandoned`，批次 FAIL 并唤醒一次。**不声称远端已停止**：每次都打印警告——那台主机若其实在运行，任务可能仍在后台执行并修改 worktree/分支；排队的取消只有主机重新可达时才送达（不存在的 id 写墓碑，未结束的任务改为 `cancelled`）。之后该主机的迟到上报只记录在 `late` 字段，不改变条目或批次结论（不会让批次“复活”）。gc 删除已 ack 的任务/批次时先写墓碑，墓碑永不清理，所以迟到的或带键重试的 create 永远不能成功 | `abandon` 后一次 `batch_done` | ✅（放弃、警告、迟到上报、墓碑与 gc 测试；真实主机断开待实测） |
| 6 | webhook 发送失败 / 重复 / 乱序 | HTTP 非 2xx 或异常 | outbox 持久化，30 s 起指数退避（上限 30 分钟）。webhook 12 次后标记 dead（`doctor` 报告，`outbox --flush` 重发）；主机→coordinator 的上报（rpc）**永不 dead**，一直按上限 30 分钟重试——它们是批次视图的唯一来源，丢了批次就永远不会结束；同一去重键（batch + id + state + 轮次）只入队一次；outbox 按入队时间顺序发送；每次发送尝试与成功送达（按去重键计）分别计数（`nova-relay stats` 的 `notification_attempts` / `notification_deliveries`；ack 后被丢弃的唤醒不算送达）；任务上报带 `rev`，coordinator 丢弃旧 rev（包括任务已重新 `queued` 时晚到的旧上报，只有派发时的占位记录会被同 rev 覆盖）；webhook **不跟随重定向**：3xx 视为失败留在 outbox（重定向目标会绕过 https/Tailscale 限制，而且跨域时 `Authorization` 被丢弃，对方返回 2xx 会被误记为已送达） | Grok Routine 以磁盘为准：醒来先 `pending`，为空就安静结束；`ack` 后重复唤醒什么也看不到 | ✅ |
| 7 | 任务卡死 / 死循环 / token 失控 | 空闲超时、每段墙钟上限、任务累计运行时间（`task_minutes`，不含暂停）、最大分段数、本地重试数、每执行者每日预算（分段数/分钟/token/费用，UTC 日）。token/费用只记**提供方报告的数字**，没报告的记为未知、不当作 0 | 每个新分段开始前检查；`segments_per_day` 在预检时原子占位（并行任务不会多跑）。超限 → `failed`；超预算 → 执行者暂停到下一个 UTC 零点，任务 `paused`（或按 #2 改路由）。**已在运行的分段可能让分钟/token/费用超出上限**，这不是精确的硬性计费上限；从未报告 token/费用的执行者，对应上限无法执行（`doctor`/`stats` 警告） | 任务终态随批次唤醒；分段失败 >3 次立即唤醒（同一网络事故导致的多个升级合并为一次） | ✅ |
| 8 | 幻觉式成功 / 越界改动 / 篡改验收 | 只看验收，判定对象是任务分支的**提交**：分段结束后先杀掉执行者进程组的残留后台进程、checkpoint；然后在一个**全新的、无 hook 的独立临时 clone**（不是共享仓库的 worktree）里 detached 检出并跑验收命令（执行者 worktree 里被 gitignore 的文件、伪造的 `node_modules/.bin/*` 都不存在；setup/测试里的 git 命令改不到共享仓库），环境是白名单变量 + 空 HOME + 私有 TMPDIR + 去掉相对/仓库内条目的 PATH + `bash --noprofile --norc`；命令异步运行，worker 照常续租。篡改检查（**致命，不重试**）：共享 `.git/config`、`.git/hooks`、`.git/info` 变化；worktree 的 HEAD 不在 `nova/<id>` 上或 base 不是祖先；删除测试文件、新增 skip/only、测试用例数减少；改了验收框架文件（Makefile、jest/vitest/pytest 等配置、`.npmrc`、`tsconfig*`、验收命令直接引用的脚本、项目 `harness_paths`）或 `package.json` 的 `scripts`；符号链接指向 worktree 外、指向 `.git`、或替换了测试/框架文件；验收命令运行期间共享 `.git` 被改或任务分支被移动。`acceptance_setup` 失败（网络/registry/工具链）→ `FAIL setup:…`，`failed` + 升级，不交给执行者重试。可重试的：空 diff、禁止路径、超出范围、checkpoint 之后又有未提交改动、验收命令失败 | 执行者的自述只作为"摘要（非证据）"写入 result.md；可重试的 FAIL 带着错误本地重试；篡改 → `failed` + 升级 | 随批次唤醒；篡改立即唤醒 | ✅ |
| 9 | 破坏性命令、日志/结果泄露密钥、推送到保护分支、force push、守卫被绕过 | `nova-guard`（Claude PreToolUse hook / Pi 扩展）：所有 `git push`、git alias/hooksPath/remote/credential 配置、写 worktree 以外（重定向、cp/mv/tee/rm/sed -i…，目标含未知变量默认拒绝，符号链接解析后判断；`cd`、`git -C/--git-dir/--work-tree`、`make -C`、`npm --prefix`、`env -C`、`tar -C` 等换目录参数会被跟踪，目录解析不了默认拒绝）、带参数的包装命令（`env -i`、`nice -n`、`timeout`、`xargs`、`sudo`、`eval`…）先解析再检查、注入代码的环境变量（`PATH` 含可写目录、`LD_*`、`NODE_OPTIONS`、`GIT_*`）、本地移动保护分支、执行者可写位置的脚本（shell、npm scripts、Makefile、python/node/… 启发式扫描，读不到的脚本默认拒绝）。**守卫存活检查**：Claude 的 hook 每次调用计数，分段里有受控工具调用而 hook 计数为 0（`-p` 会静默忽略无效 `--settings`）→ `blocked`；Pi 扩展加载时写标记，缺失 → `blocked`；Pi 固定 `--no-extensions --no-approve --no-mcp`，只加载 nova-guard（别的扩展可能在守卫放行后改写命令），未知工具一律拦截。**Codex 无前置 hook**：用 `--json` 事件里的每条命令/文件改动/MCP 调用事后过一遍同一守卫（同一 item 的 started/completed 只算一次）；分段成功却没有一条可解析事件 → `blocked` | 拦截 → `approvals.jsonl` → 任务 `needs_approval`；同一命令精确匹配才放行；被拒的命令再次出现直接拒绝。Codex 事后审计命中 → `audit` 审批（已执行，approve = 继续，deny = 任务 failed）。日志按整行脱敏（密钥跨输出块也能抹掉），进度/结果/审批记录统一脱敏；`secrets.env` 里的变量名和配置声明的密钥变量名（webhook `url_env`/`key_env`、执行者 `key_env`）不论叫什么都不传给执行者与验收命令，值也脱敏；nova-relay 自己从不 push | 立即唤醒（needs_approval / blocked） | ✅（启发式扫描有已知盲区，见 security.md） |
| 10 | 并发任务改同一批文件 | 每任务独立 worktree；同项目范围重叠的任务不并发（精确的 glob 交集判断：`src/*.ts` 与 `src/b/c.md` 不重叠，`src/**` 与 `**/*.md` 重叠；空范围 = 整个仓库）；完成后 `git merge-tree` 检查与当前 base 是否冲突 | 冲突 → `needs_approval`（kind=merge），approve = 接受由人合并，deny = failed | 立即唤醒 | ✅ |
| 11 | 磁盘满 / 输出过大 / 日志膨胀 | 每段前检查 `min_free_mb`；分段日志上限 `max_log_bytes`；`events.jsonl` 超 5 MB 轮转 | 磁盘不足 → `blocked`；ack 后 gc 删 worktree（分支保留），`retention_days` 后删任务目录、批次、已发 outbox | 磁盘不足时唤醒 | ✅ |
| 12 | box 与 VPS 时钟/时区偏差 | `doctor` 通过 ssh ping 估算偏差（>60 s 警告） | 内部全部 UTC ISO；租约只在本机比较；心跳用 coordinator 自己的接收时间；报告显示 Asia/Singapore | 否 | ✅ |
| 13 | 批次部分失败 | 每任务独立状态 | 失败任务不阻塞其他任务；verdict 行列出每个非 done 任务；`ack` 拒绝还有未结束任务的批次（被 ack 的任务不会再运行，否则会被永远搁置） | 整批结束时唤醒一次（`exit_code` 1 = 有失败） | ✅ |
| 14 | 长任务上下文溢出 | 输出匹配 `prompt is too long` / `context length` | 下一段开新会话，只带任务书 + `progress.md` 尾部摘要；每 `fresh_session_every` 段也会主动换新会话 | 否 | ✅ |
| 15 | 仓库/网页内容中的提示词注入 | guard + 白名单（`guard.allow_hosts`）；Claude 默认禁用 WebFetch/WebSearch，并以 `--setting-sources user --strict-mcp-config` 忽略仓库里的 `.claude/settings*.json`（hooks/权限）与 `.mcp.json`（MCP 服务器可能发消息）；Codex 以 `--ignore-user-config --ignore-rules` 运行且不加 `--trust`；Pi 以 `--no-approve --no-mcp --no-extensions` 运行；子进程环境剔除 webhook/token/key/credential 类变量、`GIT_CONFIG_*`、`GIT_SSH*`、`SSH_AUTH_SOCK` | 执行者不能发消息、花钱、改远端配置、读凭据、推送；任务书提示词明确要求忽略与任务书冲突的仓库内指令 | 被拦截时按 #9 | ✅ / 📝 |
| 16 | 配置错误 / 执行者不存在 | 启动时完整校验，错误带路径（如 `routing.rules[2]: unknown executor "foo"`）；任何一层的未知键（拼写错误，如 `forbiden_paths`、`protected_branch`、`budgt`）都报错而不是悄悄用更弱的默认值（`_`/`$` 开头的键是注释）；`hosts.*.role` 只能是 box/vps；claude 不允许 `--bare`、网关变量或非 box 主机；codex/pi 不允许绕过沙箱或守卫的参数 | 命令以退出码 3 拒绝运行；运行中的任务若执行者/项目已从配置删除 → `blocked` | `blocked` 时唤醒 | ✅ |
| 17 | nova-relay 自身崩溃 / 状态文件损坏 / 多进程同时写 | `state.json` 解析失败，或 journal 的 `seq` 比 `state.json` 新（在追加 journal 与 rename 之间崩溃） | 所有状态写入 tmp+fsync+rename（并 fsync 目录）；`journal.jsonl` 只追加并带序号，落后或损坏时重放重建；任务状态、批次视图、预算账本、暂停表、审批决定的读-改-写都在跨进程文件锁内（多个 ssh `rpc report` 同时到达不会丢上报）；outbox 同一时刻只有一个 flush；崩溃残留的 tmp/锁文件由 gc 清理；租约过期后由 resume 接管 | 否 | ✅ |
| 18 | PD/NM 项目隔离被突破 | 配置校验：项目 repo 与 worktree 根目录互不包含；任务书 scope 不能含绝对路径、`..`、`~`、`$`；任务书 `project:` 与派发项目不一致即拒绝；可选每项目执行者白名单；写路径解析符号链接（worktree 里放一个指向 NM 的链接也写不过去）；项目 `env_file` 必须 0600 | 每项目独立 repo、worktree 目录、env 文件、webhook、owner；`pending/ack/approve/deny/cancel` 校验 owner | 否（直接拒绝派发）；env_file 权限不对 → `blocked` 唤醒 | ✅ |
| 19 | 升级 nova-relay 时有任务在跑 | 状态文件带 `schema`；读取时按迁移链升级，遇到更新版本写的状态拒绝处理 | `install.sh` 并排安装 `versions/<ver>` 并原子切换 `current`，旧 worker 继续用旧代码直到结束；新 worker 接手时迁移状态 | 否 | ✅（迁移框架有测试；目前 schema=1）。升级前用 `snapshot` 备份元数据、`migrate --dry-run` 查看能读/不能读什么与回滚步骤（见 #22） |
| 20 | 严格隔离不可用（`isolation.mode: "strict"`）：bwrap 缺失、非特权 user namespace 被禁用、执行者适配器没有隔离配置（本版本只有 claude 有）、`~/.claude` 缺失、绑定路径不安全 | 只读探测（在空配置里运行 `true`，进程内缓存）；`doctor` 显示 available / UNAVAILABLE | 该步骤**不运行**，绝不退回无隔离运行 → 任务 `blocked`（原因写明）；执行者步骤在占用预算名额前就检查 | 立即唤醒；同一批次里同一原因只唤醒一次 | ✅（模拟的探测失败 + 本机 bwrap 0.12 实测） |
| 21 | 一个原因同时卡住多个任务 / 唤醒刷屏 | 执行者级原因（CLI 参数、模型 id、守卫失效、隔离不可用、磁盘）与网络导致的升级各有一个持久的事故 id（`run/incidents.json`，`notify_cooldown_minutes` 内复用） | 同一批次同一事故映射到同一个 outbox 去重键：第一次立即入队并发送，之后的任务不再产生唤醒；重复的 tick、flush 失败、网络抖动不会产生新的唤醒（只重试同一条）。`batch_done`、`needs_approval` 不受影响 | 第一次立即唤醒 | ✅ |
| 22 | 任务库元数据丢失 / 升级后要回滚 | — | `nova-relay snapshot`（不含密钥、日志、租约；**不含 git 分支与 worktree**）；`nova-relay restore --from … --dest <空目录>`（全部校验通过才写入；不启动 worker；未完成的任务改为 `blocked`；待发通知被扣住，不重放）；`nova-relay migrate --dry-run`（能读/不能读什么、回滚步骤） | 否 | ✅（本地测试）/ 🟡（真实主机上的恢复演练） |

## doctor

`nova-relay doctor [--live]` 逐项检查上表依赖的前提：Node 版本、配置、secrets 文件权限、目录可写、磁盘、git ≥ 2.38、本机执行者 CLI 契约（版本 + 必需参数）、凭据存在性、执行者暂停状态与当日预算（token 已报告/未知分开显示；从未报告而无法执行的上限给出 WARN）、进程隔离（`off`，或 strict 时 bwrap 是否可用、每个执行者是否有隔离配置、包装脚本形式的 `bin`、无网络时的 `acceptance_setup`）、项目 repo 与 base 分支、webhook 环境变量与 URL 规则、outbox 死信、任务库 schema 与失效租约、systemd 定时器、到其他主机的 ssh 可达性与时钟偏差。任何 FAIL → 退出码 1。

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
10. 派发时让执行主机的 ssh 中途断开（例如提交瞬间断 Tailscale）：批次应保持 WAIT（`submitting`），恢复后 coordinator 的 tick 把任务对上（已存下的继续跑，没送达的判 `FAIL submit`），不出现“批次已 FAIL 但任务还在跑”。
11. 用 `dispatch --key K --json` 派发时断开执行主机：应得到退出码 75 和 `delivery: "unknown"`；恢复后用同一个 `--key` 重试，应仍是同一个批次（`created: false`），任务只创建一次。
12. 让执行主机长期断开后 `nova-relay abandon <batch> --host <H> --yes`：确认警告出现、批次 FAIL 并唤醒一次；之后恢复主机，确认排队的取消被送达（任务变为 `cancelled` 或本来已结束），迟到上报不改变批次结论。同时确认在那台主机上实际还有没有进程在跑——`abandon` 本身不保证这一点。
13. 对一个正在运行的 worker `kill -STOP`：确认 `resume-all` 不会在 3×TTL 之前杀它；确认它被杀并且确认死亡后才续跑；`kill -STOP` 一个持有短文件锁的进程（很难卡准时机）时，其它进程报锁超时而不是抢锁。

14. 开启 `isolation.mode: "strict"`（`executors.claude.bin` 设为真实二进制）后，在 box 上派一个小任务：确认官方 claude 在只读 `~/.claude`、私有 HOME 下能完成一个真实分段并 PASS（本仓库只实测了该配置下 `claude --version` 能启动；真实分段需要模型调用，未做）；运行中登录过期时是否表现为一次 `needs_auth`。
15. `nova-relay stats` 与真实 Claude Code 输出对照：`result` 事件里实际出现了哪些 `usage` 字段、`total_cost_usd` 是否出现（本仓库只用伪造 CLI 测试了解析规则）。
16. 在 box 与 VPS 上各做一次 `snapshot` → `restore --dest <临时目录>` 演练，`migrate --dry-run` 无 `cannot read`；确认你另外备份了项目仓库与 `nova/<task>` 分支。
17. 合并前看一次 GitHub Actions（`.github/workflows/test.yml`）的真实运行结果：托管 runner 上 bwrap 的实测用例会因探测失败而**跳过**（不是失败），模拟用例照常运行。

## 故障演练（fault harness）

`tests/fault-harness.test.mjs` 在一台主机上、用临时 git 仓库、伪造的执行者 CLI（`tests/fixtures/fake-agent.mjs`）和伪造的 webhook（不联网）重复演练：断网（分段网络失败退避后升级、`preflight_cmd` 失败暂停）、额度墙、登录失效、执行者卡死（空闲超时）、通知送达失败（outbox 退避重试、只送达一次）。测试名带标签：

- `[simulated]`：故障由伪造的 CLI / fetch 注入，所有环境都能跑。
- `[real-runtime]`：用本机真实的 bubblewrap（`tests/process-isolation.test.mjs`，包括端到端的 strict 执行者 + 验收）；没有 bwrap 或不允许非特权 user namespace 时自动跳过并写明原因。

本地测试**不能**证明下面这些外部集成。

## 待完成的外部集成关卡

以下都没有在本仓库的测试里做过（不使用真实凭据、不连真实主机、不碰生产仓库），上线前逐项实测并记录：

- [ ] 真实 VPS / ssh over Tailscale：rpc、心跳、watchdog、跨主机交接（上面第 1–3、9–12 项）
- [ ] Codex 登录后的真实执行与审计事件（第 7 项）
- [ ] DeepSeek 真实 key 与所选模型 id（`doctor --live`，第 8 项）
- [ ] 不在本机回环上的真实 webhook（Grok Routine）：送达、重试、只处理一次（第 4 项）
- [ ] 真实主机睡眠 / 重启 / 断网与恢复时机（第 1、2、13 项）
- [ ] 真实生产仓库上的 `acceptance_setup` 与验收时长；strict 隔离下的官方 claude 分段（第 14 项）
- [ ] 真实 CLI 报告的用量字段（第 15 项）、真实主机上的快照恢复演练（第 16 项）、GitHub Actions 首次运行（第 17 项）

nova-relay **不承诺**持续可用、不承诺零停机，也**不能唤醒睡眠中的 box**；它的设计目标（经本地测试检查，不是保证）是：状态在磁盘上、能检测并通知、主机恢复运行后可从 checkpoint 续跑、可审计、有上限。

## box 睡眠：检测 / 通知 / 恢复后续跑

| 阶段 | 能做什么 | 不能做什么 |
|---|---|---|
| 检测 | VPS watchdog 每 5 分钟 `ssh box … resume-all`，失败即记录 `unreachable_since`（`run/host-box.json`，`doctor` 可见）；coordinator 检查 box 心跳；box 运行时自己的 tick 检测死进程、过期租约、冻结进程；分段内计时器检测到睡眠造成的时间跳变（不计入分段时长） | 分辨"睡眠""关机""断网"——从 VPS 看都是 ssh 不通 |
| 通知 | 心跳缺失超过 `heartbeat_miss_minutes` → 每次中断一条 `box_unreachable` webhook（只唤醒 Grok Routine，告诉用户 box 不可用） | 唤醒或解冻 box：ssh 做不到，watchdog 做不到，webhook 也做不到。nova-relay 不发 Wake-on-LAN，也不改电源设置 |
| 恢复后续跑 | box 重新运行后，它的 tick 定时器（`Persistent=true`）或下一次连上它的 watchdog 运行 `resume-all`：杀孤儿进程组并确认它们已不能运行 → 任务回到 `queued` → 从最后一个 checkpoint + `progress.md` 继续；VPS 上的任务不受影响 | 保证"多久之内"恢复；保证睡眠瞬间正在写的内容不丢（最多丢一个分段的未提交工作） |

如果需要 box 上的任务在无人值守时也能完成，请把 box 设置为不睡眠，或者用路由规则（`routing.rules`）把这类任务派给常开的 VPS 执行者（`reroute_paused` 只在额度/预算暂停时生效，不处理睡眠）——nova-relay 本身不会让一台睡着的机器跑起来。
