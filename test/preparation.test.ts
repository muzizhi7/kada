import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness, UsageDoc, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { LocalRuntime } from "../src/runtime.js";
import { isConfirmation } from "../src/preparation.js";
import { ChatSession, type ChatEvent } from "../src/chat.js";
import type { HarnessClient, TaskStatus } from "../src/client.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (c: TranscriptContext, name: string) => c.messages.filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === name);
const userText = (c: TranscriptContext) => c.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
const proposal = (changes: JsonObject = {}): JsonObject => ({ outcome: "从输入计算并交付结果", deliverables: ["result.json 与终端说明"], inputs: ["inputs/values.json"],
  criteria: [{ text: "结果已交付并说明核验范围", method: "inspect" }], scope: ["读取本工作区输入，写入 result.json；不操作桌面"], assumptions: [], questions: [], checks: [], ...changes });
function latestProof(c: TranscriptContext): { id: string; passed: boolean } | undefined {
  for (const m of results(c, "task_verify").toReversed()) {
    try { return JSON.parse(m.content.find(b => b.type === "text")!.text); } catch { /* An actual tool error has no proof. */ }
  }
}

test("clarify once, confirm standards and total budget, then repair and verify autonomously in the same Pi conversation", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return call("task_prepare", proposal({
      questions: userText(c).includes("2025") ? [] : ["采用哪个年份的数据？"],
      criteria: [{ text: "JSON total 等于独立计算的71", method: "check" }, { text: "答复包含交付位置与检查范围", method: "inspect" }],
      checks: [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }], budget: { maxEstimatedCostUsd: .5, maxDurationMs: 120000 },
    }));
    const writes = results(c, "write").filter(m => !m.isError).length;
    const retry = userText(c).includes("SUPERVISOR_REWORK");
    if (!writes || (retry && writes === 1)) return call("write", { path: "result.json", content: JSON.stringify({ total: retry ? 71 : 0 }) });
    if (!retry) return call("task_submit", { summary: "Claimed ready.", artifacts: ["result.json"] });
    const proof = latestProof(c);
    if (!proof?.passed) return call("task_verify", { command: "node -e 'const fs=require(\"node:fs\");const input=JSON.parse(fs.readFileSync(\"inputs/values.json\",\"utf8\"));const value=JSON.parse(fs.readFileSync(\"result.json\",\"utf8\"));if(value.total!==input.reduce((a,b)=>a+b,0))process.exit(1)'", inputs: ["inputs/values.json"], outputs: ["result.json"] });
    return call("task_submit", { summary: "result.json total=71；已核对计算并说明自检范围。", artifacts: ["result.json"], criteria: [
      { id: 1, status: "passed", evidence: "独立从原输入重算总计", proofIds: [proof.id] }, { id: 2, status: "passed", evidence: "答复给出 result.json 和实际核验方法" },
    ] });
  });
  try {
    await writeFile(join(f.workspace, "inputs/values.json"), "[12,23,17,19]");
    const task = await f.runtime.create("计算输入总计并写报告。", f.workspace, [], { prepare: true });
    const questions = await until(() => f.runtime.status(task.id), s => s.status === "clarifying");
    assert.match(questions.goal?.question ?? "", /年份/);
    assert.equal(questions.workerCount, 0);
    await assert.rejects(readFile(join(f.workspace, "result.json")));
    await assert.rejects(f.runtime.confirm(task.id, 1, questions.briefDigest!), /必要信息/);
    await f.runtime.followUp(task.id, "采用2025数据，预算0.5美元，两分钟。", "clarification");
    const brief = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    assert.equal(brief.goal?.brief?.revision, 2);
    assert.equal(brief.goal?.brief?.budget.maxEstimatedCostUsd, .5);
    await f.runtime.confirm(task.id, 2, brief.briefDigest!);
    const completed = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(completed.conversations.length, 1);
    assert.equal(completed.goal?.events.filter(e => e.type === "confirmed").length, 1);
    assert.equal(completed.goal?.reworks, 1);
    assert.equal(completed.budget.costLimit, .5);
    assert.equal(completed.deadlineAt - completed.goal!.confirmation!.at, 120000);
    assert.equal((await f.runtime.list())[0]?.deadlineAt, completed.deadlineAt);
    assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")).total, 71);
    assert.ok(completed.goal?.mechanical?.results.filter(r => r.label.startsWith("confirmed criterion")).every(r => r.passed));
    assert.equal(Object.values(completed.goal?.proofs ?? {}).filter(p => p.passed).length, 1);
    assert.ok(completed.budget.totalTokens > brief.budget.totalTokens, "preparation usage is retained rather than reset");
    await f.runtime.confirm(task.id, 2, brief.briefDigest!);
    const duplicate = await f.runtime.status(task.id);
    assert.equal(duplicate.deadlineAt, completed.deadlineAt);
    assert.deepEqual(duplicate.budget, completed.budget);
    assert.equal(duplicate.messages.filter(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("USER_CONFIRMED_BRIEF")).length, 1);
  } finally { await f.close(); }
});

