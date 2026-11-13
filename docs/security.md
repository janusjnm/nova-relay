# 安全：守卫、审批、密钥与提示词注入

## 威胁模型

执行者（Claude Code / Codex / Pi）会读仓库内容，可能读到恶意指令（提示词注入），也可能"幻觉"出危险操作。nova-relay 的目标：**执行者只能在自己的 worktree 里改代码**，不能发消息、花钱、推送、改远端或主机配置、读凭据；做不到的事进入人工审批。

## nova-guard（原 pi-guard）

规则在 `lib/guard.mjs`，所有执行者共用同一个判定函数（`lib/approvals.mjs#guardDecision`）：

| 类别 | 拦截示例 |
|---|---|
| disaster | `rm -r` 目标为 `/`、`~`、`$HOME`、`/home`、`/etc`、`/workspace`、`..`、`*`、`.` 等；`find / -delete`；`mkfs*`；`dd of=/dev/*`；`git filter-branch` |
| push | **任何** `git push`（force / 删除 / `+refspec` / 保护分支会特别标注）——执行者从不推送，合并由 owner 完成 |
| remote | `git remote add/set-url`、`git config --global`、`gh` 写操作、`npm/cargo/twine publish` |
| egress | `ssh/scp/nc/telnet/mail`、`rsync host:`、`curl/wget` 上传或 POST、访问不在 `guard.allow_hosts` 的主机 |
| system | `crontab`、`systemctl`、`tailscale`、`reboot/shutdown`、防火墙、对 `/` 或 `~` 的递归 chmod/chown |
| secrets | `env`/`printenv`/`export -p` 全量输出、读取 `~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.ssh/`、`.netrc` 等 |
| path | 写 worktree 以外（`/tmp` 除外）或写入 `forbidden_paths` |

复合命令（`;`、`&&`、`|`）、`$(...)`、反引号、`bash -c '...'` 都会拆开逐段检查。

接入方式：

- **Claude Code**：通过 `--settings` 注入 PreToolUse hook（`bin/nova-guard-hook.mjs`），覆盖 Bash/Edit/Write/MultiEdit/NotebookEdit；hook 以退出码 2 拒绝并把原因返回给 Claude。默认禁用 WebFetch/WebSearch。
- **Pi**：始终加载 `extensions/nova-guard.ts`，没有关闭开关。
- **Codex**：没有逐命令 hook，依赖 `codex exec --sandbox workspace-write`（只能写工作目录、默认无网络）；禁止在配置里传入沙箱绕过参数。另外所有执行者共同受验收阶段的 forbidden-path / 范围 / 测试篡改检查约束。
- **deepseek-text**：没有 shell 与文件访问。

## 审批流程

```
执行者尝试危险操作 → guard 拦截，写 approvals.jsonl {req, kind, subject(已脱敏), category, reason}
                     → 告诉执行者"跳过这一步继续，不要换写法绕过"
分段结束 → 任务 needs_approval → coordinator 唤醒 Grok（state=needs_approval）
Grok 把命令原样给用户看 → 用户决定
  nova-relay approve <task> <req> --owner <bot>   → 精确匹配的命令放行，任务继续
  nova-relay deny    <task> <req> --owner <bot>   → 记为拒绝，同一命令再出现直接拒绝，任务继续
```

- Grok **永远不能自行批准**，必须由用户明确同意（见 routine 模板）。
- 合并冲突也走同一流程（kind=merge）：approve = 由人处理合并，任务记为 done；deny = failed。
- `--owner` 不匹配会被拒绝。

## 密钥

- 只来自环境变量或仓库外的 `~/.config/nova-relay/secrets.env`（必须 0600，否则拒绝加载）与项目 `env_file`。
- 配置文件里只写**变量名**（`url_env`/`key_env`）。
- 执行者子进程环境会剔除：名字匹配 `WEBHOOK|NOVA_RELAY_*|*_KEY|*_TOKEN|SECRET|PASSWORD` 的变量、`SSH_AUTH_SOCK`、以及各适配器的网关/API key 变量（例外：pi 所需的 `key_env`）。
- `events.jsonl`、分段日志、`progress.md`、`result.md`、审批记录都经过脱敏（常见 key/token 格式、Bearer 值、私钥块、以及所有已知密钥值）。
- webhook payload 只有 `{source,batch,id,state,exit_code}`；URL 只允许 HTTPS 或 Tailscale 地址；不开放任何端口。

## 分支与推送

- 每个任务在 `nova/<task-id>` 分支的独立 worktree 中工作；nova-relay 只在该分支上做 checkpoint commit，**从不 push、从不合并到 base**。
- 合并、推送、发布都由 owner 在审阅后亲自完成。

## 已知局限

- guard 是基于词法的规则，不是沙箱；它能挡住常见的危险写法，挡不住刻意混淆的代码（例如写一个脚本文件再执行）。真正的边界还包括：worktree 隔离、子进程环境剔除密钥、验收阶段的路径/测试检查、以及"不 push"的流程。高风险项目请在容器或独立用户下运行执行者。
- Codex 的约束依赖其自身沙箱实现。
