# VPS / mm01 安装（coordinator + codex / pi / deepseek-text + watchdog）

VPS 常开，承担：批次视图与 webhook 发送（coordinator）、运行 `codex`、`pi`、`deepseek-text` 执行者、每 5 分钟 watchdog。

## 1. 前提

- Node.js ≥ 22，git ≥ 2.38，Tailscale 已登录，能 `ssh box`（box 的 MagicDNS 名）且使用密钥登录（`BatchMode=yes`，不能交互输密码）。
- **不要开放任何公网端口**：nova-relay 不监听端口，主机间只走 Tailscale 上的 ssh；webhook 是向外的 HTTPS 请求。
- 官方 Codex CLI，用 ChatGPT 订阅登录：
  ```bash
  npm i -g @openai/codex
  codex login            # 选择 ChatGPT 账号登录；不要设置 OPENAI_API_KEY / OPENAI_BASE_URL
  ```
- Pi coding agent：`npm i -g @earendil-works/pi-coding-agent`，`pi --version`。
- DeepSeek API key（pi 与 deepseek-text 共用，变量名可配置，默认 `DEEPSEEK_API_KEY`）。

## 2. 安装

```bash
git clone <repo> ~/src/nova-relay && cd ~/src/nova-relay
./install.sh --systemd vps
systemctl --user daemon-reload
systemctl --user enable --now nova-relay-watchdog.timer
loginctl enable-linger "$USER"
```

没有 systemd 时用 cron（效果相同）：

```cron
*/5 * * * * $HOME/.local/bin/nova-relay watchdog >> $HOME/.nova-relay/run/watchdog.log 2>&1
```

## 3. 密钥

全部写入 `~/.config/nova-relay/secrets.env`（`install.sh` 已建好，权限必须 0600，否则 nova-relay 拒绝加载）：

```bash
PD_NOVA_WEBHOOK_URL=https://<grok-routine-webhook>
PD_NOVA_WEBHOOK_KEY=<bearer token>
NM_NOVA_WEBHOOK_URL=https://<grok-routine-webhook-for-nm>
NM_NOVA_WEBHOOK_KEY=<bearer token>
DEEPSEEK_API_KEY=<key>
```

- webhook URL 只允许 `https://` 或 Tailscale 地址（`*.ts.net` / `100.64.0.0/10`）。
- 这些变量**不会**传给执行者子进程（名字含 KEY/TOKEN/SECRET/WEBHOOK 的变量都会被剔除，`pi` 的 `key_env` 是唯一例外）。
- 不要把密钥写进仓库、任务书或聊天。

## 4. 配置

与 box 共用同一份 `config.json`，VPS 上 `self` 为 `vps`（或设置 `NOVA_RELAY_HOST=vps`）。`coordinator` 必须是 `vps`：它常开，能在 box 睡眠时发送 webhook。

## 5. watchdog 做什么

每 5 分钟：

1. `tick`：flush outbox（重发失败的 webhook / rpc）、续跑本机过期租约的任务、检查 box 心跳、gc。
2. 对每个运行执行者的远端主机（box）：`ssh box nova-relay rpc resume-all`（1/4/16 s 退避重试 3 次）。box 上发现 claude 分段进程死亡或冻结过久 → 从 checkpoint + progress 续跑（幂等）。
3. ssh 不通 → 降级为心跳模式：box 的 tick 每 5 分钟向 VPS 推心跳；超过 `heartbeat_miss_minutes`（默认 15）没收到，且该批次还有 box 上的未完成任务 → 发一次 `box_unreachable` webhook，Grok 醒来后在 box 上执行 `nova-relay resume --all`。

> 这是**尽力而为**的恢复，不是可用性保证。部署后请按 [failure-modes.md](failure-modes.md) 的「必须实测的项目」实测。

## 6. 验证

```bash
nova-relay doctor
nova-relay watchdog      # 手动跑一次，看 hosts.box 的结果
nova-relay outbox        # 有无积压/死信
```
