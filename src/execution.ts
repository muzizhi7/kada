import { createBashTool, createCodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineExtension, type CompactionPolicy, type CompactionSettings } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "./config.js";

// Local commands get normal user tooling paths, not the daemon's provider credentials.
function shellEnvironment(): Record<string, string> {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SHELL", "TERM", "SystemRoot", "COMSPEC", "PATHEXT"];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

/** Pi owns command execution, cancellation, file operations, truncation and output spilling. */
export function localExecution() {
  const tools = createCodingTools();
  return defineExtension({ ...tools, tools: [
    ...tools.tools!.filter(tool => tool.name !== "bash"),
    createBashTool({ prepare(execution) { execution.inheritEnv = false; execution.env = shellEnvironment(); } }),
  ] });
}

export function localEnvironment(cwd: string): NodeExecutionEnv {
  return new NodeExecutionEnv({ cwd, shellEnv: shellEnvironment() });
}

/** Configure Pi's existing background compaction; do not implement a second context manager. */
export function taskCompaction(models: Models, refs: ModelRef[], trigger = 48_000): CompactionSettings {
  const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};
  for (const ref of refs) {
    const window = models.getModel(ref.provider, ref.modelId)?.contextWindow;
    if (!window || window <= 0) continue;
    const reserveTokens = Math.min(16_384, Math.floor(window / 4));
    const blocking = window - reserveTokens;
    const threshold = Math.min(trigger, Math.floor(blocking * 0.8));
    modelOverrides[`${ref.provider}/${ref.modelId}`] = {
      enabled: true, reserveTokens, backgroundTokens: blocking - threshold,
      keepRecentTokens: Math.max(256, Math.min(16_000, Math.floor(threshold / 3))),
    };
  }
  return { modelOverrides };
}
