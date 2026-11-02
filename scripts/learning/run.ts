/** A bounded development sequence; reuses Pi and the existing comparison helpers. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { loadEnvFile } from "node:process";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry, type UsageState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { loadConfig } from "../../src/config.js";
import { cloudModels } from "../../src/models.js";
import { LocalRuntime, type TaskMeta } from "../../src/runtime.js";
import { GoalDoc, readGoal } from "../../src/goal.js";
import { briefDigest, type TaskBrief } from "../../src/preparation.js";
import { Workspace } from "../../src/workspace.js";
import { hashFiles } from "../../src/verification.js";
import { localEnvironment, taskCompaction } from "../../src/execution.js";
import { taskUsage } from "../../src/budget.js";
import { VERSION } from "../../src/version.js";
import { pinSkills, skillInstructions, skillReads } from "../../src/skills.js";
import { verificationExtension } from "../../src/verification.js";
import { extensions, snapshots, nativeInstructions, runtimeConfig, save, type RunConfig } from "../heldout/common.js";
import { families, fixture } from "./fixtures.js";
import { preflight } from "./preflight.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const args = parseArgs({ options: { execute: { type: "boolean" }, "native-skills": { type: "boolean" }, offset: { type: "string" }, cases: { type: "string" }, "prior-cost-usd": { type: "string" } } });
const nativeSkills = !!args.values["native-skills"];
const offset = Number(args.values.offset ?? 0), priorCostUsd = Number(args.values["prior-cost-usd"] ?? 0);
const cases = Number(args.values.cases ?? 3);
assert(Number.isSafeInteger(cases) && cases >= 2 && cases <= 3, "Use two or three cases per family");
assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000, "Invalid input variant offset");
assert(Number.isFinite(priorCostUsd) && priorCostUsd >= 0 && priorCostUsd < 1, "Invalid prior study cost");
const execute = promisify(execFile), config = await loadConfig(), models = cloudModels();
const base = resolve(nativeSkills ? ".harness/skill-studies" : ".harness/learning-studies", randomUUID());
await mkdir(base, { recursive: true, mode: 0o700 });
// Keep fast reference-check construction off a potentially syncing Documents volume.
// Actual paid work still uses its frozen workspace and the unchanged byte checks.
const preflightDirectory = await mkdtemp(join(tmpdir(), "pi-learning-preflight-"));
try { await save(join(base, "preflight.json"), await preflight(preflightDirectory, offset, nativeSkills)); }
finally { await rm(preflightDirectory, { recursive: true, force: true }); }
const frozen = join(base, "frozen"); await mkdir(frozen);
const frozenInputs = ["src", "methods", "skills", "scripts/learning", "scripts/heldout/common.ts", "package.json", "package-lock.json"];
for (const path of frozenInputs) {
  await mkdir(dirname(join(frozen, path)), { recursive: true });
  await cp(resolve(path), join(frozen, path), { recursive: true });
}
const source = await Workspace.open(process.cwd()), frozenHashes = await hashFiles(source, frozenInputs);
const arms: ("legacy" | "off" | "on" | "pi")[] = nativeSkills ? ["legacy", "off", "on", "pi"] : ["off", "on", "pi"];
const prepared: { family: string; variant: number; arm: typeof arms[number]; directory: string; workspace: string; brief: TaskBrief }[] = [];
for (const family of families) for (let variant = 0; variant < cases; variant++) {
  // Rotate order to avoid giving the learning arm every warm-cache advantage.
  const order = [...arms.slice(variant), ...arms.slice(0, variant)];
  for (const arm of order) {
    const directory = join(base, arm, `${family}-${variant}`), workspace = join(directory, "workspace");
    const brief = await fixture(workspace, family, variant + offset, nativeSkills);
    prepared.push({ family, variant: variant + offset, arm, directory, workspace, brief });
  }
}
await save(join(base, "protocol.json"), { status: "frozen-before-execution", version: VERSION, model: config.model,
  sequence: prepared.map(p => ({ family: p.family, variant: p.variant, arm: p.arm })),
  perTaskUsd: .05, protectionUsd: 1, durationMs: 240000, independentReview: false, computerUse: false,
  priorCostUsd, offset, cases,
  nativeSkills,
  scope: nativeSkills ? "Two known development families with new inputs, including root-value checks frozen before execution. Four arms: v0.6 compatibility learning, new thin runtime off/on and Pi SDK reference. Execution tools/models/permissions/budget match. Off/on/Pi share native criterion verification; on adds only optional task_submit.skill plus a capture instruction. Legacy retains its two method tools and old verification schema as diagnostic policy differences. Pi is the SDK with common business tools, not stock CLI. All initial discovery, capture and failures included. Preparation is preconfirmed equally; intake quality/cost is outside this experiment." : "Two development fixture families, each one discovery plus two new-input cases; not real user trials or a broad held-out superiority study. Learning may only see earlier authorized cases through saved methods. All arms include discovery cost. Common execution tools/models/permissions/budget match; on adds two method tools. Pi is the SDK with shared task/delegate/verify tools, not stock Pi CLI.",
  limitations: "Each case runs once, no statistical claim. Visible original check feedback is normal task feedback. No hidden feedback or operator correction. Prices are Pi estimates; local CPU and unreported provider charges are not measured.",
  frozenHashes });
console.log(JSON.stringify({ prepared: prepared.length, paid: !!args.values.execute, record: base }));
if (!args.values.execute) process.exit(0);
assert(config.model, "Configure the existing online model first");
assert(!config.computer, "computer-use stays disabled");

const results: any[] = [];
for (const item of prepared) {
  const { family, variant, arm, directory, workspace, brief } = item;
  assert.deepEqual(await hashFiles(source, frozenInputs), frozenHashes, "source changed during fixed experiment");
  const spent = priorCostUsd + results.reduce((sum, r) => sum + r.budget.estimatedCostUsd, 0);
  if (spent + .05 > 1) throw new Error("Study protection budget exhausted");
  const dataDir = join(base, arm, "state"), taskId = randomUUID(), taskDirectory = join(dataDir, "tasks", taskId);
  await mkdir(taskDirectory, { recursive: true });
  const run: RunConfig = { directory: dataDir, workspace, study: base, frozen, task: `${family}-${variant}`, category: family,
    arm: arm === "pi" ? "pi" : "extension", repeat: 1, sequence: results.length + 1, model: config.model,
    maxEstimatedCostUsd: .05, maxDurationMs: 240000, maxSubagents: 1, compactAtTokens: config.compactAtTokens ?? 48000, transientFault: false };
  const common = await extensions(run), registry = createRegistry();
  const selected = nativeSkills && arm !== "legacy" ? [...common.selected.filter(e => e.name !== "local_verification"), verificationExtension(await Workspace.open(workspace), true), skillReads()] : common.selected;
  for (const extension of selected) registry.install(extension);
  const ws = await Workspace.open(workspace), verification = brief.criteria[0]!.verification!, originals = await hashFiles(ws, verification.inputs);
  const objective = await readFile(join(workspace, "TASK.md"), "utf8"), started = Date.now(), deadline = started + run.maxDurationMs;
  const storage = await openNodeSqliteStorage(join(taskDirectory, "session.sqlite"));
  let harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(workspace) }, ctx);
  const skills = nativeSkills && arm === "pi" ? await pinSkills(ws, taskDirectory) : undefined;
  await harness.root(ctx, { agent: { model: config.model, cwd: workspace, extensions: selected, instructions: nativeInstructions(run) + skillInstructions(skills) } });
  await harness.commit(async tx => {
    const goal = await tx.doc(GoalDoc);
    goal.initialized = true; goal.objective = objective; goal.phase = "working"; goal.tokenLimit = null; goal.costLimit = .05;
    goal.brief = brief; goal.confirmation = { revision: 1, digest: briefDigest(brief), at: started, deadlineAt: deadline, requestId: "preconfirmed-development-sequence", verificationInputs: { "1": originals } };
    if (skills) goal.skills = skills;
  }, ctx);
  await harness.close(ctx);
  const meta: TaskMeta = { id: taskId, objective, workspace, model: config.model, createdAt: started, deadlineAt: deadline,
    maxSubagents: 1, control: "active", schemaVersion: 3, planPolicy: "advisory", preparation: true, ...(["on", "legacy"].includes(arm) ? { learning: true } : {}),
    ...(nativeSkills && arm !== "legacy" ? { resourcePolicy: "pi-skills" as const } : {}),
    maxEstimatedCostUsd: .05, review: false, maxReworks: 3, maxStalls: 2 };
  await save(join(taskDirectory, "task.json"), meta);
  let runtime: LocalRuntime | undefined, execution = "pending", usage: UsageState | undefined, goal: Awaited<ReturnType<typeof readGoal>> | undefined;
  let error: string | undefined;
  try {
    if (arm === "pi") {
      const opened = await openNodeSqliteStorage(join(taskDirectory, "session.sqlite"));
      harness = await Harness.open(opened, { models, registry, env: () => localEnvironment(workspace),
        settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120000 }, toolExecution: "parallel", compaction: taskCompaction(models, [config.model], run.compactAtTokens) } }, ctx);
      const root = await harness.root(ctx); await root.submit({ type: "input", content: objective, requestId: "initial" }, ctx);
    } else {
      runtime = new LocalRuntime({ ...runtimeConfig(run), learning: ["on", "legacy"].includes(arm) }, { models }); await runtime.recover();
    }
    let lastOutput = 0;
    for (;;) {
      let busy: boolean;
      if (runtime) {
        const state = await runtime.status(taskId); usage = state.usage; execution = state.status; goal = state.goal;
        busy = ["running", "pending", "verifying"].includes(execution);
      } else {
        const inspection = await harness.inspect(ctx); usage = await harness.usage(ctx); goal = await readGoal(harness);
        busy = inspection.tasks.length > 0 || inspection.submissions.length > 0; execution = busy ? "running" : "done";
      }
      if (Date.now() >= deadline || taskUsage(usage!).estimatedCostUsd >= .05) { execution = "budget_limited"; busy = false; }
      if (Date.now() - lastOutput > 15000 || !busy) { console.log(JSON.stringify({ family, variant, arm, execution, budget: taskUsage(usage!), elapsedMs: Date.now() - started })); lastOutput = Date.now(); }
      if (!busy) break;
      await setTimeout(300);
    }
  } catch (caught) { error = String(caught); execution = "runner_error"; }
  finally { await runtime?.close(); if (!runtime) await harness.close(ctx); }
  const closedStorage = await openNodeSqliteStorage(join(taskDirectory, "session.sqlite"));
  harness = await Harness.open(closedStorage, { models, registry, env: () => localEnvironment(workspace) }, ctx);
  let transcript: Awaited<ReturnType<typeof snapshots>>;
  try { usage = await harness.usage(ctx); goal = await readGoal(harness); transcript = await snapshots(harness); }
  finally { await harness.close(ctx); }
  let checked = false, checkOutput = "";
  const stable = JSON.stringify(await hashFiles(ws, verification.inputs)) === JSON.stringify(originals);
  if (stable) try {
    const check = await execute(process.execPath, ["acceptance/check.mjs"], { cwd: workspace, timeout: 15000 });
    checkOutput = check.stdout + check.stderr; checked = true;
  } catch (caught) { checkOutput = String(caught); }
  const manifests = transcript!.map(t => ({ worker: !!t.record.owner, tools: getCurrentTools(t.context.messages).map(t => t.name).sort() }));
  const result = { family, variant, arm, taskId, execution, budget: taskUsage(usage!), elapsedMs: Date.now() - started,
    qualified: checked && stable && !!goal!.candidate && (arm === "pi" ? execution === "done" : execution === "completed"),
    originalInputsUnchanged: stable, externalCheckPassed: checked, operatorMessages: 0, reworks: goal!.reworks,
    learning: goal!.learning ?? null, skills: goal!.skills ?? null,
    modelResponses: transcript!.flatMap(t => t.context.messages).filter(m => m.role === "assistant" && m.usage).length,
    checkOutput, error, toolManifests: manifests };
  results.push(result);
  await save(join(directory, "result.json"), result); await save(join(directory, "transcript.json"), transcript!); await save(join(directory, "goal.json"), goal!);
  await save(join(base, "results.json"), results);
}
const summary = arms.map(arm => {
  const values = results.filter(r => r.arm === arm), cost = values.reduce((sum, r) => sum + r.budget.estimatedCostUsd, 0), passed = values.filter(r => r.qualified).length;
  return { arm, tasks: values.length, qualified: passed, estimatedCostUsd: cost, amortizedQualifiedCostUsd: passed ? cost / passed : null,
    discoveryCostUsd: values.filter(r => r.variant === offset).reduce((s, r) => s + r.budget.estimatedCostUsd, 0),
    reusedMethods: values.reduce((s, r) => s + (r.learning?.loaded?.length ?? 0), 0),
    readManagedSkills: values.reduce((s, r) => s + (r.skills?.pins.filter((p: any) => p.managed && r.skills.loaded.includes(`${p.name}@${p.version}`)).length ?? 0), 0),
    capturedSkills: values.filter(r => r.skills?.proposal).length,
    modelResponses: values.reduce((s, r) => s + r.modelResponses, 0),
    reworks: values.reduce((s, r) => s + r.reworks, 0) };
});
assert.deepEqual(await hashFiles(source, frozenInputs), frozenHashes);
await save(join(base, "summary.json"), { arms: summary, priorCostUsd, offset, totalEstimatedCostUsd: results.reduce((s, r) => s + r.budget.estimatedCostUsd, 0),
  sourceUnchanged: true, note: "Development sequence only; all initial discovery, failures and learning requests are included. No general advantage claimed." });
console.log(JSON.stringify({ finished: true, record: base, arms: summary }));
