import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ConversationId, type Harness, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { acceptanceChecks, CheckSchema, type AcceptanceCheck, type MechanicalReport } from "./checks.js";
import type { Confirmation, TaskBrief } from "./preparation.js";
import type { CheckReceipt, CriterionResult } from "./verification.js";
import type { LearningState } from "./learning.js";
import type { SkillState } from "./skills.js";

export type GoalPhase = "working" | "clarifying" | "awaiting_confirmation" | "submitted" | "verifying" | "completed" | "waiting_user" | "blocked" | "needs_attention" | "failed";
export type ReviewVerdict = { verdict: "pass" | "rework" | "blocked"; reason: string; evidence: string[] };
export type GoalState = {
  initialized: boolean;
  revision: number;
  epoch: number;
  objective: string;
  userMessages: string[];
  phase: GoalPhase;
  brief?: TaskBrief;
  confirmation?: Confirmation;
  proofs?: Record<string, CheckReceipt>;
  learning?: LearningState;
  skills?: SkillState;
  localSkillReads?: { path: string; sha256: string }[];
  plan: { id: string; title: string; status: "pending" | "running" | "done"; evidence: string }[];
  checks: { source: "user" | "agent"; check: AcceptanceCheck }[];
  candidate: { id: string; revision: number; summary: string; artifacts: string[]; criteria?: CriterionResult[]; skill?: string } | null;
  review: { conversationId: ConversationId; requestId: string; candidateId: string } | null;
  mechanical: MechanicalReport | null;
  verification: { completedAt: number; reviewer: ConversationId | null; result: ReviewVerdict; method?: "checks" | "model" } | null;
  reworks: number;
  stalls: number;
  lastFingerprint: string | null;
  lastEvaluated: string | null;
  outbox: { requestId: string; content: string } | null;
  tokenLimit: number | null;
  costLimit?: number;
  reason: string | null;
  question: string | null;
  appliedTools: Record<string, boolean>;
  events: { at: number; type: string; detail: string }[];
};
export const GoalDoc = defineDoc<GoalState>({
  scope: "session", kind: "local.goal", version: 1, checkpointWhen: () => true,
  initial: () => ({ initialized: false, revision: 1, epoch: 1, objective: "", userMessages: [], phase: "working", plan: [], checks: [], candidate: null,
    review: null, mechanical: null, verification: null, reworks: 0, stalls: 0, lastFingerprint: null, lastEvaluated: null, outbox: null,
    tokenLimit: 500_000, reason: null, question: null, appliedTools: {}, events: [] }),
});
export const Reviews = defineDoc<{ verdicts: Record<string, ReviewVerdict> }>({
  scope: "session", kind: "local.reviews", version: 1, initial: () => ({ verdicts: {} }), checkpointWhen: () => true,
});

/** Chord documents are proxies inside commits; detach before returning them to the host. */
export function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function goalEvent(goal: GoalState, type: string, detail: string): void {
  goal.events.push({ at: Date.now(), type, detail: detail.slice(0, 4000) });
  if (goal.events.length > 200) goal.events.splice(0, goal.events.length - 200);
}
export async function readGoal(harness: Harness): Promise<GoalState> {
  return harness.commit(async tx => plain(await tx.doc(GoalDoc)), ctx);
}

