import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { cloudModels } from "../src/models.js";
import { LocalRuntime } from "../src/runtime.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const config = await loadConfig(), models = cloudModels();
const maxCost = Number(process.env.INTAKE_SMOKE_MAX_USD ?? .1);
if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > .1) throw new Error("Smoke budget must be greater than0 and at most USD0.10");
const directory = resolve(config.dataDir, "live-tests", `intake-${randomUUID()}`), workspace = join(directory, "workspace");
await mkdir(join(workspace, "inputs"), { recursive: true });
await writeFile(join(workspace, "inputs/values.json"), "[12,23,17,19]\n");
await writeFile(join(workspace, "result.json"), '{"total":0}\n');
await writeFile(join(workspace, "report.md"), "# 草稿\n总计：0\n");
const hashes = async () => Promise.all(["inputs/values.json", "result.json", "report.md"].map(async name => createHash("sha256").update(await readFile(join(workspace, name))).digest("hex")));
const original = await hashes();
const runtime = new LocalRuntime({ ...config, dataDir: directory, maxEstimatedCostUsd: maxCost, maxDurationMs: 300000, maxTotalTokens: undefined, review: false, web: false, computer: undefined }, { models });
const start = Date.now();
let taskId: string | undefined;
try {
  const objective = `这是本地功能联调：读取 inputs/values.json 的四个数，修正已有错误草稿 result.json 的 total，并生成 report.md。报告需含中文摘要、正确总计、来源文件路径与实际核验说明；原始输入保持不变。所有工作仅在当前工作区，不联网、不操作电脑、不创建子Agent，不读其他任务或配置凭据。交付标准至少有一项命令核验（method=check），从原始输入独立计算核对结果并运行 task_verify；其余内容可自检。预算总计最多${maxCost}美元（含澄清），执行时限5分钟。目标、输入与口径已明确，无需再询问业务问题；先只读材料并提出待确认的完整任务说明，确认后自主执行、核验、修正直至交付。`;
  const task = await runtime.create(objective, workspace, [
    { type: "json_value", path: "result.json", pointer: "/total", equals: 71 },
    { type: "file_contains", path: "report.md", text: "71" },
    { type: "file_contains", path: "report.md", text: "来源" },
  ], { prepare: true });
  taskId = task.id;
  console.log(JSON.stringify({ directory, taskId, model: task.model, maxEstimatedCostUsd: maxCost }));
  let approved = false, lastLog = 0;
  for (;;) {
    const status = await runtime.status(task.id);
    if (Date.now() - lastLog > 15000) { console.log(JSON.stringify({ status: status.status, elapsedSeconds: Math.round((Date.now() - start) / 1000), estimatedCostUsd: status.budget.estimatedCostUsd, reworks: status.goal?.reworks })); lastLog = Date.now(); }
    if (!approved && status.status === "awaiting_confirmation") {
      const brief = status.goal!.brief!;
      if (JSON.stringify(await hashes()) !== JSON.stringify(original)) throw new Error("Files changed before approval");
      if (brief.questions.length || brief.budget.maxEstimatedCostUsd > maxCost || brief.budget.maxDurationMs > 300000 || !brief.criteria.some(c => c.method === "check")) throw new Error("Brief exceeds the preauthorized smoke task or omits an objective check");
      await writeFile(join(directory, "brief.json"), JSON.stringify(brief, null, 2));
      await runtime.confirm(task.id, brief.revision, status.briefDigest!);
      approved = true;
      console.log(JSON.stringify({ approvedRevision: brief.revision, elapsedSeconds: Math.round((Date.now() - start) / 1000) }));
    }
    if (status.status === "completed") {
      const value = JSON.parse(await readFile(join(workspace, "result.json"), "utf8"));
      const report = await readFile(join(workspace, "report.md"), "utf8");
      if (value.total !== 71 || !report.includes("71") || !report.includes("来源")) throw new Error("Final independent smoke checks failed");
      if ((await hashes())[0] !== original[0]) throw new Error("Original input changed");
      const proofs = Object.values(status.goal?.proofs ?? {});
      if (!approved || !proofs.some(p => p.passed) || status.workerCount || status.goal?.events.filter(e => e.type === "confirmed").length !== 1) throw new Error("Workflow invariants failed");
      const result = { passed: true, taskId, elapsedMs: Date.now() - start, model: task.model, confirmationCount: 1, preparationWasReadOnly: true,
        reworks: status.goal?.reworks, proofCount: proofs.length, budget: status.budget, verification: status.goal?.verification };
      await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      break;
    }
    if (["failed", "needs_attention", "budget_limited", "blocked", "clarifying"].includes(status.status)) throw new Error(JSON.stringify({ status: status.status, reason: status.goal?.reason, question: status.goal?.question }));
    if (Date.now() - start > 360000) throw new Error("Smoke wall-time cap exceeded");
    await setTimeout(300);
  }
} catch (error) {
  await writeFile(join(directory, "failure.json"), JSON.stringify({ taskId, error: String(error), elapsedMs: Date.now() - start }, null, 2));
  throw error;
} finally { await runtime.close(); }
