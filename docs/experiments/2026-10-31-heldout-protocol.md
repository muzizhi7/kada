# 三类真实任务的固定条件对照

本次按用户要求实际执行。所有输入、标准、脚本和候选生产代码在第一次付费请求前冻结。此前汽车案例属于开发回归，本批六个新任务不复用该案例。

## 任务与范围

| 类别 | 任务 | 实际输入与交付 |
|---|---|---|
| 资料研究 | 气温与CO₂简报 | NASA GISTEMP、NOAA Mauna Loa年均/增长率和说明；逐年数据、OLS、报告、引用、图及重建 |
| 资料研究 | 九地区电力结构 | OWID发布的四张真实电力表与元数据；2015–2025、加权与简单均值、生命周期单位、报告和重建 |
| 批量文件 | 去重归档 | 三个真实开源仓库约2,700个文件；字节去重、映射、完整性、ZIP、重复执行 |
| 批量文件 | Markdown迁移 | Rust Book src的112份Markdown及附件；扁平编号、URL重写、代码区块保留、索引和ZIP |
| 代码修改 | QuickLRU | 固定MIT源码，增加同步惰性填充接口，覆盖falsey、TTL、工厂副作用、泛型与兼容性 |
| 代码修改 | MRI | 固定MIT源码，修复配置复用与负数参数；冻结配置、别名/布尔、readonly类型和兼容性 |

