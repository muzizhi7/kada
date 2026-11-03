import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxToolCall, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { LocalRuntime } from "../src/runtime.js";
import { taskView } from "../src/task-view.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const users = (c: TranscriptContext) => c.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
function hasGoalDocument(directory: string, id: string) {
  const db = new DatabaseSync(join(directory, "tasks", id, "session.sqlite"), { readOnly: true });
  try { return Boolean(db.prepare("SELECT 1 FROM documents WHERE kind = ?").get(JSON.stringify("local.goal"))); }
  finally { db.close(); }
}

test("ordinary five-turn conversation and dismissal return answers without creating or supervising a Goal", async () => {
  let requests = 0;
  const f = await scriptedFixture(c => {
    requests++;
    for (const name of ["write", "edit", "bash", "delegate", "task_status", "task_submit"]) assert(!hasTool(c, name), name);
    assert(hasTool(c, "read"));
    assert(hasTool(c, "task_prepare"));
    return fauxAssistantMessage(users(c).at(-1) === "不用了,退下吧" ? "好的，有需要再叫我。" : `回答第 ${users(c).length} 条消息`);
  });
  try {
    const task = await f.runtime.create("你了解我吗", f.workspace, [], { chat: true });
    for (const [index, message] of ["你了解我吗", "你可以猜测我的背景", "产品经理,AI agnet", "自己做的Agent产品,\n需要", "不用了,退下吧"].entries()) {
      if (index) await f.runtime.followUp(task.id, message, `turn-${index}`);
      const status = await until(() => f.runtime.status(task.id), s => s.status === "answered");
      assert.equal(status.goal, undefined);
      assert.equal(status.workerCount, 0);
      const view = taskView(status);
      assert.equal(view.interaction, "chat");
      assert.equal(view.brief, null);
      assert.equal(view.delivery, null);
      assert.equal(view.reply?.text, index === 4 ? "好的，有需要再叫我。" : `回答第 ${index + 1} 条消息`);
    }
    await setTimeout(250);
    assert.equal(requests, 5, "natural answers must never trigger supervisor retries");
    await assert.rejects(f.runtime.confirm(task.id, 1, "a".repeat(64)), /No task brief/);
    assert.equal(hasGoalDocument(f.directory, task.id), false, "polling, replies and invalid confirmation must not allocate GoalDoc");
  } finally { await f.close(); }
});

test("ordinary chat survives restart and idle time, keeps context and deduplicates follow-ups", async () => {
  let requests = 0;
  const f = await scriptedFixture(c => { requests++; return fauxAssistantMessage(users(c).join(" / ")); }, { maxDurationMs: 500 });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("记住 CODE_29", f.workspace, [], { chat: true });
    await until(() => f.runtime.status(task.id), s => s.status === "answered");
    await f.runtime.close();
    await setTimeout(550);
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    assert.equal(requests, 1);
    assert.equal((await reopened.status(task.id)).status, "answered");
    await reopened.followUp(task.id, "还记得吗？", "repeat-safe");
    const status = await until(() => reopened!.status(task.id), s => s.status === "answered");
    await reopened.followUp(task.id, "还记得吗？", "repeat-safe");
    assert.equal(requests, 2);
    assert.equal(status.goal, undefined);
    assert.match(taskView(status).reply!.text, /CODE_29.*还记得吗/);
    assert.equal(hasGoalDocument(f.directory, task.id), false);
  } finally { await reopened?.close(); await f.close(); }
});

