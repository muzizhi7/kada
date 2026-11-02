import type { TaskStatus } from "./client.js";

export function briefText(status: TaskStatus): string {
  const brief = status.goal?.brief;
  if (!brief) return "正在整理目标与交付标准。";
  const list = (name: string, values: string[]) => values.length ? `${name}：\n${values.map((v, i) => `  ${i + 1}. ${v}`).join("\n")}` : `${name}：无新增。`;
  return [
    `任务说明 v${brief.revision}${status.goal?.confirmation ? "（已确认）" : brief.questions.length ? "（待澄清）" : "（待确认）"}`,
    `目标：${brief.outcome}`, `工作区：${status.workspace}`,
    list("交付物", brief.deliverables), list("输入资料", brief.inputs),
    list("交付标准", brief.criteria.map(c => `${c.text}〔${c.method === "check" ? "命令核验" : "内容自检"}〕${c.verification ? `\n     核对命令：${c.verification.command}\n     保持原样：${c.verification.inputs.join("、")}；核对产物：${c.verification.outputs.join("、")}` : ""}`)),
    list("执行范围", brief.scope), list("假设与限制", brief.assumptions),
    `总费用上限：$${brief.budget.maxEstimatedCostUsd}（含已用澄清费用 $${status.budget.estimatedCostUsd.toFixed(4)}）；执行时限：${brief.budget.maxDurationMs / 60_000} 分钟（从确认开始）。`,
    ...(brief.budget.maxTotalTokens === undefined ? [] : [`累计 token 上限：${brief.budget.maxTotalTokens}（含澄清）。`]),
    status.goal?.confirmation ? "该版本已确认，普通阶段无需重复确认；实际核验见任务状态。" : brief.questions.length ? list("请补充必要信息", brief.questions) : "回复“确认开始”或 /confirm 执行；要修改内容或预算，直接说明。",
  ].join("\n");
}

/** Describe the checks that actually ran, rather than equating a receipt with semantic completion. */
export function verificationText(status: TaskStatus): string {
  const goal = status.goal;
  if (!goal) return "验证范围：历史对话，没有目标验收记录。";
  const report = goal.mechanical;
  const lines: string[] = [];
  if (!report) lines.push("交付检查：尚未执行。");
  else if (!report.results.length) lines.push("交付检查：未配置产物或可自动核验的条件。");
  else {
    lines.push(`已配置交付检查：${report.results.filter(r => r.passed).length}/${report.results.length} 通过；留存 ${report.files.length} 个文件快照${report.directories?.length ? `、${report.directories.length} 个目录快照` : ""}。`);
    const scopes: string[] = [];
    if (report.results.some(r => r.label.startsWith("artifact:"))) scopes.push("声明文件/目录存在及原字节版本（允许空文件/目录）");
    if (report.results.some(r => r.label.startsWith("file_exists:"))) scopes.push("文件存在/可读");
    if (report.results.some(r => r.label.startsWith("file_contains:"))) scopes.push("指定文本包含");
    if (report.results.some(r => r.label.startsWith("json_value:"))) scopes.push("指定 JSON 值");
    if (report.results.some(r => r.label === "requested live research")) scopes.push("联网访问与实际 URL 引用记录");
    if (report.results.some(r => r.label === "plan")) scopes.push("历史任务的计划登记条件");
    if (report.results.some(r => r.label.startsWith("confirmed criterion"))) scopes.push("确认标准的自检覆盖与命令回执/文件版本（非独立语义证明）");
    if (scopes.length) lines.push(`核验范围：${scopes.join("；")}。`);
    for (const failure of report.results.filter(r => !r.passed)) lines.push(`未通过：${failure.label} — ${failure.detail}`);
  }
  if (goal.verification?.method === "model") {
    lines.push("独立模型复核：通过；语义结论来自模型判断，未作确定性证明。");
  } else if (goal.review) lines.push("独立模型复核：尚未通过。");
  else lines.push("语义质量与事实正确性：未独立复核。");
  if (report?.notices?.length) lines.push(`可选计划：${goal.plan.filter(s => s.status !== "done").length} 个步骤未登记完成，仅作进度提示。`);
  return lines.join("\n");
}

export function usageText(status: TaskStatus): string {
  const budget = status.budget;
  const context = status.contextUsage;
  return [
    `估算费用：$${budget.estimatedCostUsd.toFixed(4)}${budget.costLimit === null ? "" : ` / $${budget.costLimit}`}（Pi 用量估算，非供应商账单）`,
    `累计 token：${budget.totalTokens}${budget.tokenLimit === null ? "；未设累计 token 硬限" : ` / ${budget.tokenLimit}`}`,
    `非缓存输入：${budget.inputTokens}；缓存读取：${budget.cachedTokens}；缓存写入：${budget.cacheWriteTokens ?? 0}；输出：${budget.outputTokens}`,
    context ? `主 Agent 当前上下文：约 ${context.estimatedTokens}${context.contextWindow === null ? "" : ` / ${context.contextWindow}`} token（Pi 估算；不是累计用量）` : "主 Agent 当前上下文：暂无估算。",
    `累计压缩：${status.compactions} 次（主 Agent ${status.rootCompactions ?? status.compactions} 次；总数含子 Agent/评审会话）`,
    ...(status.goal?.learning ? [`试用方法：提供${status.goal.learning.offers.length}个、读取${status.goal.learning.loaded.length}个${status.goal.learning.proposal ? "；已提出1个候选" : ""}。方法读取/提炼费用已含在本任务总额，未独立拆分。${status.goal.learning.notice ? ` ${status.goal.learning.notice}` : ""}`] : []),
    ...(status.goal?.skills ? [`Pi Skills：提供${status.goal.skills.pins.length}个、读取${status.goal.skills.loaded.length}个${status.goal.skills.proposal ? "；保存1个本地试用" : ""}。读取不等于实际应用；全部费用已含在本任务总额，无额外反思调用。${status.goal.skills.notice ?? ""}`] : []),
    ...(status.goal?.localSkillReads?.length ? [`外部 Skills：实际读取 ${status.goal.localSkillReads.length} 份清单版本（含准备阶段）；脚本资产仍使用原目录，读取不等于已执行或完整版本固定。费用已含任务总额。`] : []),
  ].join("\n");
}