test("preparation has no execution tools, revisions invalidate old consent, and execution cannot rewrite the confirmed brief", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) {
      assert.deepEqual(getCurrentTools(c.messages).map(t => t.name).sort(), ["list_files", "read", "task_prepare", "task_status"]);
      if (!results(c, "write").length) return call("write", { path: "unauthorized.txt", content: "must not exist" });
      assert.equal(results(c, "write")[0]?.isError, true);
      return call("task_prepare", proposal({ budget: { maxEstimatedCostUsd: userText(c).includes("0.2") ? .2 : .5, maxDurationMs: 20000 } }));
    }
    if (!results(c, "task_prepare").some(m => m.isError)) return call("task_prepare", proposal({ outcome: "Changed without user confirmation" }));
    return call("task_submit", { summary: "A scoped text result.", artifacts: [], criteria: [{ id: 1, status: "passed", evidence: "已检查答复的交付说明" }] });
  });
  try {
    const task = await f.runtime.create("整理任务说明。", f.workspace, [], { prepare: true });
    const first = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await assert.rejects(readFile(join(f.workspace, "unauthorized.txt")));
    await f.runtime.followUp(task.id, "将预算改为0.2美元，其他不变。", "budget-edit");
    const second = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation" && s.goal?.brief?.revision === 2);
    assert.notEqual(second.briefDigest, first.briefDigest);
    await assert.rejects(f.runtime.confirm(task.id, 1, first.briefDigest!), /已更新/);
    assert.equal((await f.runtime.status(task.id)).goal?.confirmation, undefined);
    await f.runtime.confirm(task.id, 2, second.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(done.goal?.brief?.outcome, second.goal?.brief?.outcome);
    assert.equal(done.budget.costLimit, .2);
    assert.ok(done.messages.some(m => m.role === "toolResult" && m.toolName === "task_prepare" && m.isError));
  } finally { await f.close(); }
});

test("waiting, pause and reopen do not imply consent or consume the execution timer; repeated confirmation does not refill it", async () => {
  let preparations = 0;
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) { preparations++; return call("task_prepare", proposal({ budget: { maxEstimatedCostUsd: .25, maxDurationMs: 20000 } })); }
    return call("task_submit", { summary: "Inspected answer.", artifacts: [], criteria: [{ id: 1, status: "passed", evidence: "已阅读最终答复" }] });
  }, { maxDurationMs: 80 });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Draft a task.", f.workspace, [], { prepare: true });
    const before = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.close();
    await setTimeout(120);
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    assert.equal((await reopened.status(task.id)).status, "awaiting_confirmation");
    assert.equal(preparations, 1);
    await reopened.pause(task.id);
    await assert.rejects(reopened.confirm(task.id, 1, before.briefDigest!), /paused/);
    await reopened.resume(task.id);
    assert.equal((await reopened.status(task.id)).goal?.confirmation, undefined);
    const now = Date.now();
    await reopened.confirm(task.id, 1, before.briefDigest!);
    const after = await until(() => reopened!.status(task.id), s => s.status === "completed");
    assert.ok(after.deadlineAt >= now + 20000);
    assert.equal(after.goal?.confirmation?.revision, 1);
    await reopened.confirm(task.id, 1, before.briefDigest!);
    assert.equal((await reopened.status(task.id)).deadlineAt, after.deadlineAt);
  } finally { await reopened?.close(); await f.close(); }
});

