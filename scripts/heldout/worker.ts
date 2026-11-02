import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { loadEnvFile } from "node:process";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry, type Conversation, type UsageState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { cloudModels } from "../../src/models.js";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { localEnvironment, taskCompaction } from "../../src/execution.js";
import { GoalDoc, goalEvent, plain, readGoal } from "../../src/goal.js";
import { LocalRuntime, type TaskMeta } from "../../src/runtime.js";
import { taskUsage } from "../../src/budget.js";
import { briefDigest, type TaskBrief } from "../../src/preparation.js";
import { extensions, conversations, snapshots, compactions, nativeInstructions, runtimeConfig, save, sha, type RunConfig } from "./common.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const configFile = resolve(process.argv[2]!);
const run = JSON.parse(await readFile(configFile, "utf8")) as RunConfig;
const models = run.offline ? (await import("./offline.js")).offlineModels(run.model) : cloudModels();
const { selected, faults } = await extensions(run);
const registry = createRegistry(); for (const extension of selected) registry.install(extension);
const objective = await readFile(join(run.workspace, "TASK.md"), "utf8");
const brief = JSON.parse(await readFile(join(run.workspace, "BRIEF.json"), "utf8")) as TaskBrief;
if (!run.startedAt) {
  run.startedAt = Date.now(); run.deadlineAt = run.startedAt + run.maxDurationMs; run.taskId = randomUUID();
  await save(configFile, run);
  const taskDirectory = join(run.directory, "tasks", run.taskId);
  await mkdir(taskDirectory, { recursive: true });
  const storage = await openNodeSqliteStorage(join(taskDirectory, "session.sqlite"));
  const harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(run.workspace) }, ctx);
  await harness.root(ctx, { agent: { model: run.model, cwd: run.workspace, extensions: selected, instructions: nativeInstructions(run) } });
  await harness.commit(async tx => {
    const state = await tx.doc(GoalDoc);
    state.initialized = true; state.objective = objective; state.phase = "working"; state.tokenLimit = null; state.costLimit = run.maxEstimatedCostUsd;
    state.brief = brief; state.checks = brief.checks.map(check => ({ source: "user", check }));
    state.confirmation = { revision: brief.revision, digest: briefDigest(brief), at: run.startedAt!, deadlineAt: run.deadlineAt!, requestId: "preconfirmed-study" };
    goalEvent(state, "confirmed", "Frozen benchmark task authorized by the user's study execution request; no model-generated approval.");
  }, ctx);
  await harness.close(ctx);
  const meta: TaskMeta = { id: run.taskId, objective, workspace: run.workspace, model: run.model, subagentModel: run.model,
    createdAt: run.startedAt, deadlineAt: run.deadlineAt, maxSubagents: run.maxSubagents, control: "active", schemaVersion: 3, planPolicy: "advisory", preparation: true,
    acceptance: brief.checks, maxEstimatedCostUsd: run.maxEstimatedCostUsd, review: false, maxReworks: 3, maxStalls: 2 };
  await save(join(taskDirectory, "task.json"), meta);
}

