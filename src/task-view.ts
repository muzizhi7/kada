import type { TaskStatus } from "./client.js";
import { verificationText } from "./presentation.js";
import { conversationAnswer } from "./conversation.js";

/** A delivery-oriented projection; no transcript, tool output or independent task state. */
export function taskView(status: TaskStatus) {
  const goal = status.goal;
  const message = status.interaction === "chat" ? [...status.messages].reverse().find(m => conversationAnswer(m) !== undefined) : undefined;
  return {
    id: status.id, objective: status.objective, workspace: status.workspace, status: status.status,
    interaction: status.interaction,
    reply: message ? { timestamp: message.timestamp, text: conversationAnswer(message)! } : null,
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
