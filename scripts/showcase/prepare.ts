import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export async function prepareShowcase(directory: string, source?: string) {
  const staged = resolve(source ?? ".harness/benchmarks/feedback-2026-10-31-corrected/fixtures/files-normalize/incoming");
  if (!(await lstat(staged).catch(() => undefined))?.isDirectory()) throw new Error("Provide the pinned Click source checkout with --source /path/to/click; no model call was made.");
  const workspace = join(directory, "workspace");
  await mkdir(directory, { recursive: true });
  await cp(resolve("examples/handover/seed"), workspace, { recursive: true });
  await cp(staged, join(workspace, "incoming"), { recursive: true,
    filter: async path => !path.split(/[\\/]/).some(part => [".git", "__pycache__", ".DS_Store"].includes(part)) && !(await lstat(path)).isSymbolicLink() });
  const edge = join(workspace, "incoming/_edge_cases");
  await mkdir(join(edge, "empty-dir"), { recursive: true });
  const controlled: Record<string, Buffer> = {
    "bom.txt": Buffer.from("\ufeff中文\r\nsecond\r\n"), "crlf.txt": Buffer.from("one\r\ntwo\rend\n"),
    "invalid.bin": Buffer.from([0x80, 0xff, 13, 10]), "nul.dat": Buffer.from("binary\0\r\n"),
    "empty": Buffer.alloc(0), ".hidden": Buffer.from("  \r\n\r\n"), "space name.txt": Buffer.from("a\r\nb\rc\n"),
  };
  for (const [name, bytes] of Object.entries(controlled)) await writeFile(join(edge, name), bytes);
  await mkdir(join(workspace, "inputs"));
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await walk(name);
      else {
        const data = await readFile(name);
        entries.push({ path: name.slice(join(workspace, "incoming").length + 1), bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      }
    }
  }
  await walk(join(workspace, "incoming"));
  const provenance = { repository: "https://github.com/pallets/click", expectedCommit: "2247b35ea1c47c727d7a06e51fa280e12a863ff6",
    source: source ? "User-supplied local checkout; verify its commit separately" : "Previously pinned Click snapshot from the local feedback regression materials",
    license: "incoming/LICENSE.txt", controlledEdgeFiles: Object.keys(controlled), addedEmptyDirectory: "_edge_cases/empty-dir",
    symlinkPolicy: "staging skips links without following them; this example has no symlink inputs", entries };
  await writeFile(join(workspace, "inputs/provenance.json"), JSON.stringify(provenance, null, 2));
  return workspace;
}
