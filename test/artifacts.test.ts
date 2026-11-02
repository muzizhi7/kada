import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { checkArtifacts } from "../src/checks.js";
import { hashFiles } from "../src/verification.js";
import { TextFileError, Workspace } from "../src/workspace.js";
import { loadConfig } from "../src/config.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (context: TranscriptContext, name: string) => context.messages.filter(message => message.role === "toolResult" && message.toolName === name);
const repairing = (context: TranscriptContext) => context.messages.some(message => message.role === "user" && String(message.content).includes("SUPERVISOR_REWORK"));
function proof(context: TranscriptContext): { id: string; passed: boolean } | undefined {
  const value = results(context, "task_verify").at(-1)?.content.find(block => block.type === "text");
  return value?.type === "text" ? JSON.parse(value.text) : undefined;
}
const brief = (deliverable: string) => ({ outcome: "交付当前文件并核对真实结果", deliverables: [deliverable], inputs: [],
  criteria: [{ text: "实际命令验证当前文件", method: "check" }], scope: ["本工作区"], assumptions: [], questions: [],
  checks: [{ type: "file_exists", path: deliverable }] });

test("large binary delivery hashes original bytes and does not inherit the bounded text reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-"));
  try {
    const workspace = await Workspace.open(directory);
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x80);
    bytes.write("PK\x03\x04"); // Binary bytes are deliberately not treated as ZIP format validation.
    await writeFile(join(directory, "archive.zip"), bytes);
    const report = await checkArtifacts(workspace, ["archive.zip"], [{ type: "file_exists", path: "archive.zip" }]);
    assert.equal(report.passed, true);
    assert.deepEqual(report.files, [{ path: join(workspace.root, "archive.zip"), bytes: bytes.length, sha256: digest(bytes) }]);
    assert.deepEqual(await hashFiles(workspace, ["archive.zip"]), report.files, "command receipts and delivery use the same byte snapshot");
    await assert.rejects(() => workspace.read("archive.zip"), TextFileError);
    const text = await checkArtifacts(workspace, [], [{ type: "file_contains", path: "archive.zip", text: "PK" }]);
    assert.equal(text.passed, false);
    assert.match(text.results[0]!.detail, /1 MiB/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("zero automatic repairs is an explicit configuration while negative limits remain invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-repair-config-"));
  try {
    const file = join(directory, "config.json");
    await writeFile(file, '{"maxReworks":0}');
    assert.equal((await loadConfig(file)).maxReworks, 0);
    await writeFile(file, '{"maxReworks":-1}');
    await assert.rejects(() => loadConfig(file), /maxReworks/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("existence and declared artifacts accept empty files while explicit text predicates retain their meaning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-"));
  try {
    const workspace = await Workspace.open(directory);
    await writeFile(join(directory, "empty"), "");
    assert.equal((await checkArtifacts(workspace, [], [{ type: "file_exists", path: "empty" }])).passed, true);
    assert.equal((await checkArtifacts(workspace, ["empty"], [])).passed, true);
    const bytes = Buffer.from('\ufeff{"value":"中文"}');
    await writeFile(join(directory, "result.json"), bytes);
    const report = await checkArtifacts(workspace, ["result.json"], [
      { type: "json_value", path: "result.json", pointer: "/value", equals: "中文" },
      { type: "file_contains", path: "result.json", text: "中文" },
    ]);
    assert.equal(report.passed, true);
    assert.equal(report.files[0]!.sha256, digest(bytes), "UTF-8 decoding/BOM handling cannot change byte evidence");
    await writeFile(join(directory, "invalid.bin"), Buffer.from([0x80, 0xff]));
    await writeFile(join(directory, "nul.bin"), Buffer.from("pass\x00"));
    for (const path of ["invalid.bin", "nul.bin"]) {
      assert.equal((await checkArtifacts(workspace, [path], [{ type: "file_exists", path }])).passed, true);
      assert.equal((await checkArtifacts(workspace, [], [{ type: "file_contains", path, text: "pass" }])).passed, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("byte inspection still rejects directories, traversal and symlinks, including links inside the workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-"));
  try {
    const workspace = await Workspace.open(join(directory, "workspace"));
    await writeFile(join(directory, "outside"), "private");
    await writeFile(join(workspace.root, "inside"), "result");
    await mkdir(join(workspace.root, "folder"));
    await symlink("inside", join(workspace.root, "link"));
    await symlink(directory, join(workspace.root, "escape"));
    for (const path of ["../outside", "link", "escape/outside", "folder", "missing"]) {
      await assert.rejects(() => workspace.inspect(path));
      assert.equal((await checkArtifacts(workspace, [], [{ type: "file_exists", path }])).passed, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a changed file cannot combine an earlier artifact hash with a later passing text predicate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-"));
  try {
    const workspace = await Workspace.open(directory);
    await writeFile(join(directory, "value.json"), '{"value":1}');
    const read = workspace.readSnapshot.bind(workspace);
    workspace.readSnapshot = async (path, cwd) => {
      await writeFile(join(directory, "value.json"), '{"value":2}');
      return read(path, cwd);
    };
    const report = await checkArtifacts(workspace, ["value.json"], [{ type: "json_value", path: "value.json", pointer: "/value", equals: 2 }]);
    assert.equal(report.passed, false);
    assert.match(report.results.at(-1)!.detail, /changed during checks/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a changed large binary invalidates its command receipt and is reverified in the original Pi session", async () => {
  const f = await scriptedFixture(context => {
    if (hasTool(context, "task_prepare")) return call("task_prepare", brief("bundle.bin"));
    const writes = results(context, "bash").length;
    if (writes === 0) return call("bash", { command: 'node -e \'require("node:fs").writeFileSync("bundle.bin",Buffer.alloc(2097152,17))\'' });
    const receipt = proof(context);
    if (!receipt || (repairing(context) && results(context, "task_verify").length === 1)) return call("task_verify", {
      command: 'node -e \'require("node:assert/strict").equal(require("node:fs").statSync("bundle.bin").size,2097152)\'', inputs: [], outputs: ["bundle.bin"],
    });
    if (writes === 1) return call("bash", { command: 'node -e \'require("node:fs").writeFileSync("bundle.bin",Buffer.alloc(2097152,34))\'' });
    return call("task_submit", { summary: "已交付bundle.bin；命令只核对大小，不证明格式质量。", artifacts: ["bundle.bin"],
      criteria: [{ id: 1, status: "passed", evidence: "实际命令核对当前文件大小", proofIds: [receipt.id] }] });
  });
  try {
    const task = await f.runtime.create("交付大二进制文件，核对当前版本。", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), state => state.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, ready.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), state => state.status === "completed");
    assert.equal(done.goal!.reworks, 1);
    assert.match(done.goal!.events.find(event => event.type === "rejected")!.detail, /proof .* stale/i);
    assert.equal(done.conversations.length, 1);
    assert.equal(done.goal!.mechanical!.files[0]!.sha256, digest(await readFile(join(f.workspace, "bundle.bin"))));
    assert.equal(Object.values(done.goal!.proofs!).length, 2);
    assert.equal(done.deadlineAt, done.goal!.confirmation!.deadlineAt);
    assert.equal(done.budget.costLimit, ready.goal!.brief!.budget.maxEstimatedCostUsd);
  } finally { await f.close(); }
});

for (const limit of [0, 3]) test(`failed verification feedback preserves the actual command, exit and invariant (repair limit ${limit})`, async () => {
  const f = await scriptedFixture(context => {
    if (hasTool(context, "task_prepare")) return call("task_prepare", brief("value.json"));
    const retry = repairing(context);
    const writes = results(context, "write").length;
    if (writes === 0 || (retry && writes === 1)) return call("write", { path: "value.json", content: JSON.stringify({ value: retry ? 71 : 0 }) });
    const receipt = proof(context);
    if (!receipt || (retry && !receipt.passed)) return call("task_verify", {
      command: 'node -e \'const v=JSON.parse(require("node:fs").readFileSync("value.json","utf8")).value;if(v!==71){console.error("value.json /value: expected 71, actual "+v);process.exit(7)}\'', inputs: [], outputs: ["value.json"],
    });
    return call("task_submit", { summary: "value.json已交付", artifacts: ["value.json"], criteria: [{ id: 1, status: "passed", evidence: "运行值断言", proofIds: [receipt.id] }] });
  }, { maxReworks: limit });
  try {
    const task = await f.runtime.create("交付value.json并验证value=71。", f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(task.id), state => state.status === "awaiting_confirmation");
    await f.runtime.confirm(task.id, 1, ready.briefDigest!);
    const done = await until(() => f.runtime.status(task.id), state => state.status === (limit ? "completed" : "needs_attention"));
    const event = done.goal!.events.find(item => item.type === "rejected")!;
    assert.match(event.detail, /Proof \d+/);
    assert.match(event.detail, /exit 7/);
    assert.match(event.detail, /value.json \/value: expected 71, actual 0/);
    assert.equal(done.goal!.reworks, limit ? 1 : 0);
    assert.equal(done.messages.filter(message => message.role === "user" && String(message.content).includes("SUPERVISOR_REWORK")).length, limit ? 1 : 0);
    assert.equal(done.budget.costLimit, ready.goal!.brief!.budget.maxEstimatedCostUsd);
  } finally { await f.close(); }
});
