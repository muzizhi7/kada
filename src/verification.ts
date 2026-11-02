import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { GoalDoc, plain, type GoalState } from "./goal.js";
import type { PathSnapshot, Workspace } from "./workspace.js";

export type CheckReceipt = { id: string; command: string; passed: boolean; exitCode: number | null; inputs: PathSnapshot[]; outputs: PathSnapshot[]; outputPreview?: string; detail: string };
export type CriterionResult = { id: number; status: "passed" | "failed" | "unverified"; evidence: string; proofIds?: string[] };

export async function hashFiles(workspace: Workspace, paths: string[]): Promise<PathSnapshot[]> {
  const result: PathSnapshot[] = [];
  for (const path of [...new Set(paths)]) {
    const file = await workspace.inspectPath(path);
    if (!result.some(previous => previous.path === file.path)) result.push(file);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** A reusable procedure needs the same fresh, frozen evidence as the original delivery. */
export async function confirmedProof(goal: GoalState, workspace: Workspace, proofId: string) {
  const proof = goal.proofs?.[proofId];
  if (!goal.confirmation || !goal.brief || !proof?.passed) throw new Error("Learning requires a passing confirmed command receipt");
  let matched = false;
  for (const [index, criterion] of goal.brief.criteria.entries()) {
    const spec = criterion.verification, originals = goal.confirmation.verificationInputs?.[String(index + 1)];
    if (criterion.method !== "check" || !spec || !originals?.length || proof.command.trim() !== spec.command.trim()) continue;
    const outputs = await Promise.all(spec.outputs.map(path => workspace.path(path)));
    if (originals.every(file => proof.inputs.some(input => JSON.stringify(input) === JSON.stringify(file))) &&
      outputs.every(path => proof.outputs.some(output => output.path === path))) matched = true;
  }
  if (!matched) throw new Error("Learning proof must match the confirmed command, original inputs and outputs");
  for (const snapshots of [proof.inputs, proof.outputs]) {
    if (JSON.stringify(await hashFiles(workspace, snapshots.map(f => f.path))) !== JSON.stringify(snapshots)) throw new Error("Learning proof is stale; verify current files first");
  }
  return proof;
}

/** A thin, replay-safe composition over Pi bash; no alternate process runner or predicate engine. */
export function verificationExtension(workspace: Workspace, confirmedCriteria = false) {
  return defineExtension({ name: "local_verification", tools: [defineTool({
    name: "task_verify", description: confirmedCriteria ? "Run the frozen check for a confirmed criterion through Pi bash: supply criterionId (1-based) only. For an additional self-check instead supply command, inputs and outputs together. Returns file-bound proof IDs; reverify after edits. A check proves only its actual coverage." : "Run a real check through native Pi bash and return its receipt bound to input/output file or directory hashes, including empty files/directories. If the confirmed criterion specifies verification, use that exact command with every specified immutable input and output. Prefer existing tests/independent checks; self-tests do not prove every requirement. Cite proof IDs and reverify after edits.",
    parameters: Type.Object({ ...(confirmedCriteria ? { criterionId: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })) } : {}),
      command: confirmedCriteria ? Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })) : Type.String({ minLength: 1, maxLength: 16000 }),
      inputs: confirmedCriteria ? Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })) : Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 }),
      outputs: confirmedCriteria ? Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })) : Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 }),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })) }),
    replay: "safe", executionMode: "sequential",
    execute: async (args, api, ctx) => {
      const id = String(api.taskId);
      const saved = await api.commit(async tx => plain((await tx.doc(GoalDoc)).proofs?.[id] ?? null), ctx);
      if (saved) return { output: [{ type: "text", text: JSON.stringify(saved) }], isError: !saved.passed };
      const goal = await api.commit(async tx => plain(await tx.doc(GoalDoc)), ctx);
      if (goal.phase !== "working") throw new Error("Verification requires an executing task");
      let { command, inputs, outputs: paths } = args;
      const criterionId = "criterionId" in args ? args.criterionId as number | undefined : undefined;
      if (criterionId !== undefined) {
        if (command !== undefined || inputs !== undefined || paths !== undefined) throw new Error("Use criterionId alone, or command/inputs/outputs for an additional check");
        const spec = goal.confirmation && goal.brief?.criteria[criterionId - 1]?.verification;
        const original = goal.confirmation?.verificationInputs?.[String(criterionId)];
        if (!spec || !original?.length) throw new Error("No frozen check for this confirmed criterion");
        if (JSON.stringify(await hashFiles(workspace, spec.inputs)) !== JSON.stringify(original)) throw new Error("Confirmed check inputs changed; restore the originals before checking");
        ({ command, inputs, outputs: paths } = spec);
      }
      if (!command || !inputs || !paths) throw new Error("Supply criterionId or all of command, inputs and outputs");
      const before = await api.memo("inputs", await hashFiles(workspace, inputs), ctx);
      const run = await api.executeTool("bash", { command, ...(args.timeout === undefined ? {} : { timeout: args.timeout }) }, ctx, { key: "verify", progress: false });
      const after = await hashFiles(workspace, inputs);
      const outputs = await hashFiles(workspace, paths);
      const exitCode = (run.structuredOutput as { exitCode?: number } | undefined)?.exitCode ?? null;
      const output = (run.structuredOutput as { output?: unknown } | undefined)?.output;
      const stable = JSON.stringify(before) === JSON.stringify(after);
      const receipt: CheckReceipt = { id, command, exitCode, passed: !run.isError && exitCode === 0 && stable,
        inputs: after, outputs, outputPreview: typeof output === "string" ? output.slice(-2000) : "", detail: stable ? "Actual Pi bash receipt; file hashes observed after the check. This is an agent-run check, not proof of every semantic claim." : "Inputs changed while verification ran; inspect and verify again." };
      await api.commit(async tx => {
        const state = await tx.doc(GoalDoc);
        state.proofs ??= {};
        state.proofs[id] = receipt;
        const keys = Object.keys(state.proofs);
        for (const old of keys.slice(0, Math.max(0, keys.length - 32))) delete state.proofs[old];
      }, ctx);
      return { output: [{ type: "text", text: JSON.stringify(receipt) }], isError: !receipt.passed };
    },
  })] });
}
