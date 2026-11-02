import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { cloudModels, validateModel } from "../src/models.js";
import { LocalRuntime } from "../src/runtime.js";

// Explicit opt-in integration test. This calls the configured online model and incurs its usage.
try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const config = await loadConfig();
const args = parseArgs({ options: { resume: { type: "string" }, "data-dir": { type: "string" } } }).values;
if (args.resume && !args["data-dir"]) throw new Error("--resume requires --data-dir from the original test");
const models = cloudModels();
validateModel(models, config.model);
const directory = args["data-dir"] ? resolve(args["data-dir"]) : join(config.dataDir, "live-tests", `m1-${randomUUID()}`);
const workspace = join(directory, "workspace");
if (!args.resume) {
  await mkdir(join(workspace, "inputs"), { recursive: true });
  await writeFile(join(workspace, "inputs", "alpha.json"), JSON.stringify({ values: [12, 23] }));
  await writeFile(join(workspace, "inputs", "beta.json"), JSON.stringify({ values: [17, 19] }));
  await writeFile(join(workspace, "report.json"), '{"alpha":0,"beta":0,"total":0}');
}
const runtime = new LocalRuntime({ ...config, dataDir: directory, maxSubagents: 2, maxDurationMs: 180_000, review: true, maxEstimatedCostUsd: 0.5, maxTotalTokens: undefined }, { models });
try {
  if (args.resume) await runtime.resume(args.resume);
  const task = args.resume ? await runtime.metadata(args.resume) : await runtime.create(`这是明确标注的 Harness 故障注入联调。首先调用 task_submit，提交现有 report.json（不要先修改）；这份文件故意含错误，交给监督器退回。收到退回后，再执行以下实际工作：
1. 记录计划，并用 delegate 启动两个独立子 Agent，各自读取 inputs/alpha.json 或 inputs/beta.json，计算 values 的和并保存各自的计算结果。
2. 汇总到 report.json，字段 alpha、beta、total。生成中文 report.md，说明计算过程，并引用两个输入文件的实际路径和子 Agent 的交付。
3. 重新读取检查输出，记录步骤完成，再次 task_submit，交付 report.json 和 report.md。
最终验收只检查修正后的交付；第一次故意交错文件属于测试流程。不得修改 inputs。`, workspace, [
    { type: "json_value", path: "report.json", pointer: "/alpha", equals: 35 },
    { type: "json_value", path: "report.json", pointer: "/beta", equals: 36 },
    { type: "json_value", path: "report.json", pointer: "/total", equals: 71 },
    { type: "file_contains", path: "report.md", text: "alpha.json" },
    { type: "file_contains", path: "report.md", text: "beta.json" },
  ]);
  console.log(JSON.stringify({ taskId: task.id, workspace, model: task.model }));
  let previous = "";
  for (;;) {
    const status = await runtime.status(task.id);
    const activity = `${status.status}:${status.goal?.reworks}:${status.workerCount}`;
    if (activity !== previous) { console.log(JSON.stringify({ status: status.status, reworks: status.goal?.reworks, workers: status.workerCount })); previous = activity; }
    if (status.status === "completed") {
      assert.ok(status.goal?.verification);
      const rejections = status.goal.events.filter(e => e.type === "rejected").length;
      assert.ok(rejections >= 1, "Fault injection must exercise automatic rework");
      assert.ok(status.workerCount >= 2, "The model must use independent workers");
      const report = JSON.parse(await readFile(join(workspace, "report.json"), "utf8"));
      assert.deepEqual([report.alpha, report.beta, report.total], [35, 36, 71]);
      await writeFile(join(directory, "verification.json"), JSON.stringify({ taskId: task.id, goal: status.goal, usage: status.usage }, null, 2));
      console.log(JSON.stringify({ result: "passed", rejections, reworks: status.goal.reworks, workers: status.workerCount, verification: join(directory, "verification.json"), report: join(workspace, "report.md") }));
      break;
    }
    if (!["running", "pending", "verifying"].includes(status.status)) throw new Error(JSON.stringify({ status: status.status, reason: status.goal?.reason, question: status.goal?.question }));
    await setTimeout(500);
  }
} finally { await runtime.close(); }