export function goalExtension(options: { advisoryPlan?: boolean; captureSkill?: boolean } = {}) {
  const mutate = async (api: ToolExecutionApi, context: typeof ctx, action: (goal: GoalState) => void) => api.commit(async tx => {
    const goal = await tx.doc(GoalDoc);
    const key = String(api.taskId);
    if (!goal.appliedTools[key]) {
      if (goal.phase !== "working") throw new Error(`Goal is ${goal.phase}; wait for supervision or user input`);
      action(goal);
      goal.appliedTools[key] = true;
    }
    return { ok: true, revision: goal.revision, phase: goal.phase, candidateId: goal.candidate?.id ?? null };
  }, context);
  const output = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  return defineExtension({ name: "local_goal", tools: [
    defineTool({
      name: "task_status", description: "Read durable objective, plan, acceptance checks and last verification. Read this after context compaction or a restart. Proofs are concise summaries; pass proofId to inspect one full command receipt and file hashes.",
      parameters: Type.Object({ proofId: Type.Optional(Type.String({ minLength: 1 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await api.commit(async tx => {
        const goal = await tx.doc(GoalDoc);
        return plain({ objective: goal.objective, revision: goal.revision, userRequirements: goal.userMessages, phase: goal.phase,
          brief: goal.brief ?? null, confirmation: goal.confirmation ?? null,
          ...(goal.learning ? { learning: goal.learning } : {}),
          ...(goal.skills ? { skills: goal.skills } : {}),
          proofs: args.proofId ? { [args.proofId]: goal.proofs?.[args.proofId] ?? null } : Object.fromEntries(Object.values(goal.proofs ?? {}).map(p => [p.id, { passed: p.passed, exitCode: p.exitCode, command: p.command.slice(0, 120), inputs: p.inputs.length, outputs: p.outputs.length }])),
          plan: goal.plan, checks: goal.checks, candidate: goal.candidate, verification: goal.verification,
          reworks: goal.reworks, stalls: goal.stalls, reason: goal.reason, question: goal.question, tokenLimit: goal.tokenLimit, costLimit: goal.costLimit ?? null,
          failedChecks: goal.mechanical?.results.filter(r => !r.passed) ?? [] });
      }, context)) }),
    }),
    defineTool({
      name: "task_plan", description: `${options.advisoryPlan ? "Optionally record a concise plan for progress. Plan status does not gate delivery. " : ""}Persist a plan with stable step IDs; retain completed steps. Optionally APPEND executable acceptance checks. Existing checks cannot be removed or weakened. Only mark steps done through task_checkpoint with evidence.`,
      parameters: Type.Object({ steps: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }), title: Type.String({ minLength: 1, maxLength: 500 }) }), { minItems: 1, maxItems: 24 }),
        checks: Type.Optional(Type.Array(CheckSchema, { maxItems: 32 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, goal => {
        if (new Set(args.steps.map(s => s.id)).size !== args.steps.length) throw new Error("Plan step IDs must be unique");
        const added = acceptanceChecks(args.checks);
        const checks = plain(goal.checks);
        for (const check of added) if (!checks.some(c => JSON.stringify(c.check) === JSON.stringify(check))) checks.push({ source: "agent", check });
        if (checks.length > 32) throw new Error("At most 32 acceptance checks per task");
        const previous = plain(goal.plan);
        goal.plan = args.steps.map(step => ({ id: step.id, status: "pending" as const, evidence: "", ...previous.find(s => s.id === step.id), title: step.title }));
        for (const step of previous) if (step.status === "done" && !goal.plan.some(s => s.id === step.id)) goal.plan.push(step);
        goal.checks = checks;
        goalEvent(goal, "plan", `${goal.plan.length} steps, ${goal.checks.length} checks`);
      })) }),
    }),
    defineTool({
      name: "task_checkpoint", description: "Persist a plan step's state and concrete evidence. Notes alone do not prove task completion.",
      parameters: Type.Object({ stepId: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done")]), evidence: Type.String({ minLength: 1, maxLength: 2000 }) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, goal => {
        const step = goal.plan.find(s => s.id === args.stepId);
        if (!step) throw new Error("Unknown plan step ID");
        step.status = args.status; step.evidence = args.evidence;
        goalEvent(goal, "checkpoint", `${step.id}: ${step.status}: ${step.evidence}`);
      })) }),
    }),
    defineTool({
      name: "task_submit", description: `Submit a candidate for task verification and end this run. This does NOT mark the task completed. Include the actual artifacts; ${options.advisoryPlan ? "report actual checks and unresolved requirements, without registering optional plan checkpoints just to submit" : "finish any plan checkpoints first"}. For a confirmed brief cover every criterion (1-based ID) with status, concrete evidence and current task_verify proof IDs for command checks. For a text-only request submit its answer in summary and an empty artifacts array.`,
      parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 16000 }), artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
        ...(options.captureSkill ? { skill: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: "Optional standard Skill directory already included in freshly verified outputs. No extra learning task; skip if no useful reusable discovery." })) } : {}),
        criteria: Type.Optional(Type.Array(Type.Object({ id: Type.Integer({ minimum: 1, maximum: 16 }), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("unverified")]),
          evidence: Type.String({ minLength: 1, maxLength: 2000 }), proofIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })) }), { maxItems: 16 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, goal => {
        if (args.criteria && new Set(args.criteria.map(c => c.id)).size !== args.criteria.length) throw new Error("Criterion IDs must be unique");
        goal.candidate = { id: String(api.taskId), revision: goal.revision, summary: args.summary, artifacts: [...new Set(args.artifacts)], ...(args.criteria ? { criteria: args.criteria } : {}) };
        if (options.captureSkill && "skill" in args && typeof args.skill === "string") goal.candidate.skill = args.skill;
        goal.phase = "submitted"; goal.review = null; goal.mechanical = null; goal.verification = null;
        goalEvent(goal, "submitted", args.summary);
      })), control: { terminate: true } }),
    }),
    defineTool({
      name: "task_blocked", description: "Stop autonomous work when an external dependency is unavailable. If user input is required, provide a precise question. State what is already done and why continuation is impossible.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4000 }), question: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, context) => ({ output: output(await mutate(api, context, goal => {
        goal.phase = args.question ? "waiting_user" : "blocked"; goal.reason = args.reason; goal.question = args.question ?? null;
        goalEvent(goal, goal.phase, `${args.reason}${args.question ? `\n${args.question}` : ""}`);
      })), control: { terminate: true } }),
    }),
  ] });
}

/** Installed only in the isolated reviewer, never in the coordinator or its workers. */
export function reviewExtension() {
  return defineExtension({ name: "local_review", tools: [defineTool({
    name: "review_result", description: "Submit an independent acceptance verdict. Read artifacts and compare the ORIGINAL objective and user requirements. Reject missing requirements, incorrect calculations and unsupported completion claims. Evidence should cite inspected paths/findings. Ends review.",
    parameters: Type.Object({ verdict: Type.Union([Type.Literal("pass"), Type.Literal("rework"), Type.Literal("blocked")]), reason: Type.String({ minLength: 1, maxLength: 4000 }), evidence: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }) }),
    replay: "safe", executionMode: "sequential",
    execute: async (args, api, context) => {
      await api.commit(async tx => { const reviews = await tx.doc(Reviews); reviews.verdicts[String(api.conversationId)] = args; }, context);
      return { output: [{ type: "text", text: JSON.stringify(args) }], control: { terminate: true } };
    },
  })] });
}
