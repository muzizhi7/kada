import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LocalInventory } from "./discovery.js";

export type MemoryDomain = "general" | "work" | "life" | "unknown";
export type MemoryProvider = "shared" | "pi" | "codex" | "claude" | "cursor" | "codebuddy" | "workbuddy" | "openclaw" | "chatgpt" | "dot" | "gemini" | "other";
export type SourceSpec = { path: string; kind: "guidance" | "memory"; scope: "global" | "project"; provider: MemoryProvider; domain?: MemoryDomain; project?: string; explicit?: boolean };

const inside = (root: string, path: string) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep); };
export const claudeProject = (workspace: string) => `claude:${workspace.replace(/[^a-zA-Z0-9]/g, "-")}`;

/** The nearest repository root is a stable identity for both project instructions and recall. */
export async function memoryProject(workspace?: string): Promise<string | undefined> {
  if (!workspace) return;
  const actual = await realpath(workspace).catch(() => undefined);
  if (!actual || !(await stat(actual).catch(() => undefined))?.isDirectory()) return;
  let dir = actual;
  while (true) {
    if (await stat(join(dir, ".git")).catch(() => undefined)) return dir;
    const parent = dirname(dir); if (parent === dir) return actual;
    dir = parent;
  }
}

/** Only known text memory locations and explicitly registered text exports, never chat/log databases. */
export async function memorySources(inventory: LocalInventory, directory: string, workspace?: string): Promise<{ specs: SourceSpec[]; project?: string; notices: string[] }> {
  const home = inventory.home, project = await memoryProject(workspace), specs = new Map<string, SourceSpec>(), notices: string[] = [];
  const add = (path: string, provider: MemoryProvider, kind: SourceSpec["kind"], scope: SourceSpec["scope"] = "global", extra: Partial<SourceSpec> = {}) => {
    specs.set(resolve(path), { path: resolve(path), provider, kind, scope, ...extra });
  };
  const addFiles = async (folder: string, provider: MemoryProvider, kind: SourceSpec["kind"], scope: SourceSpec["scope"], extra: Partial<SourceSpec>, extensions: RegExp) => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const files = entries.filter(e => e.isFile() && extensions.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length > 128) notices.push(`Memory directory partially scanned (128 files): ${folder}`);
    for (const entry of files.slice(0, 128)) add(join(folder, entry.name), provider, kind, scope, extra);
  };
  for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "USER.md"]) add(join(home, name), "shared", "guidance");
  for (const name of ["MEMORY.md", "memory.md"]) add(join(home, name), "shared", "memory");
  for (const a of inventory.agents) {
    const provider: MemoryProvider = ["pi", "codex", "claude", "cursor", "gemini"].includes(a.id) ? a.id as MemoryProvider : "other";
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "USER.md"]) add(join(a.root, name), provider, "guidance");
    for (const name of ["MEMORY.md", "memory.md"]) add(join(a.root, name), provider, "memory");
  }
  for (const g of inventory.guidance) add(g.path, (["pi", "codex", "claude", "cursor", "gemini"].includes(g.owner) ? g.owner : "other") as MemoryProvider, "guidance");
  // Prefer Codex's active global override, rather than merging a disabled base instruction.
  const override = join(home, ".codex/AGENTS.override.md");
  if ((await stat(override).catch(() => undefined))?.isFile()) { specs.delete(join(home, ".codex/AGENTS.md")); add(override, "codex", "guidance"); }
  for (const name of ["MEMORY.md", "memory_summary.md", "raw_memories.md"]) add(join(home, ".codex/memories", name), "codex", "memory");
  add(join(home, ".codebuddy/CODEBUDDY.md"), "codebuddy", "guidance");
  await addFiles(join(home, ".codebuddy/rules"), "codebuddy", "guidance", "global", {}, /\.md$/i);
  // CodeBuddy documents this as the cross-project Auto Memory directory. The
  // sibling project-id directories have no documented path-to-project mapping;
  // do not guess and accidentally recall another project's memory.
  await addFiles(join(home, ".codebuddy/memories/global"), "codebuddy", "memory", "global", {}, /\.md$/i);
  const codebuddyProjects = (await readdir(join(home, ".codebuddy/memories"), { withFileTypes: true }).catch(() => []))
    .filter(e => e.isDirectory() && e.name !== "global");
  if (codebuddyProjects.length) notices.push("CodeBuddy project Auto Memory requires explicit registration with its project path.");
  for (const name of ["USER.md", "MEMORY.md", "memory.md"]) add(join(home, ".openclaw/workspace", name), "openclaw", name === "USER.md" ? "guidance" : "memory");
  const claude = join(home, ".claude/projects");
  const projects = (await readdir(claude, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  if (projects.length > 256) notices.push("Claude project memory scan was partial (256 directories).");
  for (const entry of projects.slice(0, 256)) await addFiles(join(claude, entry.name, "memory"), "claude", "memory", "project", { project: `claude:${entry.name}` }, /\.md$/i);
  if (project) {
    // Read only the active workspace and its repository root, not unrelated local projects.
    const actual = await realpath(workspace!).catch(() => project);
    const dirs: string[] = []; let dir = actual;
    while (inside(project, dir)) { dirs.push(dir); if (dir === project) break; dir = dirname(dir); }
    for (const root of dirs.reverse()) {
      const codexFile = (await stat(join(root, "AGENTS.override.md")).catch(() => undefined))?.isFile() ? "AGENTS.override.md" : "AGENTS.md";
      for (const [file, provider] of [[codexFile, "codex"], ["CLAUDE.md", "claude"], ["CLAUDE.local.md", "claude"], [".claude/CLAUDE.md", "claude"], ["CODEBUDDY.md", "codebuddy"], ["CODEBUDDY.local.md", "codebuddy"], [".codebuddy/CODEBUDDY.md", "codebuddy"], [".cursorrules", "cursor"]] as const)
        add(join(root, file), provider, "guidance", "project", { project });
      await addFiles(join(root, ".cursor/rules"), "cursor", "guidance", "project", { project }, /\.(?:md|mdc)$/i);
      await addFiles(join(root, ".codebuddy/rules"), "codebuddy", "guidance", "project", { project }, /\.md$/i);
      await addFiles(join(root, ".claude/rules"), "claude", "guidance", "project", { project }, /\.md$/i);
    }
  }
  // Registration is a user-maintained file: no guessed vendor-internal databases or exports.
  const manifest = join(directory, "memory-imports.json");
  try {
    const info = await stat(manifest);
    if (info.size > 65536) throw new Error("manifest exceeds 64 KiB");
    const imports: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (!Array.isArray(imports) || imports.length > 128) throw new Error("expected an array of at most 128 imports");
    for (const [index, item] of imports.entries()) {
      if (!item || typeof item !== "object") { notices.push(`Invalid memory import #${index + 1}`); continue; }
      const x = item as Record<string, unknown>;
      if (typeof x.path !== "string" || !isAbsolute(x.path) || !/\.(?:md|mdc|txt)$/i.test(x.path) ||
        !["chatgpt", "dot", "cursor", "workbuddy", "codebuddy", "openclaw", "codex", "claude", "other"].includes(String(x.provider)) ||
        !["global", "project"].includes(String(x.scope)) || !["general", "work", "life", "unknown"].includes(String(x.domain)) ||
        (x.scope === "project" && (typeof x.project !== "string" || !isAbsolute(x.project)))) {
        notices.push(`Invalid memory import #${index + 1}`); continue;
      }
      const targetProject = x.scope === "project" ? await memoryProject(x.project as string) : undefined;
      if (x.scope === "project" && !targetProject) { notices.push(`Unavailable project for memory import #${index + 1}`); continue; }
      add(x.path, x.provider as MemoryProvider, "memory", x.scope as "global" | "project", { domain: x.domain as MemoryDomain, project: targetProject, explicit: true });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") notices.push(`Cannot read memory-imports.json: ${error instanceof Error ? error.message : String(error)}`); }
  return { specs: [...specs.values()], project, notices };
}

export function allowedMemoryPath(spec: SourceSpec, actual: string, home: string, project?: string): boolean {
  if (spec.explicit) return true;
  return inside(home, actual) || (!!project && inside(project, actual));
}
