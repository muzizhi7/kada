# 学习成本复核与Pi生态借鉴

日期：2026-10-31。范围：读取本地实验原始记录、已安装Pi1.4.0文档，以及上游仓库当前文档/代码；本轮没有安装插件、改运行策略或增加付费任务。上一轮实现与全部失败批次见[开发试跑](experiments/2026-10-31-learning-results.md)。

## 贵在哪里

最终批次各组六个任务，估算模型费用：关闭学习USD0.036987684，开启USD0.053704056，Pi参考USD0.044555172。开启相对关闭的增量为USD0.016716372，即45.19%；它是六次开发样例的累计差异，不是普遍的单次学习税率。

从每个存档assistant响应重新累加usage，与任务总额逐项一致，未发现费用重复相加。当前记录采用的每百万token估算单价为非缓存输入USD0.30、输出1.20、缓存读取0.006；这是该批Pi价格口径，不是供应商账单或未来报价。

| 累计观察 | 关闭学习 | 开启学习 | 变化 |
|---|---:|---:|---:|
| 有用量记录的模型回复 | 44 | 66 | +50.0% |
| 非缓存输入token | 50,671 | 70,610 | +39.35% |
| 输出token | 16,787 | 24,050 | +43.27% |
| 缓存读取token | 273,664 | 610,176 | 数量增加，但单价低 |

| 增量费用来源 | USD | 占增量 |
|---|---:|---:|
| 更多非缓存输入 | 0.005981700 | 35.78% |
| 更多输出 | 0.008715600 | 52.14% |
| 更多缓存读取 | 0.002019072 | 12.08% |

[完整费用与逐次轮次拆分](experiments/artifacts/2026-10-31-learning/cost-breakdown.json)保留纯聚合数据与工具计数。缓存仍大量命中；不能只看累计token，或把压缩上下文当成唯一解法。

### 多数增量不是实际提炼动作

代码任务没有调用task_learn或task_method，却产生了71.03%的费用增量。其中最后一例关闭组9轮、开启组21轮，单例贡献整个增量的45.19%。实际轨迹包含反复修改补充自测与代码、未引用完整含空格路径导致的失败，以及两组都发生的确认核对输入/输出遗漏返工。

这些观察不能证明“学习工具执行直接造成所有增量”。当前提示与工具声明影响输入开销，模型选择更多自检/修正又增加输出和轮次；每个案例只有一次运行，生成波动、额外检查范围和缓存顺序都可能影响差异。质量口径仍须沿用原报告的原始检查与补充语义核对。

文件复用也没有自然节省：一个新输入上，学习组虽复制了保存脚本，但用了8轮，关闭组6轮。读取方法、检查适用条件、复制资产与说明仍需上下文和调用；本轮收益没有覆盖它们及首次提炼的开销。

当前可直接看到的浪费点包括：

- 开启学习就常驻提示与两份工具schema，即使本任务没有适用方法或值得提炼的发现。
- 原目标同时出现在system instructions与用户输入/确认说明中；task_status又可能返回完整说明，存在重复。
- 动态目标、工作区在系统指令前段，后面才是大段通用规则，不利于跨任务复用稳定前缀。实际能省多少仍需测，不能仅凭顺序推算。
- 原生工具已经设置工作目录，模型仍反复生成包含空格的绝对cd；确认过的核对命令及输入/输出仍要求模型重新抄写。可优先减少这些重复选择和错误，不增加反思流程。

## Pi本体已有能力

### 标准Skills与公开加载API：优先复用

[官方Skills文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)说明：启动时只暴露名字、描述、路径，相关时用read读取正文；Skill可带scripts/references/assets。模型也可能跳过相关Skill，官方文档提供显式skill命令，因此不能保证换格式就能解决调用率。

同版本的[pi-coding-agent包](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)当前为1.4.0，[公开导出](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/index.ts)包含loadSkills、loadSkillsFromDir、formatSkillsForPrompt及DefaultResourceLoader。

当前项目只安装pi-durable、pi-ai等底层SDK，没有安装pi-coding-agent。我们的defineExtension/GenerationTask接口与社区CLI插件的ExtensionAPI不同，运行pi install不会自动接入这个宿主。下一版应先验证官方加载API的薄适配，复用标准SKILL.md；执行和会话继续留在现有Pi路径，不迁移整套运行层。

