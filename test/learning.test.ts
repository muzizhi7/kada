import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { MethodStore, learningProof, type MethodProposal } from "../src/learning.js";
import { Workspace } from "../src/workspace.js";
import { LocalRuntime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";
import { usageText } from "../src/presentation.js";
import { hasTool, scriptedFixture as fixture, until } from "./helpers.js";

// Preserve the v0.6 recovery contract; new tasks are covered in skills.test.ts.
const scriptedFixture: typeof fixture = (respond, config, extensions) => fixture(respond, config, extensions, { legacyResources: true });

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (c: TranscriptContext, name: string) => c.messages.filter((m): m is Extract<TranscriptContext["messages"][number], { role: "toolResult" }> => m.role === "toolResult" && m.toolName === name);
function value(c: TranscriptContext, name: string): any {
  const block = results(c, name).at(-1)?.content.find(b => b.type === "text");
  if (block?.type !== "text") return undefined;
  try { return JSON.parse(block.text); } catch { return undefined; }
}
const spec = { command: "node acceptance/check.mjs", inputs: ["acceptance", "input.json", "environment.json"], outputs: ["deliverables"] };
const script = `import {readFileSync,writeFileSync} from 'node:fs';
const rows=JSON.parse(readFileSync(process.argv[2],'utf8'));
const result=rows.reduce((sum,row)=>sum+(row.qty===null?0:row.qty*row.cents),0);
writeFileSync(process.argv[3],JSON.stringify({totalCents:result}));\n`;
const proposal = (proofId: string): MethodProposal => ({ id: "ledger-normalize", title: "金额批量汇总", match: ["ledger-normalize"],
  when: "输入为含qty与cents的JSON数组，qty可为null；先检查格式与单位。", instructions: "使用参数化脚本处理当前输入；qty为0不能替换为默认值，null表示缺失。重新运行当前任务已有核对。",
  guardFiles: ["environment.json"], assets: ["deliverables/normalize.mjs"], proofId });
function respond(c: TranscriptContext, options: { invalidProof?: boolean; skipProposal?: boolean } = {}) {
  if (hasTool(c, "task_prepare")) return call("task_prepare", { outcome: "汇总当前资料并交付目录", deliverables: ["deliverables"], inputs: spec.inputs,
    criteria: [{ text: "通过保留原样的核对", method: "check", verification: spec }], scope: ["在工作区处理当前资料，保留输入"], assumptions: [], questions: [] });
  if (hasTool(c, "task_learn") && !results(c, "task_status").length) return call("task_status", {});
  const offer = value(c, "task_status")?.learning?.offers?.[0];
  const rejected = value(c, "task_method")?.stopped;
  if (offer && !results(c, "task_method").length) return call("task_method", { id: offer.id, action: "load" });
  if ((!offer || rejected) && !results(c, "write").length) return call("write", { path: "deliverables/normalize.mjs", content: script });
  if (!results(c, "bash").length) {
    const method = results(c, "task_method").at(-1)?.content.find(b => b.type === "text");
    const asset = !rejected && method?.type === "text" ? method.text.split("\n").find(line => line.endsWith("/assets/normalize.mjs")) : undefined;
    return call("bash", { command: `node ${asset ? "'" + asset.replaceAll("'", "'\\''") + "'" : "deliverables/normalize.mjs"} input.json deliverables/result.json` });
  }
  if (!results(c, "task_verify").length) return call("task_verify", spec);
  if (hasTool(c, "task_learn") && !offer && !options.skipProposal && !results(c, "task_learn").length) return call("task_learn", proposal(options.invalidProof ? "made-up" : value(c, "task_verify").id) as unknown as JsonObject);
  return call("task_submit", { summary: "当前资料已汇总并核对", artifacts: ["deliverables"], criteria: [{ id: 1, status: "passed", evidence: "已运行提供的核对", proofIds: [value(c, "task_verify").id] }] });
}
async function prepare(path: string, next = false) {
  await mkdir(join(path, "acceptance"), { recursive: true });
  await mkdir(join(path, "deliverables"), { recursive: true });
  await writeFile(join(path, "input.json"), JSON.stringify(next ? [{ qty: 0, cents: 31 }, { qty: 3, cents: 11 }, { qty: null, cents: 5 }] : [{ qty: 2, cents: 7 }, { qty: 0, cents: 3 }, { qty: null, cents: 9 }]));
  await writeFile(join(path, "environment.json"), '{"schema":1,"unit":"cents"}');
  await writeFile(join(path, "acceptance/check.mjs"), `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
assert.deepEqual(JSON.parse(readFileSync('deliverables/result.json','utf8')),{totalCents:${next ? 33 : 14}}); console.log('ORIGINAL_CHECK_PASS');\n`);
}
async function complete(runtime: LocalRuntime, path: string, objective = "执行 ledger-normalize 并交付") {
  const task = await runtime.create(objective, path, [], { prepare: true });
  const ready = await until(() => runtime.status(task.id), s => s.status === "awaiting_confirmation");
  assert.equal(ready.goal?.learning, undefined, "preparation cannot load or propose learned methods");
  await runtime.confirm(task.id, ready.goal!.brief!.revision, ready.briefDigest!);
  return until(() => runtime.status(task.id), s => s.status === "completed");
}

test("a real Pi task proposes a checked script, reuses it on different inputs, and preserves pins through reopen", async () => {
  const f = await scriptedFixture(c => respond(c), { learning: true });
  let reopened: LocalRuntime | undefined;
  try {
    await prepare(f.workspace);
    const discovery = await complete(f.runtime, f.workspace);
    const proposed = discovery.goal!.learning!.proposal!;
    assert.ok(proposed);
    assert.equal(discovery.goal!.learning!.settledRevision, 1);
    assert.equal(discovery.goal!.confirmation!.revision, 1);
    assert.equal(discovery.goal!.events.filter(e => e.type === "confirmed").length, 1);
    const path = join(f.directory, "new-inputs"); await prepare(path, true);
    const next = await complete(f.runtime, path);
    assert.deepEqual(next.goal!.learning!.loaded, [proposed]);
    assert.equal(next.messages.filter(m => m.role === "toolResult" && m.toolName === "write").length, 0, "the second task uses the saved script, not a newly generated copy");
    assert.deepEqual(JSON.parse(await readFile(join(path, "deliverables/result.json"), "utf8")), { totalCents: 33 });
    const outcomes = await readdir(join(f.directory, "learned-methods", proposed.id, "outcomes"));
    const outcome = JSON.parse(await readFile(join(f.directory, "learned-methods", proposed.id, "outcomes", outcomes[0]!), "utf8"));
    assert.equal(outcome.newInputs, true);
    assert.equal(outcome.outcome, "completed");
    assert.equal(outcome.estimatedTaskCostUsd, next.budget.estimatedCostUsd);
    assert.match(usageText(next), /已含在本任务总额/);
    assert.equal(next.budget.costLimit, discovery.budget.costLimit);
    const store = await MethodStore.open(f.directory);
    const changed = await store.stage(discovery.id, await Workspace.open(f.workspace), discovery.goal!, { ...proposal(Object.values(discovery.goal!.proofs!)[0]!.id), instructions: "不同的新版本" });
    await store.publish(changed);
    await f.runtime.close();
    reopened = new LocalRuntime({ ...f.settings, learning: false }, { models: f.models }); await reopened.recover();
    const after = await reopened.status(next.id);
    assert.deepEqual(after.goal!.learning!.loaded, next.goal!.learning!.loaded);
    assert.deepEqual(after.goal!.learning!.offers, next.goal!.learning!.offers, "a new global version does not replace pinned task instructions");
    assert.deepEqual(after.budget, next.budget, "reopen does not launch another learning model request or refill budget");
    assert.equal((await stat(join(f.directory, "learned-methods"))).mode & 0o777, 0o700);
  } finally { await reopened?.close(); await f.close(); }
});

test("learning disabled adds no tools, no model request, and no method directory", async () => {
  let requests = 0;
  const f = await scriptedFixture(c => { requests++; assert.equal(hasTool(c, "task_learn"), false); assert.equal(hasTool(c, "task_method"), false); return respond(c); });
  try {
    await prepare(f.workspace);
    const done = await complete(f.runtime, f.workspace);
    assert.equal(done.learning, undefined);
    assert.equal(done.goal?.learning, undefined);
    assert.equal(requests, 5, "one preparation, write, bash, verify and submit; no post-task reflection call");
    await assert.rejects(stat(join(f.directory, "learned-methods")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("an enabled task without a reusable discovery finishes without a mandatory proposal or reflection", async () => {
  const f = await scriptedFixture(c => respond(c, { skipProposal: true }), { learning: true });
  try {
    await prepare(f.workspace);
    const done = await complete(f.runtime, f.workspace);
    assert.equal(done.goal!.learning!.proposal, undefined);
    assert.equal(done.messages.some(m => m.role === "toolResult" && m.toolName === "task_learn"), false);
    assert.equal(done.goal!.reworks, 0);
  } finally { await f.close(); }
});

test("a fabricated proof cannot publish a method and optional learning failure does not block delivery", async () => {
  const f = await scriptedFixture(c => respond(c, { invalidProof: true }), { learning: true });
  try {
    await prepare(f.workspace);
    const done = await complete(f.runtime, f.workspace);
    assert.equal(done.goal!.learning!.proposal, undefined);
    const error = done.messages.find(m => m.role === "toolResult" && m.toolName === "task_learn");
    assert.equal(error?.role === "toolResult" && error.isError, false, "optional proposal failures do not invite an error-retry loop");
    assert.match(JSON.stringify(error), /skipped/);
    assert.equal((await (await MethodStore.open(f.directory)).select("ledger-normalize", await Workspace.open(f.workspace))).length, 0);
  } finally { await f.close(); }
});

test("methods skip unrelated tasks or obsolete environments and detect tampered assets", async () => {
  const f = await scriptedFixture(c => respond(c), { learning: true });
  try {
    await prepare(f.workspace);
    const source = await complete(f.runtime, f.workspace), ref = source.goal!.learning!.proposal!;
    const store = await MethodStore.open(f.directory), workspace = await Workspace.open(f.workspace);
    assert.equal((await store.select("unrelated document", workspace)).length, 0);
    await writeFile(join(f.workspace, "environment.json"), '{"schema":2}');
    assert.equal((await store.select("ledger-normalize", workspace)).length, 0);
    await assert.rejects(store.materialize(ref, workspace, join(f.directory, "snap")), /precondition changed/);
    await writeFile(join(f.workspace, "environment.json"), '{"schema":1,"unit":"cents"}');
    const recordFile = join(store.files.root, ref.id, `${ref.version}.json`), record = JSON.parse(await readFile(recordFile, "utf8"));
    record.assets[0].content = "unexpected modified program";
    await writeFile(recordFile, JSON.stringify(record));
    await assert.rejects(store.read(ref), /content changed/);
    assert.equal((await store.select("ledger-normalize", workspace)).length, 0);
    await assert.rejects(store.read({ id: "../outside", version: ref.version }), /Invalid method/);
  } finally { await f.close(); }
});

test("rollback restores the previous trial without changing an already pinned version", async () => {
  const f = await scriptedFixture(c => respond(c), { learning: true });
  try {
    await prepare(f.workspace);
    const source = await complete(f.runtime, f.workspace), original = source.goal!.learning!.proposal!;
    const store = await MethodStore.open(f.directory), workspace = await Workspace.open(f.workspace);
    const next = await store.stage(source.id, workspace, source.goal!, { ...proposal(Object.values(source.goal!.proofs!)[0]!.id), instructions: "新候选仍待真实任务试用" });
    await store.publish(next);
    assert.equal((await store.select("ledger-normalize", workspace))[0]?.version, next.version);
    await store.rollback(next, "A concrete regression was reported");
    assert.equal((await store.select("ledger-normalize", workspace))[0]?.version, original.version);
    await store.publish(next);
    assert.equal((await store.select("ledger-normalize", workspace))[0]?.version, original.version, "crash recovery cannot republish a rolled-back trial");
    assert.equal((await store.read(next)).instructions, "新候选仍待真实任务试用", "rollback does not mutate immutable task pins");
    await store.rollback(next, "retry after crash");
    assert.equal((await store.select("ledger-normalize", workspace))[0]?.version, original.version);
    await store.rollback(original, "No previous candidate exists");
    assert.equal((await store.select("ledger-normalize", workspace)).length, 0);
    await store.publish(original);
    assert.equal((await store.select("ledger-normalize", workspace)).length, 0, "a replay cannot re-enable a disabled version");
  } finally { await f.close(); }
});

test("stale receipts, unverified script assets and escaped guard paths cannot become methods", async () => {
  const f = await scriptedFixture(c => respond(c), { learning: true });
  try {
    await prepare(f.workspace);
    const done = await complete(f.runtime, f.workspace), workspace = await Workspace.open(f.workspace), store = await MethodStore.open(f.directory);
    const proofId = Object.values(done.goal!.proofs!)[0]!.id;
    await writeFile(join(f.workspace, "unverified.mjs"), "process.exit(0)");
    await assert.rejects(store.stage(done.id, workspace, done.goal!, { ...proposal(proofId), assets: ["unverified.mjs"] }), /verified outputs/);
    await assert.rejects(store.stage(done.id, workspace, done.goal!, { ...proposal(proofId), guardFiles: ["../outside"] }), /workspace-relative/);
    await assert.rejects(store.stage(done.id, workspace, done.goal!, { ...proposal(proofId), match: ["invented-label"] }), /literally occur/);
    await writeFile(join(f.workspace, "deliverables/result.json"), '{"totalCents":999}');
    await assert.rejects(learningProof(done.goal!, workspace, proofId), /stale/);
    await assert.rejects(store.stage(done.id, workspace, done.goal!, proposal(proofId)), /stale/);
  } finally { await f.close(); }
});

test("learning config is opt-in and rejects ambiguous truthy values", async () => {
  const f = await scriptedFixture(c => respond(c));
  try {
    const path = join(f.directory, "config.json");
    await writeFile(path, '{}'); assert.equal((await loadConfig(path)).learning, false);
    await writeFile(path, '{"learning":true}'); assert.equal((await loadConfig(path)).learning, true);
    await writeFile(path, '{"learning":"true"}'); await assert.rejects(loadConfig(path), /learning must be a boolean/);
  } finally { await f.close(); }
});

test("a proposal from a rejected delivery is never offered to another task", async () => {
  const f = await scriptedFixture(c => {
    if (results(c, "task_learn").length && !results(c, "task_submit").length) return call("task_submit", {
      summary: "不合格的交付", artifacts: ["missing.txt"], criteria: [{ id: 1, status: "passed", evidence: "existing check", proofIds: [value(c, "task_verify").id] }],
    });
    return respond(c);
  }, { learning: true, maxReworks: 0 });
  try {
    await prepare(f.workspace);
    const task = await f.runtime.create("执行 ledger-normalize", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, ready.briefDigest!);
    const failed = await until(() => f.runtime.status(task.id), s => s.status === "needs_attention");
    assert.ok(failed.goal!.learning!.proposal, "proposal was really staged before rejection");
    assert.equal((await (await MethodStore.open(f.directory)).select("ledger-normalize", await Workspace.open(f.workspace))).length, 0);
  } finally { await f.close(); }
});

test("method failures reported through Pi disable future selection while allowing current delivery", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_method") && results(c, "task_method").length === 1) return call("task_method", { id: "ledger-normalize", action: "report_failure", reason: "Example exposes an unsuitable precondition; proceed without reusing it" });
    return respond(c);
  }, { learning: true });
  try {
    await prepare(f.workspace);
    await complete(f.runtime, f.workspace);
    const nextPath = join(f.directory, "failure-report"); await prepare(nextPath, true);
    const next = await complete(f.runtime, nextPath);
    assert.equal(next.goal!.learning!.rejected.length, 1);
    const store = await MethodStore.open(f.directory);
    assert.equal((await store.select("ledger-normalize", await Workspace.open(nextPath))).length, 0);
    assert.equal(next.status, "completed");
  } finally { await f.close(); }
});

test("a failed optional proposal gets one attempt, never a learning repair loop", async () => {
  const f = await scriptedFixture(c => {
    const count = results(c, "task_learn").length;
    if (count === 1) return call("task_learn", proposal(value(c, "task_verify").id) as unknown as JsonObject);
    return respond(c, { invalidProof: true });
  }, { learning: true });
  try {
    await prepare(f.workspace);
    const done = await complete(f.runtime, f.workspace);
    const calls = done.messages.filter(m => m.role === "toolResult" && m.toolName === "task_learn");
    assert.equal(calls.length, 2, "the model tried again but the second call was declined without staging");
    assert.match(JSON.stringify(calls[1]), /already made/);
    assert.equal(done.goal!.learning!.proposal, undefined);
    assert.equal(done.goal!.reworks, 0);
    assert.equal(done.status, "completed");
  } finally { await f.close(); }
});
