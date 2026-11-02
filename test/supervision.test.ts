import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { LocalRuntime } from "../src/runtime.js";
import type { Config } from "../src/config.js";
import { acceptanceChecks, checkArtifacts } from "../src/checks.js";
import { Workspace } from "../src/workspace.js";
import { demoFixture, until } from "./helpers.js";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (c: TranscriptContext, name: string) => c.messages.filter(m => m.role === "toolResult" && m.toolName === name && !m.isError);
const tools = (c: TranscriptContext) => c.messages.flatMap(m => m.role === "system" ? m.toolsAdded?.map(t => t.name) ?? [] : []);
const reviewer = (c: TranscriptContext) => tools(c).includes("review_result");
const users = (c: TranscriptContext) => c.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
function review(c: TranscriptContext, verdict: "pass" | "rework" = "pass", reason = "Actual artifacts meet the original objective.") {
  assert.deepEqual(tools(c).sort(), ["list_files", "read_file", "review_result"]);
  const payload = JSON.parse(users(c)[0]!);
  const files: string[] = payload.mechanical.files.map((f: { path: string }) => f.path);
  const reads = results(c, "read_file").length;
  if (reads < files.length) return call("read_file", { path: files[reads]! });
  return call("review_result", { verdict, reason, evidence: files });
}
async function fixture(respond: (c: TranscriptContext, signal?: AbortSignal) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>, config: Partial<Config> = {}) {
  const f = await demoFixture();
  const faux = fauxProvider({ provider: "supervision-test", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 256 }, () => (c, options) => respond(c, options?.signal)));
  const models = createModels(); models.setProvider(faux.provider);
  const settings = { ...f.config, ...config, model: { provider: "supervision-test", modelId: "scripted" } };
  const runtime = new LocalRuntime(settings, { models });
  return { ...f, runtime, settings, models, async close() { await runtime.close(); await f.close(); } };
}

test("bare completion claims are rejected and identical failures stop without client polling", async () => {
  let calls = 0;
  let cooperate = false;
  const f = await fixture(c => { calls++; return cooperate ? reviewer(c) ? review(c) : call("task_submit", { summary: "Revised text answer.", artifacts: [] }) : fauxAssistantMessage("Everything is done."); });
  try {
    const task = await f.runtime.create("Produce a report with real evidence.", f.workspace);
    // Supervision runs without GET/status driving it.
    await setTimeout(900);
    const status = await f.runtime.status(task.id);
    assert.equal(status.status, "needs_attention");
    assert.equal(status.goal?.verification, null);
    assert.equal(status.goal?.stalls, 2);
    const count = calls;
    await setTimeout(300);
    assert.equal(calls, count);
    assert.equal((await f.runtime.list())[0]?.status, "needs_attention");
    cooperate = true;
    await f.runtime.resume(task.id);
    const resumed = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(resumed.goal?.epoch, 2);
  } finally { await f.close(); }
});

