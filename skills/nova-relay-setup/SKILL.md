---
name: nova-relay-setup
description: 配置、自检、修复 nova-relay（box + VPS）。触发词：配置 nova-relay、nova-relay 自检、doctor、执行者登录失效、webhook 不通。
---

# nova-relay 配置与自检

## 自检

```bash
nova-relay doctor
```

逐条处理 FAIL / WARN（含义见 `docs/failure-modes.md`）：

| 项 | 处理 |
|---|---|
| `executor claude cli` | box 上安装/升级官方 Claude Code；参数缺失说明 CLI 变了 → 告诉用户，需要更新 nova-relay 适配器 |
| `executor * auth` | 请用户亲自登录（`claude` → `/login`；VPS 上 `codex login`；DeepSeek key 写入 VPS 的 `~/.config/nova-relay/secrets.env`），然后 `nova-relay unpause <executor>` |
| `webhook *` | 请用户把 Grok Routine 的 URL/Bearer key 写入 coordinator 的 secrets.env（0600），变量名见配置 `webhook.url_env/key_env`。**绝不**让用户在聊天里发送这些值 |
| `secrets file` | `chmod 600 ~/.config/nova-relay/secrets.env` |
| `host *` 不可达 | 检查 Tailscale（`tailscale status`）与 ssh 密钥；在此期间心跳兜底会生效 |
| `leases` | `nova-relay resume --all` |
| `outbox` 死信 | 修好 webhook 后 `nova-relay outbox --flush` |
| `disk` | 清理磁盘；`nova-relay gc` 只会删 ack 过的任务 |

## 边界

- 你可以运行 `doctor`、`resume --all`、`outbox --flush`、`gc`、`unpause`（用户确认已重新登录后）。
- 你不能：登录订阅账号、生成或查看密钥、开放端口、修改 `~/.nova-relay` 内的文件、启用 `--bare` 或任何第三方网关、关闭 guard。
- 修改 `~/.config/nova-relay/config.json` 前先给用户看 diff；改完运行 `nova-relay config-check`。
