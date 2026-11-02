import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.js";

test("workspace rejects parent traversal and symlink escape for both reads and writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-"));
  try {
    const files = await Workspace.open(join(directory, "workspace"));
    await writeFile(join(directory, "outside.txt"), "private");
    await symlink(directory, join(files.root, "escape"));
    await assert.rejects(() => files.read("../outside.txt"), /outside/);
    await assert.rejects(() => files.read("escape/outside.txt"), /Symlinks/);
    await assert.rejects(() => files.write("escape/new/file.txt", "bad"), /Symlinks/);
    await files.write("nested/report.md", "verified");
    assert.equal(await files.read("nested/report.md"), "verified");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
