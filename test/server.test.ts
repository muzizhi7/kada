import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "../src/server.js";
import { demoFixture, until } from "./helpers.js";
import { hasTool, scriptedFixture } from "./helpers.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createClient } from "../src/client.js";

test("chat API returns a normal reply, rejects ambiguous flags and never creates a Goal", async () => {
  const f = await scriptedFixture(() => fauxAssistantMessage("可以直接聊天。"));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...f.settings, port };
  const server = await serve(settings, { models: f.models });
  const client = createClient(settings);
  try {
    await assert.rejects(client.request("/v1/tasks", "POST", { objective: "你好", mode: "other" }), /mode must be chat/);
    await assert.rejects(client.request("/v1/tasks", "POST", { objective: "你好", mode: "chat", confirmed: true }), /cannot preconfirm/);
    await assert.rejects(client.request("/v1/tasks", "POST", { objective: "你好", mode: "chat", acceptance: [{ type: "file_exists", path: "x" }] }), /explicit task/);
    assert.equal((await server.runtime.list()).length, 0);
    const task = await client.request<{ id: string }>("/v1/tasks", "POST", { objective: "你好", mode: "chat" });
    await until(() => server.runtime.status(task.id), s => s.status === "answered");
    const view = await client.request<{ interaction: string; reply: { text: string }; brief: unknown; delivery: unknown }>(`/v1/tasks/${task.id}/view`);
    assert.equal(view.interaction, "chat");
    assert.equal(view.reply.text, "可以直接聊天。");
    assert.equal(view.brief, null);
    assert.equal(view.delivery, null);
    assert.equal((await server.runtime.status(task.id)).goal, undefined);
  } finally { await server.close(); await f.close(); }
});

test("daemon requires its token, rejects cross-origin mutation, and reports missing model configuration", async () => {
  const f = await demoFixture();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const server = await serve({ ...f.config, port, model: undefined });
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/tasks`)).status, 401);
    const token = (await readFile(join(f.directory, "token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/v1/tasks`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: JSON.stringify({ objective: "work" }) })).status, 403);
    const response = await fetch(`${base}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ objective: "work" }) });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /No model configured/);
  } finally { await server.close(); await f.close(); }
});

test("default API creation requires confirmation of the current brief; plain messages and malformed flags cannot authorize execution", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return fauxAssistantMessage(fauxToolCall("task_prepare", {
      outcome: "生成 result.txt", deliverables: ["result.txt"], inputs: [], criteria: [{ text: "结果文件可读", method: "inspect" }],
      scope: ["仅操作工作区"], assumptions: [], questions: [], checks: [{ type: "file_exists", path: "result.txt" }],
      budget: { maxEstimatedCostUsd: .25, maxDurationMs: 20000 },
    }), { stopReason: "toolUse" });
    if (!c.messages.some(m => m.role === "toolResult" && m.toolName === "write")) return fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "actual result" }), { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "结果已保存", artifacts: ["result.txt"], criteria: [{ id: 1, status: "passed", evidence: "实际 result.txt 已核对" }] }), { stopReason: "toolUse" });
  });
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const server = await serve({ ...f.settings, port }, { models: f.models });
  const base = `http://127.0.0.1:${port}`;
  try {
    const token = (await readFile(join(f.directory, "token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const post = (path: string, data: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(data) });
    assert.equal((await post("/v1/tasks", { objective: "生成结果", confirmed: "true" })).status, 400);
    const response = await post("/v1/tasks", { objective: "生成结果", workspace: f.workspace });
    const task = await response.json() as { id: string; preparation: boolean };
    assert.equal(response.status, 201); assert.equal(task.preparation, true);
    const first = await until(() => server.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await assert.rejects(readFile(join(f.workspace, "result.txt")));
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/confirm`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await post(`/v1/tasks/${task.id}/confirm`, { revision: 1 })).status, 400);
    await post(`/v1/tasks/${task.id}/messages`, { message: "确认", requestId: "message-not-approval" });
    const updated = await until(() => server.runtime.status(task.id), s => s.status === "awaiting_confirmation" && s.goal?.brief?.revision === 2);
    assert.equal(updated.goal?.confirmation, undefined, "the model or ordinary message endpoint cannot manufacture confirmation");
    assert.equal((await post(`/v1/tasks/${task.id}/confirm`, { revision: 1, digest: first.briefDigest })).status, 400);
    assert.equal((await post(`/v1/tasks/${task.id}/confirm`, { revision: 2, digest: updated.briefDigest })).status, 200);
    const done = await until(() => server.runtime.status(task.id), s => s.status === "completed");
    assert.equal(done.budget.costLimit, .25);
    assert.equal(await readFile(join(f.workspace, "result.txt"), "utf8"), "actual result");
  } finally { await server.close(); await f.close(); }
});

test("task API validates immutable checks and exposes independently verified status", async () => {
  const f = await demoFixture();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const server = await serve({ ...f.config, port }, { models: f.models });
  const base = `http://127.0.0.1:${port}`;
  try {
    const token = (await readFile(join(f.directory, "token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const invalid = await fetch(`${base}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ objective: "demo", acceptance: [{ type: "shell", path: "." }] }) });
    assert.equal(invalid.status, 400);
    const acceptance = [{ type: "file_contains", path: "report.md", text: "Alpha source" }];
    const response = await fetch(`${base}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ objective: "Complete the two-worker demo.", workspace: f.workspace, acceptance, confirmed: true }) });
    assert.equal(response.status, 201);
    const task = await response.json() as { id: string; acceptance: unknown };
    assert.deepEqual(task.acceptance, acceptance);
    await until(() => server.runtime.status(task.id), s => s.status === "completed");
    const listing = await (await fetch(`${base}/v1/tasks`, { headers })).json() as { status: string }[];
    assert.equal(listing[0]?.status, "completed");
    const detail = await (await fetch(`${base}/v1/tasks/${task.id}`, { headers })).json() as { goal: { verification: { result: { verdict: string } } } };
    assert.equal(detail.goal.verification.result.verdict, "pass");
  } finally { await server.close(); await f.close(); }
});
