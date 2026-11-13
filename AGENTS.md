# AGENTS.md — nova-relay 配置向导（给 AI Agent / Grok Bot）

> 用户把本仓库发给你时，按下面 6 步配置。每步写明：你做什么、**必须由用户做什么**、完成标准。
> 任何一步失败就停下来如实告诉用户，不要绕过。
> 铁律：不要求用户在聊天里发送任何密钥；不开放端口；不使用 `--bare` 或任何第三方 API 网关；不在本轮里长时间阻塞等待。

## 步骤 1：确认拓扑

向用户确认：
- box（你所在、可能睡眠的机器）与 VPS / mm01（常开）的 Tailscale 名称，两边能否互相 `ssh`（密钥登录）。
- 项目列表（如 PD、NM）：每个项目在 box 与 VPS 上的仓库路径、基准分支、owner 名。
- 要启用哪些执行者（claude / codex / pi / deepseek-text）。
- 运行中的任务碰到额度/预算时是否改路由（`routing.reroute_paused`：`off` 默认 / `same-host` / `any`，见 `docs/config.md`）。

完成标准：拿到上述信息（不含任何密钥）。

## 步骤 2：安装（box 与 VPS 各一次）

你执行（box）：
```bash
node -v      # >= 22
git --version   # >= 2.38
git clone <本仓库> ~/src/nova-relay && cd ~/src/nova-relay && ./install.sh --systemd box
```
VPS 上由用户（或你经 ssh，经用户同意）执行同样步骤，参数 `--systemd vps`。启用定时器的命令由 `install.sh` 打印，需用户确认后执行。

完成标准：两台机器 `nova-relay version` 正常输出。

## 步骤 3：执行者登录（必须由用户完成）

- box：用户运行 `claude` 并以**订阅账号** `/login`。
- VPS：用户运行 `codex login`（ChatGPT 账号）；安装 `pi`。
- DeepSeek key、webhook URL/key：用户自己写入 VPS 的 `~/.config/nova-relay/secrets.env`（0600）。

你只验证，不接触值：`nova-relay doctor` 中 `executor * auth` 为 OK。经用户同意后可再跑 `nova-relay doctor --live`（真实检查：claude 必须是 claude.ai 订阅登录、codex 不能是 API key 登录、DeepSeek key 有效；不调用模型），`executor * live` 应为 OK。

## 步骤 4：配置

根据步骤 1 的信息编辑 `~/.config/nova-relay/config.json`（模板 `config/nova-relay.example.json`，说明 `docs/config.md`），先把 diff 给用户确认。两台机器用同一份配置，`self` 分别为 `box` / `vps`。

完成标准：两台机器 `nova-relay config-check` 输出 OK，`nova-relay doctor` 无 FAIL（未安装的执行者除外）。

## 步骤 5：Grok Routine 与技能

- 用户在 Grok 平台按 `routines/grok-wake.md` 为每个项目创建 Webhook Routine，替换 `<OWNER>`；生成的 URL/Bearer key 由用户写入 VPS 的 secrets.env（见步骤 3）。
- 加载技能：`skills/nova-relay-dispatch/SKILL.md`、`skills/nova-relay-setup/SKILL.md`。

完成标准：VPS 上 `nova-relay doctor` 的 `webhook <P>` 为 OK。

## 步骤 6：冒烟测试（不阻塞）

1. 按 `docs/setup-box.md` 第 6 节写一个最小任务书并 `nova-relay dispatch --project <P> --owner <OWNER> /tmp/smoke.md`。
2. 告诉用户已派发，**结束本轮**。
3. 被 webhook 唤醒后按 Routine 处理：`pending` → `batch` → 抽查分支 `nova/<task>` 上的文件 → 汇报 → `ack`。
4. 再次 `nova-relay pending --owner <OWNER>` 应为空。

完成标准：批次 PASS、抽查通过、ack 后 pending 为空。之后提醒用户按 `docs/failure-modes.md` 末尾的清单实测睡眠/重启/断网恢复——这些只能实测，不能凭测试通过就宣称可靠。
