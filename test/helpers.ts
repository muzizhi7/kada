import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { demoModels } from "../src/models.js";
import { LocalRuntime, type RuntimeOptions } from "../src/runtime.js";
import { prepareDemo } from "../src/demo.js";
import type { Config } from "../src/config.js";
import { createModels, fauxProvider, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";

export function hasTool(context: TranscriptContext, name: string): boolean { return getCurrentTools(context.messages).some(t => t.name === name); }

export async function demoFixture(delayMs = 0, maxDurationMs = 30_000) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-harness-")));
  const workspace = join(directory, "workspace");
  await prepareDemo(workspace);
  const { models, ref } = demoModels(workspace, { delayMs });
  const config: Config = { dataDir: directory, port: 4317, model: ref, maxSubagents: 2, maxDurationMs, review: true, web: false, discovery: false };
  const runtime = new LocalRuntime(config, { models });
  return { directory, workspace, config, runtime, models, async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(value).slice(0, 4000)}`);
    await setTimeout(25);
  }
}

export async function scriptedFixture(respond: (context: TranscriptContext, signal?: AbortSignal) => AssistantMessage | Promise<AssistantMessage>, config: Partial<Config> = {}, extensions: (workspace: string) => Extension[] | Promise<Extension[]> = () => [], options: Omit<RuntimeOptions, "models" | "extensions"> = {}) {
  const f = await demoFixture();
  const faux = fauxProvider({ provider: "local-test", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 256 }, () => (context, options) => respond(context, options?.signal)));
  const models = createModels(); models.setProvider(faux.provider);
  const settings = { ...f.config, model: { provider: "local-test", modelId: "scripted" }, review: false, ...config };
  const runtime = new LocalRuntime(settings, { ...options, models, extensions: await extensions(f.workspace) });
  return { ...f, runtime, settings, models, async close() { await runtime.close(); await f.close(); } };
}
