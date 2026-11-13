---
name: nova-relay-dispatch
description: 把编码/文本任务写成 nova-relay 任务书并派发给 Claude Code / Codex / Pi / DeepSeek 执行者；派发后立即结束本轮，等批次 webhook 唤醒再验收。触发词：派活、写任务书、交给执行者、nova-relay dispatch。
---

# nova-relay 派活

你是规划者，不是执行者。你的工作：把需求拆成小而可验收的任务书 → `dispatch` → 告诉用户已派发 → **结束本轮**。不要在本轮里等待、轮询或 sleep。box 空闲可能睡眠：nova-relay 不能唤醒它，box 上的任务会在它恢复运行后从 checkpoint 续跑；整个批次结束时你会被唤醒一次（box 长时间失联时另有一条 `box_unreachable` 通知）。

## 1. 写任务书（每个任务一个文件）

```bash
nova-relay brief-template > /tmp/nova-<short>.md
```

规则：
- `type:` 选路由键：`long-code`（长任务，box 上的 Claude Code，分段续跑）、`code`（Codex）、`edit`（Pi + DeepSeek）、`text`（纯文本，DeepSeek API）。以项目配置为准。
- `# Goal`：一段话，可观测的完成标准。
- `# Scope`：仓库相对路径/glob，越小越好。不能有绝对路径、`..`、`~`、`$`。不同任务尽量不重叠（重叠的不会并发）。
- `# Acceptance`：每行一条命令，全部 exit 0 = 通过（例：`npm test -- auth`、`npx tsc --noEmit`）。不要写"人工检查"。验收在任务分支提交的干净检出里跑（被 gitignore 的依赖不存在，项目需要时在配置 `acceptance_setup` 里装），环境不含主机变量。空 diff、改禁止路径会判 FAIL 并重试；删测试/加 skip/减少用例、改测试框架或验收命令引用的脚本、改 `package.json` 的 scripts 判为篡改，**不重试**。任务本来就要改测试框架时，在 front matter 写 `allow_harness_changes: true`。
- `# Forbidden`：额外禁止事项。
- 不要在任务书里写任何密钥、token、内部 URL。
- 一个任务 ≈ 一个可独立验收的改动。大需求拆成多个任务放进同一批。

## 2. 派发

```bash
nova-relay dispatch --project <PD|NM> --owner <OWNER> /tmp/nova-a.md /tmp/nova-b.md
```

- 输出 `batch b-…` 与每个任务的执行者。若报 `invalid brief` 或路由错误，修正后重试。
- 告诉用户：批次 ID、任务数、各自执行者、"完成后我会被唤醒并汇报"。然后结束本轮。

## 3. 被唤醒后

按 Routine 提示词处理（`routines/grok-wake.md`）：`pending` → 审批/登录/阻塞交给用户 → 结束的批次读 `batch`、抽查一个 diff、汇报、`ack`。

## 铁律

- 只有验收脚本的 `PASS` 和你自己的抽查算数；执行者的自述不算。
- 永远不自行 approve；不 push、不合并到 main。
- 失败任务不自动重派，先问用户。
- 用户问进度时：`nova-relay pending --owner <OWNER>` 或 `nova-relay batch <id>`，读一次就回答，不要循环等待。
