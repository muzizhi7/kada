import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { serve } from "../src/server.js";
import { demoFixture, scriptedFixture, until } from "./helpers.js";
import { setTimeout } from "node:timers/promises";
import { Type, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type JsonObject } from "@earendil-works/pi-durable";
import { ChatSession, type ChatEvent } from "../src/chat.js";
import { createClient } from "../src/client.js";
import type { TaskView } from "../src/task-view.js";

test("desktop delivery projection keeps confirmation/budget semantics and excludes transcripts, proofs and unverified candidates", async () => {
  const f = await demoFixture(80);
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const server = await serve({ ...f.config, port }, { models: f.models });
  const base = `http://127.0.0.1:${port}`;
  try {
    const task = await server.runtime.create("Complete the existing two-worker demo.", f.workspace);
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/view`)).status, 401);
    const token = (await readFile(join(f.directory, "token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}` };
    const pending = await fetch(`${base}/v1/tasks/${task.id}/view`, { headers });
    const first = await pending.json() as Record<string, unknown>;
    assert.equal(pending.status, 200);
    assert.equal(first.delivery, null);
    for (const key of ["messages", "tasks", "conversations", "usage", "goal", "proofs"]) assert.equal(key in first, false, key);
    assert.deepEqual(first.resumeBudget, { maxEstimatedCostUsd: 1, maxDurationMs: f.config.maxDurationMs, maxTotalTokens: null });
    await until(() => server.runtime.status(task.id), value => value.status === "completed");
    const completed = await (await fetch(`${base}/v1/tasks/${task.id}/view`, { headers })).json() as {
      status: string; delivery: { artifacts: string[]; verification: string }; budget: { costLimit: number };
    };
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.delivery.artifacts, ["report.md"]);
    assert.match(completed.delivery.verification, /独立模型复核：通过/);
    assert.equal(completed.budget.costLimit, 1);
  } finally { await server.close(); await f.close(); }
});

test("task progress follows live Pi tools and saved steps across terminal reattachment", async () => {
  let entered = false, released = false;
  let question = "交付到哪个目录？";
  const gate = defineTool({
    name: "archive_documents", description: "Build the requested archive.",
    parameters: Type.Object({ internal: Type.String() }), replay: "safe",
    execute: async (_args, _api, context) => {
      entered = true;
      while (!released) await setTimeout(20, undefined, { signal: context.abortSignal });
      return { output: [{ type: "text", text: "Archive ready." }] };
    },
  });
  const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const f = await scriptedFixture(context => {
    const results = context.messages.filter(message => message.role === "toolResult");
    if (!results.some(result => result.toolName === "task_plan")) return call("task_plan", {
      steps: [{ id: "collect", title: "整理资料" }, { id: "archive", title: "生成压缩包" }],
    });
    const checkpoints = results.filter(result => result.toolName === "task_checkpoint").length;
    if (checkpoints === 0) return call("task_checkpoint", { stepId: "collect", status: "done", evidence: "原件已核对" });
    if (checkpoints === 1) return call("task_checkpoint", { stepId: "archive", status: "running", evidence: "开始生成压缩包" });
    if (!results.some(result => result.toolName === "archive_documents")) return call("archive_documents", { internal: "PRIVATE_ARGUMENT_MARKER" });
    if (checkpoints === 2) return call("task_checkpoint", { stepId: "archive", status: "done", evidence: "压缩包已生成" });
    return call("task_blocked", { reason: "需要客户选择接收方式", question });
  }, {}, () => [defineExtension({ name: "archive_progress", tools: [gate] })]);
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const config = { ...f.settings, port };
  const server = await serve(config, { models: f.models, extensions: [defineExtension({ name: "archive_progress", tools: [gate] })] });
  const client = createClient(config);
  const events: ChatEvent[] = [];
  try {
    const task = await server.runtime.create("整理资料并生成压缩包。", f.workspace);
    await until(async () => entered, Boolean);
    const status = await server.runtime.status(task.id);
    assert.deepEqual(status.activeTools.map(tool => ({ name: tool.name, worker: tool.worker })), [{ name: "archive_documents", worker: false }]);
    const running = await client.request<TaskView>("/v1/tasks/" + task.id + "/view");
    assert.equal(running.progress.steps.filter(step => step.status === "done").length, 1);
    assert.equal(running.progress.steps.find(step => step.status === "running")?.title, "生成压缩包");
    assert.deepEqual(running.progress.tools, status.activeTools);
    assert(!JSON.stringify(running.progress).includes("PRIVATE_ARGUMENT_MARKER"));
    const terminal = new ChatSession(client, event => events.push(event));
    await terminal.handle("/attach " + task.id);
    assert(events.some(event => event.text.includes("步骤记录：1/2") && event.text.includes("当前步骤：生成压缩包")));
    assert(events.some(event => event.text.includes("正在执行：archive_documents")));
    const count = events.length;
    await terminal.poll();
    assert.equal(events.length, count);
    assert.equal(await terminal.handle("/quit"), false);
    const reattached: ChatEvent[] = [];
    const nextTerminal = new ChatSession(client, event => reattached.push(event));
    await nextTerminal.handle("/attach " + task.id);
    assert(reattached.some(event => event.text.includes("当前步骤：生成压缩包")));
    await nextTerminal.handle("/status");
    assert(reattached.some(event => event.text.includes("步骤记录：1/2") && event.text.includes("正在执行：archive_documents")));
    released = true;
    await until(() => server.runtime.status(task.id), value => value.status === "waiting_user");
    await nextTerminal.poll();
    assert(reattached.some(event => event.text.includes("交付到哪个目录？")));
    const stopped = await client.request<TaskView>("/v1/tasks/" + task.id + "/view");
    assert.equal(stopped.progress.steps.filter(step => step.status === "done").length, 2);
    assert.deepEqual(stopped.progress.tools, []);
    assert.equal(stopped.question, "交付到哪个目录？");
    question = "使用哪个客户的接收目录？";
    await server.runtime.followUp(task.id, "请确认客户目录。", "choose-customer");
    await until(() => server.runtime.status(task.id), value => value.status === "waiting_user" && value.goal?.question === question);
    await nextTerminal.poll();
    assert(reattached.some(event => event.text.includes(question)));
    await server.close();
    const reopened = await serve(config, { models: f.models, extensions: [defineExtension({ name: "archive_progress", tools: [gate] })] });
    try {
      const recovered = await client.request<TaskView>("/v1/tasks/" + task.id + "/view");
      assert.equal(recovered.question, question);
      assert.deepEqual(recovered.progress, stopped.progress);
    } finally { await reopened.close(); }
  } finally { released = true; await server.close(); await f.close(); }
});
