import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { cloudModels } from "../src/models.js";
import { LocalRuntime } from "../src/runtime.js";

try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const config = await loadConfig();
const directory = join(config.dataDir, "live-tests", `web-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const runtime = new LocalRuntime({ ...config, dataDir: directory, maxDurationMs: 180_000, maxEstimatedCostUsd: 0.1, maxTotalTokens: undefined, review: false, web: true }, { models: cloudModels() });
try {
  const task = await runtime.create("联网搜索 DeepSeek 官方 Search API 文档，使用 web_fetch 读取官方正文。写一份简短中文 notes.md，说明 query、count、need_content 参数，附实际读取的官方文档 URL。用终端命令检查 notes.md 存在且非空，然后提交。单独执行，不需要子 Agent。", undefined,
    [{ type: "file_contains", path: "notes.md", text: "need_content" }]);
  console.log(JSON.stringify({ taskId: task.id, workspace: task.workspace }));
  for (;;) {
    const status = await runtime.status(task.id);
    if (status.status === "completed") {
      const tools = status.messages.filter(m => m.role === "toolResult" && !m.isError).map(m => m.toolName);
      for (const name of ["web_search", "web_fetch", "bash"]) assert.ok(tools.includes(name), `${name} must actually run`);
      assert.equal(status.goal?.verification?.method, "checks");
      assert.equal(status.goal?.epoch, 1);
      assert.equal(status.goal?.tokenLimit, null);
      const record = { taskId: task.id, goal: status.goal, budget: status.budget, tools, usage: status.usage };
      await writeFile(join(directory, "verification.json"), JSON.stringify(record, null, 2));
      console.log(JSON.stringify({ result: "passed", budget: status.budget, tools, verification: join(directory, "verification.json") }));
      break;
    }
    if (!["running", "pending", "verifying"].includes(status.status)) throw new Error(JSON.stringify({ status: status.status, reason: status.goal?.reason }));
    await setTimeout(300);
  }
} finally { await runtime.close(); }
