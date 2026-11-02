import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchRun } from "./launch.js";
import type { Arm, RunConfig } from "./common.js";

const directory = await mkdtemp(join(tmpdir(), "pi-heldout-plumbing-"));
await writeFile(join(directory, "goal-driven-template.txt"), "Goal: [[[[[DEFINE YOUR GOAL HERE]]]]]\nCriteria: [[[[[DEFINE YOUR CRITERIA FOR SUCCESS HERE]]]]]");
const manifests: string[] = [];
for (const arm of ["pi", "prompt", "extension"] as Arm[]) {
  const work = join(directory, arm), workspace = join(work, "workspace");
  await mkdir(workspace, { recursive: true });
  const budget = { maxEstimatedCostUsd: .25, maxDurationMs: 30000 };
  await writeFile(join(workspace, "TASK.md"), "Materialize deliverables/ready.txt containing ok and action-count.txt containing once followed by a newline. The command is idempotent because raw commands may replay across a crash. Verify actual results and submit. Do not ask the user to continue.");
  await writeFile(join(workspace, "BRIEF.json"), JSON.stringify({ revision: 1, outcome: "Free plumbing test", deliverables: ["deliverables/ready.txt"], inputs: [],
    criteria: [{ text: "Actual output and one append checked", method: "check" }], scope: ["test workspace"], assumptions: [], questions: [],
    checks: [{ type: "file_exists", path: "deliverables/ready.txt" }], budget }));
  const config: RunConfig = { directory: work, workspace, study: directory, frozen: resolve("."), task: "plumbing", category: "test", arm, repeat: 1, sequence: manifests.length + 1,
    model: { provider: "local-test", modelId: "scripted" }, maxEstimatedCostUsd: .25, maxDurationMs: 30000, maxSubagents: 3, compactAtTokens: 48000,
    transientFault: true, crashWatch: "deliverables", offline: true };
  const result = await launchRun(config, resolve("scripts/heldout/worker.ts"));
  assert.equal(result.processFailure, null, arm);
  assert.equal(result.interruption.injected, true, arm);
  assert.equal(result.interruption.restarts, 1, arm);
  assert.equal(await readFile(join(workspace, "action-count.txt"), "utf8"), "once\n", arm);
  assert.equal(await readFile(join(workspace, "deliverables/ready.txt"), "utf8"), "ok", arm);
  const detail = result as typeof result & { fault: { injected: boolean }; budget: { estimatedCostUsd: number }; toolManifests: { worker: boolean; names: string[]; schemaSha256: string }[]; approvedDeadline: number; hostDeclaredComplete: boolean };
  assert.equal(detail.fault.injected, true); assert.equal(detail.budget.estimatedCostUsd, 0);
  assert.equal(detail.hostDeclaredComplete, true, JSON.stringify({ arm, execution: (result as Record<string, unknown>).execution }));
  const root = detail.toolManifests.find(item => !item.worker)!;
  assert.equal(root.names.length, 11); manifests.push(root.schemaSha256);
  const saved = JSON.parse(await readFile(join(work, "run.json"), "utf8")) as RunConfig;
  assert.equal(detail.approvedDeadline, saved.deadlineAt, "recovery must not refill execution time");
}
assert.equal(new Set(manifests).size, 1, "every arm must offer identical tool schemas");
console.log(JSON.stringify({ freePlumbingTest: "passed", arms: 3, commonRootTools: 11, crashRecoveries: 3, transientErrors: 3, idempotentOutputVerified: true, modelCostUsd: 0, directory }));
