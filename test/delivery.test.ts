import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { checkArtifacts } from "../src/checks.js";
import { Workspace } from "../src/workspace.js";
import { hashFiles } from "../src/verification.js";
import { briefText } from "../src/presentation.js";
import { LocalRuntime } from "../src/runtime.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (c: TranscriptContext, name: string) => c.messages.filter(m => m.role === "toolResult" && m.toolName === name);
const receipt = (c: TranscriptContext): { id: string; passed: boolean } | undefined => {
  const block = results(c, "task_verify").at(-1)?.content.find(b => b.type === "text");
  return block?.type === "text" ? JSON.parse(block.text) : undefined;
};
const verification = { command: "node acceptance/check.mjs", inputs: ["acceptance"], outputs: ["project"] };
const proposal = (fixed = true): JsonObject => ({ outcome: "修复代码的嵌套空值/零值兼容性，交付源码目录", deliverables: ["project"], inputs: ["acceptance"],
  criteria: [{ text: "保留原行为并通过提供的原始核对", method: "check", ...(fixed ? { verification } : {}) }],
  scope: ["只修改project，保持acceptance原样"], assumptions: [], questions: [] });
const corrected = "export function classes(xs) { return xs.flat(Infinity).filter(Boolean).join(' '); }\n";
async function inputs(workspace: string) {
  await mkdir(join(workspace, "acceptance")); await mkdir(join(workspace, "project"));
  await writeFile(join(workspace, "project/index.mjs"), "export function classes(xs) { return xs.flat(Infinity).join(' '); }\n");
  await writeFile(join(workspace, "acceptance/check.mjs"), `import assert from 'node:assert/strict';
import {classes} from '../project/index.mjs';
try {
  assert.equal(classes([0,null,['ok',0,false]]),'ok');
  assert.equal(classes(['a',['b','a']]),'a b a');
  console.log('NESTED_FALSEY_AND_ORDER_PASS');
} catch(e) { console.error(e.message); process.exit(7); }
`);
}

test("directory delivery includes nested/hidden/empty files and empty directories with stable byte evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tree-"));
  try {
    const workspace = await Workspace.open(directory);
    await mkdir(join(directory, "bundle/empty-dir"), { recursive: true });
    await writeFile(join(directory, "bundle/empty"), "");
    await writeFile(join(directory, "bundle/.hidden"), "content");
    await writeFile(join(directory, "bundle/binary"), Buffer.alloc(1048580, 0x80));
    const report = await checkArtifacts(workspace, ["bundle", "bundle/empty", "bundle/empty-dir"], []);
    assert.equal(report.passed, true);
    assert.equal(report.files.length, 3);
    assert.equal(report.directories?.length, 2);
    assert.equal(report.directories?.find(d => d.path.endsWith("/bundle"))?.entries, 4);
    assert.equal(report.files.find(f => f.path.endsWith("/empty"))?.bytes, 0);
    assert.deepEqual(await hashFiles(workspace, ["bundle"]), [report.directories![0]]);
    const before = (await workspace.inspectPath("bundle")).sha256;
    await mkdir(join(directory, "bundle/new-empty"));
    assert.notEqual((await workspace.inspectPath("bundle")).sha256, before, "an added empty directory invalidates proof");
    await rm(join(directory, "bundle/new-empty"), { recursive: true });
    assert.equal((await workspace.inspectPath("bundle")).sha256, before, "timestamps alone do not change content evidence");
    await rename(join(directory, "bundle/.hidden"), join(directory, "bundle/renamed"));
    assert.notEqual((await workspace.inspectPath("bundle")).sha256, before, "same bytes at a new member path differ");
    assert.equal((await checkArtifacts(workspace, [], [{ type: "file_exists", path: "bundle" }])).passed, false, "file_exists remains a file predicate");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("directory observation rejects escaped paths, links and mutation during its scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tree-"));
  try {
    const workspace = await Workspace.open(join(directory, "work"));
    await mkdir(join(workspace.root, "bundle"));
    await writeFile(join(workspace.root, "bundle/data"), "original");
    await symlink(directory, join(workspace.root, "bundle/link"));
    await assert.rejects(workspace.inspectPath("bundle"), /Symlinks/);
    await assert.rejects(workspace.inspectPath("../outside"), /outside/);
    await rm(join(workspace.root, "bundle/link"));
    const inspect = workspace.inspect.bind(workspace);
    workspace.inspect = async (path, cwd) => {
      const file = await inspect(path, cwd);
      await mkdir(join(workspace.root, "bundle/added-during-read"));
      return file;
    };
    await assert.rejects(workspace.inspectPath("bundle"), /Directory changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a directory receipt detects new empty members and repairs in the same confirmed Pi session", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return call("task_prepare", proposal(false));
    const calls = results(c, "task_verify").length;
    if (!calls) return call("task_verify", { command: "node -e '0'", inputs: [], outputs: ["project"] });
    if (!results(c, "bash").length) return call("bash", { command: "mkdir project/new-empty" });
    if (calls === 1 && results(c, "task_submit").length) return call("task_verify", { command: "node -e '0'", inputs: [], outputs: ["project"] });
    return call("task_submit", { summary: "源码目录已交付", artifacts: ["project"], criteria: [{ id: 1, status: "passed", evidence: "实际检查当前目录", proofIds: [receipt(c)!.id] }] });
  });
  try {
    await inputs(f.workspace);
    const task = await f.runtime.create("交付目录", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, ready.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(done.goal?.reworks, 1);
    assert.match(done.goal!.events.find(e => e.type === "rejected")!.detail, /stale/);
    assert.equal(done.goal?.mechanical?.directories?.[0]?.entries, 2);
    assert.equal(done.budget.costLimit, ready.goal?.brief?.budget.maxEstimatedCostUsd);
  } finally { await f.close(); }
});

