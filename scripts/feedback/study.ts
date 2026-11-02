/** Freeze and launch eight matched component trials; not an application runtime. */
import { cp, mkdir, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadConfig } from "../../src/config.js";
import { cloudModels, validateModel } from "../../src/models.js";
import { save, sha, type Arm, type RunConfig } from "../heldout/common.js";
import { launchRun } from "../heldout/launch.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const base = resolve(process.argv[2] ?? ".harness/benchmarks/feedback-2026-10-31");
const freezeFile = join(base, "frozen.json");
const paid = process.argv.includes("--execute");
async function hashes(root: string) {
  const output: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output[path.slice(root.length + 1)] = sha(await readFile(path));
      else if (entry.isSymbolicLink()) output[path.slice(root.length + 1)] = sha("symlink:" + await readlink(path));
    }
  }
  await walk(root); return output;
}
const config = await loadConfig(), models = cloudModels(), model = validateModel(models, config.model);
if (config.computer) throw new Error("Computer-use must remain off for this comparison");
if (!await stat(freezeFile).catch(() => undefined)) {
  if (paid) throw new Error("Freeze protocol/code/fixtures and pass free checks before execution");
  const frozen = join(base, "frozen"); await mkdir(frozen, { recursive: true });
  const prior = await readFile(join(base, "prior-cost.json"), "utf8").then(text => JSON.parse(text) as { budgetChargeUsd: number; recordedEstimatedCostUsd: number }).catch(() => ({ budgetChargeUsd: 0, recordedEstimatedCostUsd: 0 }));
  const previousSpend = prior.budgetChargeUsd;
  if (!Number.isFinite(previousSpend) || previousSpend < 0 || previousSpend >= 2.25) throw new Error("Invalid or exhausted prior paid cost");
  const filter = (path: string) => !path.includes("__pycache__") && !path.endsWith(".pyc");
  for (const directory of ["src", "methods", "scripts/heldout", "scripts/feedback"]) await cp(resolve(directory), join(frozen, directory), { recursive: true, filter });
  for (const file of ["package.json", "package-lock.json"]) await cp(resolve(file), join(frozen, file));
  await cp(resolve("docs/experiments/2026-10-31-feedback-protocol.md"), join(frozen, "PROTOCOL.md"));
  const tasks = JSON.parse(await readFile(join(base, "tasks.json"), "utf8")) as { id: string; category: string }[];
  if (tasks.length !== 2) throw new Error("Expected exactly two new tasks");
  const runs: RunConfig[] = [];
  for (const repeat of [1, 2]) for (const [index, task] of tasks.entries()) {
    const arms: Arm[] = (repeat + index) % 2 === 1 ? ["pi", "extension"] : ["extension", "pi"];
    for (const arm of arms) {
      const sequence = runs.length + 1, directory = join(base, "runs", `${String(sequence).padStart(2, "0")}-${task.id}-${arm}-r${repeat}`);
      runs.push({ directory, workspace: join(directory, "workspace"), study: base, frozen, task: task.id, category: task.category, arm,
        repeat, sequence, model, maxEstimatedCostUsd: .25, maxDurationMs: 3600000, maxSubagents: 3, compactAtTokens: 48000, transientFault: false });
    }
  }
  await save(freezeFile, { frozen, createdAt: Date.now(), hashes: await hashes(frozen), fixtureHashes: await hashes(join(base, "fixtures")),
    taskHash: sha(await readFile(join(base, "tasks.json"))), sourceHash: sha(await readFile(join(base, "source-manifest.json"))),
    piVersion: "1.4.0", harnessVersion: "0.5.1", model, modelCost: models.getModel(model.provider, model.modelId)!.cost,
    onlyTreatment: "maxReworks=0 versus 3; same production host, instructions, tools, methods, approved brief and budgets",
    scope: "Execution after fixed confirmation only. Shared Pi/production adapters, NOT stock Pi CLI. No hidden grader feedback, web, computer or artificial crash.",
    nominalUsd: 2, previousBudgetChargeUsd: previousSpend, previousRecordedEstimatedCostUsd: prior.recordedEstimatedCostUsd,
    totalProtectionUsd: 2.25, aggregateStopUsd: 2.25 - previousSpend, maxBatchDurationMs: 4 * 3600000, runs });
  console.log(JSON.stringify({ frozen: true, paid: false, runs: runs.length, model, nominalUsd: 2 })); process.exit(0);
}
const record = JSON.parse(await readFile(freezeFile, "utf8")) as { frozen: string; hashes: Record<string, string>; fixtureHashes: Record<string, string>; taskHash: string; sourceHash: string; runs: RunConfig[]; aggregateStopUsd: number; maxBatchDurationMs: number };
async function intact() {
  for (const [directory, expected] of [[record.frozen, record.hashes], [join(base, "fixtures"), record.fixtureHashes]] as const) {
    const actual = await hashes(directory);
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error("Frozen files changed: " + directory);
  }
  if (sha(await readFile(join(base, "tasks.json"))) !== record.taskHash || sha(await readFile(join(base, "source-manifest.json"))) !== record.sourceHash) throw new Error("Study metadata changed");
}
await intact();
if (!paid) { console.log(JSON.stringify({ frozen: true, paid: false, runs: record.runs.length })); process.exit(0); }
const started = await readFile(join(base, "execution.json"), "utf8").then(text => (JSON.parse(text) as { startedAt: number }).startedAt).catch(() => Date.now());
await save(join(base, "execution.json"), { startedAt: started, authorization: "User requested execution of the agreed bug fixes and eight matched component trials." });
const results: Record<string, unknown>[] = [];
for (const run of record.runs) {
  const previous = await readFile(join(run.directory, "result.json"), "utf8").then(text => JSON.parse(text) as Record<string, unknown>).catch(() => null);
  if (previous) { results.push(previous); continue; }
  const cost = results.reduce((sum, row) => sum + ((row.budget as { estimatedCostUsd: number } | null)?.estimatedCostUsd ?? 0), 0);
  if (cost + .25 > record.aggregateStopUsd || Date.now() - started > record.maxBatchDurationMs) {
    await save(join(base, "stopped.json"), { completed: results.length, cost, reason: "aggregate fee/time boundary" }); break;
  }
  await intact(); await mkdir(run.directory, { recursive: true });
  if (!await stat(run.workspace).catch(() => undefined)) await cp(join(base, "fixtures", run.task), run.workspace, { recursive: true, dereference: false, verbatimSymlinks: true });
  const result: Record<string, unknown> = await launchRun(run, join(record.frozen, "scripts/feedback/worker.ts")); results.push(result);
  await save(join(base, "results.json"), results);
  console.log(JSON.stringify({ completed: results.length, task: run.task, arm: run.arm, execution: result.execution, budget: result.budget }));
  if (!result.budget) { await save(join(base, "stopped.json"), { reason: "Missing auditable usage", sequence: run.sequence }); break; }
  const manifests = results.flatMap(row => (row.toolManifests ?? []) as { worker: boolean; names: string[]; schemaSha256: string }[]).filter(item => item.names.length && !item.worker);
  if (new Set(manifests.map(item => item.schemaSha256)).size !== 1 || manifests.some(item => item.names.length !== 11)) throw new Error("Observed root tool schemas differ");
  const instructionHashes = results.filter(row => row.task === run.task).map(row => row.instructionsSha256);
  if (new Set(instructionHashes).size !== 1 || instructionHashes.some(hash => typeof hash !== "string")) throw new Error("Observed normalized instructions differ");
}
console.log(JSON.stringify({ completed: results.length, planned: 8 }));
