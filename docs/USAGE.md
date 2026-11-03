# Kada 使用手册

## 开始使用

需要 Node.js 24.7 或更高版本，使用 Node 内置 SQLite。

```sh
npm ci --ignore-scripts
cp .env.example .env
```

在 `.env` 配置 `MODEL_PROVIDER`、`MODEL_ID` 和供应商密钥，然后在**项目目录**运行：

```sh
npm run chat
```

已配置的 `.env` 无需覆盖。CLI 自动加载当前目录的 `.env`，不会覆盖已导出的环境变量。可以用 `npm run harness -- models [provider]` 查看安装版本的 Pi 模型目录；当前 DeepSeek 配置使用 `deepseek/deepseek-flash`。

在其他目录运行时，指定实际项目路径：

```sh
npm --prefix "/absolute/path/to/project" run chat
```

看到 `你 >` 后可以直接聊天。问答、背景与记忆交流、简短文本和结束语直接回复，不建立 Goal，也不要求确认预算。需要实际交付时输入目标，例如：

```text
读取 inputs 的 JSON，用终端计算分类汇总，生成 result.json 和 report.md，检查结果后交付。
```

Agent 在同一 Pi 会话中按需建立任务，先只读材料，集中询问必要信息，再展示目标、交付物、标准、范围和总预算。内容需要调整时直接说明；完整说明展示后回复“确认开始”或 `/confirm`，随后自主执行、检查和修正。普通阶段切换不再询问确认。

聊天自动启动或连接后台服务。退出客户端后，已确认的执行继续在后台；待确认任务只保存，不会自行开始。服务和电脑需要保持运行。

| 命令 | 用途 |
|---|---|
| `/new [消息]` | 新建普通对话，原任务继续运行 |
| `/confirm` 或“确认开始” | 确认刚展示版本的任务说明、标准与预算 |
| `/run 已授权目标` | 已有明确授权时，新建任务并沿用配置预算直接执行 |
| `/tasks`、`/attach 任务ID` | 查看并接回已有对话或任务 |
| `/status` | 查看核验范围、费用、输入/输出及缓存、当前上下文和累计压缩 |
| `/pause`、`/resume`、`/cancel` | 暂停、恢复、取消 |
| `/quit` 或 Ctrl+C | 退出聊天，保留后台服务 |

确认前可用普通语言修改目标、标准或预算，Agent 会生成新版说明；旧版确认不会生效。后续普通补充继续同一目标和剩余预算，不自动加钱。要重订已确认标准或预算，可用 `/new` 重新说明；`/resume` 是显式补充预算的操作。新任务默认有独立输出目录；指定工作区用 `npm run chat -- --workspace /absolute/path`。

升级后需要重启旧后台服务并重新进入聊天，桌面入口也需要退出后重开；已有任务、密钥和输出保留。普通会话用于新建对话，接回旧任务保持其保存的工具、预算和计划约束。客户端会检查后台是否支持普通会话，避免同版本旧进程忽略新模式。

## 长任务如何推进

用户确认目标、标准和预算后，Pi 执行模型循环和工具。本项目在执行边界检查实际交付：候选缺文件、遗漏确认标准、命令检查失败或回执对应文件已经变化时，将具体问题返回给 Agent 自动修正。模型一轮结束或只说“完成”不等于目标完成。

默认执行直接的交付检查，不为每个任务另开评审 Agent。`review: true` 可启用独立只读评审；子 Agent 也按需调用。委派直接使用 Pi 的会话、任务归属、等待与取消机制，结果只返回摘要和文件路径。

新任务的计划与 checkpoint 仅记录辅助进度，未登记步骤会提示但不阻止交付；用户和 Agent 追加的实际验收条件仍有效。继续/返工暂由原有一处宿主边界决定：已实测自然答复经过 Pi onYield，但 task_submit 的终止工具绕过该 hook，没有再叠加一套续跑机制。

上下文整理使用 Pi 自带后台压缩，默认约 48,000 个当前上下文 token 时开始准备摘要，具体受模型窗口约束。**上下文长度与多次请求累计计费 token 是两个指标**；缓存输入也计入累计 token。因此新版默认不再用累计 500,000 token 强制暂停任务。

暂停、常规恢复和内部阶段转换依靠 Pi 的持久记录。命令、写文件或桌面动作中断后的效果可能不确定；Agent 需检查真实进程、文件或应用状态再继续，不能假定动作从未执行。

## 配置与预算

复制 `harness.config.example.json` 为本地 `harness.config.json`，按需调整：

```json
{
  "maxSubagents": 3,
  "maxDurationMs": 3600000,
  "maxEstimatedCostUsd": 1,
  "compactAtTokens": 48000,
  "review": false,
  "web": true,
  "maxReworks": 3,
  "maxStalls": 2
}
```

这些值是普通会话的累计用量上限、单轮时限，以及任务澄清阶段的已配置上限和默认提议。普通会话等待用户期间不消耗单轮时限，下一条消息沿用剩余费用/token；重启不补额度。确认后的费用/token 上限是任务说明中的总额，包含同会话已经发生的消耗；执行时限从确认开始，等待用户确认不扣执行时间。`maxTotalTokens` 仅在显式配置时启用。费用来自 Pi usage，包含主/子 Agent、压缩和可选评审，不能代替供应商账单；在途请求可能使费用超出设置值。

