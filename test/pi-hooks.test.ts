import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GoalDoc, goalExtension } from "../src/goal.js";
import { localEnvironment, localExecution } from "../src/execution.js";
import { until } from "./helpers.js";

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("Pi onYield continues a natural answer; failed tools continue normally; task_submit terminates without onYield", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-hook-boundary-")));
  let yields = 0, rounds = 0;
  const probe = defineExtension({ name: "hook_probe", hooks: [hook(GenerationTask, {
    onYield: () => { yields++; return { continue: "PI_HOOK_CONTINUE: inspect the real result and submit it." }; },
    afterTools: () => { rounds++; },
  })], tools: [defineTool({ name: "fail_once", description: "Return a controlled tool failure for the hook probe.", parameters: Type.Object({}), execute: async () => { throw new Error("probe failure"); } })] });
  const faux = fauxProvider({ provider: "hook-test", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 10 }, () => c => {
    const results = c.messages.filter(m => m.role === "toolResult");
    if (!c.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("PI_HOOK_CONTINUE"))) return fauxAssistantMessage("Draft only; no artifact yet.");
    if (!results.length) return call("fail_once", {});
    assert.ok(results[0]?.isError, "Pi must expose the actual tool failure");
    if (!results.some(m => m.toolName === "write")) return call("write", { path: "result.txt", content: "verified local artifact" });
    return call("task_submit", { summary: "Result saved.", artifacts: ["result.txt"] });
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(), extensions = [localExecution(), goalExtension(), probe];
  for (const e of extensions) registry.install(e);
  const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
  const harness = await Harness.open(storage, { models, registry, env: () => localEnvironment(directory) }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "hook-test", modelId: "scripted" }, cwd: directory, extensions } });
    const input = await root.submit({ type: "input", requestId: "initial", content: "Create result.txt, verify it and submit." }, ctx);
    assert.equal((await input.wait(ctx)).status, "done");
    assert.equal(yields, 1, "a terminating submission bypasses onYield even when it always requests continuation");
    assert.equal(rounds, 3, "afterTools observes failure, write and terminating submission");
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "verified local artifact");
    const state = await harness.commit(async tx => ({ ...(await tx.doc(GoalDoc)) }), ctx);
    assert.equal(state.phase, "submitted", "the hook alone does not verify candidate quality");
    const inputs = await storage.scanSubmissions({ conversationId: root.id }, 100, undefined, ctx);
    assert.deepEqual(inputs.items.map(s => s.requestId), ["initial"], "Pi's hook continuation is internal, with no host submission");
    const messages = (await root.context(ctx)).messages;
    assert.equal(messages.filter(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("PI_HOOK_CONTINUE")).length, 1);
  } finally { await harness.close(ctx); await rm(directory, { recursive: true, force: true }); }
});

test("Pi hook continuation survives compaction and SIGKILL without duplicate input or side effects", { timeout: 25_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-hook-crash-")));
  let processHandle: ChildProcess | undefined;
  const worker = (mode: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/hooks-worker.ts", import.meta.url)), mode, directory], { stdio: ["ignore", "pipe", "pipe"] });
    processHandle = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { child, exit, stdout: () => stdout, stderr: () => stderr };
  };
  try {
    const first = worker("create");
    await until(async () => first.stdout(), text => text.includes('"type":"ready"'));
    const before = JSON.parse(first.stdout().trim().split("\n").at(-1)!);
    first.child.kill("SIGKILL"); await first.exit;
    await writeFile(join(directory, "release"), "resume");
    const second = worker("recover");
    assert.equal(await second.exit, 0, second.stderr());
    const after = JSON.parse(second.stdout().trim().split("\n").at(-1)!);
    assert.equal(after.type, "completed");
    assert.equal(after.inputId, before.inputId);
    assert.equal(after.inputRequests, 1);
    assert.equal(after.continuations, 1);
    assert.equal(after.bashCalls, 1);
    assert.ok(after.compactions >= 1);
    assert.equal(after.phase, "submitted");
    assert.equal(await readFile(join(directory, "effects.txt"), "utf8"), "once\n");
  } finally { processHandle?.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
});
