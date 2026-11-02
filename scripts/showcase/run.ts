/** One bounded demonstration plus a matched Pi execution reference, not a runtime. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { loadConfig } from "../../src/config.js";
import { cloudModels } from "../../src/models.js";
import { LocalRuntime } from "../../src/runtime.js";
import { Workspace } from "../../src/workspace.js";
import { hashFiles } from "../../src/verification.js";
import { briefText, usageText, verificationText } from "../../src/presentation.js";
import { save, type RunConfig } from "../heldout/common.js";
import { launchRun } from "../heldout/launch.js";
import { prepareShowcase } from "./prepare.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const args = parseArgs({ options: { execute: { type: "boolean" }, source: { type: "string" } } });
const execute = promisify(execFile), base = resolve(".harness/showcases", randomUUID());
const candidate = join(base, "candidate"), workspace = await prepareShowcase(candidate, args.values.source);
await execute("python3", [resolve("scripts/showcase/preflight.py"), workspace], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 200000 });
console.log(JSON.stringify({ prepared: true, directory: base, paid: Boolean(args.values.execute), preflight: JSON.parse(await readFile(join(candidate, "preflight.json"), "utf8")) }));
if (!args.values.execute) process.exit(0);

const config = await loadConfig(), models = cloudModels();
if (config.computer) throw new Error("Computer-use must stay off for this example");
const priorCostUsd = Number(process.env.SHOWCASE_PRIOR_COST_USD ?? 0);
assert(Number.isFinite(priorCostUsd) && priorCostUsd >= 0 && priorCostUsd < .5, "invalid prior cost");
const maximumCost = Math.min(.25, (.5 - priorCostUsd) / 2), duration = 15 * 60_000;
const runtime = new LocalRuntime({ ...config, dataDir: join(candidate, "state"), maxEstimatedCostUsd: maximumCost,
  maxDurationMs: duration, maxTotalTokens: undefined, maxSubagents: 1, review: false, web: false, computer: undefined }, { models });
const fixed = { command: "python3 acceptance/check.py", inputs: ["acceptance", "incoming", "inputs"], outputs: ["project", "tests", "README.md", "deliverables"] };
const immutable = ["incoming", "inputs", "acceptance", "TASK.md"], files = await Workspace.open(workspace);
const original = await hashFiles(files, immutable);
const source = await readFile(join(workspace, "TASK.md"), "utf8") + `\n本次准备和执行的总费用上限为USD${maximumCost}，若正文有更高默认额，以本条较低额度为准。`;
let baseline: Record<string, unknown> | undefined, taskId: string | undefined;
const started = Date.now();
try {
  const task = await runtime.create(source, workspace, [], { prepare: true }); taskId = task.id;
  let ready: Awaited<ReturnType<LocalRuntime["status"]>> | undefined;
  let last = 0;
  while (!ready) {
    const state = await runtime.status(task.id);
    if (Date.now() - last >= 15000) { console.log(JSON.stringify({ stage: "preparing", status: state.status, budget: state.budget.estimatedCostUsd })); last = Date.now(); }
    if (state.status === "awaiting_confirmation") ready = state;
    else if (!["running", "pending"].includes(state.status)) throw new Error("Preparation stopped: " + state.status + ": " + state.goal?.reason);
    if (Date.now() - started > duration + 10000) throw new Error("Preparation time boundary");
    if (!ready) await setTimeout(300);
  }
  const brief = ready.goal!.brief!;
  assert.equal(brief.questions.length, 0, "scope is explicit; this demo cannot invent user replies");
  assert(brief.budget.maxEstimatedCostUsd <= maximumCost && brief.budget.maxDurationMs <= duration);
  assert(brief.criteria.some(c => c.method === "check" && c.verification?.command.trim() === fixed.command &&
    JSON.stringify([...c.verification.inputs].sort()) === JSON.stringify([...fixed.inputs].sort()) &&
    JSON.stringify([...c.verification.outputs].sort()) === JSON.stringify([...fixed.outputs].sort())), "brief omitted the supplied check/input/output contract");
  for (const criterion of brief.criteria) if (criterion.verification) await hashFiles(files, criterion.verification.inputs);
  assert.deepEqual(await hashFiles(files, immutable), original, "preparation must not edit sources or checkers");
  await save(join(base, "approved-brief.json"), brief);
  await writeFile(join(base, "confirmation.txt"), briefText(ready));
  // Freeze the production/method sources before either execution arm begins.
  await mkdir(join(base, "frozen"));
  for (const directory of ["src", "methods"]) await cp(resolve(directory), join(base, "frozen", directory), { recursive: true });
  const codeBefore = await hashFiles(await Workspace.open(process.cwd()), ["src", "methods"]);
  const preparationCostUsd = ready.budget.estimatedCostUsd, executionCostCapUsd = maximumCost - preparationCostUsd;
  const reference = join(base, "pi-reference"); await mkdir(reference);
  await cp(workspace, join(reference, "workspace"), { recursive: true });
  await save(join(reference, "workspace/BRIEF.json"), brief);
  const run: RunConfig = { directory: reference, workspace: join(reference, "workspace"), study: base, frozen: join(base, "frozen"),
    task: "handover-showcase", category: "files-and-code", arm: "pi", repeat: 1, sequence: 1, model: task.model,
    maxEstimatedCostUsd: executionCostCapUsd, maxDurationMs: brief.budget.maxDurationMs, maxSubagents: 1,
    compactAtTokens: config.compactAtTokens ?? 48000, transientFault: false };
  await save(join(base, "protocol.json"), { model: task.model, piVersion: "1.4.0", harnessVersion: "0.5.2", approvedBrief: brief,
    preparationCostUsd, matchedExecutionCostCapUsd: executionCostCapUsd, priorCostUsd, perArmCostCapUsd: maximumCost, totalProtectionUsd: .5,
    meaning: "Development showcase and one matched Pi SDK reference with common tools; not a held-out effectiveness study. Preparation is shared, paid once, and reported separately. No user followups, injected faults, forced delay, hidden feedback or automatic retries.", codeBefore });
  baseline = await launchRun(run, resolve("scripts/heldout/worker.ts"));
  assert(baseline.budget, "missing baseline usage; stop rather than spend an unaudited remainder");
  assert.deepEqual(await hashFiles(files, immutable), original);
  assert.deepEqual(await hashFiles(await Workspace.open(process.cwd()), ["src", "methods"]), codeBefore, "production/method code changed during reference");
  await runtime.confirm(task.id, brief.revision, ready.briefDigest!);
  console.log(JSON.stringify({ stage: "confirmed-once", taskId: task.id, executionCostCapUsd }));
  last = 0;
  for (;;) {
    const state = await runtime.status(task.id);
    if (Date.now() - last >= 15000) { console.log(JSON.stringify({ stage: "executing", status: state.status, budget: state.budget.estimatedCostUsd, reworks: state.goal?.reworks })); last = Date.now(); }
    if (!["running", "pending", "verifying"].includes(state.status)) {
      assert.deepEqual(await hashFiles(files, immutable), original, "original materials/checkers changed");
      await save(join(candidate, "result.json"), { execution: state.status, taskId: task.id, elapsedMs: Date.now() - state.goal!.confirmation!.at,
        preparationCostUsd, executionCostUsd: state.budget.estimatedCostUsd - preparationCostUsd, budget: state.budget,
        confirmationCount: state.goal?.events.filter(event => event.type === "confirmed").length, operatorFollowupMessages: 0,
        workerCount: state.workerCount, compactions: state.compactions, reworks: state.goal?.reworks,
        goal: state.goal, model: task.model, independentEvaluation: "pending source review and post-run check" });
      await writeFile(join(candidate, "delivery.txt"), [state.goal?.candidate?.summary ?? state.goal?.reason ?? state.status, verificationText(state), usageText(state)].join("\n\n"));
      await save(join(base, "result.json"), { candidate: state.status, baseline: baseline.execution, estimatedCostUsd: state.budget.estimatedCostUsd + (baseline.budget as { estimatedCostUsd: number }).estimatedCostUsd,
        originalInputsUnchanged: true, sourceAndMethodsUnchanged: true, independentEvaluation: "pending", record: base });
      console.log(JSON.stringify({ finished: true, candidate: state.status, baseline: baseline.execution, record: base }));
      break;
    }
    await setTimeout(400);
  }
} catch (error) {
  const state = taskId ? await runtime.status(taskId).catch(() => undefined) : undefined;
  await save(join(base, "failure.json"), { taskId, error: String(error), elapsedMs: Date.now() - started, baseline,
    candidateBudget: state?.budget, candidateGoal: state?.goal });
  throw error;
} finally { await runtime.close(); }