真实预算耗尽时停下；`/resume` 显式补充一份已确认预算（历史/直接执行任务沿用配置），保留累计消耗。普通消息、重复确认和服务重启都不补配额；确认后的离线时间计入执行时限。连续失败达到返工/无进展限制时保存原因，避免无效消耗。`maxReworks: 0`可关闭自动反馈，首次核验失败即记录`needs_attention`，用于组件对照或手动接管，不算任务完成。

JSON 也可设置 `model`、`subagentModel`，格式为 `{"provider":"...","modelId":"..."}`；主模型环境变量优先。`HARNESS_DATA_DIR`、`HARNESS_PORT` 可覆盖状态目录和端口。所有 CLI 命令支持 `--config /absolute/path/config.json`。

## 联网

`web_search`、`web_fetch` 直接调用 DeepSeek 官方 Search/Fetch API，使用 `DEEPSEEK_API_KEY`。没有该 key 时，可使用已安装的 Agent Reach CLI。页面返回普通 404 时允许尝试 Agent Reach；鉴权拒绝和限流不会自动换渠道绕过。

搜索摘要和页面正文保存到工作区 `.sources/`，模型只收到有长度上限的摘要/预览，全文可用 Pi `read` 分段读取。工具费用使用保守估算；Agent Reach 的外部服务费用未计入。

明确要求“查资料/联网搜索”等的任务，交付前需有成功检索、正文读取记录及实际读取 URL 的引用，不能用离线草稿冒充。这个检查证明访问和引用发生过，**不证明报告每项事实正确、来源充分或结论可靠**。其他联网工具的验收接入仍需按需适配。

## 检查交付物

确认前只有 Pi 原生 `read`、列目录、读取任务状态和起草说明工具；写入、命令执行与委派在确认后才开放。这是工具选择限制，不是 OS 沙箱。

Agent 可调用 `task_plan`、`task_checkpoint` 保存简短进度，`task_status` 找回确认标准与证明摘要，`task_submit` 提交每项标准的结果，`task_blocked` 记录真实阻塞。经过确认流程的任务，其命令型标准需要 `task_verify` 的实际通过回执：它直接调用 Pi bash，保存退出码、输出预览、输入/产物哈希；文件变化后必须重新验证。内容型标准说明具体自检证据。已有授权的直接执行入口仍可使用 Pi 原生命令与配置检查。自检、命令通过和独立语义复核分别呈现，不能相互替代。

[原生Skills](../skills)提供数据/研究、批量文件和代码修改三份按需说明，使用Pi公开加载API；`methods/`保留给旧任务。计划和子 Agent 仍为可选，不要求逐步补登记才能交付。

可以把固定条件保存为 `acceptance.json`：

```json
[
  { "type": "file_exists", "path": "report.md" },
  { "type": "file_contains", "path": "report.md", "text": "来源" },
  { "type": "json_value", "path": "result.json", "pointer": "/total", "equals": 71 }
]
```

```sh
npm run harness -- run "汇总 inputs 并生成报告和计算结果" --workspace /absolute/path --acceptance /absolute/path/acceptance.json
```

交付检查对常规文件流式保存原始字节大小与SHA-256，支持大ZIP等二进制；声明产物可为文件或目录，允许空文件/空目录。目录快照覆盖成员路径、文件原字节和空目录，不跟随符号链接/特殊文件。这些检查不证明格式/内容正确。文本包含/JSON条件单独限于≤1MiB的严格UTF-8、无NUL文本；用户条件不能被Agent删除或降低。已有测试或提供的检查可在确认说明的标准中记录`verification: {command, inputs, outputs}`：确认固定inputs原字节，交付须有同一命令和约定输入/输出的实际回执。待修改源码应列为outputs；自编测试不自动成为独立证明。[本轮验证](verification-2026-10-31-delivery.md)说明实际范围。终端可运行任务相关计算和测试，宿主不根据产物文本执行任意验收脚本。API的`completed`保留兼容含义，交付展示实际核验范围；0项检查和模型自评都不等于完整质量证明。可选只读模型评审仍主要支持有限文本，高要求任务需实际方法和必要抽查。

终端和桌面新对话通过 HTTP `POST /v1/tasks` 的 `mode: "chat"` 复用 Pi 会话；GoalDoc 直到实际调用 task_prepare 才创建，普通回复从 Pi 原有记录投影。默认 `run` 和不带 mode 的显式任务 API 仍先准备说明。已有明确授权的自动化可用 `run --yes` 或请求中的 `confirmed: true` 直接执行，沿用配置预算；chat 模式不接受预确认或验收条件。确认接口是 `POST /v1/tasks/:id/confirm`，提交 `{ "revision": goal.brief.revision, "digest": briefDigest }`（值取自当前 GET 状态）；普通 messages 接口不能代替确认。

## 电脑操作：可选，默认关闭

