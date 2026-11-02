import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig } from "../src/config.js";
import { cloudModels, validateModel } from "../src/models.js";
import { localEnvironment, localExecution, taskCompaction } from "../src/execution.js";
import { taskUsage } from "../src/budget.js";
import { LocalRuntime } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";
import { checkArtifacts, type AcceptanceCheck } from "../src/checks.js";

// Small, opt-in comparison. One case is not a completion-rate benchmark.
try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const config = await loadConfig(), models = cloudModels(), model = validateModel(models, config.model);
const directory = join(config.dataDir, "live-tests", `compare-${randomUUID()}`);
const objective = "读取 inputs/source.json，只统计 active=true 的项目。按 category 汇总 amount*quantity，按分类名排序，将结果写成 result.json：categories 数组（每项 name 和 total），grandTotal 为合计。写简短中文 summary.md，包含“来源”和输入文件路径。使用本地终端实际计算并自查。不要修改输入。单独执行，不委派。";
const checks: AcceptanceCheck[] = [
  { type: "json_value", path: "result.json", pointer: "/grandTotal", equals: 71 },
  { type: "json_value", path: "result.json", pointer: "/categories/0/name", equals: "alpha" },
  { type: "json_value", path: "result.json", pointer: "/categories/0/total", equals: 36 },
  { type: "json_value", path: "result.json", pointer: "/categories/1/total", equals: 35 },
  { type: "file_contains", path: "summary.md", text: "来源" },
];
const results: unknown[] = [];
for (const arm of ["pi", "extension"] as const) {
  const dataDir = join(directory, arm), workspace = join(dataDir, "workspace");
  await mkdir(join(workspace, "inputs"), { recursive: true });
  const source = JSON.stringify([{ category: "alpha", amount: 12, quantity: 3, active: true }, { category: "beta", amount: 5, quantity: 7, active: true }, { category: "alpha", amount: 999, quantity: 9, active: false }]);
  await writeFile(join(workspace, "inputs", "source.json"), source);
  const caseChecks: AcceptanceCheck[] = [...checks, { type: "file_contains", path: "inputs/source.json", text: source }];
  const startedAt = Date.now();
  let usage, execution: string, reworks = 0;
  if (arm === "pi") {
    const extension = localExecution(), registry = createRegistry(); registry.install(extension);
    const storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
    const harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(workspace), settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120_000 }, toolExecution: "parallel", compaction: taskCompaction(models, [model], config.compactAtTokens) } }, ctx);
    const clock = new AbortController();
    const timer = setTimeout(180_000, undefined, { signal: clock.signal }).then(() => "timeout", () => "cancelled");
    try {
      const root = await harness.root(ctx, { agent: { model, cwd: workspace, extensions: [extension], instructions: `Execute the user's local task using the native tools; verify the result. Workspace: ${workspace}.` } });
      const submission = await root.submit({ type: "input", content: objective, requestId: "comparison" }, ctx);
      const result = await Promise.race([submission.wait(ctx), timer]);
      execution = typeof result === "string" ? result : result.status;
      usage = await harness.usage(ctx);
    } finally { clock.abort(); await harness.close(ctx); }
  } else {
    const runtime = new LocalRuntime({ ...config, dataDir, web: false, review: false, maxDurationMs: 180_000, maxEstimatedCostUsd: 0.1, maxTotalTokens: undefined }, { models });
    try {
      const task = await runtime.create(objective, workspace, caseChecks);
      for (;;) {
        const status = await runtime.status(task.id);
        if (!["running", "pending", "verifying"].includes(status.status)) { execution = status.status; usage = status.usage; reworks = status.goal?.reworks ?? 0; break; }
        await setTimeout(100);
      }
    } finally { await runtime.close(); }
  }
  const report = await checkArtifacts(await Workspace.open(workspace), ["result.json", "summary.md"], caseChecks);
  const record = { arm, model, execution, passed: report.passed && ["done", "completed"].includes(execution!), elapsedMs: Date.now() - startedAt, reworks, userContinuationMessages: 0, budget: taskUsage(usage!), checks: report.results };
  results.push(record); console.log(JSON.stringify(record));
}
await writeFile(join(directory, "comparison.json"), JSON.stringify({ objective, results, note: "Single real terminal case. This does not establish general superiority or a completion rate." }, null, 2));
console.log(JSON.stringify({ record: join(directory, "comparison.json") }));