test("missing files and incorrect JSON are repaired before independent review can accept", async () => {
  const f = await fixture(c => {
    if (reviewer(c)) return review(c);
    const attempts = users(c).filter(t => t.includes("SUPERVISOR_REWORK")).length;
    const writes = results(c, "write").length;
    if (attempts > writes) return call("write", { path: "result.json", content: JSON.stringify({ total: attempts === 1 ? 0 : 71 }) });
    return call("task_submit", { summary: "The total is 71, saved in result.json.", artifacts: ["result.json"] });
  });
  try {
    const task = await f.runtime.create("Save total 71 in result.json.", f.workspace, [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.goal?.reworks, 2);
    assert.equal(status.goal?.checks[0]?.source, "user");
    assert.match(status.goal?.events.find(e => e.type === "rejected" && e.detail.includes("expected 71"))?.detail ?? "", /got 0/);
    assert.equal(status.conversations.filter(c => !c.owner).length, 2);
    assert.match(status.goal?.mechanical?.files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")).total, 71);
  } finally { await f.close(); }
});

test("read-only semantic review rejects an omitted user requirement and validates the repair", async () => {
  const f = await fixture(c => {
    if (reviewer(c)) {
      const content = results(c, "read_file").flatMap(m => m.content).filter(b => b.type === "text").map(b => b.text).join("\n");
      return review(c, content.includes("Sources:") ? "pass" : "rework", content.includes("Sources:") ? "Report includes the required source explanation." : "The report omits the source explanation requested by the user.");
    }
    const writes = results(c, "write").length;
    const retry = users(c).some(t => t.includes("SUPERVISOR_REWORK"));
    if (!writes || (retry && writes === 1)) return call("write", { path: "report.md", content: retry ? "# Report\nTotal: 71\nSources: alpha and beta.\n" : "# Report\nTotal: 71\n" });
    return call("task_submit", { summary: "Report ready.", artifacts: ["report.md"] });
  });
  try {
    const task = await f.runtime.create("Produce report.md with the total AND a source explanation.", f.workspace, [{ type: "file_contains", path: "report.md", text: "Total: 71" }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.goal?.reworks, 1);
    assert.equal(status.conversations.filter(c => !c.owner).length, 3);
    assert.ok(status.goal?.events.some(e => e.type === "rejected" && e.detail.includes("omits the source")));
  } finally { await f.close(); }
});

test("plan state and append-only checks survive revisions; completed work is retained", async () => {
  const f = await fixture(c => {
    if (reviewer(c)) return review(c);
    if (!results(c, "task_plan").length) return call("task_plan", { steps: [{ id: "report", title: "Write report" }], checks: [{ type: "file_contains", path: "report.md", text: "Evidence" }] });
    if (!results(c, "write").length) return call("write", { path: "report.md", content: "Evidence: both sources inspected." });
    if (!results(c, "task_checkpoint").length) return call("task_checkpoint", { stepId: "report", status: "done", evidence: "report.md written from inputs" });
    if (results(c, "task_plan").length === 1) return call("task_plan", { steps: [{ id: "report", title: "Verify report" }], checks: [] });
    return call("task_submit", { summary: "Evidence saved.", artifacts: ["report.md"] });
  });
  try {
    const task = await f.runtime.create("Write an evidence report.", f.workspace, [{ type: "file_exists", path: "report.md" }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.goal?.checks.length, 2);
    assert.equal(status.goal?.plan[0]?.status, "done");
    assert.equal(status.goal?.plan[0]?.title, "Verify report");
    assert.equal(status.goal?.verification?.result.verdict, "pass");
    for (const result of status.messages.filter(m => m.role === "toolResult" && ["task_plan", "task_checkpoint"].includes(m.toolName))) {
      assert.ok(JSON.stringify(result.content).length < 512, "Progress acknowledgements must not echo the growing goal/event history");
    }
  } finally { await f.close(); }
});

test("waiting for user input resumes the same goal and duplicate request IDs do not resubmit", async () => {
  let requests = 0;
  const f = await fixture(c => {
    if (reviewer(c)) return review(c);
    requests++;
    if (users(c).length === 1) return call("task_blocked", { reason: "Need the reporting quarter.", question: "Which quarter should I use?" });
    return call("task_submit", { summary: users(c).at(-1)?.includes("Q3") ? "Use Q3." : "Use Q2.", artifacts: [] });
  });
  try {
    const task = await f.runtime.create("Confirm the selected quarter.", f.workspace);
    const waiting = await until(() => f.runtime.status(task.id), s => s.status === "waiting_user");
    assert.match(waiting.goal?.question ?? "", /Which quarter/);
    await f.runtime.followUp(task.id, "Use Q2.", "quarter-answer");
    await f.runtime.followUp(task.id, "Use Q2.", "quarter-answer");
    const completed = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(completed.goal?.revision, 2);
    assert.equal(requests, 2);
    await f.runtime.followUp(task.id, "Use Q2.", "quarter-answer");
    assert.equal((await f.runtime.status(task.id)).goal?.revision, 2);
    await f.runtime.followUp(task.id, "Use Q3 instead.", "quarter-revision");
    const revised = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(revised.goal?.revision, 3);
    assert.equal(revised.goal?.candidate?.summary, "Use Q3.");
    assert.notEqual(revised.goal?.verification?.reviewer, completed.goal?.verification?.reviewer);
  } finally { await f.close(); }
});

test("files changed during review cannot inherit an earlier passing verdict", async () => {
  let changed = false;
  let target = "";
  const f = await fixture(async c => {
    if (reviewer(c)) {
      if (results(c, "read_file").length && !changed) { await writeFile(target, '{"total":0}'); changed = true; }
      return review(c);
    }
    const retries = users(c).filter(t => t.includes("SUPERVISOR_REWORK")).length;
    if (results(c, "write").length <= retries) return call("write", { path: "result.json", content: '{"total":71}' });
    return call("task_submit", { summary: "Total 71.", artifacts: ["result.json"] });
  });
  target = join(f.workspace, "result.json");
  try {
    const task = await f.runtime.create("Save total 71.", f.workspace, [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }]);
    const completed = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(completed.goal?.reworks, 1);
    assert.ok(completed.goal?.events.some(e => e.type === "rejected" && e.detail.includes("changed or checks failed")));
  } finally { await f.close(); }
});

test("pausing a live reviewer preserves identity and cancellation stops an ownerless reviewer", async () => {
  let hold = true;
  const f = await fixture(async (c, signal) => {
    if (reviewer(c)) { if (hold) await setTimeout(60_000, undefined, { signal }); return review(c); }
    return call("task_submit", { summary: "A text answer for review.", artifacts: [] });
  });
  try {
    const task = await f.runtime.create("Return a text answer.", f.workspace);
    const before = await until(() => f.runtime.status(task.id), s => s.status === "verifying" && !!s.goal?.review && s.tasks.length > 0);
    await f.runtime.pause(task.id);
    assert.equal((await f.runtime.status(task.id)).status, "paused");
    hold = false;
    await f.runtime.resume(task.id);
    const after = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(after.goal?.verification?.reviewer, before.goal?.review?.conversationId);
    hold = true;
    const second = await f.runtime.create("Another answer.", f.workspace);
    await until(() => f.runtime.status(second.id), s => !!s.goal?.review && s.tasks.length > 0);
    await f.runtime.cancel(second.id);
    const cancelled = await f.runtime.status(second.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.tasks.length, 0);
  } finally { await f.close(); }
});

test("token budget is persistent, includes the coordinator and requires explicit replenishment", async () => {
  const f = await fixture(c => reviewer(c) ? review(c) : call("task_submit", { summary: "Text answer.", artifacts: [] }), { maxTotalTokens: 1 });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Give a text answer.", f.workspace);
    const limited = await until(() => f.runtime.status(task.id), s => s.status === "budget_limited");
    assert.equal(limited.goal?.tokenLimit, 1);
    assert.ok(limited.usage.models["supervision-test/scripted"]!.totalTokens > 1);
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    assert.equal((await reopened.status(task.id)).status, "budget_limited");
    await reopened.resume(task.id);
    const replenished = await reopened.status(task.id);
    assert.ok(replenished.goal!.tokenLimit > limited.goal!.tokenLimit);
  } finally { await reopened?.close(); await f.close(); }
});

test("checker handles JSON Pointer escaping and rejects unsafe or nonmatching predicates", async () => {
  const f = await demoFixture();
  try {
    const workspace = await Workspace.open(f.workspace);
    await writeFile(join(f.workspace, "sample.json"), JSON.stringify({ "a/b": { "~x": [false, null] } }));
    const checks = acceptanceChecks([{ type: "json_value", path: "sample.json", pointer: "/a~1b/~0x/0", equals: false }, { type: "json_value", path: "sample.json", pointer: "/a~1b/~0x/1", equals: null }]);
    assert.equal((await checkArtifacts(workspace, ["sample.json"], checks)).passed, true);
    assert.equal((await checkArtifacts(workspace, ["../outside"], [])).passed, false);
    assert.equal((await checkArtifacts(workspace, [], [{ type: "json_value", path: "sample.json", pointer: "/missing", equals: null }])).passed, false);
    assert.throws(() => acceptanceChecks([{ type: "shell", path: "sample.json", command: "echo ok" }]));
    assert.throws(() => acceptanceChecks([{ type: "json_value", path: "sample.json", pointer: "invalid", equals: null }]));
  } finally { await f.close(); }
});
