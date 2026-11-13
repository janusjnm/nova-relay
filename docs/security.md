# 安全：守卫、审批、密钥与提示词注入

## 威胁模型

执行者（Claude Code / Codex / Pi）会读仓库内容，可能读到恶意指令（提示词注入），也可能"幻觉"出危险操作。nova-relay 的目标：**执行者只能在自己的 worktree 里改代码**，不能发消息、花钱、推送、改远端或主机配置、读凭据；做不到的事进入人工审批。

## nova-guard（原 pi-guard）

规则在 `lib/guard.mjs`，所有执行者共用同一个判定函数（`lib/approvals.mjs#guardDecision`）：

| 类别 | 拦截示例 |
|---|---|
| disaster | `rm -r` 目标为 `/`、`~`、`$HOME`、`/home`、`/etc`、`/workspace`、`..`、`*`、`.` 等；`find / -delete`；`mkfs*`；`dd of=/dev/*`；`git filter-branch` |
| push | **任何** `git push`（force / 删除 / `+refspec` / 保护分支会特别标注）——执行者从不推送，合并由 owner 完成 |
| remote | `git remote add/set-url`、`git config --global`、`git config` / `git -c` 设置 `alias.*`、`core.hooksPath`、`core.sshCommand`、`remote.*`、`url.*`、`credential.*`、`include*` 等、`gh` 写操作、`npm/cargo/twine publish` |
| egress | `ssh/scp/nc/telnet/mail`、`rsync host:`、`curl/wget` 上传或 POST、访问不在 `guard.allow_hosts` 的主机、`git send-email/daemon/svn/p4` |
| system | `crontab`、`systemctl`、`tailscale`、`reboot/shutdown`、防火墙、对 `/` 或 `~` 的递归 chmod/chown |
| secrets | `env`/`printenv`/`export -p` 全量输出、读取 `~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.ssh/`、`.netrc` 等 |
| path | 写 worktree 以外（`/tmp` 除外）或写入 `forbidden_paths`：Edit/Write 工具、shell 重定向（`>`、`>>`、`&>`）、`cp/mv/install/ln/tee/touch/mkdir/rm/chmod/sed -i/perl -i/dd of=` 的目标。目标里有无法解析的变量或命令替换（`> $OUT`）**默认拒绝**；`~`、`$HOME`、`$PWD`、`$TMPDIR` 会被展开。路径先解析符号链接（对尚不存在的路径取最深的已存在祖先的 realpath），所以 worktree 里放一个指向别的项目的链接也写不出去 |
| script | 执行者**可能自己写的**脚本（位于 worktree 或 `/tmp`）会被读出来检查：`bash x.sh`、`sh -x x.sh`、`./x`（按 shebang 判断）、`source`/`.`、`npm/pnpm/yarn/bun run <name>`（含 pre/post）、`make <target>`（Makefile 配方行）逐行按 shell 规则检查；`python/node/perl/ruby/php/deno/bun` 脚本及 `-c/-e` 内联代码做启发式扫描（能 shell-out 的代码里像命令的字符串、写 worktree 外或家目录、对外发送（`requests.post`、`smtplib`、`method: 'POST'`、socket）、base64 解码后执行）。读不到的执行者脚本**默认拒绝** |

复合命令（`;`、`&&`、`|`，双引号内不拆）、`$(...)`、反引号、`bash -c '...'` / `bash -lc '...'`（含 `-ec`、`-xc` 等组合短参数）都会拆开逐段检查；`2>&1` 这类重定向不会被误拆。

接入方式：

- **Claude Code**：通过 `--settings` 注入 PreToolUse hook（`bin/nova-guard-hook.mjs`），覆盖 Bash/Edit/Write/MultiEdit/NotebookEdit；hook 以退出码 2 拒绝并把原因返回给 Claude（已在 Claude Code 2.1.308 上实测：`git push origin main` 被拦下并生成审批请求）。hook 输入无法解析、或写工具没有路径时**拒绝**。默认禁用 WebFetch/WebSearch；`--setting-sources user --strict-mcp-config` 让仓库内的 `.claude/settings*.json` 与 `.mcp.json` 不生效。
  - **存活检查**：`claude -p` 对校验失败的 `--settings` 是静默忽略的（`claude --help` 原文），也就是守卫可能悄悄失效。hook 每次被调用都在任务目录的 `hook-calls` 记一笔；分段结束时，若 stream-json 里有受控工具调用而 hook 一次都没被调用，任务直接 `blocked` 并唤醒，不会继续、也不会判 done。
