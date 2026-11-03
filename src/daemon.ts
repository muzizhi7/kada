import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
import type { Config } from "./config.js";
import { createClient } from "./client.js";
import { VERSION } from "./version.js";

/** Start a separate daemon so exiting the terminal chat does not stop a long task. */
export async function ensureDaemon(config: Config, configFile?: string): Promise<{ started: boolean; pid?: number }> {
  const client = createClient(config);
  if (await client.healthy()) {
    // Validate the state directory/token too, rather than using an unrelated daemon on the port.
    await client.request("/v1/tasks");
    return { started: false };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as { status?: string; version?: string; capabilities?: string[] };
    if (response.ok && health.status === "ok" && health.version && health.version !== VERSION) {
      throw new Error(`后台服务版本为 ${health.version}，当前客户端需要 ${VERSION}。请先重启原来的后台服务（npm run dev），再运行聊天。`);
    }
    if (response.ok && health.status === "ok" && health.version === VERSION && !health.capabilities?.includes("ordinary-chat")) {
      throw new Error("后台服务尚未加载普通会话功能，请重启原来的后台服务（npm run dev），再运行聊天。已有会话和任务会保留。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("后台服务")) throw error;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logfile = join(config.dataDir, "daemon.log");
  const log = await open(logfile, "a", 0o600);
  const source = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));
  const loader = source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
  let failure: string | undefined;
  let ended = false;
  const child = spawn(process.execPath, [...loader, cli, "serve", ...(configFile ? ["--config", resolve(configFile)] : [])], {
    cwd: process.cwd(), env: process.env, detached: true, windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.once("error", error => { failure = error.message; });
  child.once("exit", () => { ended = true; });
  child.unref();
  await log.close();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failure) throw new Error(`无法启动后台服务：${failure}`);
    if (await client.healthy()) {
      await client.request("/v1/tasks");
      return { started: true, pid: child.pid };
    }
    if (ended) break;
    await setTimeout(150);
  }
  throw new Error(`后台服务未能就绪。请查看 ${logfile}`);
}
