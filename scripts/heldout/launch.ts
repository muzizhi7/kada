import { spawn } from "node:child_process";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createRequire } from "node:module";
import { save, type RunConfig } from "./common.js";

/** Experiment process control only; each worker uses the existing Pi execution engine. */
export async function launchRun(config: RunConfig, workerFile: string) {
  const configFile = join(config.directory, "run.json");
  await save(configFile, config);
  let interrupted = false, attempts = 0, processFailure: unknown;
  for (;;) {
    const logfile = await open(join(config.directory, "worker.log"), "a");
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), workerFile, configFile], { stdio: ["ignore", logfile.fd, logfile.fd], env: process.env });
    await logfile.close();
    await save(join(config.directory, "worker-process.json"), { pid: child.pid, attempt: attempts, startedAt: Date.now() });
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("exit", (code, signal) => { exit = { code, signal }; });
    child.on("error", error => { processFailure = String(error); exit = { code: -1, signal: null }; });
    let lastLog = 0;
    while (!exit) {
      if (!interrupted && config.crashWatch) {
        const names = await readdir(join(config.workspace, config.crashWatch)).catch(() => []);
        const finished = await readFile(join(config.directory,"result.json"),"utf8").then(()=>true).catch(()=>false);
        if (names.length && !finished) {
          interrupted = true;
          await save(join(config.directory, "interruption.json"), { at: Date.now(), pid: child.pid, kind: "SIGKILL", boundary: config.crashWatch, observedFiles: names.slice(0, 8), note: "Files were visible before killing only this benchmark worker; external command state may already have changed." });
          child.kill("SIGKILL");
        }
      }
      if (Date.now() - lastLog >= 30_000) {
        const progress = await readFile(join(config.directory, "progress.json"), "utf8").then(data => JSON.parse(data) as unknown).catch(() => null);
        console.log(JSON.stringify({ sequence: config.sequence, task: config.task, arm: config.arm, repeat: config.repeat, attempt: attempts, progress }));
        lastLog = Date.now();
      }
      await setTimeout(40);
    }
    const ended = exit as { code: number | null; signal: NodeJS.Signals | null };
    if (ended.signal === "SIGKILL" && interrupted && attempts === 0) { attempts++; continue; }
    if (ended.code !== 0) processFailure = processFailure ?? ended;
    break;
  }
  const result = await readFile(join(config.directory, "result.json"), "utf8").then(data => JSON.parse(data) as Record<string, unknown>).catch(() => ({ execution: "worker_error", budget: null }));
  const combined = { ...result, task: config.task, category: config.category, arm: config.arm, repeat: config.repeat, sequence: config.sequence, directory: config.directory,
    interruption: { planned: Boolean(config.crashWatch), injected: interrupted, restarts: attempts }, processFailure: processFailure ?? null };
  await save(join(config.directory, "result.json"), combined);
  return combined;
}
