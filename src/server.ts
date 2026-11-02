import { createServer, type IncomingMessage } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Config } from "./config.js";
import { ComputerBridge } from "./computer.js";
import { VERSION } from "./version.js";
import { LocalRuntime, type RuntimeOptions } from "./runtime.js";
import { cloudModels } from "./models.js";
import { errorText } from "./util.js";
import { taskView } from "./task-view.js";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error("Request body exceeds 64 KiB");
    chunks.push(Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

export async function serve(config: Config, options?: RuntimeOptions) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.dataDir, { stale: 5000, update: 1000, retries: { retries: 6, minTimeout: 1000, maxTimeout: 1000 } });
  const computer = new ComputerBridge();
  let runtime: LocalRuntime | undefined;
  let token: string;
  const tokenFile = join(config.dataDir, "token");
  try { token = (await readFile(tokenFile, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await release(); throw error; }
    token = randomBytes(32).toString("hex");
    await writeFile(tokenFile, token + "\n", { mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(token)) { await release(); throw new Error("Invalid daemon token file"); }
  let ready = false;
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      if (!ready || !runtime) return send(503, { error: "Runtime is starting" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
      if (url.pathname === "/health" && req.method === "GET") return send(200, { status: "ok", version: VERSION });
      const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: "Unauthorized" });
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${config.port}`) return send(403, { error: "Cross-origin requests are not allowed" });
      if (url.pathname === "/v1/environment" && req.method === "GET") return send(200, await runtime.localSetup());
      if (url.pathname === "/v1/environment/refresh" && req.method === "POST") return send(200, await runtime.localSetup(true));
      if (url.pathname === "/v1/tasks" && req.method === "GET") return send(200, await runtime.list());
      if (url.pathname === "/v1/tasks" && req.method === "POST") {
        const input = await body(req);
        if (typeof input.objective !== "string" || (input.workspace !== undefined && typeof input.workspace !== "string")) throw new Error("Expected objective and optional workspace strings");
        if (input.confirmed !== undefined && typeof input.confirmed !== "boolean") throw new Error("confirmed must be a boolean");
        return send(201, await runtime.create(input.objective, input.workspace, input.acceptance, { prepare: input.confirmed !== true }));
      }
      const match = /^\/v1\/tasks\/([a-f0-9-]{36})(?:\/(pause|resume|cancel|messages|confirm|view))?$/.exec(url.pathname);
      if (!match) return send(404, { error: "Not found" });
      const id = match[1]!;
      if (match[2] === "view" && req.method === "GET") return send(200, taskView(await runtime.status(id)));
      if (!match[2] && req.method === "GET") return send(200, await runtime.status(id));
      if (req.method !== "POST") return send(405, { error: "Method not allowed" });
      const input = await body(req);
      switch (match[2]) {
        case "pause": await runtime.pause(id); break;
        case "resume": await runtime.resume(id); break;
        case "cancel": await runtime.cancel(id); break;
        case "confirm":
          if (!Number.isSafeInteger(input.revision) || typeof input.digest !== "string") throw new Error("Confirm requires the displayed brief revision and digest");
          await runtime.confirm(id, input.revision as number, input.digest); break;
        case "messages":
          if (typeof input.message !== "string" || (input.requestId !== undefined && typeof input.requestId !== "string")) throw new Error("Expected message and optional requestId strings");
          await runtime.followUp(id, input.message, input.requestId); break;
        default: return send(404, { error: "Not found" });
      }
      return send(200, { ok: true });
    } catch (error) { send((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400, { error: errorText(error) }); }
  });
  try {
    const extensions = config.computer ? [await computer.connect(config.computer)] : [];
    runtime = new LocalRuntime(config, { ...options, models: options?.models ?? cloudModels(), extensions: [...extensions, ...(options?.extensions ?? [])], computer: config.computer ? computer : options?.computer });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
    await runtime.recover();
    await runtime.localSetup();
    ready = true;
  } catch (error) {
    server.close();
    await runtime?.close();
    await computer.close();
    await release();
    throw error;
  }
  let closing = false;
  return {
    runtime,
    async close() {
      if (closing) return;
      closing = true;
      ready = false;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { await runtime!.close(); await computer.close(); } finally { await release(); }
    },
  };
}
