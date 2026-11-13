# 命令参考

所有时间内部为 UTC，显示为 `display_tz`（默认 Asia/Singapore）。需要 coordinator 的命令（`pending`/`verdict`/`batch`/`ack`）在非 coordinator 主机上会自动经 ssh 转发；任务命令（`status`/`approve`/`deny`/`cancel`）会先查本机任务库，再向 coordinator 查询任务所在主机。

## Grok（规划者）使用

| 命令 | 说明 |
|---|---|
| `nova-relay brief-template` | 打印任务书模板 |
| `nova-relay dispatch --project P [--owner O] a.md b.md …` | 校验任务书 → 路由 → 在 coordinator 登记批次 → 提交到各执行主机并启动 worker；打印 `batch <id>` 与每个任务的执行者。**立即返回**，Grok 随即结束本轮 |
| `nova-relay pending [--owner O]` | 需要处理的批次，每批一行（为空 = 无事可做，保持安静） |
| `nova-relay verdict <batch>` | 一行结论：`batch <id> PASS\|FAIL\|WAIT done/total \| <非 done 任务…>` |
| `nova-relay batch <batch> [--json]` | 每个任务的状态、执行者、verdict、原因 |
| `nova-relay status <task> [--json]` | 任务详情（分支、worktree、分段数、重试数、待审批请求） |
| `nova-relay log <task> [-n N]` | 最近事件（已脱敏） |
| `nova-relay approve <task> <req> --owner O` / `deny …` | 仅在用户明确决定后执行 |
| `nova-relay ack <batch> --owner O` | 抽查通过后确认；之后不再唤醒，worktree 被清理（分支保留） |
| `nova-relay cancel <task>` | 取消（运行中的分段会在下一次续租时被终止） |

## 运维

| 命令 | 说明 |
|---|---|
| `nova-relay doctor [--no-remote]` | 检查全部前提（见 failure-modes.md），有 FAIL 退出码 1 |
| `nova-relay config-check` | 只校验配置 |
| `nova-relay worker [--once]` | 运行本机可运行任务（通常由 dispatch / tick 自动后台启动） |
| `nova-relay resume --all` | 幂等：续跑租约失效的任务、到期的 paused 任务 |
| `nova-relay tick` | 定时器入口：心跳 → resume → 心跳检查（coordinator）→ flush outbox → gc |
| `nova-relay watchdog` | VPS 定时器入口：tick + 经 ssh 让各执行主机 resume |
| `nova-relay heartbeat` | 手动向 coordinator 推心跳 |
| `nova-relay unpause <executor>` | 重新登录/充值后解除暂停，并把 needs_auth/paused 任务重新排队 |
| `nova-relay accept <task>` | 手动重跑验收，打印 `PASS` / `FAIL <where>` |
| `nova-relay outbox [--flush]` | 查看/重发待发消息与死信 |
| `nova-relay gc` | 清理 ack 后的 worktree，及超过保留期的任务/批次/outbox |
| `nova-relay rpc <method>` | 主机间调用（stdin/stdout JSON），供 ssh 使用 |

## 退出码

`0` 成功；`1` 失败（含 doctor 有 FAIL、accept FAIL）；`2` 用法错误；`3` 配置错误。

## 任务状态

`queued` → `running` → `done` / `failed` / `cancelled`（终态）；中间态 `paused`（额度/预算/网络退避，自动继续）；需要人：`needs_approval`、`needs_auth`、`blocked`。
