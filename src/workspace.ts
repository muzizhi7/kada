import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SerialQueue } from "./util.js";

export const ReadEvidence = defineDoc<{ files: Record<string, string[]> }>({
  scope: "session", kind: "local.read_evidence", version: 1, initial: () => ({ files: {} }), checkpointWhen: () => true,
});

export type FileSnapshot = { path: string; bytes: number; sha256: string };
export type DirectorySnapshot = FileSnapshot & { kind: "directory"; entries: number };
export type PathSnapshot = FileSnapshot | DirectorySnapshot;
/** A bounded text view is unavailable; the file can still be a valid binary artifact. */
export class TextFileError extends Error {}

export class Workspace {
  private writes = new SerialQueue();
  private constructor(readonly root: string) {}
  static async open(path: string, options: { create?: boolean } = {}): Promise<Workspace> {
    if (options.create !== false) await mkdir(path, { recursive: true });
    return new Workspace(await realpath(path));
  }
  private contains(path: string): boolean {
    const rel = relative(this.root, path);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  }
  async path(input: string, cwd = this.root): Promise<string> {
    const target = resolve(cwd, input);
    if (!this.contains(target)) throw new Error("Path is outside this task's workspace");
    // Resolve every existing component; reject symlinks, including in a path being created.
    const parts = relative(this.root, target).split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace tools");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return target;
  }
  private async snapshot(input: string, cwd: string | undefined, text: boolean): Promise<{ file: FileSnapshot; text?: string }> {
    const absolute = await this.path(input, cwd);
    // NONBLOCK lets us reject a FIFO/device rather than hanging while opening it.
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error(`Not a regular workspace file: ${input}`);
      if (text && before.size > 1_048_576) throw new TextFileError("Text reads require a regular UTF-8 file of at most 1 MiB; file existence and artifact hashing have no text-size limit");
      const hash = createHash("sha256"), chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (text && bytes > 1_048_576) throw new TextFileError("Text reads are limited to 1 MiB");
        hash.update(chunk);
        if (text) chunks.push(chunk);
      }
      const after = await file.stat();
      await this.path(input, cwd);
      const current = await lstat(absolute);
      if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || current.dev !== after.dev || current.ino !== after.ino ||
          current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
        throw new Error(`File changed while checking: ${input}. Inspect it and verify again.`);
      }
      const evidence = { path: absolute, bytes, sha256: hash.digest("hex") };
      if (!text) return { file: evidence };
      const content = Buffer.concat(chunks);
      if (content.includes(0)) throw new TextFileError(`Text reads do not accept binary NUL bytes: ${input}`);
      try { return { file: evidence, text: new TextDecoder("utf-8", { fatal: true }).decode(content) }; }
      catch { throw new TextFileError(`Text reads require valid UTF-8: ${input}`); }
    } finally { await file.close(); }
  }
  async inspect(input: string, cwd?: string): Promise<FileSnapshot> {
    return (await this.snapshot(input, cwd, false)).file;
  }
  /** A directory digest covers names, original file bytes and empty directories.
   * Links/special files are not followed. This observes a tree, not an OS transaction.
   */
  async inspectTree(input: string, cwd?: string): Promise<{ root: PathSnapshot; files: FileSnapshot[] }> {
    const absolute = await this.path(input, cwd);
    if (!(await lstat(absolute)).isDirectory()) {
      const file = await this.inspect(absolute);
      return { root: file, files: [file] };
    }
    const scan = async () => {
      const nodes: { path: string; name: string; directory: boolean; stamp: string }[] = [];
      const walk = async (path: string) => {
        await this.path(path);
        const stat = await lstat(path);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Not a regular file or directory: ${path}`);
        nodes.push({ path, name: relative(absolute, path).split(sep).join("/"), directory: stat.isDirectory(),
          stamp: JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]) });
        if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(resolve(path, name));
      };
      await walk(absolute);
      return nodes;
    };
    const before = await scan(), files: FileSnapshot[] = [];
    const members: unknown[] = [];
    for (const node of before) {
      if (node.directory) members.push([node.name, "directory"]);
      else {
        const file = await this.inspect(node.path);
        files.push(file); members.push([node.name, "file", file.bytes, file.sha256]);
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(await scan())) throw new Error(`Directory changed while checking: ${input}. Inspect it and verify again.`);
    return { root: { path: absolute, kind: "directory", entries: before.length - 1,
      bytes: files.reduce((total, file) => total + file.bytes, 0), sha256: createHash("sha256").update(JSON.stringify(members)).digest("hex") }, files };
  }
  async inspectPath(input: string, cwd?: string): Promise<PathSnapshot> {
    return (await this.inspectTree(input, cwd)).root;
  }
  async readSnapshot(input: string, cwd?: string): Promise<{ file: FileSnapshot; text: string }> {
    const result = await this.snapshot(input, cwd, true);
    return { file: result.file, text: result.text! };
  }
  async read(input: string, cwd?: string): Promise<string> {
    return (await this.readSnapshot(input, cwd)).text;
  }
  async write(input: string, text: string, cwd?: string): Promise<void> {
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("write_file is limited to 1 MiB");
    await this.writes.run(async () => {
      const path = await this.path(input, cwd);
      await mkdir(dirname(path), { recursive: true });
      await this.path(input, cwd);
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
        await rename(temp, path);
      } finally { await unlink(temp).catch(() => {}); }
    });
  }
  async list(input = ".", cwd?: string): Promise<string[]> {
    const files = await readdir(await this.path(input, cwd), { withFileTypes: true });
    return files.slice(0, 500).map(f => f.name + (f.isDirectory() ? "/" : f.isSymbolicLink() ? " [symlink]" : ""));
  }
}

export function workspaceExtension(workspace: Workspace, readonly = false) {
  const tools = [
    defineTool({
      name: "read_file", description: "Read a UTF-8 file inside the task workspace. Paths are relative to your working directory, or absolute within the workspace.",
      parameters: Type.Object({ path: Type.String() }), replay: "safe",
      execute: async (args, api, ctx) => {
        const cwd = (await api.agent(ctx)).cwd;
        const text = await workspace.read(args.path, cwd);
        if (readonly) {
          const file = await workspace.path(args.path, cwd);
          await api.commit(async tx => {
            const evidence = await tx.doc(ReadEvidence);
            const key = String(api.conversationId);
            const paths = evidence.files[key] ?? [];
            if (!paths.includes(file)) evidence.files[key] = [...paths, file];
          }, ctx);
        }
        return { output: [{ type: "text", text }] };
      },
    }),
    defineTool({
      name: "write_file", description: "Create or replace a UTF-8 file inside the task workspace. After an interrupted write, read the actual file before deciding to repeat it.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (args, api, ctx) => {
        const cwd = (await api.agent(ctx)).cwd;
        await workspace.write(args.path, args.content, cwd);
        return { output: [{ type: "text", text: `Saved ${await workspace.path(args.path, cwd)}` }] };
      },
    }),
    defineTool({
      name: "list_files", description: "List up to 500 entries in a workspace directory.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }), replay: "safe",
      execute: async (args, api, ctx) => ({ output: [{ type: "text", text: (await workspace.list(args.path, (await api.agent(ctx)).cwd)).join("\n") }] }),
    }),
  ];
  return defineExtension({ name: readonly ? "local_readonly_files" : "local_files", tools: readonly ? tools.filter(t => t.name !== "write_file") : tools });
}
