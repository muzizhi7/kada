import { readFile } from "node:fs/promises";
import { VERSION } from "./version.js";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { LocalRuntime, TaskMeta } from "./runtime.js";

export type TaskStatus = Awaited<ReturnType<LocalRuntime["status"]>>;
export interface HarnessClient {
  request<T>(path: string, method?: string, data?: unknown): Promise<T>;
  healthy(): Promise<boolean>;
}

export function createClient(config: Config): HarnessClient {
  const base = `http://127.0.0.1:${config.port}`;
  return {
    async healthy() {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        const data = await response.json() as { status?: string; version?: string };
        return response.ok && data.status === "ok" && data.version === VERSION;
      } catch { return false; }
    },
    async request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
      const token = (await readFile(join(config.dataDir, "token"), "utf8")).trim();
      const response = await fetch(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15_000),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error((result as { error?: string }).error ?? `HTTP ${response.status}`);
      return result as T;
    },
  };
}

export type { TaskMeta };
