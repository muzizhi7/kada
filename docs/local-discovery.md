# 首次启动：主动认识用户与本机能力

2026-11-11 源码增量，尚未包含在 v0.8.0-alpha.1 安装包中。已发布版本只发现能力元数据；当前源码读取已有用户指导与记忆，整理为带来源的用户记忆，不增加背景问卷。没有配置线上模型时也能完成初次分类摘录。扫描不调用模型、不导入扩展代码、不执行插件或 MCP 命令，也不改原 Agent 配置。

## 用户体验

运行`npm run chat`、`npm run dev`或`npm run pet`，后台首次启动时自动扫描。能力目录后续复用缓存；用户记忆来源在启动、查看环境、创建新任务和保存整理结果前做有界重读，不在每条消息前重新扫描，也没有常驻 watcher。

查看或刷新：

```sh
npm run discover
npm run discover -- --refresh
```

小宠物菜单“本机 Agent 与 Skills…”打开能力概况，“用户记忆…”优先按通用、工作、个人生活、待分类展示已整理的画像，每条可展开证据；自动摘录的线索折叠在后方，并可打开完整记忆文件。CLI 同时显示两者路径。扫描与形成记忆不询问用户；正常任务的目标、范围和总预算仍按原流程处理，记忆不扩大授权，也不会打开 computer-use 驱动。

概况保存在本机数据目录的`local-context/`：

- `inventory.json`：结构化观察记录。
- `overview.md`：Agent配置、模型/语言偏好、用户指导文件位置、插件/MCP概况及扫描限制。
- `skills.md`：逐行的名字、用途、来源、原SKILL.md路径和关闭状态，可用Pi原生read/grep按需查找。
- `user-memory.json`：分类记忆、全局或具体项目、明确/待核实标记、来源引用和状态。
- `user-memory.md`：用户和 Agent 可读的记忆，先列已整理的画像，再列按领域分类的来源线索。
- `user-evidence.md`：当前脱敏来源、提供方、原文件哈希、观察时间与快照位置。
- `memory-snapshots/<来源 ID>/<原文件 SHA-256>.md`：各次观察的脱敏文本，不覆盖旧版本。哈希来自原始字节，快照不是原始字节。
- `memory-originals/<来源 ID>/<原文件 SHA-256>.txt`：从本次改造后实际读取的来源原字节，每个版本独立保留，用于还原和人工核对；可能包含凭据或其他敏感内容。它不自动注入模型，文件创建权限为 0600；应考虑操作系统的备份、同步及同账户访问。旧缓存只有脱敏文本的历史版本无法凭空补回原字节，用户对话只保存被引用的片段。
- `memory-imports.json`：可选的用户维护的外部记忆登记表，格式见下文。

默认数据目录是Git忽略的`.harness/`。目录/文件首次创建权限为0700/0600；内容不发布到仓库。更换或安装能力后手动刷新；大目录命中限制会明确标为部分结果，不能将数量当作完整性保证。

## 当前支持的来源

| 来源 | 已识别信息 |
|---|---|
| 通用Agent Skills：`~/.agents` | 标准Skills和用户指导文件位置 |
| Pi：`~/.pi/agent` | settings中的模型/Skills路径/package声明、原生Skills、extensions、已存在的npm/git包目录 |
| Codex：`~/.codex` | TOML模型偏好、MCP名字、用户指导文件、Skills、`.codex-plugin/plugin.json`缓存清单 |
| Claude Code：`~/.claude`及`~/.claude.json` | 模型/语言、MCP、插件启用声明/安装索引/本地清单、Skills、用户指导文件位置 |
| Cursor：`~/.cursor` | Skills、MCP配置、插件/扩展目录的已识别清单 |
| OpenCode：`~/.config/opencode` | JSON/JSONC插件声明、MCP名字、Skills和本地插件目录 |
| Gemini CLI：`~/.gemini` | 模型偏好、Skills、扩展清单、MCP名字、指导文件位置 |
| Copilot CLI：`~/.copilot` | 配置、Skills和MCP名字 |

这里只说明发现了本地配置或缓存，不代表程序仍安装、已经认证、插件启用或服务可连通。启用状态只在格式有明确字段时记录；无法确定时保留未知。原Claude插件明确关闭时，其关联Skill也标为关闭。其它来源的未知状态不推测为启用。

任务工作区的`.pi/skills`、`.agents/skills`、`.claude/skills`、`.codex/skills`、`.cursor/skills`、`.opencode/skills`和`.gemini/skills`也由Pi原生加载，项目人工版本优先于内置及生成方法。

能力发现只访问约定 Agent 目录以及配置明确引用的本地 Skill/已安装插件路径；混合设置文件只提取白名单字段，API Key、env、命令参数、headers、账户信息和带认证的 URL 不进入能力概况。

用户记忆还自动读取以下约定的文本文件；“规则/指导”并不一定是用户事实，作为来源线索保留：

