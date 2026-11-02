import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { LocalRuntime } from "./runtime.js";
import { demoModels } from "./models.js";
import type { Config } from "./config.js";

export async function prepareDemo(workspace: string): Promise<void> {
  await mkdir(join(workspace, "inputs"), { recursive: true });
  await writeFile(join(workspace, "inputs", "alpha.txt"), "Alpha source: local task persistence.\n");
  await writeFile(join(workspace, "inputs", "beta.txt"), "Beta source: parallel worker coordination.\n");
}

export async function runDemo(dataDir: string): Promise<void> {
  const workspace = join(dataDir, "workspace");
  await prepareDemo(workspace);
  const { models, ref } = demoModels(workspace);
  const config: Config = { dataDir, port: 4317, model: ref, maxSubagents: 2, maxDurationMs: 60_000, review: true, web: false };
  const runtime = new LocalRuntime(config, { models });
  try {
    const task = await runtime.create("Run the offline two-worker demonstration and verify report.md.", workspace);
    console.log(`Offline simulation (no cloud requests). Task: ${task.id}`);
    for (;;) {
      const status = await runtime.status(task.id);
      if (status.status === "completed") {
        console.log(`Completed with ${status.workerCount} workers and an independent read-only reviewer. Report: ${workspace}/report.md`);
        break;
      }
      if (!["running", "pending", "verifying"].includes(status.status)) throw new Error(JSON.stringify({ status: status.status, reason: status.goal?.reason }));
      await setTimeout(100);
    }
  } finally { await runtime.close(); }
}
