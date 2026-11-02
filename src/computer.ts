import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ComputerConfig } from "./config.js";
import { SerialQueue } from "./util.js";
import { VERSION } from "./version.js";

/** A thin MCP adapter and one local desktop lease. The driver owns all UI automation. */
export class ComputerBridge {
  private client?: Client;
  private queue = new SerialQueue();
  private tools: Tool[] = [];
  private resources: { uri: string; name: string }[] = [];
  private config?: ComputerConfig;
  private lease?: { owner: string; expiresAt: number; observed: boolean };
  async connect(config: ComputerConfig): Promise<Extension> {
    this.config = config;
    const client = new Client({ name: "local-pi-harness", version: VERSION });
    this.client = client;
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: "inherit" }));
    const available: Tool[] = [];
    let cursor: string | undefined;
    do { const page = await client.listTools({ cursor }); available.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    for (const name of config.tools) if (!available.some(t => t.name === name)) throw new Error(`Configured computer tool not found: ${name}`);
    this.tools = available.filter(t => config.tools.includes(t.name));
    if (client.getServerCapabilities()?.resources) {
      cursor = undefined;
      do { const page = await client.listResources({ cursor }); this.resources.push(...page.resources.map(r => ({ uri: r.uri, name: r.name }))); cursor = page.nextCursor; } while (cursor);
    }
    // Old tasks retain their per-call serialized interface. New tasks use forTask().
    return this.extension();
  }
  forTask(owner: string): Extension { return this.extension(owner); }
  release(owner: string): void { if (this.lease?.owner === owner) this.lease = undefined; }
  private observer(tool: Tool): boolean {
    return this.config?.observationTools ? this.config.observationTools.includes(tool.name) : tool.annotations?.readOnlyHint === true;
  }
  private extension(owner?: string): Extension {
    const client = this.client;
    if (!client) throw new Error("Computer driver is not connected");
    const remote = this.tools.map((tool, index) => defineTool({
      name: `computer_${index}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64),
      description: `Desktop tool ${tool.name}: ${tool.description ?? ""}. ${owner ? "Use computer_begin before a workflow and computer_end afterwards; re-observe after reconnect or a new lease." : "Calls are serialized."} An interrupted action is ambiguous; inspect the real app before retrying.`,
      parameters: tool.inputSchema as TSchema, replay: "unsafe",
      execute: async (args, _api, context) => this.queue.run(async () => {
        context.abortSignal?.throwIfAborted();
        if (owner) {
          if (!this.lease || this.lease.expiresAt <= Date.now() || this.lease.owner !== owner) throw new Error("Desktop lease missing or expired. Call computer_begin, then observe current app state before acting.");
          const hasObservers = this.tools.some(t => this.observer(t));
          if (hasObservers && !this.lease.observed && !this.observer(tool)) throw new Error("A fresh observation is required before desktop actions. Call an observation tool first.");
          this.lease.expiresAt = Date.now() + (this.config?.leaseMs ?? 120_000);
        }
        const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal: context.abortSignal, timeout: 60_000 }) as CallToolResult;
        if (owner && this.lease?.owner === owner && !result.isError && this.observer(tool)) this.lease.observed = true;
        return { isError: result.isError === true, output: result.content.flatMap((block): NonNullable<ToolExecutionResult["output"]> => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type === "image") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
          return [{ type: "text", text: JSON.stringify(block) }];
        }) };
      }),
    }));
    const lease = owner ? [
      defineTool({ name: "computer_begin", description: "Acquire the local desktop for one dependent workflow. If busy, continue independent work before retrying. Every new/expired lease requires observing current app state. Read computer_guide when available before using a new driver.", parameters: Type.Object({}), replay: "safe", executionMode: "sequential",
        execute: async (_args, _api, context) => this.queue.run(async () => {
          context.abortSignal?.throwIfAborted();
          if (this.lease && this.lease.expiresAt > Date.now() && this.lease.owner !== owner) throw new Error("Desktop is in use by another task. Do independent work before retrying; do not send desktop actions.");
          if (!this.lease || this.lease.expiresAt <= Date.now() || this.lease.owner !== owner) this.lease = { owner, expiresAt: 0, observed: false };
          this.lease.expiresAt = Date.now() + (this.config?.leaseMs ?? 120_000);
          return { output: [{ type: "text", text: "Desktop acquired. Observe current app state; earlier captures and coordinates may be stale. Release with computer_end after this workflow." }] };
        }),
      }),
      defineTool({ name: "computer_end", description: "Release this task's desktop workflow lease so another task can use it.", parameters: Type.Object({}), replay: "safe", executionMode: "sequential",
        execute: async () => { this.release(owner); return { output: [{ type: "text", text: "Desktop released" }] }; },
      }),
    ] : [];
    const guides = this.resources.length ? [defineTool({ name: "computer_guide", description: "List the connected driver's bundled instructions, or read one advertised resource URI. Read its main skill and platform instructions before operating apps. This reads documentation; it does not grant permissions.",
      parameters: Type.Object({ uri: Type.Optional(Type.String()) }), replay: "safe",
      execute: async (args, _api, context) => {
        if (!args.uri) return { output: [{ type: "text", text: JSON.stringify(this.resources) }] };
        if (!this.resources.some(r => r.uri === args.uri)) throw new Error("Resource URI was not advertised by this driver");
        const result = await client.readResource({ uri: args.uri }, { signal: context.abortSignal, timeout: 30_000 });
        return { output: result.contents.flatMap(c => "text" in c ? [{ type: "text" as const, text: c.text }] : []) };
      },
    })] : [];
    return defineExtension({ name: "local_computer", tools: [...remote, ...lease, ...guides] });
  }
  async close(): Promise<void> { this.lease = undefined; await this.client?.close(); }
}
