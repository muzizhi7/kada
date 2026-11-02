import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LocalRuntime } from "../src/runtime.js";
import { scriptedFixture, demoFixture, until } from "./helpers.js";

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("Pi native bash computes artifacts; the goal repairs a bad result without user continuation or a mandatory reviewer", async () => {
  const f = await scriptedFixture(c => {
    const retries = c.messages.filter(m => m.role === "user" && typeof m.content === "string" && m.content.includes("SUPERVISOR_REWORK")).length;
    const commands = c.messages.filter(m => m.role === "toolResult" && m.toolName === "bash");
    if (!retries) return fauxAssistantMessage("Done.");
    if (commands.length < retries) return call("bash", { command: `node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync("inputs/values.json","utf8"));fs.writeFileSync("result.json",JSON.stringify({total:${retries === 1 ? "0" : "v.reduce((a,b)=>a+b,0)"}}));console.log("computed")'`, timeout: 10 });
    return call("task_submit", { summary: "The checked total is 71.", artifacts: ["result.json"] });
  });
  try {
    await writeFile(join(f.workspace, "inputs", "values.json"), "[12,23,17,19]");
    const task = await f.runtime.create("Compute the total from inputs/values.json and save result.json.", f.workspace, [{ type: "json_value", path: "result.json", pointer: "/total", equals: 71 }]);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")).total, 71);
    assert.equal(status.goal?.reworks, 2);
    assert.equal(status.conversations.length, 1);
    assert.equal(status.goal?.verification?.method, "checks");
    assert.equal(status.goal?.tokenLimit, null);
    assert.equal(status.goal?.epoch, 1);
    assert.ok(status.messages.some(m => m.role === "toolResult" && m.toolName === "bash" && !m.isError));
  } finally { await f.close(); }
});

test("Pi read supports line ranges and native edit changes only requested text", async () => {
  const f = await scriptedFixture(c => {
    const results = c.messages.filter(m => m.role === "toolResult");
    if (!results.some(m => m.toolName === "write")) return call("write", { path: "notes.txt", content: "one\ntwo\nthree\nfour\nfive\n" });
    const read = results.find(m => m.toolName === "read");
    if (!read) return call("read", { path: "notes.txt", offset: 2, limit: 2 });
    const text = JSON.stringify(read.content);
    assert.match(text, /two/); assert.match(text, /three/); assert.doesNotMatch(text, /one/);
    if (!results.some(m => m.toolName === "edit")) return call("edit", { path: "notes.txt", edits: [{ oldText: "three", newText: "updated" }] });
    return call("task_submit", { summary: "Edited and checked the notes.", artifacts: ["notes.txt"] });
  });
  try {
    const task = await f.runtime.create("Edit notes.txt.", f.workspace, [{ type: "file_contains", path: "notes.txt", text: "updated" }]);
    await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(await readFile(join(f.workspace, "notes.txt"), "utf8"), "one\ntwo\nupdated\nfour\nfive\n");
  } finally { await f.close(); }
});

test("native commands do not inherit daemon credentials and Pi cancels a running command on pause", async () => {
  const previous = process.env.PRIVATE_FOR_EXECUTION_TEST;
  process.env.PRIVATE_FOR_EXECUTION_TEST = "should-not-reach-command";
  const f = await scriptedFixture(c => {
    const done = c.messages.filter(m => m.role === "toolResult");
    if (!done.length) return call("bash", { command: "node -e 'const fs=require(\"node:fs\");fs.writeFileSync(\"process.json\",JSON.stringify({pid:process.pid,secret:process.env.PRIVATE_FOR_EXECUTION_TEST??null}));setTimeout(()=>{},300000)'", timeout: 300 });
    if (!done.some(m => m.toolName === "read")) return call("read", { path: "process.json" });
    return call("task_submit", { summary: "Inspected the interrupted command state.", artifacts: ["process.json"] });
  });
  try {
    const task = await f.runtime.create("Run the local command and inspect it after interruption.", f.workspace);
    const data = await until(() => readFile(join(f.workspace, "process.json"), "utf8").then(JSON.parse, () => undefined), v => !!v?.pid);
    assert.equal(data.secret, null);
    await f.runtime.pause(task.id);
    await until(async () => { try { process.kill(data.pid, 0); return true; } catch { return false; } }, alive => !alive);
    await f.runtime.resume(task.id);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed");
    assert.equal(status.messages.filter(m => m.role === "assistant").flatMap(m => m.content).filter(b => b.type === "toolCall" && b.name === "bash").length, 1);
  } finally {
    if (previous === undefined) delete process.env.PRIVATE_FOR_EXECUTION_TEST; else process.env.PRIVATE_FOR_EXECUTION_TEST = previous;
    await f.close();
  }
});

test("Pi performs proactive compaction while the original goal continues", async () => {
  let writes = 0, summaries = 0;
  const f = await scriptedFixture(c => {
    if (c.messages.some(m => m.role === "system" && typeof m.content === "string" && m.content.includes("context summarization assistant"))) {
      summaries++; return fauxAssistantMessage("Goal: write three chunks, then submit their paths. Progress and requirements remain in task_status. Continue the original task.");
    }
    if (writes < 4) return call("write", { path: `chunk-${writes++}.txt`, content: "retained evidence ".repeat(1200) });
    return call("task_submit", { summary: "All chunks were saved.", artifacts: Array.from({ length: 4 }, (_, i) => `chunk-${i}.txt`) });
  }, { compactAtTokens: 3500 });
  try {
    const task = await f.runtime.create("Persist four chunks and verify their existence.", f.workspace);
    const status = await until(() => f.runtime.status(task.id), s => s.status === "completed", 30_000);
    assert.ok(summaries > 0, "Pi's own summarization must be used");
    assert.ok(status.compactions > 0);
    assert.equal(status.goal?.revision, 1);
    assert.equal(status.goal?.epoch, 1);
    assert.equal(status.goal?.reworks, 0);
  } finally { await f.close(); }
});

test("a stored v0.2 task still resumes with its original tools and review semantics", async () => {
  const f = await demoFixture();
  try {
    const id = randomUUID(), directory = join(f.directory, "tasks", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "task.json"), JSON.stringify({ id, objective: "Complete the offline two-worker demonstration.", workspace: f.workspace, model: f.config.model,
      createdAt: Date.now(), deadlineAt: Date.now() + 30_000, maxSubagents: 2, control: "paused", schemaVersion: 2, maxTotalTokens: 500_000 }));
    const runtime = new LocalRuntime({ ...f.config, review: false }, { models: f.models });
    try {
      await runtime.recover(); await runtime.resume(id);
      const status = await until(() => runtime.status(id), s => s.status === "completed");
      assert.equal(status.schemaVersion, 2);
      assert.equal(status.goal?.verification?.method, "model");
      assert.ok(status.messages.some(m => m.role === "toolResult" && m.toolName === "write_file"));
    } finally { await runtime.close(); }
  } finally { await f.close(); }
});