| 提供方 | 当前自动读取 | 尚未自动读取 |
|---|---|---|
| Codex | `~/.codex/AGENTS.override.md` 或 `AGENTS.md`；`~/.codex/memories/{MEMORY.md,memory_summary.md,raw_memories.md}`；当前项目的 `AGENTS.override.md` 或 `AGENTS.md` | 会话、聊天与 rollout 日志 |
| Claude Code | `~/.claude/CLAUDE.md`；`~/.claude/projects/*/memory/*.md`；当前项目的 `CLAUDE.md`、`CLAUDE.local.md`、`.claude/CLAUDE.md` 和 `.claude/rules/*.md` | 非当前项目的指导文件 |
| Cursor | 当前项目的 `.cursorrules` 和 `.cursor/rules/*.{md,mdc}` | 云端自动记忆、用户规则与私有数据库 |
| CodeBuddy | `~/.codebuddy/CODEBUDDY.md`、`rules/*.md`、`memories/global/*.md`；当前项目的 `CODEBUDDY.md`、`CODEBUDDY.local.md`、`.codebuddy/CODEBUDDY.md` 与 `rules/*.md` | 未登记的项目 Auto Memory 和团队用户记忆；其他未登记的位置 |
| OpenClaw | 默认工作区 `~/.openclaw/workspace/USER.md`、`MEMORY.md`、`memory.md` | 其他自定义工作区、每日记录和聊天日志 |
| WorkBuddy 等其他本地助手 | 可通过下文登记已存在的本地记忆文本 | 未登记的私有格式；不能将 WorkBuddy 假定为 CodeBuddy |

还读取用户目录根部及已发现 Agent 根部约定的 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`USER.md` 和 `MEMORY.md`/`memory.md`。实际读取位置以来源记录为准，不宣称覆盖所有私有格式。Claude 的项目目录名由路径编码推断，特殊字符编码可能与其他路径碰撞；重要项目应核对来源，并可通过登记表明确指定工作区。CodeBuddy 的项目 Auto Memory 目录与实际项目的对应方式没有在官方文档中明确，需登记具体文件及项目路径；团队模式的用户目录也需登记，避免误读其他人的记忆。全局记忆文件中混杂的项目线索也可能无法自动识别出项目身份。

一次最多读取约 480 份自动来源并为用户对话留出余量、单份记忆 1 MiB、单份指导 64 KiB、合计 8 MiB；Claude 最多检查 256 个项目目录，每个规则/记忆目录最多 128 个文本文件。来源超过限制会跳过并提示，不能当作完整备份。常见凭据字段、令牌和私钥块会省略，不保证识别任意格式的秘密。二进制、超限、自动来源越出用户目录或当前项目的链接和异常文件跳过并记录限制。不会读取普通聊天记录、会话、日志、命令历史或凭据文件，不遍历整个硬盘。

### 登记其他已有的本地记忆

将已有的**本地记忆文本**整理为 `.md`、`.mdc` 或 `.txt`，然后在数据目录的 `local-context/memory-imports.json` 中登记其绝对路径；不接受聊天记录或整包导出作为自动解析格式。例如，以下路径需替换为本机实际路径：

```json
[
  { "provider": "other", "path": "/Users/me/Memory/personal.md", "scope": "global", "domain": "life" },
  { "provider": "workbuddy", "path": "/Users/me/Memory/workbuddy-project.md", "scope": "project", "project": "/Users/me/Projects/example", "domain": "work" },
  { "provider": "other", "path": "/Users/me/Memory/general.md", "scope": "global", "domain": "general" }
]
```

`provider` 支持 `chatgpt`、`dot`、`workbuddy`、`cursor`、`codebuddy`、`openclaw`、`codex`、`claude`、`other`；`domain` 为 `general`、`work`、`life`、`unknown`；`scope` 为 `global` 或 `project`，后者必须填写存在的项目目录绝对路径。最多 128 条。明确登记的路径可以在用户目录之外；不展开 `~`。登记本身不会连接云服务，也不会读取未登记的聊天记录。运行 `npm run discover -- --refresh` 或在任务创建时重新读取登记表。

## 从内容形成记忆

启动先按标题与原文规则将全部可处理段落切成来源摘录，并初分通用、工作、个人生活、待分类与具体项目。未明确的内容保留待分类，不凭助手品牌断定私人生活或职业。规则分类可能出错，也无法保证跨领域隔离；需要时在登记表指定领域，并核对产生的记忆。来源明述表示材料写过这件事，不等于独立核实；已有 Agent 记忆标为待核实，不仅凭工具/Skill 清单推断身份或敏感属性。

准备和执行任务复用同一 Pi 会话。模型需要时用原生 read 查记忆与证据，通过 `user_remember` 整理稳定信息、压缩重复表述和保存用户自然给出的明确纠正。该工具核对来源 ID 与原文摘录，保存前重读来源，不接受模型自己编造的用户引语；项目来源不能改成全局偏好，已有 Agent 记忆不能直接改标为来源明述。程序核对的是出处与版本，不是自然语言总结的全部语义。

