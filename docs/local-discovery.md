# 首次启动：发现本机 Agent 与能力

v0.8.0。首次启动本地后台会自动发现已有Agent配置、标准Skills、插件与MCP声明，生成本机工作环境概况；没有配置线上模型时也能完成。扫描不调用模型、不导入扩展代码、不执行插件或MCP命令，也不改原Agent配置。

## 用户体验

运行`npm run chat`、`npm run dev`或`npm run pet`，后台首次启动时扫描一次。后续启动复用缓存，不在每条消息前重新扫描。

查看或刷新：

```sh
npm run discover
npm run discover -- --refresh
```

小宠物菜单新增“本机 Agent 与 Skills…”，打开本地概况。无需为了扫描重复确认；正常任务的目标、范围和总预算仍须按原流程确认。发现现有资源不扩大当前任务的授权，也不会打开computer-use驱动。

概况保存在本机数据目录的`local-context/`：

- `inventory.json`：结构化观察记录。
- `overview.md`：Agent配置、模型/语言偏好、用户指导文件位置、插件/MCP概况及扫描限制。
- `skills.md`：逐行的名字、用途、来源、原SKILL.md路径和关闭状态，可用Pi原生read/grep按需查找。

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

不扫描整个用户目录；只访问约定Agent目录以及配置明确引用的本地Skill/已安装插件路径。不扫描会话、历史、日志、项目列表或凭据文件；混合设置文件中只提取白名单字段，API Key、env、命令参数、headers、账户信息和带认证的URL不进入概况。用户指导文件只记录位置，不预先复制正文，不据此推断职业、身份或私人兴趣。

## 如何给Agent使用

新任务获得简短的系统/语言环境、已有Agent配置及能力数量，并得到本地概况和Skill目录的路径。完整目录和正文不会全部常驻上下文。任务需要某种能力时，模型用原生工具查目录、读取SKILL.md，再按当前权限使用相对脚本或参考材料。未接入本项目的插件专用工具不能假装可调用。

准备和执行阶段的真实原生Skill读取都记录清单文件哈希；读取不等于执行、资产完整版本固定或质量提升。外部已有Skill保留原位置，不受本地生成试用Skill的128KiB打包限制，不复制整个资产目录。项目/生成方法仍沿用已有快照机制。

任务发生时，短概况及实际读取的内容会进入用户配置的线上模型上下文；不自动发送原配置、凭据或完整Skill目录。当前用户要求优先，已有设置中的模型偏好不会更换本项目的模型、费用上限、权限或驱动。

在`harness.config.json`设置`"discovery": false`可关闭后续扫描和新上下文注入，已有任务记录保留。直接嵌入SDK的Config只有显式`discovery: true`才启用；常规配置加载器默认开启。旧任务没有discovery标记，恢复时不追加这份个人上下文。

## 轻量实现与边界

Skill解析继续使用Pi1.4.0公开`loadSkills`，正文使用Pi原生read；已有文件/脚本/会话/重试/恢复与费用路径不变。TOML和JSONC使用现成小解析器。只增加普通本地文件缓存，没有模型反思、向量库、后台扫描服务或插件运行时。

扫描有总条目/时间预算、每源预算、深度及清单尺寸限制，处理符号链接去重与循环；缺失、损坏、无效或超限资源记录提示，任务仍可继续。当前不覆盖自定义Agent配置根目录、所有厂商私有插件格式或插件在线连接状态；不尝试自动安装、更新、登录或跨Agent运行专用插件。

依据已安装Pi1.4.0[Skills文档](../node_modules/@earendil-works/pi-coding-agent/docs/skills.md)及[packages](../node_modules/@earendil-works/pi-coding-agent/docs/packages.md)，并核对[Claude插件清单](https://code.claude.com/docs/en/plugins-reference)、[Claude MCP配置](https://code.claude.com/docs/en/mcp)、[Cursor Skills](https://cursor.com/help/customization/skills)、[OpenCode Skills](https://dev.opencode.ai/v2/docs/skills/)和[Gemini扩展清单](https://geminicli.com/docs/extensions/reference/)；Codex缓存清单位置同时在本机实际验证。

自动回归、原生入口、真实模型和干净安装验证见[提交前验证记录](verification-2026-10-31-discovery.md)。这项增量不改变此前未证明学习降本的结论。
