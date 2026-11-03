# 首次启动：主动认识用户与本机能力

2026-11-03 主分支增量，尚未包含在 v0.8.0-alpha.1 安装包中。已发布 v0.8.0-alpha.1 只发现能力元数据；当前源码还自动读取已有用户指导与记忆，整理为带来源的用户工作记忆，不增加背景问卷。没有配置线上模型时也能完成初次分类摘录。扫描不调用模型、不导入扩展代码、不执行插件或 MCP 命令，也不改原 Agent 配置。

## 用户体验

运行`npm run chat`、`npm run dev`或`npm run pet`，后台首次启动时自动扫描。能力目录后续复用缓存；用户记忆来源在启动、查看环境、创建新任务和保存整理结果前做有界重读，不在每条消息前重新扫描，也没有常驻 watcher。

查看或刷新：

```sh
npm run discover
npm run discover -- --refresh
```

小宠物菜单“本机 Agent 与 Skills…”打开能力概况，“用户工作记忆…”打开分类记忆。CLI 同时显示两者路径。扫描与形成记忆不询问用户；正常任务的目标、范围和总预算仍按原流程处理，记忆不扩大授权，也不会打开 computer-use 驱动。

概况保存在本机数据目录的`local-context/`：

- `inventory.json`：结构化观察记录。
- `overview.md`：Agent配置、模型/语言偏好、用户指导文件位置、插件/MCP概况及扫描限制。
- `skills.md`：逐行的名字、用途、来源、原SKILL.md路径和关闭状态，可用Pi原生read/grep按需查找。
- `user-memory.json`：分类记忆、明确/待核实标记、作用范围、来源引用和状态。
- `user-memory.md`：用户和 Agent 可读的工作记忆，分全局与项目线索。
- `user-evidence.md`：经过常见凭据字段省略的来源摘录、原文件哈希和观察时间。

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

用户记忆额外读取用户目录根部及已发现 Agent 根部的 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`USER.md`、`MEMORY.md`/`memory.md`，以及 `.codex/memories/memory_summary.md` 和 `.claude/projects/*/memory/MEMORY.md`。Claude 项目记忆单独保留项目范围。这里只支持这些明确路径，不宣称覆盖所有 Agent 的私有记忆格式。

一次最多读取 32 份来源、每份 64 KiB、合计 256 KiB；Claude 项目记忆最多检查 24 个目录。常见凭据字段、令牌和私钥块会省略，不保证识别任意格式的秘密。二进制、超限、越出用户目录的链接和异常文件跳过并记录限制。不会读取普通聊天记录、会话、日志、命令历史或凭据文件，不遍历整个硬盘。

## 从内容形成记忆

启动先按原文与标题做轻量分类，每个来源最多导入八段，记录协作偏好、工作背景、项目线索、环境和其他明确线索。它是有来源的摘录，不是启动时已经完成深度语义分析。来源明述表示材料写过这件事，不等于独立核实；已有 Agent 记忆标为待核实，不仅凭工具/Skill 清单推断身份或敏感属性。

准备和执行任务复用同一 Pi 会话。模型需要时用原生 read 查记忆与证据，通过 `user_remember` 整理稳定信息、压缩重复表述和保存用户自然给出的明确纠正。该工具核对来源 ID 与原文摘录，保存前重读来源，不接受模型自己编造的用户引语；项目来源不能改成全局偏好，已有 Agent 记忆不能直接改标为来源明述。程序核对的是出处与版本，不是自然语言总结的全部语义。

明确用户纠正可以替代旧记忆；跨来源分歧没有用户纠正时保留两份观察。来源变化或删除后，依赖旧版本的整理结果标为过时，退出常驻短摘要。原文摘录、来源路径和哈希仍可追溯。最多保留 192 项记忆和 64 份来源，不能无限积累。

用户记忆默认随 discovery 开启，与默认关闭的“生成可复用任务 Skill”学习开关不同。不会固定增加学习 Agent、单独模型请求、后台总结轮次或新数据库；任务中整理造成的模型与工具轮次包含在原有 Pi 用量和任务预算中。

## 如何给Agent使用

新任务获得简短的系统/语言环境、已有 Agent 配置及能力数量，并得到最多六项全局记忆（每项至多 200 字符）与记忆/证据/Skill 目录的位置。项目记忆正文和完整目录不全部常驻上下文，相关任务再用原生 read 读取。任务需要某种能力时，模型用原生工具查目录、读取 SKILL.md，再按当前权限使用相对脚本或参考材料。未接入本项目的插件专用工具不能假装可调用。

准备和执行阶段的真实原生Skill读取都记录清单文件哈希；读取不等于执行、资产完整版本固定或质量提升。外部已有Skill保留原位置，不受本地生成试用Skill的128KiB打包限制，不复制整个资产目录。项目/生成方法仍沿用已有快照机制。

任务发生时，短概况、短记忆及实际读取的相关内容会进入用户配置的线上模型上下文；不自动发送原配置、凭据或完整 Skill 目录。当前用户要求优先，已有偏好与记忆不会更换本项目的模型、费用上限、权限、确认标准或驱动。

在`harness.config.json`设置`"discovery": false`可关闭后续扫描、记忆读取和新上下文注入，已有记录保留。直接嵌入 SDK 的 Config 只有显式 `discovery: true` 才启用；常规配置加载器默认开启。没有 discovery 标记的旧任务不追加环境信息；已有 v0.8 元数据任务没有 userMemory 标记，恢复时不追加用户记忆或整理工具。新行为只用于带该标记的新任务。

## 轻量实现与边界

Skill 解析继续使用 Pi1.4.0 公开 `loadSkills`，正文使用 Pi 原生 read；用户记忆整理通过公开 defineExtension/defineTool 接入原会话。普通本地文件只保存必要业务记忆和来源，不建设向量库、记忆服务、后台扫描服务或插件运行时。已有文件/脚本/会话/重试/恢复与费用路径不变。

扫描有总条目/时间预算、每源预算、深度及清单尺寸限制，处理符号链接去重与循环；缺失、损坏、无效或超限资源记录提示，任务仍可继续。当前不覆盖自定义Agent配置根目录、所有厂商私有插件格式或插件在线连接状态；不尝试自动安装、更新、登录或跨Agent运行专用插件。

依据已安装Pi1.4.0[Skills文档](../node_modules/@earendil-works/pi-coding-agent/docs/skills.md)及[packages](../node_modules/@earendil-works/pi-coding-agent/docs/packages.md)，并核对[Claude插件清单](https://code.claude.com/docs/en/plugins-reference)、[Claude MCP配置](https://code.claude.com/docs/en/mcp)、[Cursor Skills](https://cursor.com/help/customization/skills)、[OpenCode Skills](https://dev.opencode.ai/v2/docs/skills/)和[Gemini扩展清单](https://geminicli.com/docs/extensions/reference/)；Codex缓存清单位置同时在本机实际验证。

自动回归、原生入口、真实模型和干净安装验证见[提交前验证记录](verification-2026-10-31-discovery.md)。这项增量不改变此前未证明学习降本的结论。