- **Pi**：始终以 `--extension` 加载 `extensions/nova-guard.ts`，没有关闭开关（配置里出现 `--no-extensions` 会校验失败）。扩展加载时写 `guard-loaded` 标记，分段成功结束却没有标记 → `blocked`。
- **Codex**：没有逐命令 hook。约束来自三层：① `codex exec --sandbox workspace-write`（只能写工作目录、默认无网络），禁止沙箱绕过参数与开启网络的覆盖；② **事后审计**：以 `--json` 运行，事件流里每一条执行过的命令与文件改动都过一遍同一个守卫，命中即生成 `audit` 审批请求（主题以 `ran:` / `wrote:` 开头），任务进入 `needs_approval`——用户 approve 则继续，deny 则任务 `failed`（操作已经发生，deny 表示拒收这份工作）；③ 所有执行者共同的验收阶段检查（见下）。注意：审计是**事后**的，它能发现并上报，不能阻止；事件格式依赖 Codex 版本，必须实测（failure-modes.md「必须实测」第 7 项）。

### 验收阶段的独立检查（对所有执行者）

- 共享仓库的 `.git/config`（remote、alias、hooksPath、credential helper）与 `.git/hooks/` 在任务开始时做快照，验收时比较；有变化 → `FAIL integrity:…`，不重试、立即升级。这类改动会让 owner 之后的 git 操作执行任意代码或把数据发出去。owner 自己在任务期间改了仓库配置也会触发，此时核对后重新派发即可。
- diff 中新增/修改的符号链接若指向 worktree 以外 → `FAIL symlink-escape:…`。
- 禁止路径、范围、删测试/加 skip、改 `test` 脚本、空 diff（见 failure-modes.md #8）。
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
- 执行者子进程环境会剔除：名字匹配 `WEBHOOK|NOVA_RELAY_*|*_KEY|*_KEY_*|*_TOKEN|SECRET|PASSWORD|CREDENTIAL|GH_*|GITHUB_TOKEN` 的变量、`SSH_AUTH_SOCK`、`GIT_ASKPASS`/`GIT_SSH`/`GIT_SSH_COMMAND`、整组 `GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS`（只删一部分会让执行者里的所有 git 命令报错），以及各适配器的网关/API key 变量（例外：pi 所需的 `key_env`，它会以 `DEEPSEEK_API_KEY` 的名字传给 pi）。验收命令同样拿不到这些变量，但能拿到项目 `env_file` 的变量。
- `events.jsonl`、分段日志、`progress.md`、`result.md`、审批记录都经过脱敏（常见 key/token 格式、Bearer 值、JWT、URL 中的密码、私钥块、以及所有已知密钥值）。分段日志按**整行**脱敏，密钥跨两个输出块也能被抹掉。Codex 的 `--output-last-message` 文件读取后即删除。
- 项目 `env_file` 必须是 0600，否则该项目的任务 `blocked`。
- webhook payload 只有 `{source,batch,id,state,exit_code}`；URL 只允许 HTTPS 或 Tailscale 地址；不开放任何端口。

## 分支与推送

- 每个任务在 `nova/<task-id>` 分支的独立 worktree 中工作；nova-relay 只在该分支上做 checkpoint commit，**从不 push、从不合并到 base**。
- 合并、推送、发布都由 owner 在审阅后亲自完成。

## 已知局限

- guard 是基于词法与启发式的规则，**不是沙箱**。脚本扫描能挡住常见写法（脚本里的 `git push`、写 `/etc`、`requests.post`、base64+exec），挡不住刻意混淆的代码（字符串拼接出命令、编译型程序、通过测试框架间接执行的代码等）。以下也不扫描：`node_modules/`、`.venv/`、`venv/`、`vendor/` 下的文件（视为包管理器安装的内容），worktree 与 `/tmp` 以外的脚本（执行者写不到那里）；`cd` 到别处后的相对路径按 worktree 解析。
- 验收命令（测试）本身会执行执行者写的代码，并且有网络——这是验收的本质。真正的边界还包括：worktree 隔离、子进程环境剔除密钥、验收阶段的 integrity/路径/测试检查、以及"不 push"的流程。高风险项目请在容器或独立用户下运行执行者与验收。
- Codex 的前置约束依赖其自身沙箱实现；nova-relay 的审计是事后的。
