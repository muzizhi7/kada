import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, type Cursor, type EntryRecord, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GoalDoc, goalExtension } from "../../src/goal.js";
import { localEnvironment, localExecution } from "../../src/execution.js";
import { until } from "../helpers.js";

const [mode, directory] = process.argv.slice(2) as [string, string];
const exists = (file: string) => access(join(directory, file)).then(() => true, () => false);
const continuation = "PI_HOOK_CONTINUE: keep the original objective and inspect saved work.";
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const faux = fauxProvider({ provider: "hook-crash", models: [{ id: "scripted" }] });
faux.setResponses(Array.from({ length: 32 }, () => async (c, options) => {
  if (c.messages.some(m => m.role === "system" && JSON.stringify(m).includes("context summarization assistant"))) return fauxAssistantMessage("COMPACTED_PROBE. Original objective: create effects.txt with exactly one line once. PI_HOOK_CONTINUE was already applied. The file exists; inspect then task_submit, without repeating bash.");
  if (!JSON.stringify(c.messages).includes("PI_HOOK_CONTINUE")) return fauxAssistantMessage("Unsubmitted draft.");
  if (!await exists("effects.txt")) return call("bash", { command: "node -e 'require(\"node:fs\").appendFileSync(\"effects.txt\",\"once\\n\")'" });
  if (mode === "create") {
    if (!JSON.stringify(c.messages).includes("COMPACTED_PROBE")) {
      await writeFile(join(directory, "waiting-for-compaction"), "ready");
      while (!await exists("place-compaction")) await setTimeout(20, undefined, { signal: options?.signal });
      return call("read", { path: "effects.txt" });
    }
    await writeFile(join(directory, "compacted-model"), "ready");
    while (!await exists("release")) await setTimeout(20, undefined, { signal: options?.signal });
  }
  assertSaved(await readFile(join(directory, "effects.txt"), "utf8"));
  return call("task_submit", { summary: "Side effect inspected; only one append occurred.", artifacts: ["effects.txt"] });
}));
function assertSaved(text: string) { if (text !== "once\n") throw new Error("Repeated side effect"); }
const models = createModels(); models.setProvider(faux.provider);
const probe = defineExtension({ name: "hook_recovery_probe", hooks: [hook(GenerationTask, { onYield: () => ({ continue: continuation }) })] });
const extensions = [localExecution(), goalExtension(), probe], registry = createRegistry();
for (const e of extensions) registry.install(e);
const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
const harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(directory), settings: { compaction: { enabled: true, keepRecentTokens: 256, backgroundTokens: 0 } } }, ctx);
try {
  const root = await harness.root(ctx, { agent: { model: { provider: "hook-crash", modelId: "scripted" }, cwd: directory, extensions } });
  const input = await root.submit({ type: "input", requestId: "initial", content: "Create effects.txt with exactly one line once, inspect and submit. Reference material: " + "Keep the original goal and existing work. ".repeat(1000) }, ctx);
  const snapshot = async () => {
    const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await storage.scanEntries({ conversationId: root.id, order: "ascending" }, 500, cursor, ctx); entries.push(...page.items); cursor = page.next; } while (cursor);
    const messages = entries.flatMap(e => e.model ?? []);
    const inputs = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, ctx);
    const phase = await harness.commit(async tx => (await tx.doc(GoalDoc)).phase, ctx);
    return { inputId: input.id, inputRequests: inputs.items.filter(s => s.type === "input").length,
      continuations: messages.filter(m => m.role === "user" && m.content === continuation).length,
      bashCalls: messages.filter(m => m.role === "assistant").flatMap(m => m.content).filter(b => b.type === "toolCall" && b.name === "bash").length,
      compactions: entries.filter(e => e.kind === "pi.compaction").length, phase };
  };
  if (mode === "create") {
    await until(() => exists("waiting-for-compaction"), Boolean);
    const compact = await root.compact("Keep the exact original objective, prior hook continuation and side effect.", ctx);
    const result = (await harness.waitForTask(compact, ctx)).state.outcome;
    if (result.status !== "completed" || result.result.submissionId === undefined) throw new Error("Compaction did not produce a summary");
    await writeFile(join(directory, "place-compaction"), "place");
    await until(() => exists("compacted-model"), Boolean);
    console.log(JSON.stringify({ type: "ready", ...await snapshot() }));
  }
  if ((await input.wait(ctx)).status !== "done") throw new Error("Run failed");
  console.log(JSON.stringify({ type: "completed", ...await snapshot() }));
} finally { await harness.close(ctx); }
