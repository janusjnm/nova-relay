# 命令参考

所有时间内部为 UTC，显示为 `display_tz`（默认 Asia/Singapore）。需要 coordinator 的命令（`pending`/`verdict`/`batch`/`ack`）在非 coordinator 主机上会自动经 ssh 转发；任务命令（`status`/`log`/`approve`/`deny`/`cancel`）会先查本机任务库，再向 coordinator 查询任务所在主机（任务被跨主机改路由后也能找到）。

## Grok（规划者）使用

| 命令 | 说明 |
|---|---|
| `nova-relay brief-template` | 打印任务书模板 |
| `nova-relay dispatch --project P [--owner O] [--key K] [--json] a.md b.md …` | 校验任务书 → 路由 → 在 coordinator 登记批次（任务先是 `submitting`）→ 提交到各执行主机并启动 worker；打印 `batch <id>`、每个任务的执行者与送达情况、一行 `outcome`。**立即返回**，Grok 随即结束本轮。`--key K`（调用方提供的幂等键，1–200 个可打印 ASCII 字符、不含空格）：批次 id 与任务 id 由 (项目, owner, K) 推导，同一个键重试时返回/续交**同一个**批次——只重新提交仍是 `submitting` 的任务（同一 id，主机端幂等，已 fence 的被拒），已送达、已 fence、已放弃、已结束的不动，永远不会建第二个批次；同一个键配不同的任务书 → 退出码 4，什么也不派发；批次已 ack 并被 gc 后再用该键 → `status: "retired"`，不重新创建。**不带 `--key` 时每次调用都是新批次**，盲目重试会重复干活。退出码见下表；`--json` 输出机器可读结果（见“dispatch / batch 的 JSON 结果”） |
| `nova-relay pending [--owner O]` | 需要处理的批次，每批一行（为空 = 无事可做，保持安静） |
| `nova-relay verdict <batch>` | 一行结论：`batch <id> PASS\|FAIL\|WAIT done/total \| <非 done 任务…>` |
| `nova-relay batch <batch> [--json]` | 每个任务的状态、执行者、verdict、原因；`--json` 是原始批次视图外加 `outcome` 字段（同 dispatch） |
| `nova-relay status <task> [--json]` | 任务详情（分支、worktree、分段数、重试数、待审批请求） |
| `nova-relay log <task> [-n N]` | 最近事件（已脱敏），在任务所在主机读取 |
| `nova-relay approve <task> <req> --owner O` / `deny …` | 仅在用户明确决定后执行。`audit` 类请求（Codex 已执行的操作）：全部决定后，任一 deny → 任务 failed |
| `nova-relay ack <batch> --owner O` | 抽查通过后确认；之后不再唤醒，worktree 被清理（分支保留）。批次里还有未结束（非 done/failed/cancelled）的任务时拒绝 ack——被 ack 的任务不会再运行 |
| `nova-relay cancel <task> [--owner O]` | 取消（运行中的分段会在下一次续租时被终止；之后分段结束也不会覆盖为 done） |

## 运维

