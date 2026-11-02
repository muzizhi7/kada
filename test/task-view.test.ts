import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { serve } from "../src/server.js";
import { demoFixture, until } from "./helpers.js";

test("desktop delivery projection keeps confirmation/budget semantics and excludes transcripts, proofs and unverified candidates", async () => {
  const f = await demoFixture(80);
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  const server = await serve({ ...f.config, port }, { models: f.models });
  const base = `http://127.0.0.1:${port}`;
  try {
    const task = await server.runtime.create("Complete the existing two-worker demo.", f.workspace);
    assert.equal((await fetch(`${base}/v1/tasks/${task.id}/view`)).status, 401);
    const token = (await readFile(join(f.directory, "token"), "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}` };
    const pending = await fetch(`${base}/v1/tasks/${task.id}/view`, { headers });
    const first = await pending.json() as Record<string, unknown>;
    assert.equal(pending.status, 200);
    assert.equal(first.delivery, null);
    for (const key of ["messages", "tasks", "conversations", "usage", "goal", "proofs"]) assert.equal(key in first, false, key);
    assert.deepEqual(first.resumeBudget, { maxEstimatedCostUsd: 1, maxDurationMs: f.config.maxDurationMs, maxTotalTokens: null });
    await until(() => server.runtime.status(task.id), value => value.status === "completed");
    const completed = await (await fetch(`${base}/v1/tasks/${task.id}/view`, { headers })).json() as {
      status: string; delivery: { artifacts: string[]; verification: string }; budget: { costLimit: number };
    };
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.delivery.artifacts, ["report.md"]);
    assert.match(completed.delivery.verification, /独立模型复核：通过/);
    assert.equal(completed.budget.costLimit, 1);
  } finally { await server.close(); await f.close(); }
});
