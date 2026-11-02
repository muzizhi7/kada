import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UserEntry, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { LocalRuntime } from "../src/runtime.js";
import { goalExtension } from "../src/goal.js";
import { delegationExtension } from "../src/delegation.js";
import { localEnvironment, localExecution } from "../src/execution.js";
import { ChatSession, type ChatEvent } from "../src/chat.js";
import { verificationText } from "../src/presentation.js";
import type { HarnessClient, TaskStatus } from "../src/client.js";
import { scriptedFixture, until } from "./helpers.js";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("new tasks keep optional plans advisory while real user and appended checks still trigger repair", async () => {
  const f = await scriptedFixture(c => {
    const results = c.messages.filter(m => m.role === "toolResult");
    if (!results.some(m => m.toolName === "task_plan")) return call("task_plan", { steps: [{ id: "report", title: "Write report" }], checks: [{ type: "file_contains", path: "report.md", text: "Evidence" }] });
    const repair = c.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("SUPERVISOR_REWORK"));
    if (repair && !results.some(m => m.toolName === "write")) return call("write", { path: "report.md", content: "Evidence: required source content." });
    return call("task_submit", { summary: "Report saved.", artifacts: ["report.md"] });
  });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Save an evidence report.", f.workspace, [{ type: "file_exists", path: "report.md" }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.planPolicy, "advisory");
    assert.equal(status.goal?.reworks, 1, "repair missing output, not the pending plan registration");
    assert.equal(status.goal?.plan[0]?.status, "pending");
    assert.equal(status.goal?.checks.length, 2, "user and agent-added acceptance conditions remain effective");
    assert.equal(status.goal?.mechanical?.results.some(r => r.label === "plan"), false);
    assert.match(status.goal?.mechanical?.notices?.[0] ?? "", /report/);
    assert.equal(status.messages.filter(m => m.role === "toolResult" && m.toolName === "task_checkpoint").length, 0);
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    const after = await reopened.status(task.id);
    assert.equal(after.status, "completed");
    assert.equal(after.planPolicy, "advisory");
    assert.equal(after.goal?.reworks, 1);
    assert.equal(after.goal?.candidate?.id, status.goal?.candidate?.id);
    assert.equal(after.budget.costLimit, status.budget.costLimit, "reopening cannot replenish the budget");
  } finally { await reopened?.close(); await f.close(); }
});

test("a stored v0.3 task without an advisory policy retains its original plan acceptance", async () => {
  const f = await scriptedFixture(c => {
    const results = c.messages.filter(m => m.role === "toolResult");
    if (!results.some(m => m.toolName === "task_plan")) return call("task_plan", { steps: [{ id: "write", title: "Write result" }] });
    if (!results.some(m => m.toolName === "write")) return call("write", { path: "result.json", content: '{"total":71}' });
    const retry = c.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Unfinished steps"));
    if (retry && !results.some(m => m.toolName === "task_checkpoint")) return call("task_checkpoint", { stepId: "write", status: "done", evidence: "result.json contains total71" });
    return call("task_submit", { summary: "Total saved.", artifacts: ["result.json"] });
  });
  try {
    const id = randomUUID(), directory = join(f.directory, "tasks", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "task.json"), JSON.stringify({ id, objective: "Save result.json with total71.", workspace: f.workspace, model: f.settings.model,
      createdAt: Date.now(), deadlineAt: Date.now() + 30_000, maxSubagents: 2, control: "active", schemaVersion: 3, review: false,
      acceptance: [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }] }));
    await f.runtime.recover();
    const status = await until(() => f.runtime.status(id), s => s.status === "completed");
    assert.equal(status.planPolicy, undefined);
    assert.equal(status.goal?.reworks, 1);
    assert.equal(status.goal?.plan[0]?.status, "done");
    assert.ok(status.goal?.events.some(e => e.type === "rejected" && e.detail.includes("Unfinished steps")));
    assert.equal((await f.runtime.metadata(id)).planPolicy, undefined, "no silent history migration");
  } finally { await f.close(); }
});

