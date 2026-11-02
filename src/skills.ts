import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { GoalDoc, plain, type GoalState } from "./goal.js";
import { confirmedProof } from "./verification.js";
import { Workspace } from "./workspace.js";
import { errorText, SerialQueue } from "./util.js";
import type { LocalSkill } from "./discovery.js";

export type SkillPin = { name: string; description: string; filePath: string; version: string; managed: boolean };
export type SkillState = { pins: SkillPin[]; loaded: string[]; proposal?: { name: string; version: string }; settledRevision?: number; notice?: string };
type Head = { version: string; previous?: string; published: string[]; disabled?: boolean };
const bundled = fileURLToPath(new URL("../skills", import.meta.url));
const projectSources = (root: string) => [".pi", ".agents", ".claude", ".codex", ".cursor", ".opencode", ".gemini"].map(dir => join(root, dir, "skills"));
const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const key = (pin: { name: string; version: string }) => `${pin.name}@${pin.version}`;
const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
const load = (cwd: string, paths: string[]) => loadSkills({ cwd, agentDir: join(cwd, ".pi"), skillPaths: paths, includeDefaults: false });

/** File bounds protect this optional local catalogue; native Pi handles parsing and routing. */
async function tree(workspace: Workspace, path: string) {
  const value = await workspace.inspectTree(path);
  if (!("kind" in value.root) || value.files.length > 16 || value.root.bytes > 131072 ||
    value.files.some(f => f.bytes > 32768) || !value.files.some(f => f.path === join(value.root.path, "SKILL.md") && f.bytes <= 8192)) {
    throw new Error("A local Skill needs SKILL.md (at most 8 KiB), at most 16 UTF-8 files / 128 KiB total");
  }
  return value;
}
async function copy(workspace: Workspace, path: string, destination: string, version: string) {
  const original = await tree(workspace, path), target = await Workspace.open(destination);
  if (original.root.sha256 !== version) throw new Error("Skill version changed");
  for (const file of original.files) await target.write(relative(original.root.path, file.path), await workspace.read(file.path));
  if ((await tree(workspace, path)).root.sha256 !== version || (await tree(target, ".")).root.sha256 !== version) throw new Error("Skill changed while pinning");
  return target;
}

