import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LocalRuntime } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";
import { webExtension } from "../src/web.js";
import { scriptedFixture, until } from "./helpers.js";

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const url = "https://example.org/source";
const requestStub = (requests: string[], status = 200): typeof fetch => async input => {
  const endpoint = String(input); requests.push(endpoint);
  return Response.json(status !== 200 ? { error: { message: "Access denied" } } : endpoint.endsWith("/search")
    ? { results: [{ title: "Actual source", url, date: "2026-10-30", summary: "Source summary" }] }
    : { title: "Actual source", content: "Verified body\n".repeat(2500) }, { status });
};

test("requested research rejects an offline draft and an uncited draft, then accepts retrieved and cited sources", async () => {
  const requests: string[] = [];
  const f = await scriptedFixture(c => {
    const reworks = c.messages.filter(m => m.role === "user" && String(m.content).includes("SUPERVISOR_REWORK")).length;
    if (!reworks) return call("task_submit", { summary: "An offline draft.", artifacts: [] });
    const results = c.messages.filter(m => m.role === "toolResult");
    if (!results.some(m => m.toolName === "web_search")) return call("web_search", { query: "official source", count: 1 });
    const page = results.find(m => m.toolName === "web_fetch");
    if (!page) return call("web_fetch", { url });
    const data = JSON.parse(page.content.find(b => b.type === "text")!.text);
    assert.equal(data.truncated, true); assert.equal(data.content.length, 16_000);
    return call("task_submit", { summary: reworks === 1 ? "Read a source but omitted the citation." : `Finding based on [the retrieved source](${url}). Full body: ${data.file}`, artifacts: [] });
  }, { web: false }, async workspace => [webExtension(await Workspace.open(workspace), { key: "test-key", fetch: requestStub(requests) })]);
  try {
    const task = await f.runtime.create("请联网搜索并查资料，给出有引用的答案。", f.workspace);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.goal?.reworks, 2);
    assert.equal(requests.length, 2);
    assert.equal(status.budget.estimatedCostUsd, 0.0015);
    const page = status.messages.find(m => m.role === "toolResult" && m.toolName === "web_fetch")!;
    const saved = JSON.parse(page.content.find(b => b.type === "text")!.text);
    assert.equal(JSON.parse(await readFile(saved.file, "utf8")).content.length, "Verified body\n".length * 2500);
    assert.ok(status.goal?.mechanical?.results.some(r => r.label === "requested live research" && r.passed));
    assert.equal(status.conversations.length, 1);
  } finally { await f.close(); }
});

test("a provider access denial remains a real blocker instead of silently switching channels", async () => {
  const requests: string[] = [];
  const f = await scriptedFixture(c => {
    const failed = c.messages.find(m => m.role === "toolResult" && m.toolName === "web_fetch");
    if (!failed) return call("web_fetch", { url });
    assert.equal(failed.isError, true); assert.match(JSON.stringify(failed.content), /403/);
    return call("task_blocked", { reason: "The source provider denied access (HTTP 403)." });
  }, { web: false }, async workspace => [webExtension(await Workspace.open(workspace), { key: "test-key", fetch: requestStub(requests, 403) })]);
  try {
    const task = await f.runtime.create("Read the source page.", f.workspace);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "blocked");
    assert.equal(requests.length, 1);
    assert.equal(status.goal?.verification, null);
  } finally { await f.close(); }
});

test("a cited research delivery can include a large binary without the citation scan rejecting it as text", async () => {
  const requests: string[] = [];
  const f = await scriptedFixture(context => {
    const results = context.messages.filter(message => message.role === "toolResult");
    if (!results.some(message => message.toolName === "web_search")) return call("web_search", { query: "official source", count: 1 });
    if (!results.some(message => message.toolName === "web_fetch")) return call("web_fetch", { url });
    return call("task_submit", { summary: `资料来源 ${url}；bundle.zip为二进制交付，文件哈希不证明包内容正确。`, artifacts: ["bundle.zip"] });
  }, { web: false }, async workspace => [webExtension(await Workspace.open(workspace), { key: "test-key", fetch: requestStub(requests) })]);
  try {
    await writeFile(join(f.workspace, "bundle.zip"), Buffer.alloc(2 * 1024 * 1024, 0x80));
    const task = await f.runtime.create("请联网查资料并交付bundle.zip。", f.workspace);
    const done = await until(() => f.runtime.status(task.id), state => state.status === "completed");
    assert.equal(done.goal!.reworks, 0);
    assert.equal(done.goal!.mechanical!.files[0]!.bytes, 2 * 1024 * 1024);
    assert.match(done.goal!.mechanical!.notices!.join("\n"), /Citation scan skipped/);
    assert.equal(done.goal!.mechanical!.results.find(result => result.label === "requested live research")!.passed, true);
    assert.equal(requests.length, 2);
  } finally { await f.close(); }
});

test("a real cost limit persists across restart and only explicit resume grants another budget", async () => {
  const requests: string[] = [];
  const f = await scriptedFixture(async (c, signal) => {
    if (!c.messages.some(m => m.role === "toolResult" && m.toolName === "web_search")) return call("web_search", { query: "source", count: 1 });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 600); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
    return call("task_submit", { summary: "Search finished.", artifacts: [] });
  }, { web: false, maxEstimatedCostUsd: 0.0005 }, async workspace => [webExtension(await Workspace.open(workspace), { key: "test-key", fetch: requestStub(requests) })]);
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create("Find a source.", f.workspace);
    const first = await until(() => f.runtime.status(task.id), s => s.status === "budget_limited");
    assert.equal(first.budget.costLimit, 0.0005);
    assert.equal(first.budget.estimatedCostUsd, 0.00075);
    await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models, extensions: [webExtension(await Workspace.open(f.workspace), { key: "test-key", fetch: requestStub(requests) })] });
    await reopened.recover();
    assert.equal((await reopened.status(task.id)).status, "budget_limited");
    assert.equal((await reopened.status(task.id)).budget.costLimit, 0.0005);
    await reopened.resume(task.id);
    const status = await until(() => reopened!.status(task.id), s => s.status === "completed");
    assert.equal(status.budget.costLimit, 0.00125);
    assert.equal(status.goal?.epoch, 2);
    assert.equal(requests.length, 1, "completed search must not be repeated on recovery");
  } finally { await reopened?.close(); await f.close(); }
});