| 命令 | 说明 |
|---|---|
| `nova-relay abandon <batch> --host H [--owner O] [--yes] [--json]` | **运维员显式放弃**某台连不上的主机上该批次所有未结束的条目（`submitting`/`queued`/`running`/…）。不带 `--yes` 只是演练（列出会放弃哪些）。带 `--yes`：这些条目在 coordinator 的批次视图里变成终态 `abandoned`（verdict `ABANDONED`，批次结论 FAIL，照常发一次 `batch_done`，之后可以 ack）。**它不会停止那台主机上的任何东西**：主机如果其实还在运行（睡着、网络隔离、只是从这里连不上），任务进程可能仍在后台运行并继续改它的 worktree 和 `nova/<task>` 分支；每次都会打印这条警告。同时排队一条取消（`abandoned` rpc），只有主机重新可达时才会送达（不存在的 id 写墓碑，未结束的任务改为 `cancelled`），在那之前没有任何东西被确认停止。之后该主机对这些条目的迟到上报只记录在 `late` 字段里，**不会**改变条目状态或批次结论。不能对 coordinator 自己（用 `cancel`）或已 ack 的批次使用。**没有任何自动放弃**：没有超时会替运维员放弃 |
| `nova-relay doctor [--no-remote] [--live]` | 检查全部前提（见 failure-modes.md），有 FAIL 退出码 1。`--live`（可选）做真实登录/key 检查：`claude auth status`、`codex login status`、DeepSeek `/user/balance` + `/models`（key 与模型名）；不调用模型、不发 webhook |
| `nova-relay config-check` | 只校验配置 |
| `nova-relay worker [--once]` | 运行本机可运行任务（通常由 dispatch / tick 自动后台启动）；每台主机只有一个 worker，重复启动的会立即退出 |
| `nova-relay resume --all` | 幂等：续跑租约失效的任务、到期的 paused 任务 |
| `nova-relay tick` | 定时器入口：心跳 → resume → 心跳检查（coordinator）→ flush outbox → gc |
| `nova-relay watchdog` | VPS 定时器入口：tick + 经 ssh 让**正在运行**的执行主机 resume；连不上的主机只记录 `reachable: false` 与 `unreachable_since`（不能唤醒它） |
| `nova-relay heartbeat` | 手动向 coordinator 推心跳 |
| `nova-relay unpause <executor>` | 重新登录/充值后解除暂停，把 needs_auth/paused 任务重新排队并向 coordinator 上报 |
| `nova-relay accept <task>` | 手动重跑验收（与 runner 相同：任务分支提交在独立临时 clone 里的干净检出、白名单环境 + 空 HOME + 私有 TMPDIR + 清理过的 PATH + 项目 `env_file`、`acceptance_setup`、篡改检查；与 worker 的验收用不同的临时目录），打印 `PASS` / `FAIL <where>`；worktree 里有未提交改动时为 `FAIL uncommitted`。`isolation` 为 strict 且包含 `acceptance` 时同样在 bwrap 里运行，不可用 → `FAIL isolation`（不会无隔离运行） |
| `nova-relay outbox [--flush]` | 查看待发消息与死信（只有 webhook 会成为死信；主机间上报一直重试）；`--flush` 先把死信恢复为待发，再立即发送一次 |
| `nova-relay gc` | 清理 ack 后（或已交接到别的主机）的 worktree，超过保留期的任务/批次/outbox，以及崩溃残留的 tmp/锁文件。删任务前先在原目录写墓碑 `fenced.json`、删批次前先写 `batches/tombstones/<id>.json`：之后同一个 id（例如同一个 `--key` 重试）永远不会被重新创建。墓碑本身**永不清理**（每个约 100 字节，外加一个目录） |
| `nova-relay rpc <method>` | 主机间调用（stdin/stdout JSON），供 ssh 使用 |
| `nova-relay stats [--json]` | 本机**当天（UTC 日）**每个执行者的用量：分段数、分钟（本地计量）；token 与费用分为**已报告**的数字和**未报告（未知）**的分段数——未知显示为 unknown / `null`，**不是 0**；已配置的上限、是否超限、无法执行的上限（提供方从未报告该数字）；暂停状态（原因、到期时间）；通知计数：`notification_deliveries`（按 outbox 去重键计的成功送达数）、`notification_attempts`（每次发送尝试）、`notification_failures`，分 planner webhook 与主机上报两类，以及被冷却合并掉的唤醒数。存储用 UTC，显示用 `display_tz`（默认 Asia/Singapore）。**这些不是账单、不是剩余订阅额度**；通知计数是发出去的消息，不是模型消耗，也不证明 Grok 真的处理了 |
| `nova-relay recommend [--json]` | 基于本机记录的路由证据（`run/routing-evidence.jsonl`：每个任务终态时的类型、执行者、PASS/FAIL、重试、耗时、**已报告**的费用/token）给出**建议**：每个任务类型 × 执行者的样本数、通过率及 95% Wilson 区间、置信度（< 5 个样本 = `insufficient data`，< 15 low，< 40 medium，否则 high）、耗时中位数、平均重试、已测费用均值。只有双方都 ≥ 5 个样本且 95% 区间不重叠时才建议换执行者。**从不自动修改路由**：`routing.rules` 与 `routing.reroute_paused` 只能由你编辑配置来改 |
| `nova-relay snapshot [--out DIR]` | 元数据快照，写入新的 0700 目录（文件 0600，默认 `<home>/snapshots/snap-<时间>-<随机>`；目录必须不存在或为空）：任务的 state/journal/brief/progress/result/events/approvals/decisions/墓碑、批次视图与墓碑、outbox（含已发送记录，用于去重）、暂停/预算/通知计数/事故/路由证据，外加 `config.redacted.json`（执行者 `env` 的值被替换、全文脱敏）和带 sha256 的 `manifest.json`。**默认排除**：`secrets.env` 与任何密钥值、项目 `env_file` 内容、执行者凭据（`~/.claude`、`~/.codex`、`credential_files`）、ssh 密钥、分段日志、租约/锁/PID、worker/心跳/主机状态文件、CLI 契约缓存、交接 bundle；home 里的符号链接不跟随（列为 skipped）。**git 仓库、`nova/<task>` 分支与 worktree 不在快照里，恢复快照也不会恢复它们**。worker 运行时逐个文件复制，想要一致的快照请在 worker 空闲时做 |
| `nova-relay restore --from DIR --dest DIR [--replay-outbox] [--json]` | 恢复演练。`--dest` **必填**，必须不存在或为空，不能是在用的 home、在其内部或包含它，也不能与快照目录重叠。写入前先全部校验，任何一项失败**什么都不写**：清单格式与版本（比本程序新的 state schema / 快照格式拒绝）、每个路径（相对、无 `..`/绝对路径/反斜杠、在白名单内——防 zip-slip）、源文件必须是普通文件（不是符号链接）且真实位于快照内、sha256 一致、批次 ↔ 任务引用完整（coordinator 的快照：任务引用的批次存在，批次里已送达本主机的任务存在或有墓碑）。恢复后：**不启动 worker**；不恢复租约与 PID；`queued`/`running`/`paused` 的任务改为 `blocked`（原因注明“从快照恢复，未自动续跑，worktree/分支不在快照里”）；待发的 outbox 移到 `outbox/held/`，**不会发送**（除非显式 `--replay-outbox`）；写 `RESTORED.json` |
| `nova-relay migrate --dry-run [--from DIR] [--json]` | 升级/回滚计划：本版本能读什么（state/batch schema、配置 schema、快照格式）、不能读什么（比本程序新的 schema：拒绝，从不改写），扫描在用的 home（或 `--from` 指定的快照）按 schema 计数，回滚步骤，以及快照**不包含**的内容。只支持 `--dry-run`（本版本没有需要执行的迁移）；有读不了的文件时退出码 1 |