/** Only version heads/provenance are custom. No keyword index, memory service or model call. */
export class SkillStore {
  private changes = new SerialQueue();
  private constructor(readonly files: Workspace) {}
  static async open(dataDir: string) {
    const path = join(dataDir, "skills", "managed");
    await mkdir(path, { recursive: true, mode: 0o700 });
    return new SkillStore(await Workspace.open(path));
  }
  private async heads(): Promise<Record<string, Head>> {
    try { return JSON.parse(await this.files.read("heads.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  async paths(): Promise<string[]> {
    const paths: string[] = [];
    for (const [name, head] of Object.entries(await this.heads())) {
      if (!validName.test(name) || name.length > 64 || !/^[a-f0-9]{64}$/.test(head.version) || head.disabled) continue;
      const path = join(this.files.root, name, head.version);
      try { if ((await tree(this.files, path)).root.sha256 === head.version) paths.push(path); } catch { /* Optional corrupted trials are skipped. */ }
    }
    return paths;
  }
  async capture(workspace: Workspace, goal: GoalState, taskId: string, path: string) {
    if (goal.phase !== "completed") throw new Error("Skills are saved only after successful delivery");
    const candidate = await tree(workspace, path);
    const proofIds = [...new Set(goal.candidate?.criteria?.flatMap(c => c.proofIds ?? []) ?? [])];
    let proofId: string | undefined;
    for (const id of proofIds) try {
      const proof = await confirmedProof(goal, workspace, id);
      if (proof.outputs.some(p => "kind" in p && p.kind === "directory" && contains(p.path, candidate.root.path))) { proofId = id; break; }
    } catch { /* Other receipts may describe unrelated or stale work. */ }
    if (!proofId) throw new Error("Skill directory must belong to a fresh, frozen verified output");
    const parsed = load(workspace.root, [candidate.root.path]);
    const skill = parsed.skills[0];
    if (parsed.skills.length !== 1 || !skill || parsed.diagnostics.length || skill.filePath !== join(candidate.root.path, "SKILL.md") ||
      !validName.test(skill.name) || skill.name.length > 64 || skill.description.length > 1024 || skill.disableModelInvocation) throw new Error("Use one valid native Pi SKILL.md with name and description");
    const ref = { name: skill.name, version: candidate.root.sha256 };
    const authored = load(workspace.root, [...projectSources(workspace.root), bundled]);
    if (authored.skills.some(s => s.name === ref.name)) throw new Error("Managed Skills cannot replace authored Skills");
    await copy(workspace, candidate.root.path, join(this.files.root, ref.name, ref.version), ref.version);
    await confirmedProof(goal, workspace, proofId);
    await this.changes.run(async () => {
      const heads = await this.heads(), old = heads[ref.name];
      if (old?.published.includes(ref.version)) return; // Reopening cannot undo a later rollback.
      if ((!old && Object.keys(heads).length >= 32) || (old?.published.length ?? 0) >= 32) throw new Error("Local trial catalogue/revision limit reached");
      await this.files.write(`${ref.name}/${ref.version}.source.json`, JSON.stringify({ taskId, proofId, inputHashes: goal.proofs![proofId]!.inputs,
        status: "local trial; passing the source check is not proof of future quality or savings" }));
      heads[ref.name] = { version: ref.version, published: [...(old?.published ?? []), ref.version], ...(old && !old.disabled ? { previous: old.version } : {}) };
      await this.files.write("heads.json", JSON.stringify(heads));
    });
    return ref;
  }
  async rollback(ref: { name: string; version: string }) {
    await this.changes.run(async () => {
      const heads = await this.heads(), head = heads[ref.name];
      if (!head || head.version !== ref.version) return;
      heads[ref.name] = head.previous ? { version: head.previous, published: head.published } : { ...head, disabled: true };
      await this.files.write("heads.json", JSON.stringify(heads));
    });
  }
}

/** Authored first, generated second (Oh My Pi's managed/authored separation). */
export async function pinSkills(workspace: Workspace, directory: string, store?: SkillStore): Promise<SkillState> {
  const managed = await store?.paths() ?? [];
  const parsed = load(workspace.root, [...projectSources(workspace.root), bundled, ...managed]);
  const pins: SkillPin[] = [], notices = parsed.diagnostics.filter(d => d.type !== "collision" && d.message !== "skill path does not exist").map(d => d.message);
  for (const skill of parsed.skills.slice(0, 16)) try {
    if (skill.disableModelInvocation) continue;
    if (!validName.test(skill.name) || skill.name.length > 64 || skill.description.length > 1024 || skill.filePath !== join(skill.baseDir, "SKILL.md")) throw new Error("Use a standard SKILL.md with a valid name and description");
    const source = await Workspace.open(skill.baseDir), version = (await tree(source, ".")).root.sha256;
    const target = await copy(source, ".", join(directory, "skills", skill.name, version), version);
    pins.push({ name: skill.name, description: skill.description, filePath: join(target.root, "SKILL.md"), version, managed: managed.includes(skill.baseDir) });
  } catch (error) { notices.push(`${skill.name}: ${errorText(error)}`); }
  if (parsed.skills.length > 16) notices.push("Skill catalogue limited to 16; consolidate unused Skills");
  return { pins, loaded: [], ...(notices.length ? { notice: notices.join("; ").slice(0, 1000) } : {}) };
}
export function skillInstructions(state?: SkillState, capture = false): string {
  const skills: Skill[] = state?.pins.map(pin => ({ ...pin, baseDir: dirname(pin.filePath), disableModelInvocation: false,
    sourceInfo: { path: pin.filePath, baseDir: dirname(pin.filePath), source: "path", scope: "temporary", origin: "top-level" } })) ?? [];
  return (capture ? "\nLocal trial capture is optional: only for a useful new reusable script/workflow in recurring work, write a short standard SKILL.md (name/description frontmatter, applicability/limits, relative script paths) with its reusable files under an authorized output directory BEFORE the final check. Pass that directory as task_submit.skill. Skip duplicates and one-off work; no reflection turn or extra task. A saved trial is not a quality or savings claim.\n" : "") +
    (state?.pins.some(p => p.managed) ? "\nGenerated Skills are local trials. Recheck applicability/current inputs and run current task checks; they never grant permissions or override requirements.\n" : "") +
    formatSkillsForPrompt(skills, "read");
}

/** Observe native reads without adding a learning tool or changing read's output/schema. */
export function skillReads(external: LocalSkill[] = []) {
  return defineExtension({ name: "local_skills", wraps: [wrapTool(createReadTool(), tool => ({ ...tool,
    execute: async (args, api, ctx) => {
      const state = await api.commit(async tx => plain((await tx.doc(GoalDoc)).skills ?? null), ctx);
      const path = resolve((await api.agent(ctx)).cwd ?? ".", args.path);
      const pin = state?.pins.find(p => p.filePath === path);
      const discovered = external.find(s => s.path === path);
      const source = discovered ? await Workspace.open(dirname(path), { create: false }) : undefined;
      const original = source ? await source.inspect(path) : undefined;
      if (pin && (await tree(await Workspace.open(dirname(path)), ".")).root.sha256 !== pin.version) throw new Error("Pinned Skill changed; continue without this optional Skill");
      const result = await tool.execute(args, api, ctx);
      if (source && original && (await source.inspect(path)).sha256 !== original.sha256) throw new Error("External Skill changed while reading; inspect again");
      if (pin && !result.isError) await api.commit(async tx => {
        const skills = (await tx.doc(GoalDoc)).skills;
        if (skills && !skills.loaded.includes(key(pin))) skills.loaded.push(key(pin));
      }, ctx);
      if (original && !result.isError) await api.commit(async tx => {
        const goal = await tx.doc(GoalDoc);
        goal.localSkillReads ??= [];
        if (!goal.localSkillReads.some(r => r.path === path && r.sha256 === original.sha256)) goal.localSkillReads.push({ path, sha256: original.sha256 });
      }, ctx);
      return result;
    },
  }))] });
}

/** Called at the existing completion boundary. No follow-up input or model request. */
export async function settleSkills(store: SkillStore | undefined, workspace: Workspace, taskId: string, goal: GoalState) {
  const state = goal.skills;
  if (!state || state.settledRevision === goal.revision) return;
  const result: Pick<SkillState, "proposal" | "notice"> = {};
  if (store && goal.phase === "completed" && goal.candidate?.skill) try {
    result.proposal = await store.capture(workspace, goal, taskId, goal.candidate.skill);
  } catch (error) { result.notice = `Optional Skill capture skipped: ${errorText(error)}`; }
  return result;
}
