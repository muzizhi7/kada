import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { cloudModels } from "./models.js";
import { errorText } from "./util.js";
import { createClient, type TaskMeta, type TaskStatus } from "./client.js";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { briefText, usageText, verificationText } from "./presentation.js";

try { loadEnvFile(".env"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const args = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, workspace: { type: "string" }, acceptance: { type: "string" }, detach: { type: "boolean", default: false }, yes: { type: "boolean", default: false }, refresh: { type: "boolean", default: false }, help: { type: "boolean" },
} });
const [command = "chat", id, ...rest] = args.positionals;
const config = await loadConfig(args.values.config);
const client = createClient(config);
const { request } = client;

try {
  if (args.values.help || command === "help") {
    console.log(`Kada\n\n  npm run chat                             Chat in the terminal; starts/reuses the daemon\n  npm run harness -- chat [task-id]         Start chat or reconnect to a task\n  npm run dev                              Start only the local daemon\n  npm run demo                             Run the explicit offline simulation\n  npm run discover                         Inspect discovered local Agents/Skills/plugins\n  npm run discover -- --refresh             Refresh local discovery metadata\n  npm run harness -- models [provider]      List the installed Pi model catalog\n  npm run harness -- run "goal" --detach    Create a background task\n  npm run harness -- run "goal" --workspace /absolute/path\n  npm run harness -- status [task-id]       Inspect tasks, workers and usage\n  npm run harness -- pause <task-id>\n  npm run harness -- resume <task-id>       Resume with another configured task budget\n  npm run harness -- cancel <task-id>\n  npm run harness -- follow-up <task-id> "message"\n\nrun also accepts --acceptance <checks.json>. All commands accept --config <file>. Configure cloud model credentials through environment variables.`);
    console.log("\n默认 run 先准备待确认说明；在 chat 中 /attach 后确认。只有已有明确授权时使用 run --yes 或聊天 /run，沿用配置预算直接执行。");
  } else if (command === "chat") {
    const { ensureDaemon } = await import("./daemon.js");
    const { runChat } = await import("./chat.js");
    const daemon = await ensureDaemon(config, args.values.config);
    console.log(daemon.started ? `已启动后台服务（PID ${daemon.pid}），退出聊天后任务仍可继续。` : "已连接本地后台服务。");
    await runChat(createClient(config), { taskId: id, workspace: args.values.workspace ? resolve(args.values.workspace) : undefined });
  } else if (command === "serve") {
    const { serve } = await import("./server.js");
    const server = await serve(config);
    console.log(`Kada: http://127.0.0.1:${config.port}\nState: ${config.dataDir}\nCloud model: ${config.model ? `${config.model.provider}/${config.model.modelId}` : "not configured"}`);
    const stop = () => { void server.close().then(() => process.exit(0), error => { console.error(errorText(error)); process.exit(1); }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (command === "models") {
    const models = cloudModels().getModels(id);
    console.log(models.map(m => `${m.provider}/${m.id}`).join("\n"));
  } else if (command === "discover") {
    if (!config.discovery) console.log("本机环境发现已关闭（discovery: false）。");
    else {
      const { LocalDiscovery } = await import("./discovery.js");
      // Prefer the running daemon so its in-memory cache is refreshed too.
      const view = await client.healthy() ? await request<Awaited<ReturnType<InstanceType<typeof LocalDiscovery>["view"]>>>(args.values.refresh ? "/v1/environment/refresh" : "/v1/environment", args.values.refresh ? "POST" : "GET", args.values.refresh ? {} : undefined)
        : await new LocalDiscovery(config.dataDir).view(args.values.refresh);
      console.log(`已发现 ${view.agents} 份 Agent/共享配置、${view.skills} 个 Skills、${view.plugins} 条插件/MCP 记录。\n本机概况：${view.overview}\nSkills 目录：${view.catalogue}`);
      for (const notice of view.notices) console.log(notice);
    }
  } else if (command === "demo") {
    const { runDemo } = await import("./demo.js");
    await runDemo(resolve(config.dataDir, "demos", randomUUID()));
  } else if (command === "status") {
    console.log(JSON.stringify(await request(id ? `/v1/tasks/${id}` : "/v1/tasks"), null, 2));
  } else if (command === "run") {
    if (!await client.healthy()) throw new Error("后台未就绪或版本不匹配，请先用 npm run chat 启动/连接当前版本的后台。");
    const objective = [id, ...rest].filter(Boolean).join(" ");
    const acceptance = args.values.acceptance ? JSON.parse(await readFile(args.values.acceptance, "utf8")) : undefined;
    const task = await request<TaskMeta>("/v1/tasks", "POST", { objective, workspace: args.values.workspace ? resolve(args.values.workspace) : undefined, acceptance, confirmed: args.values.yes });
    console.log(`Task: ${task.id}\nWorkspace: ${task.workspace}`);
    if (task.preparation) console.log(`先整理目标和预算；进入聊天 /attach ${task.id} 后确认。已有明确授权可使用 run --yes。`);
    if (!args.values.detach) {
      let previous = "";
      for (;;) {
        const status = await request<TaskStatus>(`/v1/tasks/${task.id}`);
        if (status.status !== previous) console.log(`Status: ${status.status}`);
        previous = status.status;
        if (!["running", "pending", "verifying"].includes(status.status)) {
          if (["clarifying", "awaiting_confirmation"].includes(status.status)) {
            console.log(`${briefText(status)}\n进入 npm run chat，/attach ${task.id} 后补充信息或确认。`);
            break;
          }
          console.log(`${verificationText(status)}\n${usageText(status)}`);
          const answer = [...status.messages].reverse().find(m => m.role === "assistant");
          console.log(status.status === "completed" ? status.goal?.candidate?.summary : status.goal?.question ?? status.goal?.reason ?? answer?.content?.filter(b => b.type === "text").map(b => b.text).join("\n") ?? JSON.stringify(status.submission));
          if (status.status !== "completed") process.exitCode = 1;
          break;
        }
        await setTimeout(1000);
      }
    }
  } else if (["pause", "resume", "cancel"].includes(command)) {
    if (!id) throw new Error("Provide a task ID");
    await request(`/v1/tasks/${id}/${command}`, "POST", {});
    console.log(`${command}: ${id}`);
  } else if (command === "follow-up") {
    if (!id) throw new Error("Provide a task ID and a message");
    await request(`/v1/tasks/${id}/messages`, "POST", { message: rest.join(" "), requestId: randomUUID() });
    console.log(`Follow-up admitted: ${id}`);
  } else { throw new Error(`Unknown command: ${command}`); }
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
