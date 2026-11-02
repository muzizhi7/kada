import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { LocalRuntime } from "../../src/runtime.js";
import { demoModels } from "../../src/models.js";
import { prepareDemo } from "../../src/demo.js";

const [mode, directory] = process.argv.slice(2) as [string, string];
const workspace = join(directory, "workspace");
if (mode === "create") await prepareDemo(workspace);
const { models, ref } = demoModels(workspace, { gate: true });
const exists = (file: string) => access(file).then(() => true, () => false);
const gate = defineExtension({ name: "test_checkpoint", tools: [defineTool({
  name: "test_gate", description: "Test-only crash recovery checkpoint.", parameters: Type.Object({ worker: Type.String() }), replay: "safe",
  execute: async (args, _api, ctx) => {
    await writeFile(join(directory, `ready-${args.worker}`), "ready");
    while (!await exists(join(directory, "release"))) await setTimeout(25, undefined, { signal: ctx.abortSignal });
    return { output: [{ type: "text", text: "Checkpoint resumed" }] };
  },
})] });
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: ref, maxSubagents: 2, maxDurationMs: 60_000, review: true, web: false }, { models, extensions: [gate] });
try {
  if (mode === "create") await runtime.create("Complete the crash recovery demonstration.", workspace);
  else await runtime.recover();
  const task = (await runtime.list())[0]!;
  let announced = false;
  for (;;) {
    const status = await runtime.status(task.id);
    if (!announced && await exists(join(directory, "ready-alpha")) && await exists(join(directory, "ready-beta"))) {
      console.log(JSON.stringify({ type: "ready", taskId: task.id, ids: status.conversations.map(c => c.id) }));
      announced = true;
    }
    if (status.status === "completed") {
      console.log(JSON.stringify({ type: "completed", ids: status.conversations.filter(c => c.owner || c.id === status.conversations[0]?.id).map(c => c.id) }));
      break;
    }
    if (status.status === "failed") throw new Error(JSON.stringify(status.submission));
    await setTimeout(25);
  }
} finally { await runtime.close(); }
