import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { acceptanceChecks, CheckSchema, type AcceptanceCheck } from "./checks.js";
import { GoalDoc, goalEvent, goalExtension, plain, type GoalState } from "./goal.js";
import type { PathSnapshot, Workspace } from "./workspace.js";

export type TaskBudget = { maxEstimatedCostUsd: number; maxDurationMs: number; maxTotalTokens?: number };
export type TaskBrief = {
  revision: number;
  outcome: string;
  deliverables: string[];
  inputs: string[];
  criteria: { text: string; method: "check" | "inspect";
    verification?: { command: string; inputs: string[]; outputs: string[] } }[];
  scope: string[];
  assumptions: string[];
  questions: string[];
  checks: AcceptanceCheck[];
  budget: TaskBudget;
};
export type Confirmation = { revision: number; digest: string; at: number; deadlineAt: number; requestId: string;
  verificationInputs?: Record<string, PathSnapshot[]> };

export function briefDigest(brief: TaskBrief): string {
  return createHash("sha256").update(JSON.stringify(brief)).digest("hex");
}
export function budgetValues(value: TaskBudget): TaskBudget {
  if (!Number.isFinite(value.maxEstimatedCostUsd) || value.maxEstimatedCostUsd <= 0) throw new Error("Budget cost must be a positive finite USD amount");
  if (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1) throw new Error("Budget duration must be a positive integer in milliseconds");
  if (value.maxTotalTokens !== undefined && (!Number.isSafeInteger(value.maxTotalTokens) || value.maxTotalTokens < 1)) throw new Error("Token budget must be a positive integer");
  return { maxEstimatedCostUsd: value.maxEstimatedCostUsd, maxDurationMs: value.maxDurationMs, ...(value.maxTotalTokens === undefined ? {} : { maxTotalTokens: value.maxTotalTokens }) };
}

const text = Type.String({ minLength: 1, maxLength: 2000 });
const lines = (minimum = 0, maximum = 16) => Type.Array(text, { minItems: minimum, maxItems: maximum });

/** Only reads and one business-state tool; execution tools are absent until host confirmation. */
export function preparationExtension(workspace: Workspace, defaults: TaskBudget, options: {
  /** Ordinary conversations create business goal state only when this tool is used. */
  startGoal?: () => Promise<Pick<GoalState, "objective" | "userMessages" | "tokenLimit" | "costLimit">>;
} = {}) {
  return defineExtension({ name: options.startGoal ? "local_conversation" : "local_preparation", tools: [
    createReadTool(),
    ...goalExtension().tools!.filter(t => !options.startGoal && t.name === "task_status"),
    defineTool({
      name: "list_files", description: "List existing workspace materials, without modifying anything.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }), replay: "safe",
      execute: async (args, _api, ctx) => ({ output: [{ type: "text", text: (await workspace.list(args.path)).join("\n") }] }),
    }),
    defineTool({
      name: "task_prepare", description: (options.startGoal ? "Start a Goal only for substantive work the user actually requested: concrete deliverables, project/file changes or sustained execution. Never use for greetings, questions, advice, background/memory discussion or closing remarks; answer those directly. " : "") + "Save a concise task brief for the user. Ask only material unanswered questions; otherwise propose deliverables, scope, standards and total budget. For an existing project test or supplied independent checker, put its exact command and unchanged input paths plus expected output paths in criterion.verification (check only). Inputs must already exist; confirmation pins their original bytes. Do not list editable source as immutable input. New self-tests remain ordinary checks and are not independent proof. Only the host can accept user confirmation. Ends this planning run.",
      parameters: Type.Object({
        outcome: text, deliverables: lines(1), inputs: lines(),
        criteria: Type.Array(Type.Object({ text, method: Type.Union([Type.Literal("check"), Type.Literal("inspect")]),
          verification: Type.Optional(Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }),
            inputs: lines(1), outputs: lines(1) })) }), { minItems: 1, maxItems: 16 }),
        scope: lines(1), assumptions: lines(), questions: lines(0, 3),
        checks: Type.Optional(Type.Array(CheckSchema, { maxItems: 32 })),
        budget: Type.Optional(Type.Object({ maxEstimatedCostUsd: Type.Number({ exclusiveMinimum: 0 }), maxDurationMs: Type.Integer({ minimum: 1 }), maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1 })) })),
      }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, ctx) => {
        for (const criterion of args.criteria) if (criterion.verification) {
          for (const path of criterion.verification.inputs) {
            try { await workspace.inspectPath(path); }
            catch { throw new Error(`Verification input must already exist as an original file/directory: ${path}. Put new tests and editable source in outputs, or use an ordinary self-check without a fixed verification contract.`); }
          }
        }
        const initial = options.startGoal ? await options.startGoal() : undefined;
        const result = await api.commit(async tx => {
          const state = await tx.doc(GoalDoc), key = String(api.taskId);
          if (!state.appliedTools[key]) {
            if (state.confirmation || state.phase !== "working") throw new Error("The task is not accepting preparation changes");
            for (const criterion of args.criteria) if (criterion.verification && (criterion.method !== "check" || !criterion.verification.command.trim())) {
              throw new Error("A fixed verification command requires a check criterion and a nonempty command");
            }
            const checks = acceptanceChecks(args.checks);
            const merged = new Set([...state.checks.map(c => JSON.stringify(c.check)), ...checks.map(c => JSON.stringify(c))]);
            if (merged.size > 32) throw new Error("At most 32 acceptance checks per task");
            if (initial && !state.initialized) {
              Object.assign(state, initial, { initialized: true });
              goalEvent(state, "created", state.objective);
            }
            state.brief = { ...args, revision: (state.brief?.revision ?? 0) + 1, checks, budget: budgetValues({ ...defaults, ...args.budget }) };
            state.phase = args.questions.length ? "clarifying" : "awaiting_confirmation";
            state.question = args.questions.length ? args.questions.join("\n") : null;
            state.reason = args.questions.length ? "Material information is missing; no execution has been authorized." : "Review the task brief and total budget before execution.";
            state.appliedTools[key] = true;
            goalEvent(state, state.phase, `${state.brief.revision}: ${args.outcome}`);
          }
          return plain({ revision: state.brief?.revision, phase: state.phase });
        }, ctx);
        return { output: [{ type: "text", text: JSON.stringify(result) }], control: { terminate: true } };
      },
    }),
  ] });
}

/** Exact, contextual acknowledgements; edits or qualified consent are never silently accepted. */
export function isConfirmation(text: string): boolean {
  const acknowledgement = text.trim().replace(/[，,。.!！\s]/gu, "");
  return new Set(["确认", "确认开始", "确认执行", "确认并执行", "按这个开始", "按此执行", "开始吧", "开始执行", "可以开始", "可以开始执行", "好的开始吧", "好的执行吧", "好的可以开始", "好的可以开始执行", "好", "好的", "可以", "同意"]).has(acknowledgement)
    || /^(?:好的?|可以|同意)?(?:就)?按(?:这个|此)(?:方案)?(?:开始|执行|做吧)$/u.test(acknowledgement);
}
