import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function worker(mode: string, directory: string) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/recovery-worker.ts", import.meta.url)), mode, directory], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

test("SIGKILL during two live subagents recovers without duplicating children", { timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-crash-")));
  let processHandle: ChildProcess | undefined;
  try {
    const first = worker("create", directory);
    processHandle = first.child;
    const { until } = await import("./helpers.js");
    await until(async () => first.stdout(), text => text.includes('"type":"ready"'));
    const before = JSON.parse(first.stdout().trim().split("\n").at(-1)!);
    assert.equal(before.ids.length, 3);
    first.child.kill("SIGKILL");
    assert.equal((await first.exit).signal, "SIGKILL");
    await writeFile(join(directory, "release"), "resume");
    const second = worker("recover", directory);
    processHandle = second.child;
    const result = await second.exit;
    assert.equal(result.code, 0, second.stderr());
    const after = JSON.parse(second.stdout().trim().split("\n").at(-1)!);
    assert.equal(after.type, "completed");
    assert.deepEqual(after.ids, before.ids);
    const report = await readFile(join(directory, "workspace", "report.md"), "utf8");
    assert.match(report, /Alpha source/);
    assert.match(report, /Beta source/);
  } finally { processHandle?.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
});