test("a substantive request upgrades the same Pi conversation and retains confirmation and real file verification", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_submit")) {
      if (!c.messages.some(m => m.role === "toolResult" && m.toolName === "write")) return call("write", { path: "result.txt", content: "实际交付" });
      return call("task_submit", { summary: "已交付 result.txt", artifacts: ["result.txt"], criteria: [{ id: 1, status: "passed", evidence: "实际读取内容并核对" }] });
    }
    if (users(c).at(-1) === "帮我整理资料并保存 result.txt") return call("task_prepare", {
      outcome: "整理资料并保存结果", deliverables: ["result.txt"], inputs: [], criteria: [{ text: "内容准确", method: "inspect" }],
      scope: ["仅写入当前工作区"], assumptions: [], questions: [], checks: [{ type: "file_contains", path: "result.txt", text: "实际交付" }],
      budget: { maxEstimatedCostUsd: .25, maxDurationMs: 20_000 },
    });
    return fauxAssistantMessage("你好，可以直接聊。");
  });
  try {
    const task = await f.runtime.create("你好", f.workspace, [], { chat: true });
    const first = await until(() => f.runtime.status(task.id), s => s.status === "answered");
    const conversationId = first.conversations[0]!.id;
    await f.runtime.followUp(task.id, "帮我整理资料并保存 result.txt");
    const ready = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    assert.equal(ready.goal?.objective, "帮我整理资料并保存 result.txt");
    assert.equal(taskView(ready).objective, "帮我整理资料并保存 result.txt");
    assert.equal((await f.runtime.list())[0]?.objective, "帮我整理资料并保存 result.txt");
    assert.equal(ready.goal?.reworks, 0);
    await assert.rejects(readFile(join(f.workspace, "result.txt")));
    assert.equal(ready.conversations[0]!.id, conversationId);
    assert.equal(hasGoalDocument(f.directory, task.id), true);
    await f.runtime.confirm(task.id, ready.goal!.brief!.revision, ready.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(done.interaction, "goal");
    assert.equal(done.conversations.length, 1);
    assert.equal(done.goal?.reworks, 0);
    assert.equal(done.goal?.confirmation?.revision, 1);
    assert.equal(await readFile(join(f.workspace, "result.txt"), "utf8"), "实际交付");
    assert.deepEqual(taskView(done).delivery?.artifacts, ["result.txt"]);
  } finally { await f.close(); }
});

test("native reads and source-bound user memory work in ordinary chats without Goal state", async () => {
  let requests = 0;
  const f = await scriptedFixture(c => {
    requests++;
    assert(hasTool(c, "user_remember"));
    if (!c.messages.some(m => m.role === "toolResult" && m.toolName === "read")) return call("read", { path: "note.txt" });
    if (!c.messages.some(m => m.role === "toolResult" && m.toolName === "user_remember")) return call("user_remember", { facts: [{
      text: "用户是产品经理", category: "work", scope: "global", certainty: "stated",
      evidence: [{ sourceId: "user", quote: "我是产品经理" }],
    }] });
    assert(!c.messages.some(m => m.role === "toolResult" && m.isError));
    return fauxAssistantMessage("你是产品经理，资料已读到。");
  });
  // Use a synthetic home; neither discovery nor model requests access the real profile.
  const home = join(f.directory, "synthetic-home");
  await mkdir(home);
  await writeFile(join(f.workspace, "note.txt"), "测试资料");
  await f.runtime.close();
  const runtime = new LocalRuntime({ ...f.settings, discovery: true }, { models: f.models, discovery: { home } });
  try {
    const task = await runtime.create("我是产品经理，请读 note.txt 并记住我的工作", f.workspace, [], { chat: true });
    const status = await until(() => runtime.status(task.id), s => s.status === "answered");
    await setTimeout(200);
    assert.equal(status.goal, undefined);
    assert.equal(requests, 3);
    assert.equal(hasGoalDocument(f.directory, task.id), false);
    const memory = JSON.parse(await readFile(join(f.directory, "local-context/user-memory.json"), "utf8"));
    assert(memory.facts.some((fact: { text: string }) => fact.text === "用户是产品经理"));
  } finally { await runtime.close(); await f.close(); }
});

test("conversation budgets survive recovery and refill only on explicit resume without creating a Goal", async () => {
  let requests = 0;
  const f = await scriptedFixture(() => { requests++; return fauxAssistantMessage("普通答复"); }, { maxTotalTokens: 1 });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("你好", f.workspace, [], { chat: true });
    const limited = await until(() => f.runtime.status(task.id), s => s.status === "budget_limited");
    assert.equal(limited.goal, undefined);
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    assert.equal((await reopened.status(task.id)).status, "budget_limited");
    await assert.rejects(reopened.followUp(task.id, "继续聊"), /resume it first/);
    assert.equal(requests, 1);
    await reopened.resume(task.id);
    const resumed = await reopened.status(task.id);
    assert.equal(resumed.budget.tokenLimit, limited.budget.totalTokens + 1);
    await reopened.followUp(task.id, "继续聊");
    await until(() => reopened!.status(task.id), s => s.status === "budget_limited");
    assert.equal(requests, 2);
    assert.equal(hasGoalDocument(f.directory, task.id), false);
  } finally { await reopened?.close(); await f.close(); }
});
