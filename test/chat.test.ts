import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ChatSession, runChat, type ChatEvent } from "../src/chat.js";
import { createClient } from "../src/client.js";
import { ensureDaemon } from "../src/daemon.js";
import { serve } from "../src/server.js";
import { demoFixture, hasTool, until } from "./helpers.js";

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

async function chatFixture(delayMs = 0) {
  const f = await demoFixture();
  const faux = fauxProvider({ provider: "chat-test", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 32 }, () => async (context, options) => {
    if (delayMs) await setTimeout(delayMs, undefined, { signal: options?.signal });
    if (context.messages.some(m => m.role === "system" && m.toolsAdded?.some(t => t.name === "review_result"))) {
      return fauxAssistantMessage(fauxToolCall("review_result", { verdict: "pass", reason: "The text answer satisfies the user request.", evidence: [] }), { stopReason: "toolUse" });
    }
    if (hasTool(context, "task_prepare")) return fauxAssistantMessage(fauxToolCall("task_prepare", {
      outcome: "记住并回答代号", deliverables: ["终端答复"], inputs: ["用户的代号"], criteria: [{ text: "回答包含正确代号", method: "inspect" }],
      scope: ["仅在本次对话答复"], assumptions: [], questions: [], checks: [],
    }), { stopReason: "toolUse" });
    const users = context.messages.filter(m => m.role === "user" && !(typeof m.content === "string" && m.content.startsWith("USER_CONFIRMED_BRIEF")));
    const text = users.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    const code = /CODE_\d+/.exec(text)?.[0];
    return fauxAssistantMessage(fauxToolCall("task_submit", { summary: users.length > 1 ? `记得：${code ?? "没有代号"}` : `已记住 ${code ?? "新任务"}`, artifacts: [], criteria: [{ id: 1, status: "passed", evidence: `答复包含 ${code}` }] }), { stopReason: "toolUse" });
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const config = { ...f.config, port: await freePort(), model: { provider: "chat-test", modelId: "scripted" } };
  const server = await serve(config, { models });
  const client = createClient(config);
  return { ...f, config, server, client, async close() { await server.close(); await f.close(); } };
}

test("terminal messages retain context and slash commands select and control tasks", async () => {
  const f = await chatFixture();
  const events: ChatEvent[] = [];
  const chat = new ChatSession(f.client, event => events.push(event));
  try {
    await chat.handle("记住代号 CODE_17");
    const id = chat.taskId!;
    await until(async () => { await chat.poll(); return events; }, values => values.some(e => e.text.includes("（待确认）")));
    await chat.handle("确认开始");
    await until(async () => { await chat.poll(); return events; }, values => values.some(e => e.kind === "answer" && e.text === "已记住 CODE_17"));
    await chat.handle("刚才的代号是什么？");
    await until(async () => { await chat.poll(); return events; }, values => values.some(e => e.text === "记得：CODE_17"));
    assert.equal(chat.taskId, id);
    assert.equal((await f.server.runtime.list()).length, 1);
    const answerCount = events.filter(e => e.kind === "answer").length;
    await chat.poll(); await chat.poll();
    assert.equal(events.filter(e => e.kind === "answer").length, answerCount);
    await chat.handle("/status");
    assert.ok(events.some(e => e.text.includes("输出目录：")));
    await chat.handle("/pause");
    assert.equal((await f.server.runtime.status(id)).status, "paused");
    await chat.handle("/resume");
    assert.equal((await f.server.runtime.status(id)).status, "completed");
    await chat.handle("/new 新任务 CODE_23");
    assert.notEqual(chat.taskId, id);
    await chat.handle("/tasks");
    await chat.handle(`/attach ${id}`);
    assert.equal(chat.taskId, id);
    await chat.handle("/cancel");
    assert.equal((await f.server.runtime.status(id)).status, "cancelled");
    assert.equal(await chat.handle("/quit"), false);
    assert.equal(await f.client.healthy(), true);
  } finally { await f.close(); }
});

test("readline chat accepts multiple turns and quitting preserves the daemon", async () => {
  const f = await chatFixture();
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", data => { text += String(data); });
  const running = runChat(f.client, { input, output, intervalMs: 20 });
  try {
    input.write("记住 CODE_41\n");
    await until(async () => text, value => value.includes("（待确认）"));
    input.write("确认开始\n");
    await until(async () => text, value => value.includes("Agent > 已记住 CODE_41"));
    input.write("还记得吗？\n");
    await until(async () => text, value => value.includes("Agent > 记得：CODE_41"));
    input.write("/quit\n");
    await running;
    assert.match(text, /已退出聊天/);
    assert.equal((await f.server.runtime.list()).length, 1);
    assert.equal(await f.client.healthy(), true);
  } finally { input.end(); await running; await f.close(); }
});

test("exiting chat during an active response leaves the task running in the background", async () => {
  const f = await chatFixture(250);
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", data => { text += String(data); });
  const running = runChat(f.client, { input, output, intervalMs: 20 });
  try {
    input.write("记住 CODE_55\n");
    await until(async () => text, value => value.includes("（待确认）"));
    input.write("确认开始\n");
    await until(async () => text, value => value.includes("任务说明与预算已确认"));
    const task = (await f.server.runtime.list())[0]!;
    input.write("/quit\n");
    await running;
    await until(() => f.server.runtime.status(task.id), status => status.status === "completed");
    assert.equal(await f.client.healthy(), true);
  } finally { input.end(); await running; await f.close(); }
});

test("chat starts a separate daemon when needed and reuses the existing one", { timeout: 25_000 }, async () => {
  const f = await demoFixture();
  let pid: number | undefined;
  const config = { ...f.config, port: await freePort(), model: undefined };
  const file = join(f.directory, "config.json");
  try {
    await writeFile(file, JSON.stringify(config));
    const connection = await ensureDaemon(config, file);
    pid = connection.pid;
    assert.equal(connection.started, true);
    assert.ok(pid);
    assert.equal(await createClient(config).healthy(), true);
    assert.equal((await ensureDaemon(config, file)).started, false);
  } finally {
    if (pid) {
      process.kill(pid, "SIGTERM");
      await until(async () => access(`${f.directory}.lock`).then(() => true, () => false), exists => !exists);
    }
    await f.close();
  }
});
