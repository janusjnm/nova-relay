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
- Pi coding agent：`npm i -g @earendil-works/pi-coding-agent`（原 `@mariozechner/pi-coding-agent` 已弃用），`pi --version`。配置里 pi 与 deepseek-text 的 `model` **必须由你显式填写**（没有默认值，示例配置里是占位符 `<DEEPSEEK_MODEL_ID>`）：从 DeepSeek `GET /models` 返回的列表里选一个 id；`nova-relay doctor --live` 会核对该 id 是否原样在列表中，不在或列表读不到都是 FAIL。pi 自带的模型目录不作为依据。
- DeepSeek API key（pi 与 deepseek-text 共用，变量名可配置，默认 `DEEPSEEK_API_KEY`）。

## 2. 安装

```bash
git clone <repo> ~/src/nova-relay && cd ~/src/nova-relay
./install.sh --systemd vps
systemctl --user daemon-reload
systemctl --user enable --now nova-relay-watchdog.timer
loginctl enable-linger "$USER"
```

`install.sh` 会记录当前 `node` 的绝对路径（`bin/.node-path`），所以经 ssh 或 systemd（PATH 很短）调用 `nova-relay` 时也能找到用 nvm 等方式安装的 Node；同目录下 `npm -g` 安装的 `codex`/`pi` 也会加入 PATH。若执行者 CLI 在别处，请在配置里写 `bin` 的绝对路径。

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

与 box 共用同一份 `config.json`，VPS 上 `self` 为 `vps`（或设置 `NOVA_RELAY_HOST=vps`）。`coordinator` 必须是 `vps`：它常开，box 睡眠时仍能检测心跳缺失并发出通知 webhook（通知不会唤醒 box）。

## 5. watchdog 做什么

每 5 分钟：

1. `tick`：flush outbox（重发失败的 webhook / rpc）、续跑本机过期租约的任务、检查 box 心跳、gc。
2. **检测 + 让运行中的 box 续跑**：对每个运行执行者的远端主机（box）执行 `ssh box nova-relay rpc resume-all`（1/4/16 s 退避重试 3 次）。box 在运行、但上面的 claude 分段进程死了或冻结过久 → 从 checkpoint + progress 续跑（幂等）。
3. **ssh 不通**（box 睡眠、关机、Tailscale 断开）：watchdog 只记录 `unreachable_since`（`~/.nova-relay/run/host-box.json`，`doctor` 会显示），**什么也做不了**——ssh 不能唤醒或解冻一台挂起的机器，watchdog 也不能。
4. **通知**：box 运行时它的 tick 每 5 分钟向 VPS 推心跳；超过 `heartbeat_miss_minutes`（默认 15）没收到，且该批次还有 box 上的未完成任务 → 每次中断发一次 `box_unreachable` webhook。它只唤醒 Grok 的 Routine 告诉用户，不会唤醒 box。
5. **恢复后续跑**：box 再次运行后，它自己的 tick 定时器或下一次连上它的 watchdog 会续跑任务。在此之前 box 上的任务只能等待。

> 这是检测 + 通知 + 主机恢复后的续跑，**不是可用性保证**，没有零停机，也不会让睡着的 box 醒来。部署后请按 [failure-modes.md](failure-modes.md) 的「必须实测的项目」实测。

## 6. 验证

```bash
nova-relay doctor
nova-relay doctor --live # 可选：实查 codex 登录方式（必须是 ChatGPT 订阅）与 DeepSeek key
nova-relay watchdog      # 手动跑一次，看 hosts.box：reachable / unreachable_since / resume 结果
nova-relay outbox        # 有无积压/死信
```