已安装的[durable文档](../node_modules/@earendil-works/pi-durable/README.md)还提供稳定system sections、deferred工具/tool_search和codemode。大量工具时可延迟声明；批量工具链可只向模型返回筛选结果。但本项目仅两个新增工具，搜索本身也会增加轮次，不应无对照直接开启更多机制。

## 社区最相关实现

| 项目 | 核验内容 | 可借鉴点与取舍 |
|---|---|---|
| [Oh My Pi managed skills](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/manage_skill.md) | learn、manage_skill、autolearn设置与控制器源码 | 生成Skill与人工Skill隔离，人工版本优先；manage_skill不依赖记忆后端，本地文件即可。借鉴这部分，不迁移整个fork |
| [pi-self-learning](https://github.com/mcollina/pi-self-learning) | README、package.json、extensions/self-learning.ts | 日志与少量核心规则分层，频率/时效排序、去重和上限，git留痕；默认任务后反思会额外调用模型，不能作为低成本默认配置照搬 |
| [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) | 当前README的工具、检查、预算和恢复说明 | 固定可计算指标，试改、测量、保留或回退；原有正确性检查失败不能keep。可设置maxIterations，适合研发阶段有预算的策略试验 |
| [pi-reflect](https://github.com/jo-inc/pi-reflect) | 当前README | 从实际纠正中小幅修订行为文件，统计纠正率与规则复发；每次反思有额外模型调用，适合按事件/批次触发，不按每个普通任务固定执行 |
| [pi-condense](https://github.com/jjuraszek/pi-condense) | README | 按完成批次处理旧工具输出，保护缓存前缀、去重/落盘并可恢复原文；另有摘要成本。本轮增量主要是多输出和多轮，先不加第二套摘要路径 |

### Oh My Pi中与长目标直接相关的设计

[autolearn设置](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/autolearn/settings.ts)中enabled、autoContinue均默认false，自动捕获另有工具调用数量门槛。[控制器](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/autolearn/controller.ts)会跳过中止、计划模式及开始时或结束时处在Goal模式的轮次，避免学习提示和目标续跑竞争；被动模式保留稳定指令，不在普通结束后追加隐藏消息破坏缓存前缀。

这比“每次任务结束再开一个总结Agent”更符合本项目的边界。它也说明专用学习工具本身有生态先例；问题在于何时出现、是否带来收益，而非工具数量单独决定成本。

### 兼容性与证据限制

pi-self-learning当前package声明旧的@mariozechner/pi-coding-agent peer依赖；多个社区插件针对CLI事件与资源系统。本项目不能把仓库可安装等同于durable宿主可直接加载，也不能未经验证声称换插件会省钱。

检索中的两份旧Skill路径在主分支已404，未作为可直接采用的现存方案。pi-mind/pi-learn等更广记忆层还涉及索引、嵌入或后台整理，当前不作为本项目首选。上述仓库提供设计与代码证据，未发现能直接替代本项目同模型、同任务对照的成本证明。

## 建议的下一版颗粒度（尚未实现）

1. 保留现有目标确认、原始检查绑定和成本记录。先对固定核对标准支持按ID复用已确认命令/输入/输出，减少抄写与遗漏；这属于现有业务工具的简化。
2. 已验证的可复用脚本与说明改为标准Skill目录，优先试官方加载/格式化API；验证能否收缩自研匹配和专用加载schema，避免两套发现机制。
3. 常驻上下文只保留极短的规则与Skill元数据；正文按需读取。只有同类错误复发、用户纠正或已验证的重复工作产出时才提炼，不固定增加结束后学习轮次。
4. 例如“原生工具已在任务目录，优先相对路径，含空格路径正确引用”比每次重写一份泛用算法经验更可能避免已观察到的返工。规则也需限定适用条件、去重和淘汰。
5. 借鉴autoresearch的测量/保留/回退，在预算内对照瘦身后的策略；保留原始质量条件，确认完整序列成本下降后再启用。当前学习继续默认关闭。

本轮仅形成研究结论和费用核对；未把候选方案标为已实现或改写历史实验结果。
