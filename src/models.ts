import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Models, type TranscriptContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "./config.js";

export function cloudModels(): Models { return builtinModels(); }
export function validateModel(models: Models, ref: ModelRef | undefined): ModelRef {
  if (!ref) throw new Error("No model configured. Set MODEL_PROVIDER and MODEL_ID, or create harness.config.json. Use the models command to list providers and model IDs.");
  if (!models.getModel(ref.provider, ref.modelId)) throw new Error(`Unknown model ${ref.provider}/${ref.modelId}. Use the models command to list the installed Pi catalog.`);
  return ref;
}

/** Explicit offline simulation; this never makes a network request or impersonates a cloud model. */
export function demoModels(workspace: string, options: { delayMs?: number; gate?: boolean } = {}): { models: Models; ref: ModelRef } {
  const faux = fauxProvider({ provider: "demo", models: [{ id: "scripted", reasoning: false }] });
  const respond = (context: TranscriptContext) => {
    const input = context.messages.find(m => m.role === "user");
    const text = typeof input?.content === "string" ? input.content : JSON.stringify(input?.content);
    const results = context.messages.filter(m => m.role === "toolResult");
    const native = context.messages.some(m => m.role === "system" && m.toolsAdded?.some(t => t.name === "bash"));
    const readName = native ? "read" : "read_file", writeName = native ? "write" : "write_file";
    const has = (name: string) => results.some(m => m.toolName === name && !m.isError);
    const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    const reviewer = context.messages.some(m => m.role === "system" && m.toolsAdded?.some(t => t.name === "review_result"));
    if (reviewer) {
      const candidate = JSON.parse(text ?? "{}");
      const files: string[] = candidate.mechanical.files.map((f: { path: string }) => f.path);
      const reads = results.filter(m => m.toolName === "read_file" && !m.isError).length;
      if (reads < files.length) return call("read_file", { path: files[reads]! });
      return call("review_result", { verdict: "pass", reason: "The simulated report includes both independently produced worker findings.", evidence: files });
    }
    const worker = /DEMO_WORKER:(alpha|beta)/.exec(text ?? "")?.[1];
    if (worker) {
      if (!has(readName)) return call(readName, { path: `${workspace}/inputs/${worker}.txt` });
      if (options.gate && !has("test_gate")) return call("test_gate", { worker });
      const read = results.find(m => m.toolName === readName);
      const source = read?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
      if (!has(writeName)) return call(writeName, { path: "result.txt", content: `${worker}: ${source}\n` });
      return fauxAssistantMessage(`${worker} completed: ${source}`);
    }
    if (!has("delegate")) return call("delegate", { tasks: ["alpha", "beta"].map(name => ({ name, instructions: `DEMO_WORKER:${name}\nRead ${workspace}/inputs/${name}.txt and save result.txt.` })) });
    const delegated = results.find(m => m.toolName === "delegate");
    const summaries = delegated?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
    if (!has(writeName)) return call(writeName, { path: "report.md", content: `# Offline harness demonstration\n\nTwo independent workers completed their tasks.\n\n${summaries}\n` });
    if (!has(readName)) return call(readName, { path: "report.md" });
    return call("task_submit", { summary: `Verified report: ${workspace}/report.md`, artifacts: ["report.md"] });
  };
  faux.setResponses(Array.from({ length: 256 }, () => async (context, streamOptions) => {
    if (options.delayMs) {
      const { setTimeout } = await import("node:timers/promises");
      await setTimeout(options.delayMs, undefined, { signal: streamOptions?.signal });
    }
    return respond(context);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, ref: { provider: "demo", modelId: "scripted" } };
}