保留通用 stdio MCP 薄接口，不绑定某个驱动。当前未配置、未启用真实电脑驱动；真实桌面任务尚未验证。执行方式与驱动选型待确认，不自动安装或请求系统授权。

若以后选择接入已有驱动，`computer` 配置需要 `command`、可选 `args/env`、显式 `tools` allowlist。`observationTools` 可指定其中真正读取界面状态的工具；`leaseMs` 控制占用过期时间，默认 120 秒。启动时验证工具名，`computer_guide` 可读取该驱动公开的操作说明。

只有主 Agent 获取电脑工具。`computer_begin` 到 `computer_end` 为一段依赖流程占用本服务的桌面，阻止其他任务插入操作；新占用或恢复后先读取当前界面。动作本身仍串行执行。租约只协调当前服务，不隔离用户手动操作及其他进程，也不提供外部动作 exactly-once 保证。截图需要支持图像输入的模型。

## 结构与执行权限

```text
CLI / 本地服务
    ↓
目标推进策略 · 本地执行协调 · 按任务检查
    ↓
Pi AI / durable：模型、循环、工具、会话、压缩、SQLite 与恢复
    ↓
Pi bash/read/write/edit · 官方联网服务 · 可选电脑驱动
```

每个顶层任务一份 Pi SQLite，子 Agent 各有上下文和默认输出目录，不递归委派。任务记录位于 `.harness/tasks/<uuid>/`。服务监听 `127.0.0.1`，API 使用本地 token、拒绝跨源请求，状态目录用进程锁避免同时打开。

Pi 原生终端和文件工具使用当前本地用户的权限，**没有操作系统沙箱或工作区隔离**；验收器的路径限制不能约束 Shell。终端命令默认只继承普通工具环境，不自动注入 daemon 的供应商密钥；命令仍可访问本地用户有权读取的文件。工具执行、取消、截断和输出落盘由 Pi 实现。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run demo
```

自动测试和 `demo` 使用脚本化模型；Pi 运行时、文件、进程和 SQLite 为真实实现，桌面使用模拟 MCP。测试不消耗线上模型额度。

以下显式联调会调用已配置的线上模型：

```sh
npm run test:live       # 故意交错结果 → 自动修正 → 两个子 Agent → 可选评审
npm run test:live:web   # 实际检索、读正文、写文件和终端检查
npm run test:live:intake # 只读准备 → 确认一次 → 修正草稿 → 实际命令核验；单次预算最多 USD0.10
npm run test:cases      # 8 类办公/编程判据自检，需开发用 Python 办公依赖；不调用模型
npm run test:compare:cases # 准备32次对照；加 --execute 才付费，详见冻结协议
npm run test:compare    # 原生 Pi 与本扩展的同模型、同终端工具单案例对照
npm run test:compare:long -- /path/to/prepared-fixture # 真实研究任务三组对照，会调用线上模型
npm run test:compare:heldout -- /path/to/study # 准备后冻结；加--execute才开始36次付费执行
npm run test:compare:feedback -- /path/to/study # 新的反馈组件对照；加--execute才开始8次付费执行
```

联调记录位于 `.harness/live-tests/`，对照记录位于 `.harness/benchmarks/`。目前已验证具体机制，36次三类任务对照及后续8次反馈消融均未达到重复收益门槛；有效小时级、混合桌面流程及更广泛任务质量仍待验证。

真实三组对照的准备与复核入口见 [试验协议](experiments/2026-10-30-long-task-protocol.md)，记录另存 `.harness/benchmarks/`。本次三组都无需人工续跑、主要数值和重建正确，但报告均留有错误；当前实现没有显示质量优势。能力取舍、缓存用量、费用与方法限制见 [完整结果](experiments/2026-10-30-long-task-results.md)。

后续六个新任务的[固定协议](experiments/2026-10-31-heldout-protocol.md)、[完整结果](experiments/2026-10-31-heldout-results.md)及[逐次CSV](experiments/artifacts/2026-10-31-heldout/runs.csv)保留所有失败与评分器敏感性。36次共估算USD3.9279，0条外部消息由设计固定，不能当作减少必要介入的证明。报告明确基线为Pi SDK加共同适配，不是开箱Pi CLI；原始会话、用户路径和凭据不进入导出数据。

v0.5.1的[反馈开关组件对照](experiments/2026-10-31-feedback-results.md)共8次，双方使用同一生产Pi适配，仅`maxReworks=0/3`不同。有效尝试估算USD0.3495，连同因共享TypeScript入口缺陷而整批作废的尝试已记录USD0.5144；中断请求可能缺usage。按交付要求统一复核后产物合格数为关4/4、开2/4，宿主合格交付各2/4。原始固定评分与范围过严的敏感性解释均保留，不能把提交清单返工算成质量收益。现有默认反馈次数和历史配置未改。

办公与编程案例的输入、判据、预算和对照限制见[冻结协议](experiments/2026-11-01-office-code-protocol.md)。

[办公与编程32次真实执行结果](experiments/2026-11-01-office-code-results.md)已保留原始失败、检查器纠正和补充复核。公开检查通过仍可能遗漏业务语义，不能作为稳定长任务或成本优势的证明。