明确用户纠正可以替代旧记忆；跨来源分歧没有用户纠正时保留两份观察。来源变化或删除后，依赖旧版本的整理结果标为过时，退出常驻短摘要；未扫描的其他项目来源保留到下次进入该项目再核对。原文摘录、来源路径、哈希和版本文件仍可追溯。当前缓存最多保留 16,000 项记忆和 512 份来源，命中限制会提示；历史脱敏快照和原始版本目前没有自动清理策略，磁盘占用会随版本增加。无效或不兼容的旧缓存会先备份再重建，不删除历史记录。

用户记忆默认随 discovery 开启，与默认关闭的“生成可复用任务 Skill”学习开关不同。不会固定增加学习 Agent、单独模型请求、后台总结轮次或新数据库；任务中整理造成的模型与工具轮次包含在原有 Pi 用量和任务预算中。

## 如何给Agent使用

新任务获得简短的系统/语言环境、已有 Agent 配置及能力数量；根据目标关键词选择最多六项适用领域、通用偏好和当前项目的短记忆（每项至多 200 字符），并提供记忆/证据/Skill 目录位置。`user_memory_search` 可在同一 Pi 会话中按关键词、领域和当前项目查找；相同领域、范围和文字的结果会合并，返回最多八个来源引用，完整来源保留在本地。检索是轻量关键词匹配，不是语义检索。没有可靠项目身份的项目条目不自动进入其他项目；可通过原生 read 检查资料。领域判断、项目身份与相关性均需验证，自动筛选不是严格的信息隔离。任务需要某种能力时，模型用原生工具查目录、读取 SKILL.md，再按当前权限使用相对脚本或参考材料。未接入本项目的插件专用工具不能假装可调用。

准备和执行阶段的真实原生Skill读取都记录清单文件哈希；读取不等于执行、资产完整版本固定或质量提升。外部已有Skill保留原位置，不受本地生成试用Skill的128KiB打包限制，不复制整个资产目录。项目/生成方法仍沿用已有快照机制。

任务发生时，短概况、短记忆及实际读取的相关内容会进入用户配置的线上模型上下文；不自动发送原配置、凭据或完整 Skill 目录。当前用户要求优先，已有偏好与记忆不会更换本项目的模型、费用上限、权限、确认标准或驱动。

在`harness.config.json`设置`"discovery": false`可关闭后续扫描、记忆读取和新上下文注入，已有记录保留。直接嵌入 SDK 的 Config 只有显式 `discovery: true` 才启用；常规配置加载器默认开启。没有 discovery 标记的旧任务不追加环境信息；已有 v0.8 元数据任务没有 userMemory 标记，恢复时不追加用户记忆或整理工具。新行为只用于带该标记的新任务。

## 轻量实现与边界

Skill 解析继续使用 Pi1.4.0 公开 `loadSkills`，正文使用 Pi 原生 read；用户记忆整理通过公开 defineExtension/defineTool 接入原会话。普通本地文件只保存必要业务记忆和来源，使用已有文件锁依赖串行化跨进程更新，不建设向量库、记忆服务、后台扫描服务或插件运行时。已有文件/脚本/会话/重试/恢复与费用路径不变。

扫描有总条目/时间预算、每源预算、深度及清单尺寸限制，处理符号链接去重与循环；缺失、损坏、无效或超限资源记录提示，任务仍可继续。当前不覆盖自定义Agent配置根目录、所有厂商私有插件格式或插件在线连接状态；不尝试自动安装、更新、登录或跨Agent运行专用插件。

依据已安装 Pi 1.4.0 的 [Skills 文档](../node_modules/@earendil-works/pi-coding-agent/docs/skills.md)及 [packages](../node_modules/@earendil-works/pi-coding-agent/docs/packages.md)，并核对 [Codex 记忆](https://developers.openai.com/codex/memories)、[Codex 指导文件](https://developers.openai.com/codex/guides/agents-md)、[Claude Code 记忆](https://code.claude.com/docs/en/memory)、[Cursor 记忆](https://cursor.com/docs/context/memories)、[Cursor 规则](https://cursor.com/docs/context/rules)、[CodeBuddy 记忆](https://www.workbuddy.ai/docs/zh/cli/memory)、[CodeBuddy 配置](https://www.workbuddy.ai/docs/zh/cli/settings)、[OpenClaw 记忆](https://docs.openclaw.ai/concepts/memory)和 [dot 任务与记忆](https://learn.chatgpt.com/docs/dots/tasks-and-memory)；Codex 缓存位置也在本机实际验证。

先前自动回归、原生入口、真实模型和干净安装验证见[提交前验证记录](verification-2026-10-31-discovery.md)，不代表本次变更已完成真实模型对照。本次规则分类和关键词召回仍需以相同模型、工具和权限对比原生 Pi，衡量完成率、人工介入、恢复和成本。这项增量不改变此前未证明学习降本的结论。
