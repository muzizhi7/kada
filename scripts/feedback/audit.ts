/** Read persisted submission receipts after the study; never resumes a model. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { save } from "../heldout/common.js";

const base = resolve(process.argv[2]!);
const results = JSON.parse(await readFile(join(base, "results.json"), "utf8")) as { directory: string; sequence: number; reworks: number; hostDeclaredComplete: boolean }[];
if (results.length !== 8) throw new Error("Audit only after all eight trials ended");
const audit = [];
for (const result of results) {
  const run = JSON.parse(await readFile(join(result.directory, "run.json"), "utf8")) as { taskId: string };
  const transcript = JSON.parse(await readFile(join(result.directory, "transcript.json"), "utf8")) as { record: { id: ConversationId; owner?: unknown } }[];
  const root = transcript.find(item => !item.record.owner)!.record.id;
  const storage = await openNodeSqliteStorage(join(result.directory, "tasks", run.taskId, "session.sqlite"));
  const requests: { requestId: string; status: string }[] = [];
  try {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ conversationId: root, order: "ascending" }, 200, cursor, ctx);
      for (const item of page.items) if (item.requestId?.startsWith("supervisor:")) requests.push({ requestId: item.requestId, status: item.status });
      cursor = page.next;
    } while (cursor);
  } finally { await storage.close(ctx); }
  audit.push({ sequence: result.sequence, admittedFeedbackMessages: requests.length, scheduledReworks: result.reworks, requests });
}
await save(join(base, "submission-audit.json"), audit);
console.log(JSON.stringify({ trials: audit.length, admittedFeedbackMessages: audit.reduce((sum, item) => sum + item.admittedFeedbackMessages, 0) }));
