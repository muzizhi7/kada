import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ModelRef { provider: string; modelId: string }
export interface ComputerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools: string[];
  observationTools?: string[];
  leaseMs?: number;
}
export interface Config {
  dataDir: string;
  port: number;
  model?: ModelRef;
  subagentModel?: ModelRef;
  maxSubagents: number;
  maxDurationMs: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
  compactAtTokens?: number;
  review?: boolean;
  web?: boolean;
  /** Experimental method learning; snapshotted only for newly created tasks. */
  learning?: boolean;
  /** First-run local Agent/Skill metadata discovery; no plugins are executed by discovery. */
  discovery?: boolean;
  maxReworks?: number;
  maxStalls?: number;
  computer?: ComputerConfig;
}

export function positiveInt(value: unknown, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function modelRef(value: unknown, name: string): ModelRef | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object") throw new Error(`${name} must contain provider and modelId`);
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== "string" || !m.provider.trim() || typeof m.modelId !== "string" || !m.modelId.trim()) {
    throw new Error(`${name} must contain provider and modelId`);
  }
  return { provider: m.provider, modelId: m.modelId };
}

export async function loadConfig(filename = "harness.config.json"): Promise<Config> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Configuration must be a JSON object");
  const model = process.env.MODEL_PROVIDER && process.env.MODEL_ID
    ? { provider: process.env.MODEL_PROVIDER, modelId: process.env.MODEL_ID }
    : modelRef(raw.model, "model");
  let computer: ComputerConfig | undefined;
  if (raw.computer !== undefined) {
    const c = raw.computer as ComputerConfig;
    if (!c || typeof c.command !== "string" || !c.command.trim() || !Array.isArray(c.tools) ||
      c.tools.length === 0 || !c.tools.every(t => typeof t === "string" && t.length > 0) ||
      (c.args !== undefined && (!Array.isArray(c.args) || !c.args.every(a => typeof a === "string"))) ||
      (c.env !== undefined && (typeof c.env !== "object" || !c.env || !Object.values(c.env).every(v => typeof v === "string")))) {
      throw new Error("computer requires a command and an explicit tools allowlist (optional args and env)");
    }
    if (c.observationTools !== undefined && (!Array.isArray(c.observationTools) || !c.observationTools.every(t => typeof t === "string" && c.tools.includes(t)))) throw new Error("computer.observationTools must be selected from computer.tools");
    if (c.leaseMs !== undefined) positiveInt(c.leaseMs, "computer.leaseMs", 120_000, 3_600_000);
    computer = c;
  }
  if (raw.dataDir !== undefined && typeof raw.dataDir !== "string") throw new Error("dataDir must be a string");
  const maxEstimatedCostUsd = raw.maxEstimatedCostUsd ?? 1;
  if (typeof maxEstimatedCostUsd !== "number" || !Number.isFinite(maxEstimatedCostUsd) || maxEstimatedCostUsd <= 0) throw new Error("maxEstimatedCostUsd must be a positive number");
  return {
    dataDir: resolve(process.env.HARNESS_DATA_DIR ?? raw.dataDir as string ?? ".harness"),
    port: positiveInt(process.env.HARNESS_PORT ? Number(process.env.HARNESS_PORT) : raw.port, "port", 4317, 65535),
    model, subagentModel: modelRef(raw.subagentModel, "subagentModel"),
    maxSubagents: positiveInt(raw.maxSubagents, "maxSubagents", 3, 16),
    maxDurationMs: positiveInt(raw.maxDurationMs, "maxDurationMs", 3_600_000),
    ...(raw.maxTotalTokens === undefined ? {} : { maxTotalTokens: positiveInt(raw.maxTotalTokens, "maxTotalTokens", 500_000) }),
    maxEstimatedCostUsd,
    compactAtTokens: positiveInt(raw.compactAtTokens, "compactAtTokens", 48_000),
    review: optionalBoolean(raw.review, "review", false),
    web: optionalBoolean(raw.web, "web", true),
    learning: optionalBoolean(raw.learning, "learning", false),
    discovery: optionalBoolean(raw.discovery, "discovery", true),
    maxReworks: raw.maxReworks === 0 ? 0 : positiveInt(raw.maxReworks, "maxReworks", 3, 20),
    maxStalls: positiveInt(raw.maxStalls, "maxStalls", 2, 20),
    computer,
  };
}
