import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until } from "./helpers.js";

function worker(mode: string, directory: string, stage: string) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/supervision-worker.ts", import.meta.url)), mode, directory, stage], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}
for (const stage of ["review", "rework"]) test(`SIGKILL during ${stage} preserves reviewer/submission identity and retry counts`, { timeout: 20_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `pi-${stage}-crash-`)));
  let processHandle: ChildProcess | undefined;
  try {
    const first = worker("create", directory, stage); processHandle = first.child;
    await until(async () => first.stdout(), text => text.includes('"type":"ready"'));
    const before = JSON.parse(first.stdout().trim().split("\n").at(-1)!);
    first.child.kill("SIGKILL"); await first.exit;
    await writeFile(join(directory, "release"), "resume");
    const second = worker("recover", directory, stage); processHandle = second.child;
    assert.equal(await second.exit, 0, second.stderr());
    const after = JSON.parse(second.stdout().trim().split("\n").at(-1)!);
    assert.equal(after.type, "completed");
    assert.equal(after.rootRequest, before.rootRequest);
    assert.equal(after.reworks, before.reworks);
    assert.equal(after.reworkInputs, stage === "rework" ? 1 : 0);
    if (stage === "review") {
      assert.equal(after.reviewerId, before.reviewerId);
      assert.deepEqual(after.conversations, before.conversations);
    }
  } finally { processHandle?.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
});
