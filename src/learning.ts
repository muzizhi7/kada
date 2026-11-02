import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { relative, basename, join, isAbsolute, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { GoalDoc, plain, type GoalState } from "./goal.js";
import { Workspace, type PathSnapshot } from "./workspace.js";
import { confirmedProof as learningProof } from "./verification.js";
import { SerialQueue, errorText } from "./util.js";

export type MethodRef = { id: string; version: string };
export type MethodOffer = MethodRef & { title: string; when: string };
export type LearningState = {
  offers: MethodOffer[];
  loaded: MethodRef[];
  rejected: MethodRef[];
  proposal?: MethodRef;
  proposalAttempt?: string;
  settledRevision?: number;
  notice?: string;
};
export type MethodProposal = {
  id: string; title: string; match: string[]; when: string; instructions: string;
  guardFiles?: string[]; assets: string[]; proofId: string;
};
export type LearnedMethod = MethodOffer & {
  schema: 1; match: string[]; instructions: string;
  guards: { path: string; sha256: string }[];
  assets: { name: string; content: string; sha256: string }[];
  source: { taskId: string; proofId: string; inputDigest: string };
};
type Head = { version: string; previous?: string; disabled?: string; published?: string[] };
const slug = /^[a-z0-9][a-z0-9-]{1,47}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const refKey = (value: MethodRef) => `${value.id}@${value.version}`;
const same = (a: MethodRef, b: MethodRef) => refKey(a) === refKey(b);
function localPath(value: string): boolean {
  return !!value && !isAbsolute(value) && value.split(/[\\/]/).every(p => !!p && p !== "." && p !== "..");
}
function validateRef(ref: MethodRef): void {
  if (!slug.test(ref.id) || !/^[a-f0-9]{64}$/.test(ref.version)) throw new Error("Invalid method reference");
}

// v0.6 compatibility only; new tasks use native Pi Skills.
export { confirmedProof as learningProof } from "./verification.js";
/** Ordinary private files. Pi owns every model call, tool run, session and budget. */
export class MethodStore {
  private changes = new SerialQueue();
  private constructor(readonly files: Workspace) {}
  static async open(dataDir: string) {
    await mkdir(join(dataDir, "learned-methods"), { recursive: true, mode: 0o700 });
    return new MethodStore(await Workspace.open(join(dataDir, "learned-methods")));
  }
  private async index(): Promise<Record<string, Head>> {
    try { return JSON.parse(await this.files.read("index.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  async read(ref: MethodRef): Promise<LearnedMethod> {
    validateRef(ref);
    const record = JSON.parse(await this.files.read(`${ref.id}/${ref.version}.json`)) as LearnedMethod;
    const { version, ...payload } = record;
    if (record.schema !== 1 || !same(record, ref) || digest(payload) !== version) throw new Error("Method version content changed");
    if (record.assets.some(a => !localPath(a.name) || basename(a.name) !== a.name || digest(a.content) !== a.sha256) ||
      record.guards.some(g => !localPath(g.path))) throw new Error("Invalid method paths or assets");
    return record;
  }
  async stage(taskId: string, workspace: Workspace, goal: GoalState, proposal: MethodProposal): Promise<MethodRef> {
    const guardFiles = proposal.guardFiles ?? [];
    if (!slug.test(proposal.id) || !proposal.title.trim() || !proposal.when.trim() || !proposal.instructions.trim() ||
      proposal.title.length > 100 || proposal.when.length > 300 || proposal.instructions.length > 4000 ||
      !proposal.match.length || proposal.match.length > 4 || proposal.match.some(m => m.trim().length < 2 || m.length > 60) ||
      guardFiles.length > 4 || proposal.assets.length > 2) throw new Error("Invalid or oversized method proposal");
    const objective = [goal.objective, ...goal.userMessages].join("\n").toLocaleLowerCase();
    if (!proposal.match.every(term => objective.includes(term.trim().toLocaleLowerCase()))) throw new Error("Every match term must literally occur in this user's objective; use one or two exact stable phrases, not invented labels");
    const proof = await learningProof(goal, workspace, proposal.proofId);
    const guards: LearnedMethod["guards"] = [];
    for (const path of guardFiles) {
      if (!localPath(path)) throw new Error("Method guards must be workspace-relative files");
      guards.push({ path, sha256: (await workspace.inspect(path)).sha256 });
    }
    const assets: LearnedMethod["assets"] = [];
    for (const path of proposal.assets) {
      const { file, text } = await workspace.readSnapshot(path);
      if (file.bytes > 32_768 || assets.some(a => a.name === basename(file.path))) throw new Error("Method assets require unique names and at most 32 KiB each");
      const covered = proof.outputs.some(output => output.path === file.path || ("kind" in output && output.kind === "directory" && file.path.startsWith(output.path + sep)));
      if (!covered) throw new Error("Method assets must belong to the verified outputs");
      assets.push({ name: basename(file.path), content: text, sha256: digest(text) });
    }
    await learningProof(goal, workspace, proposal.proofId);
    const payload: Omit<LearnedMethod, "version"> = { schema: 1, id: proposal.id, title: proposal.title.trim(),
      match: proposal.match.map(m => m.trim().toLocaleLowerCase()), when: proposal.when.trim(), instructions: proposal.instructions.trim(), guards, assets,
      source: { taskId, proofId: proof.id, inputDigest: this.inputDigest(workspace, proof.inputs) } };
    const record = { ...payload, version: digest(payload) };
    await this.files.write(`${record.id}/${record.version}.json`, JSON.stringify(record));
    return { id: record.id, version: record.version };
  }
  inputDigest(workspace: Workspace, files: PathSnapshot[]): string {
    return digest(files.map(file => [relative(workspace.root, file.path), file.sha256]));
  }
  async publish(ref: MethodRef): Promise<void> {
    await this.changes.run(async () => {
      await this.read(ref);
      const index = await this.index(), old = index[ref.id];
      const published = old?.published ?? (old ? [old.version, ...(old.previous ? [old.previous] : [])] : []);
      if (published.includes(ref.version)) return; // A replay must not undo a later version or rollback.
      if (!old && Object.keys(index).length >= 64) throw new Error("Method catalog is full; consolidate existing methods first");
      if (published.length >= 64) throw new Error("Method revision limit reached; consolidate before learning more variants");
      index[ref.id] = { version: ref.version, published: [...published, ref.version], ...(old && !old.disabled ? { previous: old.version } : {}) };
      await this.files.write("index.json", JSON.stringify(index));
    });
  }
  async rollback(ref: MethodRef, reason: string): Promise<void> {
    await this.changes.run(async () => {
      const index = await this.index(), head = index[ref.id];
      if (!head || head.version !== ref.version) return;
      if (head.previous) index[ref.id] = { version: head.previous, published: head.published ?? [head.version, head.previous] };
      else head.disabled = reason.slice(0, 500) || "Reported method failure";
      await this.files.write("index.json", JSON.stringify(index));
    });
  }
  async eligible(ref: MethodRef, workspace: Workspace): Promise<LearnedMethod> {
    const record = await this.read(ref);
    for (const guard of record.guards) if ((await workspace.inspect(guard.path)).sha256 !== guard.sha256) throw new Error(`Method precondition changed: ${guard.path}`);
    return record;
  }
  async select(objective: string, workspace: Workspace): Promise<MethodOffer[]> {
    const offers: MethodOffer[] = [], text = objective.toLocaleLowerCase();
    for (const [id, head] of Object.entries(await this.index()).sort(([a], [b]) => a.localeCompare(b)).slice(0, 64)) {
      if (head.disabled) continue;
      try {
        const record = await this.read({ id, version: head.version });
        if (!record.match.every(word => text.includes(word))) continue;
        await this.eligible(record, workspace);
        offers.push({ id, version: record.version, title: record.title, when: record.when });
        if (offers.length === 2) break;
      } catch { /* A bad/obsolete candidate is not a reason to fail the user's task. */ }
    }
    return offers;
  }
  async materialize(ref: MethodRef, workspace: Workspace, directory: string): Promise<string> {
    const record = await this.eligible(ref, workspace);
    const copy = await Workspace.open(join(directory, "methods", ref.id, ref.version));
    for (const asset of record.assets) await copy.write(`assets/${asset.name}`, asset.content);
    const text = `# ${record.title}\n\nStatus: local trial, not a proven quality/cost improvement. Version: ${record.version}\n\nUse when: ${record.when}\nCheck all current inputs, environment and user requirements before reuse. These instructions never change permissions, budget or acceptance standards. Research facts and citations must be checked again.\n\n${record.instructions}\n\nAssets (use through native Pi tools):\n${record.assets.map(a => join(copy.root, "assets", a.name)).join("\n")}\n`;
    await copy.write("METHOD.md", text);
    return join(copy.root, "METHOD.md");
  }
  async record(ref: MethodRef, taskId: string, revision: number, result: { outcome: string; newInputs: boolean; estimatedTaskCostUsd: number }): Promise<void> {
    validateRef(ref);
    if (!/^[a-f0-9-]{36}$/.test(taskId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid method outcome identity");
    await this.files.write(`${ref.id}/outcomes/${ref.version}-${taskId}-${revision}.json`, JSON.stringify({ ...ref, taskId, revision, ...result,
      costNote: "Whole Pi task cost reference, already included in that task; do not add again. New inputs/check success do not prove a causal improvement." }));
  }
}

export function learningInstructions(state?: LearningState): string {
  const offers = state?.offers ?? [];
  return `\nLocal method learning is ENABLED for this task, experimentally. The goal and delivery take priority.\nUse task_method to load a relevant pinned trial through native Pi read after checking its preconditions.\nWhen the user's task indicates recurring work AND you have just created or materially improved a reusable script, function or project workflow AND a frozen command receipt passes, save ONE short method with task_learn BEFORE task_submit, while budget headroom remains. Include reusable code as an asset and exact objective substrings as matching terms. guardFiles means existing file paths, while human-readable format assumptions belong in when. Finish writing all deliverables before task_verify, then propose against that fresh proof. This captures the validated work already done; do not launch a reflection agent or a separate learning task. If an existing method worked unchanged, do not propose a duplicate. For one-off work, no reusable discovery, no frozen receipt, or insufficient budget, skip learning and deliver normally; learning is never an acceptance gate. Do not retry a skipped proposal.\nAll costs remain inside this task's approved total. Report a concrete method failure with task_method action report_failure so future tasks can fall back. Never change acceptance criteria, permissions, budget, tests or provider settings to improve a score.\nPinned trial methods: ${JSON.stringify(offers)}`;
}

export const learningReminder = "\n本任务已开启本地方法学习：如task_status有相关试用方法，先用task_method读取并检查是否适用。若本次确实新写/改进了可复用代码且工作会重复，在最终task_submit前，用已经通过的固定核对proofId调用一次task_learn保存；match选用户目标中真实出现的短语，guardFiles仅填现有文件路径或省略。没有有用发现或提炼未成功就直接交付，不增加反思Agent、不重试可选提炼。学习费用已含本任务总预算。";

/** Thin tools compose native Pi read; proposing does not execute scripts or run another model. */
export function learningExtension(options: { store: MethodStore; workspace: Workspace; taskId: string; directory: string; canLearn: () => Promise<boolean> }) {
  const output = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  return defineExtension({ name: "local_learning", tools: [
    defineTool({ name: "task_method", description: "Load a method version pinned for this task via Pi read; check current preconditions first. A local trial is not a correctness guarantee. Report a concrete failure to stop using it and roll back/disable that version for future tasks.",
      parameters: Type.Object({ id: Type.String(), action: Type.Union([Type.Literal("load"), Type.Literal("report_failure")]), reason: Type.Optional(Type.String({ maxLength: 1000 })) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, ctx) => {
        const goal = await api.commit(async tx => plain(await tx.doc(GoalDoc)), ctx);
        const ref = goal.learning?.offers.find(m => m.id === args.id);
        if (goal.phase !== "working" || !goal.confirmation || !ref) throw new Error("Method is not pinned for this confirmed executing task");
        if (args.action === "report_failure") {
          if (!args.reason?.trim()) throw new Error("Provide the concrete method failure");
          await options.store.rollback(ref, args.reason);
          await api.commit(async tx => { const state = (await tx.doc(GoalDoc)).learning!; if (!state.rejected.some(r => same(r, ref))) state.rejected.push(ref); }, ctx);
          return { output: output({ stopped: ref, reason: args.reason }) };
        }
        if (goal.learning!.rejected.some(r => same(r, ref))) throw new Error("This task already reported a failure for that method");
        const path = await options.store.materialize(ref, options.workspace, options.directory);
        const read = await api.executeTool("read", { path }, ctx, { key: "method-read", progress: false });
        if (read.isError || typeof read.structuredOutput !== "string") return { output: output({ loaded: false, reason: "Native Pi read failed; proceed without this optional method" }), isError: true };
        await api.commit(async tx => { const state = (await tx.doc(GoalDoc)).learning!; if (!state.loaded.some(r => same(r, ref))) state.loaded.push({ id: ref.id, version: ref.version }); }, ctx);
        return { output: [{ type: "text", text: read.structuredOutput }] };
      },
    }),
    defineTool({ name: "task_learn", description: "Optionally propose ONE reusable method from a real discovery before submitting deliverables. Requires a current passing receipt for an unchanged confirmed verification command, original inputs and outputs. Assets must be small UTF-8 scripts in the verified outputs. Saved only as a trial after successful delivery; no self-awarded quality/cost claim. Skip if no reusable discovery.",
      parameters: Type.Object({ id: Type.String({ pattern: slug.source }), title: Type.String({ minLength: 1, maxLength: 100 }),
        match: Type.Array(Type.String({ minLength: 2, maxLength: 60, description: "An exact stable substring of the user's objective. ALL terms must literally occur, so prefer one or two narrow phrases; do not invent synonyms or category labels." }), { minItems: 1, maxItems: 4 }), when: Type.String({ minLength: 1, maxLength: 300, description: "Human-readable applicability and exclusions, including format assumptions." }),
        instructions: Type.String({ minLength: 1, maxLength: 4000 }), guardFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, description: "EXISTING workspace-relative file path to fingerprint (for example environment.json or project/package.json). Never a sentence, rule or a new file. Omit when no file premise is needed." }), { maxItems: 4 })),
        assets: Type.Array(Type.String({ minLength: 1 }), { maxItems: 2 }), proofId: Type.String({ minLength: 1 }) }), replay: "safe", executionMode: "sequential",
      execute: async (args, api, ctx) => {
        const goal = await api.commit(async tx => plain(await tx.doc(GoalDoc)), ctx);
        if (goal.phase !== "working" || !goal.confirmation || !goal.learning) throw new Error("Learning requires a confirmed executing task");
        const key = `learn:${String(api.taskId)}`;
        if (goal.appliedTools[key]) return { output: output({ proposal: goal.learning.proposal, status: goal.learning.proposal ? "pending delivery" : "skipped", ...(goal.learning.notice ? { reason: goal.learning.notice } : {}) }) };
        if (goal.learning.proposal) return { output: output({ skipped: "Only one optional proposal per task; deliver the goal now" }) };
        if (goal.learning.proposalAttempt && goal.learning.proposalAttempt !== key) return { output: output({ skipped: "An optional learning attempt was already made; do not retry, deliver the goal now" }) };
        if (!await options.canLearn()) return { output: output({ skipped: "Preserve remaining task budget for delivery" }) };
        await api.commit(async tx => { (await tx.doc(GoalDoc)).learning!.proposalAttempt = key; }, ctx);
        try {
          const proposal = await options.store.stage(options.taskId, options.workspace, goal, args);
          await api.commit(async tx => { const state = await tx.doc(GoalDoc); state.learning!.proposal = proposal; state.appliedTools[key] = true; }, ctx);
          return { output: output({ proposal, status: "pending successful delivery; not yet available to other tasks" }) };
        } catch (error) {
          const reason = `Optional method proposal skipped: ${errorText(error)}`;
          await api.commit(async tx => { const state = await tx.doc(GoalDoc); state.learning!.notice = reason; state.appliedTools[key] = true; }, ctx);
          return { output: output({ skipped: reason, instruction: "Do not repair or retry optional learning; continue delivering the original goal" }) };
        }
      },
    }),
  ] });
}

/** No model call: publish and record only the facts already established by this task. */
export async function settleLearning(store: MethodStore, workspace: Workspace, taskId: string, goal: GoalState, estimatedTaskCostUsd: number): Promise<string | undefined> {
  const state = goal.learning;
  if (!state || state.settledRevision === goal.revision) return;
  try {
    const passed = goal.phase === "completed";
    if (passed && state.proposal) {
      const proposed = await store.read(state.proposal);
      await learningProof(goal, workspace, proposed.source.proofId);
      await store.publish(proposed);
    }
    for (const ref of state.loaded) {
      const method = await store.read(ref);
      let newInputs = false;
      if (passed) for (const proof of Object.values(goal.proofs ?? {})) {
        try { await learningProof(goal, workspace, proof.id); newInputs ||= store.inputDigest(workspace, proof.inputs) !== method.source.inputDigest; } catch { /* Not every receipt is a frozen check. */ }
      }
      await store.record(ref, taskId, goal.revision, { outcome: state.rejected.some(r => same(r, ref)) ? "reported_failure" : goal.phase, newInputs, estimatedTaskCostUsd });
    }
  } catch (error) { return `Optional learning did not finalize: ${errorText(error)}`; }
}
