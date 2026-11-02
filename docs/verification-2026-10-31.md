# 原型收敛验证记录

日期：2026-10-31。代码版本 v0.3.1，Pi 依赖保持 1.4.0。本轮完成 [ROADMAP](ROADMAP.md) 的步骤 0 和 1；目标澄清/确认、更多任务方法和留出对照仍未实现或执行。

## Pi hook 的实测边界与实现决定

先核对安装包公开的 Hooks 文档、GenerationHooks/HookApi 类型，以及生成结束边界，再用真实 Pi Harness 和 SQLite 测试：

- 自然语言答复会触发 onYield。返回 continue 后，Pi 在原 run 中持久化继续消息，不需要宿主补发 input。
- 工具报错会作为实际错误返回模型，Pi 正常进入下一轮。
- task_submit 的 control.terminate 经过 afterTools 后结束；**不会调用 onYield**。afterTools 的公开返回类型也没有 continue 决策。
- 自然答复的继续消息落盘、原生 bash 完成追加后，执行一次真实 Pi 压缩；在后续模型请求期间 SIGKILL。重开同一存储、重用 initial requestId 后完成：同一个 input、一个继续消息、一次 bash 调用，文件只有一行追加，没有重复外部动作。

据此，本轮保留现有宿主为唯一目标检查/返工决策处。没有同时启用另一个生产 onYield 续跑机制，也没有为了覆盖终止工具重写运行时。onYield 作为已验证的扩展点；日后改变提交边界时再评估迁移。现有强杀返工/评审恢复测试继续验证宿主 outbox 和请求去重。

测试见 [pi-hooks.test.ts](../test/pi-hooks.test.ts) 与 [hooks-worker.ts](../test/fixtures/hooks-worker.ts)。模型响应是脚本化 Faux，Pi、进程、原生工具、SQLite、压缩和 SIGKILL 为真实实现；这验证机制，不验证线上模型的任务质量。

## 计划改为辅助进度

新建任务保存 planPolicy=advisory。计划步骤未登记 done 仅产生进度提示，不作为失败检查、不要求补 checkpoint 才能提交；工具说明与返工提示同步调整。

用户配置和 Agent 追加的验收条件仍需通过，不能被删除或放宽。新任务用真实失败原因、检查结果与产物快照判断重复失败，改计划 ID/状态不能被算作修复进展。原有预算和失败停止上限继续保留。

旧任务缺少 advisory 标记时，继续使用原有计划约束；不批量改写 task.json。测试分别覆盖新任务缺文件自动修正、未登记计划顺利交付、旧 v0.3 仍须补登记、重复失败不能靠改计划掩盖，以及关闭重开后的策略和预算不变。既有 v0.2 兼容测试仍通过。

## 核验范围和消耗展示

聊天在展示候选答复前说明实际检查范围；/status 和 CLI run 使用同一展示函数：

- 区分产物可读/非空、文件可读、指定文本、指定 JSON 值，以及联网访问/URL 引用记录。
- 未配置产物或客观条件时直接说明，不显示“0/0 通过”或据此宣称全部完成。
- 区分未独立复核与独立模型复核通过；后者仍是模型判断。保留 API 的 completed 状态兼容，但不将其渲染成全部语义要求已获证明。
- 将估算费用、累计 token、非缓存输入、缓存读取、缓存写入和输出分别展示。费用来自 Pi ledger，非供应商账单。
- 当前主 Agent 上下文通过 Pi AI 公开的 estimateContextTokens 估算，标明约值和模型窗口；与全任务累计消耗分开。
- 累计压缩遍历 Pi 持久条目，覆盖主/子 Agent 和评审会话；同时给出主 Agent 次数。内存中只缓存已扫描位置和计数，重开从 Pi 记录重建，不创建持久计数系统。

针对统计的回归使用三次真实手动压缩：主会话两次、另一会话一次，以及超过一页的条目。验证当前可见上下文只有一个压缩标记时，累计仍为三次；反复查询和重开不增不减。展示回归直接对照 Pi provider ledger，覆盖缓存读写拆分和答复前的验证说明。

测试见 [convergence.test.ts](../test/convergence.test.ts)。实现位置：[runtime.ts](../src/runtime.ts)、[goal.ts](../src/goal.ts)、[checks.ts](../src/checks.ts)、[presentation.ts](../src/presentation.ts)。

## 已完成验证

| 验证 | 结果 |
|---|---|
| npm run typecheck | 通过 |
| npm test | 42 通过，0 失败（原有 35 + 新增 7） |
| npm run build | 通过 |
| 新测试/worker 与长任务脚本的独立严格 TypeScript 检查 | 通过 |
| npm run demo（临时独立数据目录） | 通过；两个 worker 与只读评审，不调用线上模型 |
| 本地后台升级 | 空闲时从 v0.3.0 平滑重启到 v0.3.1，health 确认版本 |
| 历史保留核对 | 六个任务；.env、本地 token、task.json 字节哈希未变；累计用量和费用/token 配额未变 |

本轮没有调用线上付费模型、重跑留出评测或启用电脑驱动。既有真实汽车案例的报告错误不因此被修复，也不宣称长任务完成率已经提升。历史任务、配置和凭据保留；重新进入聊天，通过 /new 新建任务使用辅助计划策略。
