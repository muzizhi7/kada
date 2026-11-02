/** Both arms run the SAME production Pi host. Only maxReworks (0/3) differs. */
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { cloudModels } from "../../src/models.js";
import { localEnvironment } from "../../src/execution.js";
import { LocalRuntime, type TaskMeta } from "../../src/runtime.js";
import { GoalDoc, goalEvent, readGoal } from "../../src/goal.js";
import { briefDigest, type TaskBrief } from "../../src/preparation.js";
import { taskUsage } from "../../src/budget.js";
import { compactions, conversations, extensions, runtimeConfig, save, sha, snapshots, type RunConfig } from "../heldout/common.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const file = resolve(process.argv[2]!);
const run = JSON.parse(await readFile(file, "utf8")) as RunConfig;
const models = run.offline ? (await import("../heldout/offline.js")).offlineModels(run.model) : cloudModels();
const { selected } = await extensions(run);
const registry = createRegistry(); for (const extension of selected) registry.install(extension);
const objective = await readFile(join(run.workspace, "TASK.md"), "utf8");
const brief = JSON.parse(await readFile(join(run.workspace, "BRIEF.json"), "utf8")) as TaskBrief;
const maxReworks = run.arm === "pi" ? 0 : 3;
if (!run.startedAt) {
  run.startedAt = Date.now(); run.deadlineAt = run.startedAt + run.maxDurationMs; run.taskId = randomUUID();
  await save(file, run);
  const directory = join(run.directory, "tasks", run.taskId); await mkdir(directory, { recursive: true });
  const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
  const harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(run.workspace) }, ctx);
  try {
    await harness.root(ctx, { agent: { model: run.model, cwd: run.workspace, extensions: selected } });
    await harness.commit(async tx => {
      const goal = await tx.doc(GoalDoc);
      goal.initialized = true; goal.objective = objective; goal.phase = "working"; goal.tokenLimit = null; goal.costLimit = run.maxEstimatedCostUsd;
      goal.brief = brief; goal.checks = brief.checks.map(check => ({ source: "user", check }));
      goal.confirmation = { revision: brief.revision, digest: briefDigest(brief), at: run.startedAt!, deadlineAt: run.deadlineAt!, requestId: "preconfirmed-feedback-study" };
      goalEvent(goal, "confirmed", "Fixed, preconfirmed component comparison; no model-generated approval.");
    }, ctx);
  } finally { await harness.close(ctx); }
  const meta: TaskMeta = { id: run.taskId, objective, workspace: run.workspace, model: run.model, subagentModel: run.model, createdAt: run.startedAt,
    deadlineAt: run.deadlineAt, maxSubagents: run.maxSubagents, control: "active", schemaVersion: 3, planPolicy: "advisory", preparation: true,
    acceptance: brief.checks, maxEstimatedCostUsd: run.maxEstimatedCostUsd, review: false, maxReworks, maxStalls: 2 };
  await save(join(directory, "task.json"), meta);
}
const runtime = new LocalRuntime({ ...runtimeConfig(run), maxReworks }, { models });
let execution = "pending", failure: string | null = null;
try {
  await runtime.recover();
  let last = 0;
  for (;;) {
    const state = await runtime.status(run.taskId!);
    execution = state.status;
    const progress = { execution, elapsedMs: Date.now() - run.startedAt!, budget: taskUsage(state.usage), workerCount: state.workerCount,
      compactions: state.compactions, reworks: state.goal?.reworks ?? 0, reason: state.goal?.reason ?? null };
    await save(join(run.directory, "progress.json"), progress);
    if (Date.now() - last > 30000) { console.log(JSON.stringify(progress)); last = Date.now(); }
    if (!["running", "pending", "verifying"].includes(execution)) break;
    await setTimeout(500);
  }
} catch (error) { execution = "runner_error"; failure = String(error); }
finally { await runtime.close(); }
const storage = await openNodeSqliteStorage(join(run.directory, "tasks", run.taskId!, "session.sqlite"));
const harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(run.workspace) }, ctx);
try {
  const goal = await readGoal(harness), usage = await harness.usage(ctx), transcript = await snapshots(harness);
  const rootContext = transcript.find(item => !item.record.owner)?.context;
  const initialSystem = rootContext?.messages.find(message => message.role === "system") as { sections?: Record<string, string> } | undefined;
  const instructions = initialSystem?.sections?.instructions ?? "";
  const instructionsSha256 = sha(instructions.split(run.workspace).join("<WORKSPACE>"));
  const toolManifests = transcript.map(item => {
    const tools = getCurrentTools(item.context.messages).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })).sort((a, b) => a.name.localeCompare(b.name));
    return { worker: Boolean(item.record.owner), names: tools.map(tool => tool.name), schemaSha256: sha(JSON.stringify(tools)) };
  });
  await save(join(run.directory, "transcript.json"), transcript);
  await save(join(run.directory, "goal.json"), goal);
  const result = { execution, elapsedMs: Date.now() - run.startedAt!, budget: taskUsage(usage), usage, workerCount: (await conversations(harness)).filter(c => c.owner).length,
    compactions: await compactions(harness), reworks: goal.reworks, automaticContinuations: goal.events.filter(event => event.type === "rejected").length,
    emittedFeedbackMessages: transcript.flatMap(item => item.context.messages).filter(message => message.role === "user" && String(message.content).startsWith("SUPERVISOR_REWORK")).length,
    operatorFollowupMessages: 0, userInformationRequests: goal.events.filter(event => event.type === "waiting_user").map(event => event.detail),
    candidate: goal.candidate, hostDeclaredComplete: goal.phase === "completed", approvedBriefDigest: goal.confirmation?.digest,
    approvedDeadline: goal.confirmation?.deadlineAt, toolManifests, instructionsSha256, maxReworks, failure };
  await save(join(run.directory, "result.json"), result);
  console.log(JSON.stringify({ finished: true, execution, budget: result.budget }));
} finally { await harness.close(ctx); }
