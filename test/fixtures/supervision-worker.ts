import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { LocalRuntime } from "../../src/runtime.js";

const [mode, directory, stage] = process.argv.slice(2) as [string, string, string];
const exists = (file: string) => access(file).then(() => true, () => false);
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const faux = fauxProvider({ provider: "crash-test", models: [{ id: "scripted" }] });
faux.setResponses(Array.from({ length: 64 }, () => async (c, options) => {
  const users = c.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  const isReview = c.messages.some(m => m.role === "system" && m.toolsAdded?.some(t => t.name === "review_result"));
  const results = c.messages.filter(m => m.role === "toolResult" && !m.isError);
  if ((stage === "review" && isReview) || (stage === "rework" && !isReview && users.some(t => t.includes("SUPERVISOR_REWORK")))) {
    await writeFile(join(directory, "gated"), "ready");
    while (!await exists(join(directory, "release"))) await setTimeout(25, undefined, { signal: options?.signal });
  }
  if (isReview) {
    const payload = JSON.parse(users[0]!);
    if (payload.mechanical.files.length && !results.some(m => m.toolName === "read_file")) return call("read_file", { path: "result.json" });
    return call("review_result", { verdict: "pass", reason: "Inspected result.json and verified total 71.", evidence: ["result.json"] });
  }
  if (stage === "review" || users.some(t => t.includes("SUPERVISOR_REWORK"))) {
    if (!results.some(m => m.toolName === "write")) return call("write", { path: "result.json", content: '{"total":71}' });
  }
  return call("task_submit", { summary: "Total 71 is in result.json.", artifacts: ["result.json"] });
}));
const models = createModels(); models.setProvider(faux.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: { provider: "crash-test", modelId: "scripted" }, maxSubagents: 2, maxDurationMs: 60_000, review: true, web: false }, { models });
try {
  if (mode === "create") await runtime.create("Write and verify total 71.", join(directory, "workspace"), [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }]);
  else await runtime.recover();
  const task = (await runtime.list())[0]!;
  let announced = false;
  for (;;) {
    const status = await runtime.status(task.id);
    const snapshot = { reviewerId: status.goal?.review?.conversationId, rootRequest: status.submission?.requestId, reworks: status.goal?.reworks,
      reworkInputs: status.messages.filter(m => m.role === "user" && typeof m.content === "string" && m.content.includes("SUPERVISOR_REWORK")).length,
      conversations: status.conversations.map(c => c.id) };
    if (!announced && await exists(join(directory, "gated"))) { console.log(JSON.stringify({ type: "ready", ...snapshot })); announced = true; }
    if (status.status === "completed") { console.log(JSON.stringify({ type: "completed", ...snapshot })); break; }
    if (["failed", "needs_attention", "budget_limited"].includes(status.status)) throw new Error(JSON.stringify({ status: status.status, reason: status.goal?.reason }));
    await setTimeout(25);
  }
} finally { await runtime.close(); }