let runtime: LocalRuntime | undefined, harness: Harness | undefined, root: Conversation | undefined;
let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
let usage: UsageState | undefined, execution = "pending", reworks = 0, automaticContinuations = 0, workerCount = 0, compactCount = 0;
let goal: Awaited<ReturnType<typeof readGoal>> | undefined;
let failure: string | undefined;
try {
  if (run.arm === "extension") {
    runtime = new LocalRuntime(runtimeConfig(run), { models, extensions: [faults] });
    await runtime.recover();
  } else {
    storage = await openNodeSqliteStorage(join(run.directory, "tasks", run.taskId!, "session.sqlite"));
    harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => localEnvironment(cwd ?? run.workspace),
      settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120_000 }, toolExecution: "parallel", compaction: taskCompaction(models, [run.model], run.compactAtTokens) },
      onReport: (error, info) => { console.error(JSON.stringify({ report: info.type, error: String(error) })); },
    }, ctx);
    root = await harness.root(ctx);
    await root.configure({ instructions: nativeInstructions(run), extensions: selected }, ctx);
    const initial = await harness.commit(tx => tx.submissionByRequest(root!.id, "initial"), ctx);
    if (!initial) {
      let input = objective;
      if (run.arm === "prompt") {
        const template = await readFile(join(run.study, "goal-driven-template.txt"), "utf8");
        input = template.replace("[[[[[DEFINE YOUR GOAL HERE]]]]]", "完成这份已确认任务的全部交付：\n" + objective)
          .replace("[[[[[DEFINE YOUR CRITERIA FOR SUCCESS HERE]]]]]", "满足TASK.md与task_status中全部固定标准，检查真实产物与实际测试；不以执行者自报完成替代检查。预算与权限优先于无限继续。共同delegate是前台持久子会话工具，父会话等待期间由Pi挂起，不增加后台看门狗。");
      }
      await writeFile(join(run.directory, "initial-user-prompt.txt"), input);
      await root.submit({ type: "input", content: input, requestId: "initial" }, ctx);
    }
    harness.resume();
  }
  let lastOutput = 0;
  for (;;) {
    let busy = false;
    if (runtime) {
      const state = await runtime.status(run.taskId!);
      execution = state.status; usage = state.usage; goal = state.goal;
      reworks = goal?.reworks ?? 0; automaticContinuations = goal?.events.filter(e => e.type === "rejected").length ?? 0;
      workerCount = state.workerCount; compactCount = state.compactions;
      busy = ["running", "pending", "verifying"].includes(execution);
    } else {
      const inspection = await harness!.inspect(ctx);
      usage = await harness!.usage(ctx); goal = await readGoal(harness!);
      const latest = (await storage!.scanSubmissions({ conversationId: root!.id, order: "descending" }, 1, undefined, ctx)).items[0];
      busy = inspection.tasks.length > 0 || inspection.submissions.length > 0;
      execution = busy ? "running" : latest?.status ?? "pending";
      workerCount = (await conversations(harness!)).filter(c => c.owner).length;
      compactCount = await compactions(harness!);
    }
    const budget = taskUsage(usage!);
    if (Date.now() >= run.deadlineAt! || budget.estimatedCostUsd >= run.maxEstimatedCostUsd) { execution = "budget_limited"; busy = false; }
    const progress = { execution, elapsedMs: Date.now() - run.startedAt!, budget, workerCount, compactions: compactCount, reworks, automaticContinuations, reason: goal?.reason ?? null };
    await save(join(run.directory, "progress.json"), progress);
    if (Date.now() - lastOutput >= 30_000 || !busy) { console.log(JSON.stringify(progress)); lastOutput = Date.now(); }
    if (!busy) break;
    await setTimeout(500);
  }
} catch (error) {
  execution = "runner_error"; failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeFile(join(run.directory, "runner-error.txt"), failure);
} finally {
  // Close aborts outstanding owned work through Pi; no custom command/retry engine.
  await runtime?.close();
  await harness?.close(ctx);
}

// Reopen read-only/idle after stopping to include late-settling usage and every conversation.
storage = await openNodeSqliteStorage(join(run.directory, "tasks", run.taskId!, "session.sqlite"));
harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(run.workspace) }, ctx);
try {
  usage = await harness.usage(ctx); goal = await readGoal(harness);
  const transcript = await snapshots(harness);
  const toolManifests = transcript.map(item => {
    const tools = getCurrentTools(item.context.messages).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })).sort((a, b) => a.name.localeCompare(b.name));
    return { conversationId: item.record.id, worker: Boolean(item.record.owner), names: tools.map(tool => tool.name), schemaSha256: sha(JSON.stringify(tools)) };
  });
  compactCount = await compactions(harness);
  workerCount = (await conversations(harness)).filter(c => c.owner).length;
  const fault = await readFile(join(run.directory, "fault.json"), "utf8").then(data => JSON.parse(data) as unknown).catch(() => ({ injected: false }));
  await save(join(run.directory, "transcript.json"), transcript);
  await save(join(run.directory, "goal.json"), goal);
  const result = { execution, elapsedMs: Date.now() - run.startedAt!, usage, budget: taskUsage(usage), workerCount, compactions: compactCount,
    reworks, automaticContinuations, operatorFollowupMessages: 0, userInformationRequests: goal.events.filter(e => e.type === "waiting_user").map(e => e.detail),
    fault, candidate: goal.candidate, hostDeclaredComplete: run.arm === "extension" ? goal.phase === "completed" : execution === "done",
    approvedBriefDigest: goal.confirmation?.digest, approvedDeadline: goal.confirmation?.deadlineAt, toolManifests, failure: failure ?? null };
  await save(join(run.directory, "result.json"), result);
  console.log(JSON.stringify({ finished: true, execution, budget: result.budget }));
} finally { await harness.close(ctx); }
