# 安全：守卫、审批、密钥与提示词注入

## 威胁模型

执行者（Claude Code / Codex / Pi）会读仓库内容，可能读到恶意指令（提示词注入），也可能"幻觉"出危险操作。nova-relay 的目标：**执行者只能在自己的 worktree 里改代码**，不能发消息、花钱、推送、改远端或主机配置、读凭据；做不到的事进入人工审批。

## nova-guard（原 pi-guard）

规则在 `lib/guard.mjs`，所有执行者共用同一个判定函数（`lib/approvals.mjs#guardDecision`）：

| 类别 | 拦截示例 |
|---|---|
| disaster | `rm -r` 目标为 `/`、`~`、`$HOME`、`/home`、`/etc`、`/workspace`、`..`、`*`、`.` 等；`find / -delete`；`mkfs*`；`dd of=/dev/*`；`git filter-branch` |
| push | **任何** `git push`（force / 删除 / `+refspec` / 保护分支会特别标注）——执行者从不推送，合并由 owner 完成；在本地移动保护分支：`git update-ref refs/heads/main …`、`git branch -f/-D main`、`git fetch . HEAD:main`、`git checkout -B main`、`--ignore-other-worktrees`、`git symbolic-ref` 写入 |
| remote | `git remote add/set-url`、`git config --global`、`git config` / `git -c` / `git --config-env` 设置 `alias.*`、`core.hooksPath`、`core.sshCommand`、`remote.*`、`url.*`、`credential.*`、`include*` 等、`gh` 写操作、`npm/cargo/twine publish`；设置 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_CONFIG_*`、`GIT_EXEC_PATH`、`GIT_SSH*` 等 `GIT_*` 环境变量（`GIT_AUTHOR_*`/`GIT_COMMITTER_*`/`GIT_TRACE*` 等无害变量除外）；无法识别的 git 全局参数默认拒绝 |
| egress | `ssh/scp/nc/telnet/mail`、`rsync host:`、`curl/wget` 上传或 POST、访问不在 `guard.allow_hosts` 的主机、`git send-email/daemon/svn/p4` |
| system | `crontab`、`systemctl`、`tailscale`、`reboot/shutdown`、防火墙、对 `/` 或 `~` 的递归 chmod/chown；`sudo/su/doas/pkexec/runuser`（被包装的命令更危险时报告其类别，如 `sudo rm -rf /` = disaster） |
| secrets | `env`/`printenv`/`export -p` 全量输出、读取 `~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.ssh/`、`.netrc` 等 |
| path | 写 worktree 以外（`/tmp` 除外）或写入 `forbidden_paths`：Edit/Write 工具、shell 重定向（`>`、`>>`、`&>`）、`cp/mv/install/ln/tee/touch/mkdir/rm/chmod/sed -i/perl -i/dd of=` 的目标。目标里有无法解析的变量或命令替换（`> $OUT`）**默认拒绝**；`~`、`$HOME`、`$PWD`、`$TMPDIR` 会被展开。同一条命令里前面的 `cd X` / `pushd X` 会改变相对路径的落点（`cd .. && rm -rf other` 会被拦下），`cd` 到无法解析的目录（`cd $X`、`cd -`）之后的相对写目标默认拒绝。路径先解析符号链接（对尚不存在的路径取最深的已存在祖先的 realpath），所以 worktree 里放一个指向别的项目的链接也写不出去。**换目录的参数**：`git -C`（可叠加，`-C a -C ..` 按顺序解析）、`git --git-dir/--work-tree`（`=` 与空格两种写法）、`make -C/-Cdir/--directory`、`npm --prefix/-C`、`pnpm -C/--dir`、`yarn/bun --cwd`、`env -C/--chdir`、`tar -x … -C`、`unzip -d`、`find` 的起点（配合 `-delete`/写类 `-exec`）——目标必须在 worktree 内（或 `/tmp`），解析不了（`-C "$X"`、`$(…)`）默认拒绝。其他写目标：`git diff/log --output`、`git format-patch -o`、`git worktree add`、`git clone/init <dir>`、`tar -cf <file>`、`curl -o/--output-dir`、`wget -O/-P`、`rsync` 本地目标、`time -o`、`flock <file>`、`find -fprint` |
| wrapper | 带参数的包装命令会先解析参数再检查真正的命令：`env -i/-u/-C/-S`、`nice -n`、`timeout -s … <时长>`、`time -p/-o`、`stdbuf`、`ionice`、`taskset`、`setsid`、`nohup`、`command`、`exec`、`flock … -c`、`watch`、`eval`、`xargs`。包装命令的参数看不懂 → 默认拒绝。`xargs` 后接写文件类命令（`rm`、`mv`、`cp`、`chmod`…）时目标来自 stdin，无法核验 → 拒绝 |
| env | 改变后续命令加载/执行内容的环境变量赋值（`X=… cmd`、`export`/`declare -x`/`env X=…`）：`PATH` 里出现执行者可写目录（worktree、`/tmp`、相对路径、`$PWD/…`；`node_modules/.bin` 也算）、`LD_*`、`BASH_ENV`/`ENV`、`NODE_OPTIONS`、`PERL5OPT`、`RUBYOPT`、`HOME`/`XDG_CONFIG_HOME`、`npm_config_*` |
| script | 执行者**可能自己写的**脚本（位于 worktree 或 `/tmp`）会被读出来检查，并且按**当前目录**解析（`cd sub && bash x.sh` 读的是 `sub/x.sh`；`npm test` 读从当前目录向上最近的 `package.json`；`make -C d` 读 `d/Makefile` 及其字面量 `include`，配方在 `d` 里解析）：`bash x.sh`、`sh -x x.sh`、`./x`（按 shebang 判断）、`source`/`.`、`npm/pnpm/yarn/bun run <name>`（含 pre/post）、`make <target>`（Makefile 配方行）逐行按 shell 规则检查；`python/node/perl/ruby/php/deno/bun` 脚本及 `-c/-e` 内联代码做启发式扫描（能 shell-out 的代码里像命令的字符串、写 worktree 外或家目录、对外发送（`requests.post`、`smtplib`、`method: 'POST'`、socket）、base64 解码后执行）。读不到的执行者脚本**默认拒绝** |

复合命令（`;`、`&&`、`|`，双引号内不拆）、`$(...)`、反引号、`bash -c '...'` / `bash -lc '...'`（含 `-ec`、`-xc` 等组合短参数）都会拆开逐段检查；`2>&1` 这类重定向不会被误拆。

接入方式：

- **Claude Code**：通过 `--settings` 注入 PreToolUse hook（`bin/nova-guard-hook.mjs`），覆盖 Bash/Edit/Write/MultiEdit/NotebookEdit；Bash 工具的当前目录会跨调用保留（上一次 `cd ..`、下一次 `rm -rf x`），hook 用输入里的 `cwd` 作为起点解析相对路径与脚本；hook 以退出码 2 拒绝并把原因返回给 Claude（已在 Claude Code 2.1.308 上实测：`git push origin main` 被拦下并生成审批请求）。hook 输入无法解析、或写工具没有路径时**拒绝**。默认禁用 WebFetch/WebSearch；`--setting-sources user --strict-mcp-config` 让仓库内的 `.claude/settings*.json` 与 `.mcp.json` 不生效。
  - **存活检查**：`claude -p` 对校验失败的 `--settings` 是静默忽略的（`claude --help` 原文），也就是守卫可能悄悄失效。hook 每次被调用都在任务目录的 `hook-calls` 记一笔；分段结束时，若 stream-json 里有受控工具调用而 hook 一次都没被调用，任务直接 `blocked` 并唤醒，不会继续、也不会判 done。
- **Pi**：始终以 `--extension` 加载 `extensions/nova-guard.ts`，没有关闭开关；同时固定加 `--no-extensions`（不加载全局/自动发现的扩展——pi 按加载顺序调用扩展，后加载的扩展可以在守卫放行后改写 `event.input`）、`--no-approve`（不加载仓库 `.pi/extensions`、`.pi/settings.json`、`.pi/mcp.json` 等需信任的资源）、`--no-mcp`（`--tools` 白名单不会去掉 MCP 工具）。守卫对 bash/edit/write 做检查，read/grep/find/ls 放行，**其他任何工具一律拦截**。配置 `args` 里出现 `-e/--extension`、`-a/--approve` 会校验失败。扩展加载时写 `guard-loaded` 标记，分段成功结束却没有标记 → `blocked`。以上已用 pi 1.5.2 实机验证（见 config.md「参数核验情况」）。
- **Codex**：没有逐命令 hook。约束来自三层：① `codex exec --sandbox workspace-write`（只能写工作目录、默认无网络），禁止沙箱绕过/信任参数与开启网络的覆盖；`--ignore-user-config --ignore-rules` 让 `~/.codex/config.toml`（MCP 服务器、沙箱设置）与 execpolicy 规则不生效，不加 `--trust` 所以仓库内 `.codex/` 配置不生效；② **事后审计**：以 `--json` 运行，事件流里每一条执行过的命令与文件改动都过一遍同一个守卫，每一次 MCP 工具调用都直接算命中，命中即生成 `audit` 审批请求（主题以 `ran:` / `wrote:` / `mcp:` 开头），任务进入 `needs_approval`——用户 approve 则继续，deny 则任务 `failed`（操作已经发生，deny 表示拒收这份工作）；分段成功结束却**一条可解析的事件都没有**（事件格式变了，审计等于失明）→ `blocked`；③ 所有执行者共同的验收阶段检查（见下）。注意：审计是**事后**的，它能发现并上报，不能阻止。事件信封已对照 codex-cli 0.169.0 实机输出与 `@openai/codex-sdk` 类型核验；登录后执行命令的事件仍需实测（failure-modes.md「必须实测」第 7 项）。

### 验收阶段的独立检查（对所有执行者）

验收是"完成"的唯一依据，执行者的自述（包括它打印的 `PASS`、"tests pass"）一律不作数。

- **独立运行**：分段结束时先杀掉执行者进程组里残留的后台进程，再 checkpoint 提交。判定对象是任务分支 `nova/<id>` 的**提交**：在 worktree 旁边新建一个**独立的临时 clone**（`git clone --shared --no-checkout --template=`：只读借用对象库、没有 hook 模板、删掉 remote），关闭 hook detached 检出这个提交，验收命令在那里跑，跑完删除。它不是共享仓库的 worktree：`acceptance_setup` 或测试代码在里面执行的 git 命令（husky / pre-commit 安装时的 `git config core.hooksPath`、`git update-ref`、`git branch -f`）只改到这个临时 clone，不会改 owner 的仓库配置或分支，也不会让下一次验收误报篡改。执行者留下的未跟踪/被 gitignore 的文件（伪造的 `node_modules/.bin/jest`、`.cache/verified` 之类）在干净检出里不存在；依赖请用项目 `acceptance_setup`（如 `npm ci`）安装。checkpoint 之后 worktree 里又出现未提交改动 → `FAIL uncommitted`。验收命令**异步**运行（各自的进程组，超时或中止时整组杀掉），worker 在长时间的 `npm ci` + 测试期间照常续租，不会被当成冻结进程杀掉；验收期间任务被取消或租约丢失 → 杀掉验收命令，不记录判定。
- **干净环境**：只保留 `PATH`、`LANG`/`LC_*`、`TZ`、`TERM`、`USER`、`LOGNAME`、`SHELL`，加项目 `acceptance_env_pass` 里列出的变量名（像密钥的名字、配置里声明的密钥变量名、`secrets.env` 里的名字都会被拒绝）和项目 `env_file`；`HOME`/`XDG_*` 指向一个新建的空目录，`TMPDIR` 是其中的私有子目录（执行者写进 `/tmp` 的缓存，例如 jest 的 transform 缓存，验收看不到）；`PATH` 只保留绝对路径，并去掉位于仓库、worktree 根目录、临时 clone 里的条目（``、`.`、`node_modules/.bin` 这类相对条目会让提交里的同名文件顶替真实工具；依赖的 `.bin` 由 npm scripts 自己加入）；`bash --noprofile --norc -c`，不读任何 profile/rc。
- **`acceptance_setup` 失败**（registry/网络不通、工具链缺失、锁文件坏了）→ `FAIL setup:<命令>: <最后一行输出>`，任务 `failed` 并升级，**不**当作测试失败交回执行者重试。需要网络的 setup 在断网时就是这样明确失败，而不是让执行者去"修"。
- **篡改 = 致命，不重试**（`failed` + 升级，立即唤醒）：
  - 共享仓库的 `.git/config`（remote、alias、hooksPath、credential helper）、`.git/hooks/`、`.git/info/` 在任务开始时做快照，验收时比较；有变化 → `FAIL integrity:.git/…`。这类改动会让 owner 之后的 git 操作执行任意代码或把数据发出去。owner 自己在任务期间改了这些也会触发，核对后重新派发即可。
  - worktree 的 HEAD 不在 `nova/<id>` 上 → `FAIL integrity:head`；base 不再是 HEAD 的祖先（历史被改写）→ `FAIL integrity:history`。
  - 验收命令跑完后再查一次：这期间共享 `.git/config`/`hooks`/`info` 变了 → `FAIL integrity:.git/…`；任务分支 `nova/<id>` 不再指向刚验收的提交 → `FAIL integrity:refs`（测试代码按绝对路径改共享仓库）。其它分支不比较（owner 自己的工作、其它任务的 checkpoint 会合法地移动它们）。
  - 删除测试文件、新增 `.skip/.only/xit/@pytest.mark.skip/t.Skip` 等、测试文件里的用例定义（`it(`/`test(`/`def test_`/`func Test`/`#[test]`/`@Test`）减少 → `FAIL tests-…`。
  - 改了验收/测试框架：Makefile/`*.mk`/justfile/Taskfile、jest/vitest/vite/playwright/cypress/mocha/karma/ava 配置、`.npmrc`/`.yarnrc*`/`bunfig.toml`、`tsconfig*.json`、eslint/biome 配置、`pytest.ini`/`conftest.py`/`tox.ini`/`noxfile.py`、`pyproject.toml`/`setup.cfg` 中测试工具相关的行、验收命令里直接引用的仓库文件（如 `sh check.sh`）、项目 `harness_paths`，或 `package.json` 的 `scripts`（依赖可以改）→ `FAIL harness:…`。任务本来就要改这些时，任务书写 `allow_harness_changes: true`。
  - 符号链接：指向 worktree 外 → `FAIL symlink-escape:…`；指向 `.git`、或用链接替换测试/框架文件 → `FAIL symlink-harness:…`。
- 可重试（带着错误本地重试）：空 diff、禁止路径、超出范围、`uncommitted`、验收命令失败（不含 `acceptance_setup`）。
- **deepseek-text**：没有 shell 与文件访问；文本任务的验收命令同样用干净环境与空 HOME。

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
- 执行者子进程环境会剔除：名字匹配 `WEBHOOK|NOVA_RELAY_*|*_KEY|*_KEY_*|*_TOKEN|SECRET|PASSWORD|CREDENTIAL|GH_*|GITHUB_TOKEN` 的变量、`SSH_AUTH_SOCK`、`GIT_ASKPASS`/`GIT_SSH`/`GIT_SSH_COMMAND`、整组 `GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS`（只删一部分会让执行者里的所有 git 命令报错），以及各适配器的网关/API key 变量（例外：pi 所需的 `key_env`，它会以 `DEEPSEEK_API_KEY` 的名字传给 pi）。**按声明剔除**：不管变量叫什么，`secrets.env` 里出现的每个名字、配置里声明的 `webhook.url_env`/`key_env`、执行者的 `key_env` 都不会传给执行者和验收命令，它们的值也加入脱敏列表（例如把 webhook key 放在 `PD_BEARER` 里，名字不匹配上面的模式，也一样被剔除）。验收命令同样拿不到这些变量，但能拿到项目 `env_file` 的变量。
- `events.jsonl`、分段日志、`progress.md`、`result.md`、审批记录都经过脱敏（常见 key/token 格式、Bearer 值、JWT、URL 中的密码、私钥块、以及所有已知密钥值）。分段日志按**整行**脱敏，密钥跨两个输出块也能被抹掉。Codex 的 `--output-last-message` 文件读取后即删除。
- 项目 `env_file` 必须是 0600，否则该项目的任务 `blocked`。
- webhook payload 只有 `{source,batch,id,state,exit_code}`（`state` 也可能是 `<主机>_unreachable`，如 `box_unreachable`）；URL 与 key 只从环境变量读，URL 只允许 HTTPS 或 Tailscale 地址；**不跟随重定向**（3xx 留在 outbox 重试，否则重定向目标会绕过地址限制）；发送错误只记录 HTTP 状态，不记录 URL 和 key；不开放任何端口。

## 分支与推送

- 每个任务在 `nova/<task-id>` 分支的独立 worktree 中工作；nova-relay 只在该分支上做 checkpoint commit，**从不 push、从不合并到 base**。
- 合并、推送、发布都由 owner 在审阅后亲自完成。

## 已知局限

- guard 是基于词法与启发式的规则，**不是沙箱**。脚本扫描能挡住常见写法（脚本里的 `git push`、写 `/etc`、`requests.post`、base64+exec），挡不住刻意混淆的代码（字符串拼接出命令、编译型程序、通过测试框架间接执行的代码等）。仍然存在的已知盲区：
  - 不扫描 `node_modules/`、`.venv/`、`venv/`、`vendor/` 下的文件（视为包管理器安装的内容），也不扫描 worktree 与 `/tmp` 以外的脚本（执行者写不到那里）；`npx`/`pnpm dlx`/`bunx` 运行的包不扫描。
  - `cd` 在同一条命令行内跟踪；Claude 的 Bash 工具跨调用的 cwd 由 hook 输入的 `cwd` 提供。Pi 与 Codex 的 shell 若跨调用保留 cwd，guard 仍按 worktree 解析（Codex 只做事后审计）。子 shell 的括号不建模（`(cd ..; …)` 之后的命令仍按 `..` 解析，偏保守），`popd` 之后视为未知目录。
  - Makefile 里由变量拼出的 `include $(X)` 不展开；`.yarnrc.yml` 的 `yarnPath`、`bunfig.toml` 的 `preload` 不在执行时检查（验收阶段改动它们算 `harness`）。
  - 未列出的"换目录/写文件"参数（各种工具的 `--output`、`-o`、`--prefix`）只覆盖上面列出的常见命令；`chrt`、`strace`、`script -c` 等少见包装命令不解析。
  - `setsid`/双 fork 脱离进程组的后台进程不会在分段结束时被杀；它们改不了验收用的干净检出里已提交的内容，但仍可能写 worktree 或 `/tmp`。
- 验收命令（测试）本身会执行执行者写的代码，并且有网络——这是验收的本质。空 HOME、私有 TMPDIR、独立 clone 只是纵深防御：测试代码仍能按绝对路径读写同一用户下的文件（如 `/home/<user>/.codex/auth.json`、共享仓库的对象库或其它分支）。验收后会检测共享 `.git/config`/`hooks`/`info` 与任务分支的变化，其余不检测；只有容器或独立系统用户才能真正隔离。真正的边界还包括：worktree 隔离、子进程环境剔除密钥、验收阶段的篡改检查、以及"不 push"的流程。高风险项目请在容器或独立用户下运行执行者与验收。
- 篡改检查是启发式的：它能发现删测试、加 skip、改框架文件、移走分支，但发现不了"把断言改弱"（例如把 `assert.equal(x, 3)` 改成 `assert.ok(true)`）。范围（scope）里包含测试目录的任务，抽查时请看测试 diff。
- Codex 的前置约束依赖其自身沙箱实现；nova-relay 的审计是事后的。
