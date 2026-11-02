/** Free end-to-end runner check; scripted output is not task-quality evidence. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchRun } from "../heldout/launch.js";
import type { Arm, RunConfig } from "../heldout/common.js";

const directory = await mkdtemp(join(tmpdir(), "pi-feedback-free-"));
const schemas: string[] = [];
for (const [index, arm] of (["pi", "extension"] as Arm[]).entries()) {
  const work = join(directory, arm), workspace = join(work, "workspace"); await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "TASK.md"), "Materialize deliverables/ready.txt containing ok, action-count.txt containing once followed by a newline, then verify and submit. No routine user followup.");
  await writeFile(join(workspace, "BRIEF.json"), JSON.stringify({ revision: 1, outcome: "Free runner", deliverables: ["deliverables/ready.txt"], inputs: [],
    criteria: [{ text: "Actual output verified", method: "check" }], scope: ["workspace"], assumptions: [], questions: [],
    checks: [{ type: "file_exists", path: "deliverables/ready.txt" }], budget: { maxEstimatedCostUsd: .25, maxDurationMs: 30000 } }));
  const run: RunConfig = { directory: work, workspace, study: directory, frozen: resolve("."), task: "free", category: "free", arm, repeat: 1, sequence: index + 1,
    model: { provider: "local-test", modelId: "scripted" }, maxEstimatedCostUsd: .25, maxDurationMs: 30000, maxSubagents: 3, compactAtTokens: 48000, transientFault: false, offline: true };
  const result = await launchRun(run, resolve("scripts/feedback/worker.ts")) as Record<string, unknown>;
  assert.equal(result.hostDeclaredComplete, true, JSON.stringify(result));
  assert.equal((result.budget as { estimatedCostUsd: number }).estimatedCostUsd, 0);
  assert.equal(result.maxReworks, arm === "pi" ? 0 : 3);
  assert.equal(result.emittedFeedbackMessages, 0);
  const manifests = result.toolManifests as { worker: boolean; names: string[]; schemaSha256: string }[];
  const root = manifests.find(item => !item.worker && item.names.length)!;
  assert.equal(root.names.length, 11); schemas.push(root.schemaSha256);
  assert.equal(await readFile(join(workspace, "action-count.txt"), "utf8"), "once\n");
  const saved = JSON.parse(await readFile(join(work, "run.json"), "utf8")) as RunConfig;
  assert.equal(result.approvedDeadline, saved.deadlineAt);
}
assert.equal(new Set(schemas).size, 1);
console.log(JSON.stringify({ freeRunnerTest: "passed", arms: 2, sameTools: 11, sameProductionRuntime: true, costUsd: 0, directory }));
