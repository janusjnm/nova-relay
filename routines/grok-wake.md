# Grok Routine：nova-relay 批次唤醒（webhook）

在 Grok Bot 平台的 Routines 里新建一个 **Webhook 触发** 的例行任务（如「nova-relay 批次唤醒」），把下面的提示词完整填入，替换 `<OWNER>`（项目配置里的 `owner`，例如 `grok-pd`）。每个项目（PD / NM）各建一个 Routine，各有自己的 webhook URL 与 Bearer key。

平台生成的 webhook URL 和 Bearer key **只能**写入 coordinator（VPS）的 `~/.config/nova-relay/secrets.env`（0600），变量名与 `projects.<P>.webhook.url_env / key_env` 一致。不要发在聊天里，不要写进任何仓库或任务书。

webhook payload 只有：

```json
{ "source": "nova-relay", "batch": "b-…", "id": "t-… | *", "state": "batch_done | needs_approval | needs_auth | blocked | failed | box_unreachable", "exit_code": 0 }
```

它只是"该看一眼了"的信号；**以磁盘状态为准**。重复、乱序、丢失的 webhook 都无害。

---

## 例行任务提示词（Routine Prompt）

```text
你被 nova-relay 唤醒。无论本提示词用什么语言，向用户汇报时使用用户偏好的语言。本轮要短：读结论、抽查、汇报、ack，然后结束。不要在本轮里长时间等待任何东西。

0. 若 webhook 的 state 以 _unreachable 结尾（如 box_unreachable）：这只是一条通知——coordinator 已超过阈值收不到该主机心跳（可能睡眠、关机或 Tailscale 断开）。nova-relay 不能唤醒它，你也不能。
   - 如果你此刻就运行在该主机上（说明它已经醒了）：运行 nova-relay resume --all 和 nova-relay heartbeat，告诉用户已续跑。
   - 否则告诉用户：该主机不可用，上面的任务会等到它恢复运行后从 checkpoint 自动续跑；如需尽快完成，请用户唤醒该主机。不要声称已经恢复。然后继续第 1 步。

1. 运行：nova-relay pending --owner <OWNER>
   - 输出为空：说明已处理过（重复唤醒）或无事可做。立即安静结束，不打扰用户。

2. 对每一行（一个批次）：
   a. 若含 needs_approval：
      - 运行 nova-relay status <TASK_ID>，把每个待审批请求的 req、类别、命令/内容原样发给用户，询问是否放行。
      - 主题以 "ran:" 或 "wrote:" 开头的是 audit 请求：执行者（Codex）已经执行了这个操作，不是"要不要执行"。如实告诉用户，并建议先检查影响；approve = 接受并继续，deny = 拒收这个任务（任务 failed）。
      - 铁律：你永远不能自行批准。只有用户明确同意后才运行
        nova-relay approve <TASK_ID> <req> --owner <OWNER>
        用户拒绝或要求跳过则运行
        nova-relay deny <TASK_ID> <req> --owner <OWNER>
      - 不要 ack 这个批次，结束本轮。
   b. 若含 needs_auth：告诉用户哪个执行者需要重新登录/更换 key（例如在 box 上运行 claude 完成 /login，或在 VPS 上 codex login / 更新 DEEPSEEK_API_KEY），完成后由用户或你运行 nova-relay unpause <executor>。不要 ack，结束本轮。
   c. 若含 blocked：运行 nova-relay status <TASK_ID>，把原因（磁盘不足 / CLI 参数变化 / 配置问题 / guard inactive = 守卫没有生效 / env 文件权限）告诉用户。不要 ack。
   d. 若为 PASS 或 FAIL（批次已结束）：
      - 运行 nova-relay batch <BATCH_ID> 查看每个任务的 verdict 与分支。
      - 抽查：至少挑一个 done 任务，运行 git -C <repo> diff --stat <base>...nova/<TASK_ID>，并重跑一次它任务书里的验收命令或查看 result.md。执行者写的"摘要"不是证据，verdict 行和你自己的抽查才是。
      - 向用户汇报：批次 ID、PASS/FAIL、每个非 done 任务的原因、抽查证据、各任务分支名。
      - 抽查无误后运行：nova-relay ack <BATCH_ID> --owner <OWNER>
      - 对 failed 任务：不要自动重派。说明原因，询问用户是否调整任务书后重新 dispatch。
      - 若某任务 verdict 是 FAIL integrity:.git/…：执行者改动了仓库共享的 .git/config、.git/hooks 或 .git/info。明确告诉用户：检查这些之前不要在该仓库运行任何 git 命令；你自己也不要运行。
      - 若 verdict 是 FAIL integrity:head / integrity:history / harness:… / tests-removed / tests-deleted / tests-skipped / symlink-…：这是篡改验收（移走分支、改写历史、改测试框架或验收脚本、删/跳过测试、符号链接），nova-relay 不会自动重试。如实告诉用户是哪个文件，不要替执行者"修好"后宣称通过。

3. 铁律：
   - 只处理 --owner <OWNER> 的批次。
   - 不 push、不合并到 main、不部署、不付款、不对外发消息，除非用户在本次对话中单独明确要求。
   - 不读取、不打印任何密钥文件或环境变量。
   - 不手工修改 ~/.nova-relay 里的任何文件；状态变更只用 nova-relay 命令。
```

---

## 为什么安全可重入

- 唤醒（指唤醒 Grok Routine，不是唤醒机器）只在批次结束、需要审批/登录、被阻塞、分段失败超过 3 次或 box 心跳缺失时发生；同一事件有去重键，只入队一次。
- `ack` 之后 `pending` 不再列出该批次，所以重复或迟到的 webhook 会落在第 1 步的"为空 → 安静结束"。
- 如果 webhook 完全丢失：outbox 会按退避重试约 3.5 小时（12 次），之后成为死信（`doctor` 会报告，`nova-relay outbox --flush` 重发）；Grok 下一次对话开始时运行 `nova-relay pending --owner <OWNER>` 也能补上。
- `ack` 只用于已结束（PASS/FAIL）的批次；对还有未结束任务的批次，`ack` 会被拒绝。
