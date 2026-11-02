import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until } from "./helpers.js";

for (const stage of ["waiting", "executing"]) test(`SIGKILL while ${stage} preserves confirmation boundary, budget and already executed work`, { timeout: 25000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-brief-crash-")));
  let processHandle: ChildProcess | undefined;
  const worker = (mode: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/preparation-worker.ts", import.meta.url)), mode, directory, stage], { stdio: ["ignore", "pipe", "pipe"] });
    processHandle = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { child, exit, stdout: () => stdout, stderr: () => stderr };
  };
  try {
    const first = worker("create");
    await until(async () => first.stdout(), text => text.includes('"type":"ready"'));
    const before = JSON.parse(first.stdout().trim().split("\n").at(-1)!);
    first.child.kill("SIGKILL"); await first.exit;
    await writeFile(join(directory, "release"), "resume");
    const second = worker("recover");
    assert.equal(await second.exit, 0, second.stderr());
    const after = JSON.parse(second.stdout().trim().split("\n").at(-1)!);
    assert.equal(after.taskId, before.taskId);
    assert.equal(after.digest, before.digest);
    assert.deepEqual(after.confirmation, before.confirmation);
    assert.equal(after.budget.costLimit, before.budget.costLimit);
    if (stage === "waiting") {
      assert.equal(after.status, "awaiting_confirmation");
      assert.equal(after.outputExists, false);
      assert.equal(after.modelCalls, 0);
      assert.equal(after.confirmations, 0);
      assert.deepEqual(after.budget, before.budget);
    } else {
      assert.equal(after.status, "completed");
      assert.equal(after.confirmInputs, 1);
      assert.equal(after.confirmations, 1);
      assert.equal(after.bashCalls, 1);
      assert.deepEqual(after.proofIds, before.proofIds);
      assert.equal(after.proofIds.length, 1);
    }
  } finally { processHandle?.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
});
