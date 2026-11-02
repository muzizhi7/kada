/** Development comparisons only: Pi executes; this script freezes cases and records evidence. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify, parseArgs } from "node:util";
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
import { GoalDoc, goalExtension, readGoal } from "../../src/goal.js";
import { briefDigest, type TaskBrief } from "../../src/preparation.js";
import { Workspace } from "../../src/workspace.js";
import { hashFiles, verificationExtension } from "../../src/verification.js";
import { localExecution, localEnvironment, taskCompaction } from "../../src/execution.js";
import { delegationExtension } from "../../src/delegation.js";
import { taskUsage } from "../../src/budget.js";
import { VERSION } from "../../src/version.js";
import { pinSkills, skillInstructions, skillReads } from "../../src/skills.js";
import { LocalDiscovery, localContextInstructions } from "../../src/discovery.js";
import { snapshots, compactions, nativeInstructions, runtimeConfig, save, type RunConfig } from "../heldout/common.js";

const CASES = ["office_reconcile", "office_minutes", "office_crm", "office_handover", "code_inventory", "code_pool", "code_import", "code_cache"];
const args = parseArgs({ options: { execute: { type: "boolean" }, cases: { type: "string" }, repeats: { type: "string" } } });
const cases = args.values.cases?.split(",") ?? CASES, repeats = Number(args.values.repeats ?? 2);
assert(cases.length && new Set(cases).size === cases.length && cases.every(c => CASES.includes(c)), "Unknown/duplicate case");
assert([1, 2].includes(repeats), "Use one or two repeats");
const execute = promisify(execFile), python = process.env.CASE_PYTHON ?? "python3";
try { loadEnvFile(".env"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
const config = await loadConfig(), models = cloudModels();
const base = resolve(".harness/office-code-studies", randomUUID());
await mkdir(base, { recursive: true, mode: 0o700 });
const preflight = await execute(python, ["scripts/cases/preflight.py", ...cases], { timeout: 120000, maxBuffer: 2_000_000 });
await save(join(base, "preflight.json"), JSON.parse(preflight.stdout));
const frozen = join(base, "frozen"), source = await Workspace.open(process.cwd());
const paths = ["src", "methods", "skills", "scripts/cases", "scripts/heldout/common.ts", "package.json", "package-lock.json"];
for (const path of paths) { await mkdir(dirname(join(frozen, path)), { recursive: true }); await cp(resolve(path), join(frozen, path), { recursive: true }); }
const hashes = await hashFiles(source, paths);
// No personal inventory is used or uploaded in an experiment. Both arms receive the same synthetic inventory.
const commonHome = join(base, "common-home");
await mkdir(join(commonHome, ".agents/skills/office-formats"), { recursive: true });
await mkdir(join(commonHome, ".codex"), { recursive: true });
await writeFile(join(commonHome, ".codex/config.toml"), 'model = "configured-study-model"\nlanguage = "zh-CN"\n');
await writeFile(join(commonHome, ".agents/skills/office-formats/SKILL.md"), `---\nname: office-formats\ndescription: Work with existing CSV, XLSX and DOCX dependencies; preserve data types and verify file contents.\n---\nUse existing Python packages only: openpyxl 3.1.5 and python-docx 1.2.0 are installed for python3. No install is needed. Read CSV with utf-8-sig and newline=''. Keep identifiers and phone numbers as strings. In XLSX use actual numeric and boolean cell types; missing values stay blank. Preserve legitimate zero and false. For DOCX use tables for structured actions, repeat table headers, keep content within page margins, use an installed CJK font, and verify the saved text/tables. Relevant original task rules win; a Skill never grants permission. Do not read private configuration or other tasks.\n`);
const discovery = { home: commonHome, locale: "zh-CN", timezone: "Asia/Shanghai" };
const sharedHashes = await hashFiles(await Workspace.open(commonHome), ["."]);
const prepared: { case: string; repeat: number; arm: "pi" | "current"; directory: string; workspace: string; spec: { objective: string; inputs: string[]; outputs: string[]; command: string } }[] = [];
for (const name of cases) for (let repeat = 1; repeat <= repeats; repeat++) {
  const order: ("pi" | "current")[] = repeat % 2 ? ["pi", "current"] : ["current", "pi"];
  for (const arm of order) {
    const directory = join(base, arm, `${name}-${repeat}`), workspace = join(directory, "workspace");
    const output = await execute(python, [join(frozen, "scripts/cases/fixtures.py"), name, workspace]);
    prepared.push({ case: name, repeat, arm, directory, workspace, spec: JSON.parse(output.stdout) });
  }
}
await save(join(base, "protocol.json"), { status: "frozen-before-paid-execution", checkerRevision: 2, version: VERSION, model: config.model,
  sequence: prepared.map(p => ({ case: p.case, repeat: p.repeat, arm: p.arm })), frozenHashes: hashes, sharedHashes,
  perTaskUsd: .08, protectionUsd: 3, durationMs: 300000, maxSubagents: 1, learning: false, computerUse: false, web: false,
  scope: "New synthetic development office/code cases, two repeats each. Pi SDK reference with shared business/delegation/verification tools, not unmodified Pi CLI. Same model, tools, permissions, budget, Skills and synthetic discovery. Task brief is preconfirmed equally; preparation quality/cost is outside scope. Current arm adds goal supervision and visible verification/rework. Hidden probes run only after execution terminates; never fed back. No operator continuation or correction.",
  limitations: "No general superiority/statistical claim. Per-task cost caps are checked on completed Pi usage entries, so an in-flight request can overshoot. Prices are Pi estimates, not provider invoices. Normal user filesystem permissions, not OS isolation. Manual interventions count runtime requests/blockers, not fixture preparation or post-run grading. Visual QA is reported separately from semantic probes." });
console.log(JSON.stringify({ prepared: prepared.length, paid: !!args.values.execute, record: base }));
if (!args.values.execute) process.exit(0);
assert(config.model, "Configure an online model first"); assert(!config.computer, "computer-use must remain disabled");

const results: any[] = [];
for (const item of prepared) {
  assert.deepEqual(await hashFiles(source, paths), hashes, "Source changed during frozen study");
  assert.deepEqual(await hashFiles(await Workspace.open(commonHome), ["."]), sharedHashes, "Shared resources changed");
  const spent = results.reduce((s, r) => s + r.budget.estimatedCostUsd, 0);
  if (spent + .08 > 3) throw new Error("Study protection budget exhausted; prior results remain recorded");
  const { directory, workspace, spec, arm, repeat } = item;
  const dataDir = join(directory, "state"), taskId = randomUUID(), taskDir = join(dataDir, "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  const ws = await Workspace.open(workspace), original = await hashFiles(ws, spec.inputs);
  const started = Date.now(), deadline = started + 300000;
  const run: RunConfig = { directory: dataDir, workspace, study: base, frozen, task: item.case, category: item.case.startsWith("office") ? "office" : "code",
    arm: arm === "pi" ? "pi" : "extension", repeat, sequence: results.length + 1, model: config.model,
    maxEstimatedCostUsd: .08, maxDurationMs: 300000, maxSubagents: 1, compactAtTokens: config.compactAtTokens ?? 48000, transientFault: false };
  const local = await new LocalDiscovery(dataDir, discovery).context();
  const goalTools = goalExtension({ advisoryPlan: true }), verification = verificationExtension(ws, true);
  const selected = [localExecution(), delegationExtension(workspace, 1, config.model, [goalTools, verification]), skillReads(local.skills), goalTools, verification];
  const registry = createRegistry(); for (const extension of selected) registry.install(extension);
  const brief: TaskBrief = { revision: 1, outcome: "按原始 TASK.md 完成实际交付并验证", deliverables: spec.outputs, inputs: spec.inputs,
    criteria: [{ text: "完整满足 TASK.md；固定命令仅是公开检查，未覆盖的语义仍需自行验证。", method: "check", verification: { command: spec.command, inputs: spec.inputs, outputs: spec.outputs } }],
    scope: ["仅修改约定产物；禁止网络/安装/驱动/其他运行/评估器/凭据"], assumptions: ["任务已一次确认；不等待继续"], questions: [], checks: [], budget: { maxEstimatedCostUsd: .08, maxDurationMs: 300000 } };
  let storage = await openNodeSqliteStorage(join(taskDir, "session.sqlite"));
  let harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(workspace) }, ctx);
  const skills = await pinSkills(ws, taskDir);
  await harness.root(ctx, { agent: { model: config.model, cwd: workspace, extensions: selected,
    instructions: nativeInstructions(run) + skillInstructions(skills) + localContextInstructions(local) } });
  await harness.commit(async tx => {
    const g = await tx.doc(GoalDoc); g.initialized = true; g.objective = spec.objective; g.phase = "working"; g.tokenLimit = null; g.costLimit = .08;
    g.brief = brief; g.skills = skills; g.confirmation = { revision: 1, digest: briefDigest(brief), at: started, deadlineAt: deadline,
      requestId: "preconfirmed-office-code-study", verificationInputs: { "1": original } };
  }, ctx);
  await harness.close(ctx);
  const meta: TaskMeta = { id: taskId, objective: spec.objective, workspace, model: config.model, subagentModel: config.model, createdAt: started, deadlineAt: deadline,
    maxSubagents: 1, control: "active", schemaVersion: 3, planPolicy: "advisory", preparation: true, resourcePolicy: "pi-skills", discovery: true,
    maxEstimatedCostUsd: .08, review: false, maxReworks: 3, maxStalls: 2 };
  await save(join(taskDir, "task.json"), meta);
  let runtime: LocalRuntime | undefined, execution = "pending", usage: UsageState | undefined, goal: Awaited<ReturnType<typeof readGoal>> | undefined;
  let error: string | undefined;
  try {
    if (arm === "pi") {
      storage = await openNodeSqliteStorage(join(taskDir, "session.sqlite"));
      harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(workspace), settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120000 }, toolExecution: "parallel", compaction: taskCompaction(models, [config.model], run.compactAtTokens) } }, ctx);
      await (await harness.root(ctx)).submit({ type: "input", content: spec.objective, requestId: "initial" }, ctx);
    } else {
      runtime = new LocalRuntime({ ...runtimeConfig(run), learning: false, discovery: true }, { models, discovery });
      await runtime.recover();
    }
    let lastOutput = 0;
    for (;;) {
      let busy: boolean;
      if (runtime) { const s = await runtime.status(taskId); usage = s.usage; execution = s.status; goal = s.goal; busy = ["running", "pending", "verifying"].includes(execution); }
      else { const s = await harness.inspect(ctx); usage = await harness.usage(ctx); goal = await readGoal(harness); busy = s.tasks.length > 0 || s.submissions.length > 0; execution = busy ? "running" : "done"; }
      if (Date.now() >= deadline || taskUsage(usage!).estimatedCostUsd >= .08) { execution = "budget_limited"; busy = false; }
      if (Date.now() - lastOutput > 20000 || !busy) { console.log(JSON.stringify({ case: item.case, repeat, arm, execution, costUsd: taskUsage(usage!).estimatedCostUsd, elapsedMs: Date.now() - started })); lastOutput = Date.now(); }
      if (!busy) break;
      await setTimeout(300);
    }
  } catch (caught) { execution = "runner_error"; error = String(caught); }
  finally { await runtime?.close(); if (!runtime) await harness.close(ctx); }
  storage = await openNodeSqliteStorage(join(taskDir, "session.sqlite"));
  harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(workspace) }, ctx);
  let transcript: Awaited<ReturnType<typeof snapshots>>, compacted = 0;
  try { usage = await harness.usage(ctx); goal = await readGoal(harness); transcript = await snapshots(harness); compacted = await compactions(harness); }
  finally { await harness.close(ctx); }
  const beforeExternal = await hashFiles(ws, spec.inputs);
  const originalInputsUnchanged = JSON.stringify(beforeExternal) === JSON.stringify(original);
  let visiblePassed = false, visibleOutput = "";
  try { const r = await execute(python, ["acceptance/check.py"], { cwd: workspace, timeout: 20000 }); visibleOutput = r.stdout + r.stderr; visiblePassed = true; }
  catch (e) { visibleOutput = String(e); }
  let semantic: { passed: boolean; checks: unknown[] } = { passed: false, checks: [] };
  try { const r = await execute(python, [join(frozen, "scripts/cases/checks.py"), item.case, workspace], { timeout: 60000, maxBuffer: 2_000_000 }); semantic = JSON.parse(r.stdout); }
  catch (e) { const out = e as Error & { stdout?: string }; try { semantic = JSON.parse(out.stdout ?? ""); } catch { semantic = { passed: false, checks: [{ name: "evaluator", passed: false, detail: String(e) }] }; } }
  assert.deepEqual(await hashFiles(ws, spec.inputs), beforeExternal, "External evaluation changed original inputs");
  const messages = transcript!.flatMap(t => t.context.messages), budget = taskUsage(usage!);
  const completed = !!goal!.candidate && (arm === "pi" ? execution === "done" && goal!.phase === "submitted" : execution === "completed");
  const result = { case: item.case, repeat, arm, taskId, execution, phase: goal!.phase, budget, elapsedMs: Date.now() - started,
    completed, qualified: completed && originalInputsUnchanged && visiblePassed && semantic.passed,
    falseCompletion: completed && (!originalInputsUnchanged || !visiblePassed || !semantic.passed),
    originalInputsUnchanged, visiblePassed, semantic, visibleOutput, operatorMessages: 0,
    userInputRequests: Number(goal!.phase === "waiting_user" || !!goal!.question), blocker: goal!.reason,
    reworks: goal!.reworks, compactions: compacted, skillsRead: goal!.skills?.loaded ?? [], localSkillReads: goal!.localSkillReads ?? [],
    workerCount: transcript!.filter(t => t.record.owner).length,
    modelResponses: messages.filter(m => m.role === "assistant" && m.usage).length,
    toolManifests: transcript!.map(t => ({ worker: !!t.record.owner, tools: getCurrentTools(t.context.messages).map(t => t.name).sort() })), error };
  results.push(result);
  await save(join(directory, "result.json"), result); await save(join(directory, "goal.json"), goal!); await save(join(directory, "transcript.json"), transcript!);
  await save(join(base, "results.json"), results);
  console.log(JSON.stringify({ graded: results.length, case: item.case, repeat, arm, completed, visiblePassed, semanticPassed: semantic.passed, qualified: result.qualified, costUsd: budget.estimatedCostUsd }));
}
assert.deepEqual(await hashFiles(source, paths), hashes);
assert.deepEqual(await hashFiles(await Workspace.open(commonHome), ["."]), sharedHashes);
const arms = ["pi", "current"].map(arm => {
  const values = results.filter(r => r.arm === arm), cost = values.reduce((s, r) => s + r.budget.estimatedCostUsd, 0), good = values.filter(r => r.qualified).length;
  return { arm, tasks: values.length, completed: values.filter(r => r.completed).length, qualified: good,
    visiblePassed: values.filter(r => r.visiblePassed).length, semanticPassed: values.filter(r => r.semantic.passed).length,
    falseCompletions: values.filter(r => r.falseCompletion).length, estimatedCostUsd: cost, costPerQualifiedUsd: good ? cost / good : null,
    totalTokens: values.reduce((s, r) => s + r.budget.totalTokens, 0), cachedTokens: values.reduce((s, r) => s + r.budget.cachedTokens, 0),
    userInputRequests: values.reduce((s, r) => s + r.userInputRequests, 0), operatorMessages: 0,
    reworks: values.reduce((s, r) => s + r.reworks, 0), modelResponses: values.reduce((s, r) => s + r.modelResponses, 0) };
});
await save(join(base, "summary.json"), { arms, totalEstimatedCostUsd: results.reduce((s, r) => s + r.budget.estimatedCostUsd, 0), sourceUnchanged: true,
  note: "Frozen development cases; two repeats do not establish general superiority. See protocol and visual QA scope." });
console.log(JSON.stringify({ finished: true, record: base, arms }));