## 退出码

`0` 成功；`1` 失败（含 doctor 有 FAIL、accept FAIL、`migrate --dry-run` 发现读不了的文件、`restore` 校验失败）；`2` 用法错误（含不带 `--dry-run` 的 `migrate`）；`3` 配置错误。

`dispatch` 的退出码只是摘要，真正的答案是 `--json` 的结果：

| 退出码 | 含义 | 调用方该怎么做 |
|---|---|---|
| `0` | 每个任务都已确认送达（或带键的批次早已 ack 并被 gc：`retired`） | 结束本轮，等唤醒 |
| `75` | 至少一个任务送达情况**未知**（提交与 fence 都没得到答案），或读不到结果 | 可以用**同一个** `--key` 重试（安全，不会重复）；不带键时**不要**重新 dispatch，coordinator 的 tick 会继续对账 |
| `1` | 送达情况都已知，且至少一个任务确认没送达（`FAIL submit`，已 fence）或被放弃 | 不要自动重派；告诉用户 |
| `4` | 同一个 `--key` 已经用于不同的任务书/项目/owner | 什么都没派发；换一个键或用原来的任务书 |

## dispatch / batch 的 JSON 结果

`dispatch --json` 输出 `{batch, key, created, resumed, tasks, errors, outcome, exit_code}`；`batch --json` 是批次视图加 `outcome`。`outcome`：

```json
{ "schema": 1, "batch": "b-k-…", "key": "job-42", "status": "unreconciled|in_progress|terminal|retired",
  "verdict": "WAIT|PASS|FAIL", "acked": false, "line": "batch … WAIT 0/1 | …",
  "tasks": { "t-k-…-0": { "delivery": "unknown|delivered|not_delivered|abandoned", "state": "submitting", "verdict": null, "host": "box", "executor": "claude" } } }
```

- `delivery`：`unknown` 尚未对账（可能存在也可能不存在，失败时可能带 `submit_error`）；`delivered` 主机有这个任务（提交回复、fence 找到、或主机上报过）；`not_delivered` 已 fence——主机确认没创建、以后也不会创建；`abandoned` 运维员放弃了该主机，那里实际在跑什么未知（被忽略的迟到上报在 `late_report_ignored`）。
- `status`：`unreconciled` 有任何 `unknown`（批次不会结束，`ack` 被拒）；`in_progress` 都已知但还有没结束的；`terminal` 全部终态，`verdict` 为 PASS/FAIL；`retired` 已 ack 并被 gc，只剩最后一行结论。

## 任务状态

批次视图里还有 `submitting`：已登记、尚未确认送达执行主机（非终态，批次显示 WAIT）；`abandoned`：运维员用 `abandon` 放弃（终态、算失败，只出现在 coordinator 的批次视图里，执行主机上没有这个状态）。任务：`queued` → `running` → `done` / `failed` / `cancelled`（终态）；中间态 `paused`（额度/预算/网络退避，自动继续）；需要人：`needs_approval`、`needs_auth`、`blocked`；`moved`：本机副本已交接给另一台主机（额度改路由），以那台主机上的状态为准。
