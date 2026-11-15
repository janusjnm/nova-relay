# box 安装（Grok Bot + Claude Code）

box = 运行 Grok Bot 的 Linux 机器，空闲时可能睡眠。它负责：Grok 派活、运行 `claude` 执行者、向 coordinator（VPS）推送心跳与任务状态。

## 1. 前提

- Node.js ≥ 22，git ≥ 2.38，Tailscale 已登录并能 `ssh mm01`（或你的 VPS MagicDNS 名）。
- **官方** Claude Code CLI，并用**订阅账号**登录：
  ```bash
  npm i -g @anthropic-ai/claude-code   # 或官方安装方式
  claude            # 交互式完成 /login（订阅登录），然后退出
  claude --version          # 需要 ≥ 2.0.0；已验证 2.1.308
  ```
  不要设置 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，不要使用任何第三方网关，不要使用 `--bare`。nova-relay 在启动 claude 前会主动剔除这些变量，配置里出现会直接校验失败。

## 2. 安装

```bash
git clone <repo> ~/src/nova-relay && cd ~/src/nova-relay
./install.sh --systemd box
systemctl --user daemon-reload
systemctl --user enable --now nova-relay-tick.timer
loginctl enable-linger "$USER"     # 无登录会话时定时器也运行
```

`install.sh` 只复制本地文件，不下载、不删除，重复运行安全；版本并排安装在 `~/.local/share/nova-relay/versions/<ver>`，`current` 原子切换。已有的 `config.json`/`secrets.env` 不会被覆盖；systemd 单元的 `ExecStart` 指向实际使用的 bin 目录（`NOVA_RELAY_BIN_DIR`），你改过的单元不会被覆盖，新版本写在旁边的 `<单元>.nova-new`。

配置目录：`install.sh` 把 `config.json` / `secrets.env` 写到 `$XDG_CONFIG_HOME/nova-relay/`（未设置或为空时 `~/.config/nova-relay/`），CLI 用同样的规则找它们（`NOVA_RELAY_CONFIG` / `NOVA_RELAY_SECRETS` 优先，见 [config.md](config.md)）。`XDG_CONFIG_HOME` 是相对路径时 `install.sh` 拒绝运行。使用非默认的 `XDG_CONFIG_HOME` 时，安装的 systemd 单元会带上 `Environment="XDG_CONFIG_HOME=…"`；单元本身也装在 `$XDG_CONFIG_HOME/systemd/user/`，只有 systemd 用户实例的环境里也是这个 `XDG_CONFIG_HOME` 时才会被加载（`systemctl --user cat nova-relay-tick.service` 确认）。交互式 shell 里同样要设置它，否则 `nova-relay` 会去 `~/.config/nova-relay` 找配置。

## 3. 配置

编辑 `install.sh` 打印的配置文件（默认 `~/.config/nova-relay/config.json`，设置了 `XDG_CONFIG_HOME` 时在 `$XDG_CONFIG_HOME/nova-relay/`；`nova-relay config-check` 会打印实际路径。模板见 `config/nova-relay.example.json`，字段见 [config.md](config.md)）。box 上关键项：

```json
{
  "self": "box",
  "coordinator": "vps",
  "hosts": {
    "box": { "role": "box", "ssh": "box" },
    "vps": { "role": "vps", "ssh": "mm01", "bin": "~/.local/bin/nova-relay" }
  }
}
```

box 与 VPS 使用**同一份**配置文件即可（`self` 可用环境变量 `NOVA_RELAY_HOST` 覆盖），项目路径按主机写成 `{ "box": "...", "vps": "..." }`。

项目私有环境变量（测试数据库等）放 `~/.config/nova-relay/pd.env`（0600），只注入 PD 的任务。`env_file` 是配置里写的路径，不随 `XDG_CONFIG_HOME` 变化。

## 4. 验证

```bash
nova-relay doctor          # 全部 OK / 合理 WARN
nova-relay doctor --live   # 可选：实查 claude 是订阅登录（claude auth status 的 authMethod 为 claude.ai）
ssh mm01 nova-relay rpc ping </dev/null    # box → VPS 通
```

再在 VPS 上执行 `ssh box nova-relay rpc ping </dev/null` 确认反向可达（watchdog 需要）。

## 5. 给 Grok 加载技能与 Routine

- 技能：`skills/nova-relay-dispatch/SKILL.md`、`skills/nova-relay-setup/SKILL.md`
- Routine：按 [routines/grok-wake.md](../routines/grok-wake.md) 在 Grok 平台创建 webhook 唤醒任务；webhook URL 与 Bearer key 填入 **VPS**（coordinator）的密钥文件（默认 `~/.config/nova-relay/secrets.env`，见 [config.md](config.md) 的位置规则），变量名与项目配置 `webhook.url_env/key_env` 一致。

## 6. 冒烟测试

```bash
cat > /tmp/smoke.md <<'EOF'
---
type: long-code
project: PD
---
# Goal
Create docs/nova-smoke.txt containing exactly: nova-ok

# Scope
- docs/nova-smoke.txt

# Acceptance
grep -qx nova-ok docs/nova-smoke.txt
EOF
nova-relay dispatch --project PD /tmp/smoke.md
# Grok 在这里结束本轮。几分钟后：
nova-relay pending --owner grok-pd
```

验收在任务分支提交的干净检出里运行（不是执行者的 worktree），被 gitignore 的 `node_modules/` 等不存在：项目 `checks` 需要依赖时，在项目配置里写 `acceptance_setup`（如 `["npm ci --silent"]`），否则冒烟测试会因缺依赖 FAIL。验收的 HOME 是空的（无 `~/.npmrc`、无包缓存），setup 通常要联网；装不上时 verdict 是 `FAIL setup:…`（任务 failed、唤醒，不重试），先检查网络/registry。

然后按 [failure-modes.md](failure-modes.md) 末尾「必须实测的项目」逐项实测睡眠/重启/断网恢复。
