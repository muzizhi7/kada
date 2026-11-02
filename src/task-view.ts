import type { TaskStatus } from "./client.js";
import { verificationText } from "./presentation.js";

/** A delivery-oriented projection; no transcript, tool output or independent task state. */
export function taskView(status: TaskStatus) {
  const goal = status.goal;
  return {
    id: status.id, objective: status.objective, workspace: status.workspace, status: status.status,
    brief: goal?.brief ?? null, briefDigest: status.briefDigest,
    confirmed: Boolean(goal?.confirmation), question: goal?.question ?? null, reason: goal?.reason ?? null,
    budget: { estimatedCostUsd: status.budget.estimatedCostUsd, costLimit: status.budget.costLimit },
    resumeBudget: status.resumeBudget,
    delivery: status.status === "completed" && goal?.candidate ? {
      summary: goal.candidate.summary, artifacts: goal.candidate.artifacts,
      verification: verificationText(status), assumptions: goal.brief?.assumptions ?? [],
    } : null,
  };
}

export type TaskView = ReturnType<typeof taskView>;