test("changing advisory plan IDs cannot hide a repeated failed artifact check", async () => {
  const f = await scriptedFixture(c => {
    const results = c.messages.filter(m => m.role === "toolResult");
    const plans = results.filter(m => m.toolName === "task_plan").length;
    const submissions = results.filter(m => m.toolName === "task_submit").length;
    if (plans <= submissions) return call("task_plan", { steps: [{ id: `attempt-${submissions}`, title: "Try a revised plan" }] });
    return call("task_submit", { summary: "Claimed done.", artifacts: ["missing.txt"] });
  }, { maxReworks: 8, maxStalls: 2 });
  try {
    const task = await f.runtime.create("Create missing.txt.", f.workspace, [{ type: "file_exists", path: "missing.txt" }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "needs_attention");
    assert.equal(status.goal?.stalls, 2);
    assert.equal(status.goal?.reworks, 2);
    assert.equal(status.goal?.plan[0]?.id, "attempt-2");
    assert.match(status.goal?.reason ?? "", /missing\.txt/);
    assert.equal(status.goal?.verification, null);
  } finally { await f.close(); }
});

test("compaction totals include superseded root markers and other conversations, remain stable on polling and rebuild on reopen", async () => {
  const f = await scriptedFixture(c => c.messages.some(m => m.role === "system" && JSON.stringify(m).includes("context summarization assistant"))
    ? fauxAssistantMessage("Keep original goal. The confirmed text answer was submitted; preserve completed work.")
    : call("task_submit", { summary: "A text answer.", artifacts: [] }));
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Return a text answer.", f.workspace);
    await until(() => f.runtime.status(task.id), s => s.status === "completed");
    await f.runtime.close();
    const registry = createRegistry(), goal = goalExtension({ advisoryPlan: true });
    const extensions = [localExecution(), goal, delegationExtension(f.workspace, 2, undefined, [goal])];
    for (const extension of extensions) registry.install(extension);
    const storage = await openNodeSqliteStorage(join(f.directory, "tasks", task.id, "session.sqlite"));
    const harness = await Harness.open(storage, { models: f.models, registry, env: () => localEnvironment(f.workspace), settings: { compaction: { enabled: true, keepRecentTokens: 256, backgroundTokens: 0 } } }, ctx);
    try {
      const root = await harness.root(ctx);
      const other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: f.settings.model!, cwd: f.workspace, extensions } }, ctx);
      await harness.commit(async tx => {
        for (let index = 0; index < 240; index++) await tx.appendEntry(root.id, { kind: "test.note", data: { index } });
      }, ctx);
      for (const conversation of [root, root, other]) {
        // A fresh conversation needs an older entry plus a retained tail to compact.
        for (let chunk = 0; chunk < 2; chunk++) {
          const written = await conversation.submit({ type: "write", entry: { kind: UserEntry.kind, model: [{ role: "user", content: "Archived reference material. ".repeat(3000), timestamp: Date.now() }] } }, ctx);
          assert.equal((await written.wait(ctx)).status, "done");
        }
        const compact = await conversation.compact("Keep original goal and completed work.", ctx);
        const result = (await harness.waitForTask(compact, ctx)).state.outcome;
        assert.equal(result.status, "completed");
        assert.ok(result.status === "completed" && result.result.submissionId !== undefined);
        if (result.status === "completed" && result.result.submissionId !== undefined) {
          assert.equal((await (await harness.submission(result.result.submissionId, ctx))!.wait(ctx)).status, "done");
        }
      }
      assert.equal((await root.context(ctx)).entries.filter(e => e.kind === "pi.compaction").length, 1, "visible context is not the cumulative count");
    } finally { await harness.close(ctx); }
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    for (let poll = 0; poll < 3; poll++) {
      const status: TaskStatus = await reopened.status(task.id);
      assert.equal(status.compactions, 3);
      assert.equal(status.rootCompactions, 2);
      assert.equal(status.status, "completed");
      assert.ok(status.contextUsage.estimatedTokens > 0);
      assert.ok(status.contextUsage.estimatedTokens < status.budget.totalTokens, "current context should shrink without clearing cumulative use");
    }
    await reopened.close();
    reopened = new LocalRuntime(f.settings, { models: f.models });
    assert.equal((await reopened.status(task.id)).compactions, 3);
  } finally { await reopened?.close(); await f.close(); }
});

test("chat presents actual check coverage before the candidate, splits usage and does not claim zero checks prove completion", async () => {
  const f = await scriptedFixture(c => {
    const message = !c.messages.some(m => m.role === "toolResult" && m.toolName === "write")
      ? call("write", { path: "result.json", content: '{"total":71}' })
      : call("task_submit", { summary: "All objectives verified.", artifacts: ["result.json"] });
    return message;
  });
  try {
    const task = await f.runtime.create("Save total71.", f.workspace, [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    // Faux reports its own estimates; compare the UI projection to Pi's ledger.
    const usage = status.usage.models["local-test/scripted"]!;
    assert.equal(status.budget.totalTokens, usage.totalTokens);
    assert.equal(status.budget.cachedTokens, usage.cacheRead);
    assert.equal(status.budget.cacheWriteTokens, usage.cacheWrite);
    assert.equal(status.budget.inputTokens, usage.input);
    assert.equal(status.budget.outputTokens, usage.output);
    assert.ok(usage.cacheRead > 0 && usage.cacheWrite > 0, "exercise both cache fields from the actual provider ledger");
    const events: ChatEvent[] = [];
    const client: HarnessClient = { healthy: async () => true, async request<T>() { return status as T; } };
    const chat = new ChatSession(client, e => events.push(e));
    await chat.attach(task.id); await chat.handle("/status");
    const report = events.map(e => e.text).join("\n");
    assert.match(report, /指定 JSON 值/);
    assert.match(report, /语义质量与事实正确性：未独立复核/);
    assert.ok(report.includes(`非缓存输入：${usage.input}；缓存读取：${usage.cacheRead}；缓存写入：${usage.cacheWrite}；输出：${usage.output}`));
    assert.match(report, /主 Agent 当前上下文：约/);
    assert.match(report, /计划（辅助进度）/);
    assert.doesNotMatch(report, /当前要求已通过验收/);
    assert.ok(events.findIndex(e => e.text.includes("核验范围")) < events.findIndex(e => e.kind === "answer"));
    const noChecks = { ...status, goal: { ...status.goal!, mechanical: { passed: true, results: [], files: [] } } };
    assert.match(verificationText(noChecks), /未配置产物或可自动核验的条件/);
    assert.doesNotMatch(verificationText(noChecks), /0\/0.*通过/);
  } finally { await f.close(); }
});
