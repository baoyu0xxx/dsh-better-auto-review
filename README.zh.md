# dsh-better-auto-review

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的双层工具调用审核闸门：**能用固定规则证明的，规则直接判定；规则判不了的，才交给审核模型。**

审核模型默认使用对话主模型，装上即可用，无需先做任何配置。它也支持 `opencode-go` 路由——而 DSH 原生自动审核不支持，详见 [OpenCode Go 适配](#opencode-go-适配)。

```text
                     每一次工具调用
                          │
        ┌─────────────────▼────────────────┐
        │ 第一层 — 固定规则                 │ 微秒级、不调模型、每次都跑
        │  · 17 条硬拒绝规则                │
        │  · 受保护路径 / 敏感路径          │
        │  · 工作区归属判定                 │
        │  · 字面只读命令识别               │
        └───────┬──────────────┬────────────┘
            拒绝 │        放行 │ 升级
                ▼              ▼        │
              直接拦下    直接执行       │
                          不调模型       ▼
                        ┌───────────────────────────┐
                        │ 第二层 — 审核模型         │ 只在需要时发一次请求
                        │ low/medium/high × 允许/拒绝│
                        └───────────┬───────────────┘
                              允许  │  拒绝
                                    ▼
                          放行，或交给用户确认
```

## 为什么不直接用原生自动审核

`@deepseek-ai/dsh-experimental-auto-review` 本身质量不错，本插件也沿用了它的决策协议。但有几处值得改进：

| | 原生自动审核 | 本插件 |
|---|---|---|
| 每次调用 | 都发一次模型请求，连 `ls`、`read` 也要 | 规则先判；一条 `git status` 零成本 |
| 审核模型 | 固定跟随对话路由 | 默认用主模型，**且可单独指定** |
| 审核失败时 | 直接拒绝该调用，provider 一抖整个工作就卡住 | 默认改为询问用户（`review.onError`） |
| 审计 | 「风险、prompt、推理与原始响应均不落盘，故不要把它当审计日志」（其 README 原文） | 每次决策一行 JSON，带轮转与凭据脱敏 |
| `opencode-go` | 审核请求**不带** `x-opencode-session` 头 | 始终携带 session id |
| 权限槽位 | 占用全局唯一的 `auto` 槽 | 自带命名预设，两者可共存 |

## 安装

```bash
dsh plugin --profile <profile> add /绝对路径/dsh-better-auto-review
```

或通过 plugin manager 的 `install_bundle` 用绝对包目录安装。

由桌面应用独占管理的 profile 会被 CLI 拒绝——`dsh` 会回答 *"profile `desktop` is managed exclusively by the Electron application"*。这类 profile 请改用应用自带的插件管理器安装；上面的命令适用于 `web`、`tui` 等 CLI 启动的 profile。

**安装本身不改变任何行为**：只有在会话里选中 `better-auto-review` 权限预设后闸门才会启用。

## 启用

1. 打开会话，在权限选择器里选 **Better Auto Review**。
2. 就这一步。此后该会话的每次调用先过第一层，剩下的才交给审核模型。

若想对所有会话生效，打开 **设置 → 插件 → Better Auto Review**，把 **Gate → Mode** 设为 `always`。请有意为之：`always` 意味着从未主动选择该预设的会话也会被审核。

## 配置

配置集中在 **设置 → 插件 → Better Auto Review**。插件管理器详情页也提供紧凑的 **Reviewer model** 区块，方便直接选择审核模型；两个页面共用同一套数据钩子与控件，经 Host 路由校验与持久化，并沿用 DSH 自身的设置页设计令牌（随应用主题与字号比例变化），完整设置页保留规则、审计和其余配置。

| 分组 | 作用 |
|---|---|
| **Gate** | 是否启用、`preset` 还是 `always`、预设名 |
| **Reviewer** | provider/model、思考深度、输出预算及其上限、超时、失败策略、历史与动作预算 |
| **Layer 1 rules** | 硬拒绝开关、两个快速放行开关、受保护路径、敏感写入路径、额外允许根目录、快速放行命令模式 |
| **试跑一条命令** | 只跑第一层的干跑：会命中哪条规则，且不执行任何东西 |
| **审计日志** | 记录开关，以及最近 15 条决策 |

**审核模型。** 可从 DSH 当前已配置 provider 广告的模型中选择，也可保留 **Inherit from conversation**（默认）跟随会话自身路由；思考深度选项随所选模型能力变化。已保存但当前目录不再广告的模型/深度仍会显示，而不会被静默丢弃。

**快速放行命令模式。** 这是最值得理解的一个旋钮。第一层拒绝*猜*：证明不了是日常工作的，一律升级，代价是一次模型请求。对于一个真的会授予权限的闸门，这是对的默认值；但若项目日常就是编译器或测试运行器，就会每次调用都付费。把 `^npm run `、`^pytest\b` 之类写进去即可免掉。该列表**最后**才查，在所有拒绝与敏感路径升级都已排除之后，所以写错一条也不会破防。

## 第一层规则

判定只有三种：`deny`（不执行）、`allow`（可证明是日常工作，跳过模型）、`escalate`（规则判不了，交给第二层）。

**直接拒绝** —— 不可恢复，或破坏启动与救援能力的效果：格式化卷、`diskpart`、`mkfs`、裸设备写入、删除卷影副本、`wbadmin delete`、`bcdedit /delete`、`reg delete HKLM`、关闭 Defender 实时防护、关闭防火墙、删除还原点、`takeown /r`、`icacls /deny`、清空事件日志、对文件系统根 `rm -rf`，以及**任何目标为 harness 状态（`.dsh`）的破坏性命令**。

**升级** —— 受保护根目录下的递归或强制删除（`~/.dsh`、桌面、文档、下载、图片、OneDrive、`C:\Windows`、`Program Files`、`ProgramData`）；写入敏感位置（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.dsh`、`AppData`、Program Files）；无法读出作用域的删除（通配符、未解析变量）；harness / 包 / 服务 / 注册表变更；以及所有规则不认识的命令。

**免模型放行** —— 字面只读命令（`git status`、`git diff`、`Get-ChildItem`、`node --version` 等），以及**所有**可识别目标都落在会话工作区内的写入或删除。

两个细节让这套规则值得信任：

- **引号内容被掩码，规则只在命令位置匹配。** `Write-Output "a|format C:"` 是一条打印语句，不是格式化。引号内的分隔符不切分命令；`bash -c "…"`、`pwsh -Command "…"`、`python -c "…"` 的内层脚本会被取出并单独重新扫描。
- **引号未闭合则升级。** 掩码会吞掉本行剩余内容，因此后续任何环节都不允许放行。

### 与它脱胎的那个守卫的有意差异

规则最初是把作者机器上运行、17/17 全过的 `PreToolUse` 守卫加固移植而来。有两处判定被有意改变：

- 原守卫对未被规则命中的命令一律放行，因为 `PreToolUse` 钩子**无法**预先批准——它的 `allow` 不产生任何效果。而这里的 `allow` 在全权限预设下是真正授权的，因此「证明不了是日常工作」必须升级，而不是静默通过。
- 原守卫把路径中任何名为 `sessions`、`storages`、`profiles` 的段都当作 harness 状态，因而会拒绝项目自己的 `./sessions` 目录。现在只认 `.dsh` 与 DSH 专有的 `session_projcache`，其余交给具体且可编辑的 `protectPaths`。

## 审核模型

审核模型被要求只回一个 JSON 对象，协议与原自动审核一致，因此它那些 prompt 加固经验可以照搬：

```json
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny","reason":"..."}
```

`low` 必须放行；`medium` 只有在当前明确的人类指令点名了该动作、该目标、该范围时才可放行；`high`（凭据或隐私数据跨越信任边界）**即使人类要求也一律拒绝**。键序无关，重复成员视为攻击——重复的 `risk` 无法把一个 allow 偷渡过解析器。

被截断（`max-tokens`）、报错、中止，或在若干推理块之后不是恰好一个文本块的响应，都算**错误而非决策**——被截断的审核恰恰最可能是正要说出 `deny` 的那个。截断时输出预算翻倍并重试，次数上限 `review.tokenLimitRetries`，预算上限 `maxTokensLimit`。

随后套用失败策略：

- `review.onError: "ask"`（**默认**）—— 询问用户。审核既不会静默放行，也不会因为一次抖动就卡死全部工作。
- `review.onError: "deny"` —— 直接拒绝该调用，与原生自动审核一致。

当会话的审批策略为 `never` 时，`ask` 在结构上不可能出现，于是拒绝会被终结为 `deny`，而不是弹一个永远不会出现的提示。

### OpenCode Go 适配

`opencode-go` 需要按会话携带路由头。上游有两个事实让这件事很脆弱：

- pi-ai 只在调用方传入 session id 时才注入 `x-opencode-session`——`opencode-headers.js` 里 `if (!options?.sessionId || …) return streams`。
- `@deepseek-ai/dsh-llm-pi-ai` 只在 `GenerateOptions.sessionId` 存在时才转发。

原生自动审核构造请求时不带它，于是在 `opencode-go` 路由上审核请求没有该头。本插件在每次审核时都设置 `sessionId`，与宿主自己的 agent loop 一致（`dsh-agent-loop`：`sessionId: this.session.id`）。代价是一个字段，消掉的是整类故障。

若某个适配器自己要用 `sessionId` 做路由，禁用本插件或让预设保持未选中即可。

## 审计日志

每次决策一行 JSON，位于 `$DSH_HOME/plugin-state/better-auto-review/audit.jsonl`，超过 `audit.maxBytes`（4 MiB）轮转一次。除非打开 `audit.recordArguments`，否则不记录参数体；即使打开，形如凭据的键与值也会被脱敏。写日志失败**绝不会**导致工具调用失败。

## `/bar` 命令

| 命令 | 作用 |
|---|---|
| `/bar` 或 `/bar status` | 当前状态、审核路由、审计路径 |
| `/bar on` / `/bar off` | 启用 / 停用闸门 |
| `/bar preset` / `/bar always` | 闸门的启用方式 |
| `/bar check <command>` | 只跑第一层：会命中哪条规则，不执行任何东西 |
| `/bar audit [n]` | 最近 `n` 条决策 |

## 测试

规则、审核解析、审计日志与整条决策路径都只依赖 `node:*`。先运行一次 `npm install` 安装唯一依赖（`@deepseek-ai/schemastery`，供 Host 适配层与 schema 测试使用）；此后整套测试离线运行，无需 DSH：

```bash
npm test        # 87 个单元测试
npm run verify  # 语法 + 测试
```

闸门、审核器、审计、模型目录与配置模块均由该套件端到端覆盖，包括惰性上下文与硬兜底路径。`lib/index.js` 的 HTTP 路由层只是它们之上的薄适配层，开发期间用打桩宿主验证过，不保留常驻 harness。

## 已知限制

- **预设选择器中的条目。** 原生预设不带展示文案，命名预设显示它自己设置的 `name`。本插件在 `cordis.patch.yml` 里同时设置了 `name` 与 `description`。
- **一个会话一个审核器。** 闸门绑定单一预设。它可以与原生自动审核共存，但同一会话一次只用一个。
- **它不是沙箱。** 它决定调用*是否*执行；能触达什么仍由沙箱与审批策略决定。预设特意把 `danger-full-access` 与 `approval: ask` 配对，正是为了不让审核判定落空。
- **第一层是黑名单加归属证明。** 通过未识别工具写入的命令会被升级而非放行——这正是 `escalate` 成为常见结果的原因，也是快速放行列表存在的理由。
- 管理页面为英文标签；插件自身元数据与询问提示为双语（`locale/en.json`、`locale/zh.json`）。

## 许可

MIT，见 [LICENSE](./LICENSE)。