原始来源：[NASA](https://data.giss.nasa.gov/gistemp/)、[NOAA](https://gml.noaa.gov/ccgg/trends/data.html)、[OWID electricity](https://ourworldindata.org/grapher/electricity-generation)、[QuickLRU](https://github.com/sindresorhus/quick-lru)、[MRI](https://github.com/lukeed/mri)、[Rust Book](https://github.com/rust-lang/book)。下载链接、实际提交、时间、大小及SHA保存在source-manifest.json；不声称代码任务是已有上游issue的复现。

完整公开要求见 [tasks.py](../../scripts/heldout/tasks.py)，复制到各工作区TASK.md/BRIEF.json。全量原始输入、许可证保留。代码项目上游开发依赖不安装，提供少量Node内建公共测试；保留上游测试原件但不宣称完整运行上游开发链。

本批从**目标、范围和预算已经确认**后开始；同一份固定说明写入各组Pi业务文档。它只比较执行、检查与返工，不能证明模糊需求澄清的收益。研究使用冻结的实际公开资料，不能据此推断开放式实时搜索质量。

## 条件与预算

- Pi AI/durable 1.4.0、当前配置 deepseek/deepseek-flash，所有子Agent同模型。
- Pi SDK加共同工具、同SDK加固定Goal-Driven初始用户提示、冻结的当前生产LocalRuntime；不是开箱Pi CLI/TUI对照。
- 相同11个根工具：Pi read/write/edit/bash、delegate、task_status/task_plan/task_checkpoint/task_submit/task_blocked、task_verify。子Agent只用四个原生工具，最多3个并发；方法文件可供各组同样读取。
- 每次估算USD0.25、60分钟，无累计token硬限；相同重试2次、流式请求超时120秒、48k后台压缩。完整运行期间不改策略。
- 6任务×3条件×2次，共36次；按任务/重复分块，六种组内顺序各使用两次，记录实际顺序。基准执行串行，避免同时运行的方案争用本机资源。
- 名义费用总额USD9，整批估算费用保护线USD10（预留在途余量），整批执行时限12小时；达到边界停止并披露未执行项，不自动加额。价格和用量来自Pi目录/ledger，不代替账单；被强杀或断流的未返回请求可能缺少完整usage。
- 关闭独立模型评审与联网/电脑工具，各组权限一致；Pi原生Shell仍是用户权限，不是OS沙箱。仅在隔离的评测目录工作，不改用户历史任务、配置与凭据。

Goal-Driven使用已有固定提交c8e54ba3e9a4cf65df8fd9d92d0f9b231cab7f45的模板。共同delegate为前台持久子会话，父会话等待时由Pi挂起；不另造五分钟后台看门狗。声明这一适配限制，不把模板视为完整独立产品。

候选组复用冻结的生产LocalRuntime及实际标准/回执检查，不为任务加入私有答案或新增检查策略。为了比较已确认执行，评测准备程序用Pi公开API预置真实用户授权范围内的固定说明，跳过各组不同的澄清过程。生产源码不为本批改写。

## 恢复与介入

- MRI任务各组每次的第一次原生工具调用通过Pi公开beforeTool hook返回一次暂时不可用，之后正常；事件标记在试验目录持久保存，重开不重复注入。
- Markdown任务在第一次迁移后的页面实际出现时，仅SIGKILL当前评测worker一次；随后使用同一Pi会话和原费用/截止时间恢复，不补发用户消息。记录外部状态和是否真正命中边界；若没命中，不算已验证恢复。
- 不增加睡眠、无关文档或额外返工来伪造小时级时长。若任务自然提前完成，记录真实耗时，小时级仍算未覆盖。
- 免费准备校验发现SIGKILL可发生在外部写入生效而工具回执未提交之间，非幂等追加可能重放。Pi会话恢复不等于任意外部动作恰好一次。执行链路校验使用幂等物化命令；正式迁移任务仍按实际内容和重复记录验收，不豁免恢复缺陷。
- 执行中不补发“继续”、不修文件、不喂评分。实际用户/评测者后续消息=0，模型请求用户信息另计，程序内部返工另计。失败的零消息运行不算无人介入合格完成；尚需何种纠正由事后复核说明，不捏造必要人工次数。

## 外部检查与判定

全部36次结束后才运行固定评分器；输入完整性、完整数据/公式、报告表格、引用定位结构、逐文件/ZIP字节、链接重写、代码行为/类型、全新输出重建和变更输入测试均在模型执行之外检查。研究报告语义、实际引用支持、图可读性及验证说明真实性另行逐份复核。评分器冻结前用手算小样本、正确文件包和损坏样本验证；代码原始快照应加载并通过旧行为探针，同时未满足新增要求。

不以总分覆盖关键失败，分别报告：

1. 外部核对满足全部关键条件的产物数。
2. 无外部纠正且向用户有效交付的次数；候选宿主误拦截好产物与误判坏产物均记录。
3. 模型请求信息、实际外部消息、内部返工、恢复重复动作。
4. 主/子/压缩全量Pi推理估算费用、累计/缓存/非缓存输入/输出token、耗时、失败尝试费用；CodeX当前整理/复核与本地CPU费用不在Pi账本中，不混称供应商总账单。

语义复核尽可能用随机编号隐藏方案标签；当前编码助手参与制定任务与复核，属于助手审阅，不冒称独立人类双盲或另一个模型的确定性裁判。保留逐份判断与证据。所有尝试、技术失败与缺失结果都保留；不只挑有利的一次。

保留门槛沿用SPEC：至少两个新任务上有可重复的完整交付/介入改善，不增加错误完成；双方都成功的任务，默认附加费用中位数原则上≤25%。六个任务两次重复不能宣称统计显著。若共同工具+固定提示已获得相同收益，就收缩额外控制；若没有增量，停止扩建运行层。

## 入口与复现

```sh
python3 scripts/heldout/download.py .harness/benchmarks/heldout-2026-10-31
python3 scripts/heldout/prepare.py .harness/benchmarks/heldout-2026-10-31
python3 scripts/heldout/test_grade.py .harness/benchmarks/heldout-2026-10-31
npx tsx scripts/heldout/test.ts # 免费替身，实际Pi/进程恢复，不是质量结果
npx tsx scripts/heldout/study.ts .harness/benchmarks/heldout-2026-10-31 # 冻结
npx tsx scripts/heldout/study.ts .harness/benchmarks/heldout-2026-10-31 --execute # 真实付费
python3 .harness/benchmarks/heldout-2026-10-31/frozen/scripts/heldout/grade.py .harness/benchmarks/heldout-2026-10-31
```

study.ts续开会跳过已有结果并保留时间/消耗；异常worker未留下可核实账本时停止整批。中断结果与原会话保留在Git忽略的.harness目录。上述是本批实验脚本，不是新增Agent运行时、调度器或产品数据库。
