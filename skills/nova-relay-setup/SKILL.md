---
name: nova-relay-setup
description: 配置、自检、修复 nova-relay（box + VPS）。触发词：配置 nova-relay、nova-relay 自检、doctor、执行者登录失效、webhook 不通。
---

# nova-relay 配置与自检

## 自检

```bash
nova-relay doctor
nova-relay doctor --live   # 用户同意后再跑：实查登录方式与 DeepSeek key（联网，不消耗模型额度）
```

逐条处理 FAIL / WARN（含义见 `docs/failure-modes.md`）：

| 项 | 处理 |
|---|---|
| `executor claude cli` | box 上安装/升级官方 Claude Code；参数缺失说明 CLI 变了 → 告诉用户，需要更新 nova-relay 适配器 |
| `executor * live` | `claude` 不是 `claude.ai` 订阅登录 / `codex` 是 API key 登录 / DeepSeek key 被拒 → 同下，请用户亲自处理；`model … not offered` / `not verified` → 配置里的模型 id 不在 DeepSeek `GET /models` 列表里（或列表读不到）。把 `doctor` 输出里的可用列表给用户，由用户选定后再改配置；**不要自己猜或换一个 id** |
| `config-check` 报 `model: required` / `placeholder` | pi / deepseek-text 没有默认模型，必须显式填写一个 DeepSeek `GET /models` 返回的 id |
| `executor * auth` | 请用户亲自登录（`claude` → `/login`；VPS 上 `codex login`；DeepSeek key 写入 VPS 的 `~/.config/nova-relay/secrets.env`），然后 `nova-relay unpause <executor>` |
| `webhook *` | 请用户把 Grok Routine 的 URL/Bearer key 写入 coordinator 的 secrets.env（0600），变量名见配置 `webhook.url_env/key_env`。**绝不**让用户在聊天里发送这些值 |
| `secrets file` | `chmod 600 ~/.config/nova-relay/secrets.env` |
| `host *` 不可达 | 检查 Tailscale（`tailscale status`）与 ssh 密钥，或 box 是否在睡眠/关机。nova-relay 不能唤醒它：在此期间只会检测并（心跳超时后）通知一次，box 上的任务等它恢复运行后续跑 |
| `leases` | `nova-relay resume --all` |
| `outbox` 死信 | 修好 webhook 后 `nova-relay outbox --flush`（会把死信恢复为待发并重发） |
| `disk` | 清理磁盘；`nova-relay gc` 只会删 ack 过的任务 |

## 边界

- 你可以运行 `doctor`、`resume --all`、`outbox --flush`、`gc`、`unpause`（用户确认已重新登录后）。
- 你不能：登录订阅账号、生成或查看密钥、开放端口、修改 `~/.nova-relay` 内的文件、启用 `--bare` 或任何第三方网关、关闭 guard。
- 修改 `~/.config/nova-relay/config.json` 前先给用户看 diff；改完运行 `nova-relay config-check`。
