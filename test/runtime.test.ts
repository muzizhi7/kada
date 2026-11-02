import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { LocalRuntime } from "../src/runtime.js";
import { demoFixture, until } from "./helpers.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

test("Pi delegates to two isolated conversations, writes artifacts, and verifies the report", async () => {
  const f = await demoFixture();
  try {
    const task = await f.runtime.create("Complete the offline demonstration.", f.workspace);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.workerCount, 2);
    assert.equal(status.conversations.length, 4);
    assert.equal(status.goal?.verification?.result.verdict, "pass");
    assert.equal(status.tasks.length, 0);
    const report = await readFile(join(f.workspace, "report.md"), "utf8");
    assert.match(report, /Alpha source/);
    assert.match(report, /Beta source/);
    assert.equal(status.messages.filter(m => m.role === "toolResult" && m.toolName === "delegate").length, 1);
    await f.runtime.close();
    const reopened = new LocalRuntime(f.config, { models: f.models });
    try {
      await reopened.recover();
      assert.equal((await reopened.status(task.id)).status, "completed");
      assert.equal((await reopened.status(task.id)).conversations.length, 4);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("pause survives reopening and resume reuses the same child conversations", async () => {
  const f = await demoFixture(100);
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Complete the offline demonstration.", f.workspace);
    const before = await until(() => f.runtime.status(task.id), s => s.conversations.length === 3);
    const ids = before.conversations.filter(c => c.owner).map(c => c.id);
    await f.runtime.pause(task.id);
    assert.equal((await f.runtime.status(task.id)).status, "paused");
    await f.runtime.close();
    reopened = new LocalRuntime(f.config, { models: f.models });
    await reopened.recover();
    await setTimeout(150);
    assert.equal((await reopened.status(task.id)).status, "paused");
    await reopened.resume(task.id);
    const after = await until(() => reopened!.status(task.id), s => s.status === "completed");
    assert.deepEqual(after.conversations.filter(c => c.owner).map(c => c.id), ids);
  } finally { await reopened?.close(); await f.close(); }
});

test("cancellation stops owned workers and a cancelled task cannot restart", async () => {
  const f = await demoFixture(150);
  try {
    const task = await f.runtime.create("Complete the offline demonstration.", f.workspace);
    await until(() => f.runtime.status(task.id), s => s.conversations.length === 3);
    await f.runtime.cancel(task.id);
    const status = await f.runtime.status(task.id);
    assert.equal(status.status, "cancelled");
    assert.equal(status.tasks.length, 0);
    await assert.rejects(() => f.runtime.resume(task.id), /Cancelled/);
  } finally { await f.close(); }
});

test("wall-time limit persists and reopening does not silently replenish it", async () => {
  const f = await demoFixture(100, 60);
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Complete the offline demonstration.", f.workspace);
    await until(() => f.runtime.status(task.id), s => s.status === "budget_limited");
    await f.runtime.close();
    reopened = new LocalRuntime({ ...f.config, maxDurationMs: 30_000 }, { models: f.models });
    await reopened.recover();
    assert.equal((await reopened.status(task.id)).status, "budget_limited");
    await reopened.resume(task.id);
    await until(() => reopened!.status(task.id), s => s.status === "completed");
  } finally { await reopened?.close(); await f.close(); }
});

test("explicit resume of a failed run admits a continuation with the saved history", async () => {
  const f = await demoFixture();
  const faux = fauxProvider({ provider: "failure-test", models: [{ id: "scripted" }] });
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid_request_error" })]);
  const models = createModels(); models.setProvider(faux.provider);
  const runtime = new LocalRuntime({ ...f.config, model: { provider: "failure-test", modelId: "scripted" } }, { models });
  try {
    const task = await runtime.create("Recover this task after a model error.", f.workspace);
    await until(() => runtime.status(task.id), s => s.status === "failed");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_submit", { summary: "Recovered using saved history.", artifacts: [] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("review_result", { verdict: "pass", reason: "Recovered task answered.", evidence: [] }), { stopReason: "toolUse" }),
    ]);
    await runtime.resume(task.id);
    const status = await until(() => runtime.status(task.id), s => s.status === "completed");
    assert.ok(status.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Resume the original objective")));
  } finally { await runtime.close(); await f.close(); }
});