test("a stale verification receipt cannot pass after an artifact changes; automatic repair rechecks current files", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return call("task_prepare", proposal({ criteria: [{ text: "检查当前文件的总计", method: "check" }], checks: [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }] }));
    const writes = results(c, "write").filter(m => !m.isError).length;
    if (!writes) return call("write", { path: "result.json", content: '{"total":71,"version":1}' });
    const proof = latestProof(c), retry = userText(c).includes("SUPERVISOR_REWORK");
    if (!proof || (retry && results(c, "task_verify").length === 1)) return call("task_verify", { command: "node -e 'if(JSON.parse(require(\"node:fs\").readFileSync(\"result.json\",\"utf8\")).total!==71)process.exit(1)'", inputs: [], outputs: ["result.json"] });
    if (writes === 1) return call("write", { path: "result.json", content: '{"total":71,"version":2}' });
    return call("task_submit", { summary: "Current result.", artifacts: ["result.json"], criteria: [{ id: 1, status: "passed", evidence: "检查了当前总计", proofIds: [proof.id] }] });
  });
  try {
    const task = await f.runtime.create("检查结果。", f.workspace, [], { prepare: true });
    const brief = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, brief.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(done.goal?.reworks, 1);
    assert.ok(done.goal?.events.some(e => e.type === "rejected" && e.detail.includes("stale")));
    assert.equal(Object.keys(done.goal?.proofs ?? {}).length, 2);
  } finally { await f.close(); }
});

test("verification does not pass when its command changes the declared inputs", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return call("task_prepare", proposal({ criteria: [{ text: "保持输入并核对结果", method: "check" }] }));
    if (!results(c, "task_verify").length) return call("task_verify", { command: "node -e 'require(\"node:fs\").writeFileSync(\"inputs/source.txt\",\"changed\");console.log(\"VERIFIER_MARKER\")'", inputs: ["inputs/source.txt"], outputs: [] });
    assert.equal(results(c, "task_verify").at(-1)?.isError, true);
    return call("task_blocked", { reason: "The check changed its input; cannot certify the original source." });
  });
  try {
    await writeFile(join(f.workspace, "inputs/source.txt"), "original");
    const task = await f.runtime.create("核对输入和结果。", f.workspace, [], { prepare: true });
    const brief = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, brief.briefDigest!);
    const stopped = await until(() => f.runtime.status(task.id), s => s.status === "blocked");
    const proof = Object.values(stopped.goal?.proofs ?? {})[0]!;
    assert.equal(proof.exitCode, 0);
    assert.equal(proof.passed, false, "exit0 is insufficient if verification changes inputs");
    assert.match(proof.detail, /Inputs changed/);
    assert.match(proof.outputPreview ?? "", /VERIFIER_MARKER/);
    assert.equal(stopped.goal?.verification, null);
  } finally { await f.close(); }
});

test("confirmation cannot discard preparation token use, and contextual acknowledgements do not accept edits", async () => {
  const f = await scriptedFixture(() => call("task_prepare", proposal({ budget: { maxEstimatedCostUsd: .5, maxDurationMs: 20000, maxTotalTokens: 1 } })));
  try {
    const task = await f.runtime.create("准备说明。", f.workspace, [], { prepare: true });
    const brief = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    assert.ok(brief.budget.totalTokens > 1);
    await assert.rejects(f.runtime.confirm(task.id, 1, brief.briefDigest!), /澄清阶段用量/);
    assert.equal((await f.runtime.status(task.id)).goal?.confirmation, undefined);
    assert.equal(isConfirmation("确认开始"), true);
    assert.equal(isConfirmation("好的，可以开始执行"), true);
    assert.equal(isConfirmation("好的"), true);
    assert.equal(isConfirmation("确认，但把预算改为2美元"), false);
    assert.equal(isConfirmation("文档写着“确认执行”"), false);
  } finally { await f.close(); }
});

