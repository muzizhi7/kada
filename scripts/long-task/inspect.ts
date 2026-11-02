import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// Post-run storage reads only: no Harness, scheduler, models, credentials or new submissions.
const directory = resolve(process.argv[2]!);
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const observations = [];
for (const arm of manifest.order as string[]) {
  const folder = join(directory, arm);
  const result = JSON.parse(await readFile(join(folder, "result.json"), "utf8"));
  const db = arm === "extension" ? join(folder, "tasks", result.taskId, "session.sqlite") : join(folder, "session.sqlite");
  const storage = await openNodeSqliteStorage(db);
  try {
    const conversations = []; let cursor: Cursor | undefined;
    do { const page = await storage.scanConversations({}, 200, cursor, ctx); conversations.push(...page.items); cursor = page.next; } while (cursor);
    const transcripts = [], submissions = [];
    const tools = new Map<string, { name: string; description?: string; parameters?: unknown }>();
    const postSupervisorTools: string[] = [];
    let toolCalls = 0, compactions = 0, modelReplies = 0, goalDrivenInSystem = false, goalDrivenInUser = false;
    for (const conversation of conversations) {
      const entries = [], inputs = []; let pageCursor: Cursor | undefined;
      do { const page = await storage.scanEntries({ conversationId: conversation.id, order: "ascending" }, 500, pageCursor, ctx); entries.push(...page.items); pageCursor = page.next; } while (pageCursor);
      pageCursor = undefined;
      do { const page = await storage.scanSubmissions({ conversationId: conversation.id }, 200, pageCursor, ctx); inputs.push(...page.items); pageCursor = page.next; } while (pageCursor);
      transcripts.push({ record: conversation, entries }); submissions.push({ conversationId: conversation.id, owner: conversation.owner, submissions: inputs });
      compactions += entries.filter(e => e.kind === "pi.compaction").length;
      let afterSupervisor = false;
      for (const entry of entries) for (const message of entry.model ?? []) {
        if (message.role === "assistant") {
          modelReplies++;
          const calls = message.content.filter(b => b.type === "toolCall"); toolCalls += calls.length;
          if (!conversation.owner && afterSupervisor) postSupervisorTools.push(...calls.map(c => c.name));
        }
        if (!conversation.owner && message.role === "system") {
          goalDrivenInSystem ||= JSON.stringify(message).includes("Goal-Driven");
          for (const t of message.toolsAdded ?? []) tools.set(t.name, { name: t.name, description: t.description, parameters: t.parameters });
        }
        if (!conversation.owner && message.role === "user") {
          const text = JSON.stringify(message.content);
          goalDrivenInUser ||= text.includes("Goal-Driven");
          if (text.includes("SUPERVISOR_REWORK")) afterSupervisor = true;
        }
      }
    }
    const rootInputs = submissions.filter(c => !c.owner).flatMap(c => c.submissions).filter(s => s.type === "input");
    const inputRequests = rootInputs.map(s => s.requestId);
    const operatorInputs = inputRequests.filter(id => id !== "initial" && !String(id).startsWith("supervisor:") && !String(id).startsWith("review:"));
    const rootTools = [...tools.values()];
    const observation = { arm, conversations: conversations.length, workers: conversations.filter(c => c.owner).length,
      inputRequests, operatorFollowupMessages: operatorInputs.length, compactionsAllConversations: compactions,
      totalToolCalls: toolCalls, persistedAssistantReplies: modelReplies, goalDrivenInSystem, goalDrivenInUser, postSupervisorTools,
      note: "Counts use all persisted entries. Assistant replies are not a complete API-request count; compaction and failed streams are separate. Pi usage is cumulative.",
      rootToolNames: rootTools.map(t => t.name), rootToolSchemaSha256: createHash("sha256").update(JSON.stringify(rootTools)).digest("hex") };
    await writeFile(join(folder, "all-transcripts.json"), JSON.stringify(transcripts, null, 2));
    await writeFile(join(folder, "submissions.json"), JSON.stringify(submissions, null, 2));
    await writeFile(join(folder, "observations.json"), JSON.stringify(observation, null, 2));
    observations.push(observation); console.log(JSON.stringify(observation));
  } finally { await storage.close(ctx); }
}
await writeFile(join(directory, "observations.json"), JSON.stringify(observations, null, 2));
