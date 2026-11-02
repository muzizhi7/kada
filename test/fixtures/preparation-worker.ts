import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { LocalRuntime } from "../../src/runtime.js";
import { until } from "../helpers.js";

const [mode, directory, stage] = process.argv.slice(2) as [string, string, string];
const exists = (name: string) => access(join(directory, name)).then(() => true, () => false);
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const faux = fauxProvider({ provider: "preparation-crash", models: [{ id: "scripted" }] });
faux.setResponses(Array.from({ length: 64 }, () => async (c, options) => {
  if (getCurrentTools(c.messages).some(t => t.name === "task_prepare")) return call("task_prepare", {
    outcome: "创建并检查结果", deliverables: ["result.json"], inputs: [], scope: ["只操作工作区"], assumptions: [], questions: [],
    criteria: [{ text: "结果文件有正确总计", method: "check" }], checks: [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }],
    budget: { maxEstimatedCostUsd: .5, maxDurationMs: 60000 },
  });
  const done = c.messages.some(m => m.role === "toolResult" && m.toolName === "bash" && !m.isError);
  if (!done) return call("bash", { command: "node -e 'const fs=require(\"node:fs\");fs.appendFileSync(\"effects.txt\",\"once\\n\");fs.writeFileSync(\"result.json\",JSON.stringify({total:71}))'" });
  const proof = c.messages.findLast(m => m.role === "toolResult" && m.toolName === "task_verify" && !m.isError);
  const proofId = proof?.role === "toolResult" ? JSON.parse(proof.content.find(b => b.type === "text")!.text).id as string : undefined;
  if (!proofId) return call("task_verify", { command: "node -e 'if(JSON.parse(require(\"node:fs\").readFileSync(\"result.json\",\"utf8\")).total!==71)process.exit(1)'", inputs: [], outputs: ["result.json"] });
  if (mode === "create" && stage === "executing") {
    await writeFile(join(directory, "gated"), "ready");
    while (!await exists("release")) await setTimeout(20, undefined, { signal: options?.signal });
  }
  return call("task_submit", { summary: "Result inspected.", artifacts: ["result.json"], criteria: [{ id: 1, status: "passed", evidence: "读取既有结果，total71 且无重复追加", proofIds: [proofId] }] });
}));
const models = createModels(); models.setProvider(faux.provider);
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: { provider: "preparation-crash", modelId: "scripted" }, maxSubagents: 2, maxDurationMs: 60000, review: false, web: false }, { models });
try {
  const task = mode === "create" ? await runtime.create("写入并检查正确总计。", join(directory, "workspace"), [], { prepare: true })
    : (await runtime.recover(), (await runtime.list())[0]!);
  const snapshot = async () => {
    const s = await runtime.status(task.id);
    return { taskId: task.id, status: s.status, digest: s.briefDigest, confirmation: s.goal?.confirmation ?? null, budget: s.budget,
      confirmations: s.goal?.events.filter(e => e.type === "confirmed").length ?? 0,
      confirmInputs: s.messages.filter(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("USER_CONFIRMED_BRIEF")).length,
      bashCalls: s.messages.filter(m => m.role === "assistant").flatMap(m => m.content).filter(b => b.type === "toolCall" && b.name === "bash").length,
      proofIds: Object.keys(s.goal?.proofs ?? {}), modelCalls: faux.state.callCount, outputExists: await access(join(directory, "workspace/result.json")).then(() => true, () => false) };
  };
  if (stage === "waiting") {
    await until(() => runtime.status(task.id), s => s.status === "awaiting_confirmation");
    console.log(JSON.stringify({ type: mode === "create" ? "ready" : "restored", ...await snapshot() }));
    if (mode === "create") while (!await exists("release")) await setTimeout(20);
  } else {
    if (mode === "create") {
      const brief = await until(() => runtime.status(task.id), s => s.status === "awaiting_confirmation");
      await runtime.confirm(task.id, 1, brief.briefDigest!);
      await until(() => exists("gated"), Boolean);
      console.log(JSON.stringify({ type: "ready", ...await snapshot() }));
    }
    await until(() => runtime.status(task.id), s => s.status === "completed");
    if (await readFile(join(directory, "workspace/effects.txt"), "utf8") !== "once\n") throw new Error("Repeated external action");
    console.log(JSON.stringify({ type: "completed", ...await snapshot() }));
  }
} finally { await runtime.close(); }