test("confirmed existing tests reject unrelated exit-zero proof, expose real code failure, then accept an actual repair", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return call("task_prepare", proposal());
    const count = results(c, "task_verify").length;
    if (!count) return call("task_verify", { ...verification, command: "node -e 'process.exit(0)'" });
    if (count === 1 && results(c, "task_submit").length) return call("task_verify", verification);
    if (count === 2 && results(c, "task_submit").length >= 2 && !results(c, "write").length) return call("write", { path: "project/index.mjs", content: corrected });
    if (count === 2 && results(c, "write").length) return call("task_verify", verification);
    return call("task_submit", { summary: "源码已修复", artifacts: ["project"], criteria: [{ id: 1, status: "passed", evidence: "引用实际检查结果", proofIds: [receipt(c)!.id] }] });
  });
  let reopened: LocalRuntime | undefined;
  try {
    await inputs(f.workspace);
    const original = await readFile(join(f.workspace, "acceptance/check.mjs"), "utf8");
    const task = await f.runtime.create("修复代码并运行既有测试", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    assert.match(briefText(ready), /node acceptance\/check.mjs/);
    await f.runtime.confirm(task.id, 1, ready.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(done.goal?.reworks, 2);
    const failures = done.goal!.events.filter(e => e.type === "rejected").map(e => e.detail);
    assert.match(failures[0]!, /confirmed verification command/);
    assert.match(failures[1]!, /exit 7/);
    assert.equal(await readFile(join(f.workspace, "acceptance/check.mjs"), "utf8"), original);
    assert.ok(done.goal?.confirmation?.verificationInputs?.["1"]?.length);
    assert.equal(Object.values(done.goal!.proofs!).filter(p => p.passed).length, 2, "irrelevant command really passed but did not satisfy the criterion");
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models }); await reopened.recover();
    const after = await reopened.status(task.id);
    assert.equal(after.status, "completed");
    assert.deepEqual(after.goal?.confirmation, done.goal?.confirmation);
    assert.equal(after.budget.costLimit, done.budget.costLimit);
  } finally { await reopened?.close(); await f.close(); }
});

for (const change of ["checker", "inputs", "outputs"]) test(`confirmed verification cannot be bypassed by changing ${change}`, async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) return call("task_prepare", proposal());
    if (change === "checker" && !results(c, "write").length) return call("write", { path: "acceptance/check.mjs", content: "console.log('forged success');\n" });
    if (change !== "checker" && !results(c, "write").length) return call("write", { path: "project/index.mjs", content: corrected });
    if (!results(c, "task_verify").length) return call("task_verify", { ...verification,
      ...(change === "inputs" ? { inputs: [] } : {}), ...(change === "outputs" ? { outputs: [] } : {}) });
    return call("task_submit", { summary: "claimed complete", artifacts: ["project"], criteria: [{ id: 1, status: "passed", evidence: "命令退出0", proofIds: [receipt(c)!.id] }] });
  }, { maxReworks: 0 });
  try {
    await inputs(f.workspace);
    const task = await f.runtime.create("保留原测试并交付", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, ready.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), s => s.status === "needs_attention");
    assert.match(done.goal!.reason!, /confirmed verification command/);
    assert.equal(done.goal?.verification, null);
    assert.equal(Object.values(done.goal!.proofs!)[0]?.passed, true, "exit zero alone does not meet the frozen check");
  } finally { await f.close(); }
});

test("preparation rejects nonexistent original check inputs before asking for approval and lets Pi correct the proposal", async () => {
  const f = await scriptedFixture(c => {
    if (hasTool(c, "task_prepare")) {
      const attempted = results(c, "task_prepare").length;
      if (!attempted) return call("task_prepare", { ...proposal(), criteria: [{ text: "运行现有核对", method: "check", verification: { ...verification, inputs: ["tests/not-created-yet"] } }] });
      assert.match(JSON.stringify(results(c, "task_prepare")), /must already exist/);
      return call("task_prepare", proposal());
    }
    return call("task_blocked", { reason: "test stops before executing" });
  });
  try {
    await inputs(f.workspace);
    const task = await f.runtime.create("修正说明的核对范围", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), s => s.status === "awaiting_confirmation");
    assert.deepEqual(ready.goal?.brief?.criteria[0]?.verification?.inputs, ["acceptance"]);
    assert.equal(ready.goal?.brief?.revision, 1, "invalid proposal was never saved/shown for confirmation");
    assert.equal(ready.goal?.confirmation, undefined);
    assert.equal(ready.goal?.reworks, 0, "Pi handled a tool error without a host feedback loop or user message");
  } finally { await f.close(); }
});