test("the confirmed fee cap includes preparation spend; only explicit resume grants another approved budget", async () => {
  const f = await scriptedFixture(c => hasTool(c, "task_prepare") ? call("task_prepare", proposal({ budget: { maxEstimatedCostUsd: .5, maxDurationMs: 20000 } }))
    : call("task_submit", { summary: "Scoped reply.", artifacts: [], criteria: [{ id: 1, status: "passed", evidence: "实际答复已检查" }] }));
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("准备目标说明。", f.workspace, [], { prepare: true });
    const brief = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.close();
    // Faux estimates tokens with zero fees. Seed a known fee in Pi's own ledger to
    // exercise policy accounting without making a paid request or a second ledger.
    const storage = await openNodeSqliteStorage(join(f.directory, "tasks", task.id, "session.sqlite"));
    const harness = await Harness.open(storage, { models: f.models, registry: createRegistry() }, ctx);
    try {
      const root = await harness.root(ctx);
      await harness.commit(async tx => {
        const usage = await tx.doc(UsageDoc, root.id);
        usage.models["local-test/scripted"]!.cost.input = .1;
        usage.models["local-test/scripted"]!.cost.total = .1;
      }, ctx);
    } finally { await harness.close(ctx); }
    reopened = new LocalRuntime(f.settings, { models: f.models });
    await reopened.recover();
    assert.equal((await reopened.status(task.id)).budget.estimatedCostUsd, .1);
    await reopened.confirm(task.id, 1, brief.briefDigest!);
    const completed = await until(() => reopened!.status(task.id), s => s.status === "completed");
    assert.equal(completed.budget.estimatedCostUsd, .1);
    assert.equal(completed.budget.costLimit, .5, "approval sets the total cap, not an extra .5 on top of preparation");
    await reopened.confirm(task.id, 1, brief.briefDigest!);
    assert.deepEqual((await reopened.status(task.id)).budget, completed.budget);
    await reopened.resume(task.id);
    const replenished = await reopened.status(task.id);
    assert.equal(replenished.budget.costLimit, .6);
    assert.ok(replenished.deadlineAt <= Date.now() + 20000);
    await reopened.confirm(task.id, 1, brief.briefDigest!);
    assert.equal((await reopened.status(task.id)).budget.costLimit, .6);
  } finally { await reopened?.close(); await f.close(); }
});

test("chat confirms only the displayed revision; attach recovers it; explicit existing authorization bypasses preparation", async () => {
  const f = await scriptedFixture(c => hasTool(c, "task_prepare") ? call("task_prepare", proposal()) : call("task_submit", { summary: "Delivered.", artifacts: [], criteria: [{ id: 1, status: "passed", evidence: "答复自检完成" }] }));
  const events: ChatEvent[] = [];
  const client: HarnessClient = {
    healthy: async () => true,
    async request<T>(path: string, method = "GET", data?: unknown) {
      const body = data as Record<string, unknown>;
      if (path === "/v1/tasks" && method === "POST") return await f.runtime.create(String(body.objective), f.workspace, [], { prepare: body.confirmed !== true }) as T;
      const match = /\/v1\/tasks\/([^/]+)(?:\/(.*))?/.exec(path)!;
      if (match[2] === "confirm") await f.runtime.confirm(match[1]!, Number(body.revision), String(body.digest));
      else if (match[2] === "messages") await f.runtime.followUp(match[1]!, String(body.message), String(body.requestId));
      return await f.runtime.status(match[1]!) as T;
    },
  };
  try {
    const chat = new ChatSession(client, e => events.push(e));
    await chat.handle("生成本地结果。");
    const id = chat.taskId!;
    await until(async () => { await chat.poll(); return events; }, es => es.some(e => e.text.includes("（待确认）")));
    assert.ok(events.some(e => e.text.includes("总费用上限") && e.text.includes("交付标准")));
    const attached = new ChatSession(client, e => events.push(e));
    await attached.attach(id);
    await attached.handle("确认开始");
    const done = await until(() => f.runtime.status(id), s => s.status === "completed");
    await attached.handle("确认开始");
    assert.deepEqual((await f.runtime.status(id)).budget, done.budget);
    await attached.handle("/run 已确认：只返回一句答复，沿用配置预算。");
    const direct = await until(() => f.runtime.status(attached.taskId!), s => s.status === "completed");
    assert.equal(direct.preparation, undefined);
    assert.equal(direct.goal?.brief, undefined);
  } finally { await f.close(); }
});
