import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildPet } from "../src/pet.js";
import { serve } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { taskView } from "../src/task-view.js";
import { hasTool, scriptedFixture, until } from "../test/helpers.js";

if (process.platform !== "darwin") {
  console.log("Native pet tests require macOS 13+; no desktop process started.");
  process.exit(0);
}
const execute = promisify(execFile);
const directory = resolve(".harness", "pet-tests", randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const built = await buildPet(resolve(".harness"));
const budget = { maxEstimatedCostUsd: .25, maxDurationMs: 60000 };
const fixture = {
  id: randomUUID(), objective: "摘要", workspace: directory, status: "awaiting_confirmation", confirmed: false,
  briefDigest: "a".repeat(64), question: null, reason: null, budget: { estimatedCostUsd: .001, costLimit: .25 }, resumeBudget: budget,
  brief: { revision: 2, outcome: "中文摘要", deliverables: ["report.md"], inputs: [], criteria: [{ text: "摘要含来源", method: "inspect" }], scope: ["仅工作区"], assumptions: [], questions: [], budget }, delivery: null,
};
const fixtureFile = join(directory, "core-fixture.json");
await writeFile(fixtureFile, JSON.stringify(fixture));
const testExecutable = join(directory, "PetCoreTests");
await execute("xcrun", ["swiftc", "-O", "-parse-as-library", "desktop/PetCore.swift", "desktop/PetAppearance.swift", "desktop/PetCoreTests.swift", "-o", testExecutable]);
console.log((await execute(testExecutable, [fixtureFile])).stdout.trim());

const f = await scriptedFixture(async context => {
  if (hasTool(context, "task_prepare")) {
    const answered = JSON.stringify(context.messages).includes("面向项目同事");
    return fauxAssistantMessage(fauxToolCall("task_prepare", {
      outcome: "为项目同事整理一页中文摘要，保留来源。", deliverables: ["report.md"], inputs: ["sources/alpha.txt"],
      criteria: [{ text: "摘要使用中文，包含原始资料来源。", method: "inspect" }],
      scope: ["读取提供的资料，仅在独立输出目录生成文件。"], assumptions: ["内容采用自检，事实未做独立联网复核。"],
      questions: answered ? [] : ["这份摘要给谁看？希望控制在多长？"],
      checks: [{ type: "file_contains", path: "report.md", text: "来源" }], budget,
    }), { stopReason: "toolUse" });
  }
  if (!context.messages.some(m => m.role === "toolResult" && m.toolName === "write")) {
    await setTimeout(1000);
    return fauxAssistantMessage(fauxToolCall("write", { path: "report.md", content: "# 项目资料摘要\n\n为项目同事整理的中文摘要。资料已分类，后续按约定核对。\n\n来源：sources/alpha.txt\n" }), { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(fauxToolCall("task_submit", {
    summary: "已保存一页中文摘要，包含本地资料来源；内容自检，事实未独立复核。", artifacts: ["report.md"],
    criteria: [{ id: 1, status: "passed", evidence: "已读取原资料并检查 report.md 的中文正文与来源。" }],
  }), { stopReason: "toolUse" });
});
const socket = createServer();
await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
const port = (socket.address() as { port: number }).port;
await new Promise<void>(done => socket.close(() => done()));
const nativeHome = join(directory, "first-install-home");
await mkdir(join(nativeHome, ".agents/skills/native-smoke"), { recursive: true });
await writeFile(join(nativeHome, ".agents/skills/native-smoke/SKILL.md"), "---\nname: native-smoke\ndescription: Local first-install fixture for native pet smoke.\n---\n\nUse existing local tools.\n");
const server = await serve({ ...f.settings, port, discovery: true }, { models: f.models, discovery: { home: nativeHome } });
const supportRoot = join(homedir(), "Library", "Application Support", "Local Pi Pet", "tests");
await mkdir(supportRoot, { recursive: true, mode: 0o700 });
const nativeDirectory = await mkdtemp(join(supportRoot, "smoke-"));
try {
  const configuration = join(nativeDirectory, "launch.json");
  const apiToken = (await readFile(join(f.directory, "token"), "utf8")).trim();
  await writeFile(configuration, JSON.stringify({ dataDir: f.directory, port, version: VERSION, apiToken, smokeDirectory: nativeDirectory }), { mode: 0o600 });
  await execute("open", ["-n", "-a", built.app, "--args", "--configuration", configuration]);
  const result = await until(async () => {
    try { return JSON.parse(await readFile(join(nativeDirectory, "result.json"), "utf8")) as { ok: boolean; error?: string; taskId: string; quietWhileWorking: boolean; nativeInputChecks: number; appearanceChecks: number; petName: string; environmentReachable: boolean }; }
    catch { return null; }
  }, value => value !== null, 60_000);
  assert(result, "The packaged app must produce a native result");
  await copyFile(join(nativeDirectory, "result.json"), join(directory, "result.json"));
  assert.equal(result.ok, true, result.error ?? "Packaged native flow failed");
  assert.equal(result.environmentReachable, true);
  for (const name of ["00-kada-goal.png", "01-goal.png", "02-question.png", "03-confirm.png", "04-quiet.png", "05-delivery.png", "06-personalization.png", "07-custom-pet.png", "08-kada-states.png"]) await copyFile(join(nativeDirectory, name), join(directory, name));
  assert.equal(result.quietWhileWorking, true);
  assert.equal(result.nativeInputChecks, 12);
  assert.equal(result.appearanceChecks, 6);
  assert.equal(result.petName, "米粒");
  await writeFile(configuration, JSON.stringify({ dataDir: f.directory, port, version: VERSION, apiToken, smokeDirectory: nativeDirectory, appearanceSmokeVerifyOnly: true }), { mode: 0o600 });
  await execute("open", ["-n", "-a", built.app, "--args", "--configuration", configuration]);
  const reopened = await until(async () => {
    try { return JSON.parse(await readFile(join(nativeDirectory, "result-reopen.json"), "utf8")) as { ok: boolean; error?: string; ownedPictureRestored: boolean }; }
    catch { return null; }
  }, value => value !== null, 30_000);
  assert(reopened?.ok, reopened?.error ?? "Companion preferences must survive a real app restart");
  assert.equal(reopened.ownedPictureRestored, true);
  await copyFile(join(nativeDirectory, "result-reopen.json"), join(directory, "result-reopen.json"));
  assert.equal((await server.runtime.list()).length, 1, "personalization cannot create another task");
  const done = await until(() => server.runtime.status(result.taskId), value => value.status === "completed");
  assert.equal(done.goal?.events.filter(e => e.type === "confirmed").length, 1);
  assert.equal(done.goal?.brief?.revision, 2);
  assert.equal(done.goal?.confirmation?.revision, 2);
  assert.equal(done.budget.costLimit, .25);
  const report = await readFile(join(done.workspace, "report.md"), "utf8");
  assert.match(report, /来源/);
  await writeFile(join(directory, "report.md"), report);
  await writeFile(join(directory, "delivery-view.json"), JSON.stringify(taskView(done), null, 2));
  console.log(JSON.stringify({ nativeFlow: "passed", nativeInputChecks: result.nativeInputChecks, appearanceChecks: result.appearanceChecks, environmentReachable: result.environmentReachable, realProcessReopen: true, confirmations: 1, cloudRequests: 0, screenshots: 9, record: directory }));
} finally { await server.close(); await f.close(); await rm(nativeDirectory, { recursive: true, force: true }); }
