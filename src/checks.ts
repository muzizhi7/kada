import { Type } from "@earendil-works/pi-ai";
import type { DirectorySnapshot, FileSnapshot, Workspace } from "./workspace.js";
import { errorText } from "./util.js";

const path = Type.String({ minLength: 1, maxLength: 2048 });
export const CheckSchema = Type.Union([
  Type.Object({ type: Type.Literal("file_exists"), path }),
  Type.Object({ type: Type.Literal("file_contains"), path, text: Type.String({ minLength: 1, maxLength: 2048 }) }),
  Type.Object({ type: Type.Literal("json_value"), path, pointer: Type.String({ maxLength: 256 }),
    equals: Type.Union([Type.String({ maxLength: 2048 }), Type.Number(), Type.Boolean(), Type.Null()]) }),
]);
export type AcceptanceCheck =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "json_value"; path: string; pointer: string; equals: string | number | boolean | null };
export type FileEvidence = FileSnapshot;
export type MechanicalReport = {
  passed: boolean;
  results: { label: string; passed: boolean; detail: string }[];
  files: FileEvidence[];
  directories?: DirectorySnapshot[];
  notices?: string[];
};

/** Normalize at the HTTP boundary as well as at model tool boundaries. No executable predicates. */
export function acceptanceChecks(input: unknown = []): AcceptanceCheck[] {
  if (!Array.isArray(input) || input.length > 32) throw new Error("acceptance must be an array of at most 32 checks");
  return input.map((value): AcceptanceCheck => {
    if (!value || typeof value !== "object" || typeof value.path !== "string" || !value.path.trim() || value.path.length > 2048) throw new Error("Every acceptance check needs a workspace file path");
    if (value.type === "file_exists") return { type: value.type, path: value.path };
    if (value.type === "file_contains" && typeof value.text === "string" && value.text.length > 0 && value.text.length <= 2048) return { type: value.type, path: value.path, text: value.text };
    if (value.type === "json_value" && typeof value.pointer === "string" && value.pointer.length <= 256 &&
      (value.pointer === "" || value.pointer.startsWith("/")) && !/~(?:[^01]|$)/.test(value.pointer) &&
      (value.equals === null || typeof value.equals === "boolean" || (typeof value.equals === "number" && Number.isFinite(value.equals)) || (typeof value.equals === "string" && value.equals.length <= 2048))) {
      return { type: value.type, path: value.path, pointer: value.pointer, equals: value.equals };
    }
    throw new Error("Unsupported or invalid acceptance check");
  });
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`JSON Pointer not found: ${pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** A concise view of actual failures; the full check results remain in task_status. */
export function failedCheckFeedback(report: MechanicalReport): string {
  const failures = report.results.filter(result => !result.passed);
  const shown = failures.slice(0, 6).map(result => `${result.label.slice(0, 400)}: ${result.detail.slice(0, 700)}`);
  if (failures.length > shown.length) shown.push(`${failures.length - shown.length} additional failures are available in task_status.failedChecks.`);
  return shown.join("\n");
}

/** Independent of the agent's assertions; inspect original bytes through the workspace boundary. */
export async function checkArtifacts(workspace: Workspace, artifacts: string[], checks: AcceptanceCheck[], unfinished: string[] = [], options: { advisoryPlan?: boolean } = {}): Promise<MechanicalReport> {
  const results: MechanicalReport["results"] = [];
  const contents = new Map<string, string>();
  const files = new Map<string, FileEvidence>();
  const directories = new Map<string, DirectorySnapshot>();
  const remember = (file: FileEvidence) => {
    const previous = files.get(file.path);
    if (previous && (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes)) throw new Error(`File changed during checks: ${file.path}. Inspect it and verify again.`);
    files.set(file.path, file);
  };
  const inspect = async (path: string) => {
    const absolute = await workspace.path(path);
    if (!files.has(absolute)) remember(await workspace.inspect(absolute));
    return files.get(absolute)!;
  };
  const read = async (path: string) => {
    const absolute = await workspace.path(path);
    if (!contents.has(absolute)) {
      const snapshot = await workspace.readSnapshot(absolute);
      remember(snapshot.file);
      contents.set(absolute, snapshot.text);
    }
    return contents.get(absolute)!;
  };
  const run = async (label: string, test: () => Promise<string>) => {
    try { results.push({ label, passed: true, detail: await test() }); }
    catch (error) { results.push({ label, passed: false, detail: errorText(error) }); }
  };
  for (const path of artifacts) await run(`artifact: ${path}`, async () => {
    const snapshot = await workspace.inspectTree(path);
    for (const file of snapshot.files) remember(file);
    if ("kind" in snapshot.root) {
      const previous = directories.get(snapshot.root.path);
      if (previous && previous.sha256 !== snapshot.root.sha256) throw new Error(`Directory changed during checks: ${path}`);
      directories.set(snapshot.root.path, snapshot.root);
      return `Directory exists; ${snapshot.root.entries} entries and original file bytes recorded, including empty files/directories. This does not validate task correctness.`;
    }
    return "Regular workspace file exists; original byte size and SHA-256 recorded. Empty files are allowed. This does not validate contents or format.";
  });
  for (const check of checks) await run(`${check.type}: ${check.path}`, async () => {
    if (check.type === "file_exists") {
      await inspect(check.path);
      return "Regular workspace file exists; original byte size and SHA-256 recorded. Empty files are allowed.";
    }
    const text = await read(check.path);
    if (check.type === "file_contains" && !text.includes(check.text)) throw new Error(`Missing required text: ${JSON.stringify(check.text)}`);
    if (check.type === "json_value") {
      const actual = jsonPointer(JSON.parse(text), check.pointer);
      if (actual !== check.equals) throw new Error(`At ${check.pointer || "<root>"}: expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual).slice(0, 500)}`);
    }
    return "Passed against current file contents";
  });
  const notices: string[] = [];
  if (unfinished.length) {
    if (options.advisoryPlan) notices.push(`Optional plan steps not marked done: ${unfinished.join(", ")}`);
    else results.push({ label: "plan", passed: false, detail: `Unfinished steps: ${unfinished.join(", ")}` });
  }
  return { passed: results.every(r => r.passed), results, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    ...(directories.size ? { directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path)) } : {}), ...(notices.length ? { notices } : {}) };
}
