/** Bounded real-model regression with synthetic context and a native Pi baseline. */
import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig } from "../src/config.js";
import { cloudModels } from "../src/models.js";
import { LocalRuntime } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";
import { preparationExtension } from "../src/preparation.js";
import { conversationAnswer, conversationInstructions } from "../src/conversation.js";
import { localEnvironment, taskCompaction } from "../src/execution.js";
import { GoalDoc } from "../src/goal.js";
import { taskUsage } from "../src/budget.js";
import { atomicJson } from "../src/util.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const args = parseArgs({ options: { execute: { type: "boolean" } } });
if (!args.values.execute) {
  console.log("Run with --execute: real configured model, synthetic context, native Pi comparison; USD0.03 per arm, 2 minutes each.");
  process.exit(0);
}
const settings = await loadConfig();
assert(settings.model, "Configure the existing online model first");
const base = resolve(".harness/live-tests/chat", randomUUID());
await mkdir(base, { recursive: true });
const workspace = await Workspace.open(join(base, "workspace"));
await writeFile(join(workspace.root, "alpha.txt"), "Synthetic source A\n");
await writeFile(join(workspace.root, "beta.txt"), "Synthetic source B\n");
const models = cloudModels(), budget = { maxEstimatedCostUsd: .03, maxDurationMs: 120_000 };
const messages = ["你了解我吗", "你可以猜测我的背景", "产品经理,AI agnet", "自己做的Agent产品,\n需要", "不用了,退下吧"];
const registry = createRegistry();
const conversation = preparationExtension(workspace, budget, { startGoal: async () => ({
  objective: messages[0]!, userMessages: [], tokenLimit: null, costLimit: budget.maxEstimatedCostUsd,
}) });
registry.install(conversation);
const native = await Harness.open(await openNodeSqliteStorage(join(base, "native.sqlite")), {
  models, registry, env: () => localEnvironment(workspace.root),
  settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120_000 }, toolExecution: "parallel", compaction: taskCompaction(models, [settings.model], settings.compactAtTokens) },
}, ctx);
const root = await native.root(ctx, { agent: { model: settings.model, cwd: workspace.root, extensions: [conversation], instructions: conversationInstructions(workspace.root) } });
const runtime = new LocalRuntime({ ...settings, dataDir: join(base, "state"), discovery: false, learning: false, web: false, review: false,
  maxSubagents: 1, ...budget }, { models });
const result: Record<string, unknown> = { model: settings.model, record: base };
const wait = async (id: string, predicate: (s: Awaited<ReturnType<LocalRuntime["status"]>>) => boolean) => {
  const deadline = Date.now() + budget.maxDurationMs;
  for (;;) {
    const status = await runtime.status(id);
    if (predicate(status)) return status;
    assert(!["failed", "needs_attention", "blocked", "budget_limited"].includes(status.status), `${status.status}: ${status.goal?.reason}`);
    assert(Date.now() < deadline, "live chat smoke timed out");
    await setTimeout(100);
  }
};
try {
  const nativeAnswers: string[] = [], nativeStart = Date.now();
  for (const [index, message] of messages.entries()) {
    assert(taskUsage(await native.usage(ctx)).estimatedCostUsd < budget.maxEstimatedCostUsd);
    assert(Date.now() - nativeStart < budget.maxDurationMs);
    const receipt = await (await root.submit({ type: "input", content: message, requestId: `turn-${index}` }, ctx)).wait(ctx);
    assert.equal(receipt.status, "done");
    assert.equal(await native.snapshot(GoalDoc, ctx), undefined, "baseline questions must stay ordinary conversation");
    const answer = [...(await root.context(ctx)).messages].reverse().map(conversationAnswer).find(Boolean);
    assert(answer); nativeAnswers.push(answer);
  }
  result.native = { answers: nativeAnswers, usage: taskUsage(await native.usage(ctx)), elapsedMs: Date.now() - nativeStart };
  const task = await runtime.create(messages[0]!, workspace.root, [], { chat: true }), start = Date.now(), answers: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (index) await runtime.followUp(task.id, message, `turn-${index}`);
    const status = await wait(task.id, s => !["running", "pending", "verifying"].includes(s.status));
    assert.equal(status.status, "answered"); assert.equal(status.goal, undefined);
    const answer = [...status.messages].reverse().map(conversationAnswer).find(Boolean);
    assert(answer); answers.push(answer);
  }
  await setTimeout(250);
  const done = await runtime.status(task.id);
  assert.equal(done.messages.filter(m => m.role === "assistant").length, 5, "one response per user message, no supervisor rework");
  result.kada = { taskId: task.id, answers, usage: done.budget, elapsedMs: Date.now() - start, goals: 0, reworks: 0 };
  await runtime.followUp(task.id, "现在需要一个实际文件任务：工作区只有 alpha.txt 和 beta.txt 两份资料，请整理一份文件名清单保存为 manifest.txt，只列这两个文件，不递归、不修改原件。验收为清单正好两行且无遗漏、无重名，通过内容自检即可，没有现成独立检查器；不要配置固定 verification。先提出任务说明和预算，不直接执行，不必追问。总费用最多0.03美元，执行最多2分钟。");
  const ready = await wait(task.id, s => !["running", "pending", "verifying"].includes(s.status));
  assert.equal(ready.status, "awaiting_confirmation");
  assert.equal(ready.goal?.confirmation, undefined);
  assert.equal(ready.goal?.reworks, 0);
  result.upgrade = { taskId: task.id, status: ready.status, brief: ready.goal?.brief, usage: ready.budget };
  result.passed = true;
  await atomicJson(join(base, "result.json"), result);
  console.log(JSON.stringify({ passed: true, model: settings.model, record: base, native: { responses: nativeAnswers.length, usage: taskUsage(await native.usage(ctx)) },
    kada: { responses: answers.length, goals: 0, reworks: 0, usage: done.budget }, upgrade: ready.status, totalKadaUsage: ready.budget }));
} catch (error) {
  await atomicJson(join(base, "failure.json"), { ...result, error: String(error) });
  throw error;
} finally { await native.close(ctx); await runtime.close(); }
