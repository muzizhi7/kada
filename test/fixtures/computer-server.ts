import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setTimeout } from "node:timers/promises";

const server = new Server({ name: "simulated-desktop", version: "1.0.0" }, { capabilities: { tools: {} } });
let active = 0;
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "desktop_action", description: "Simulated action for integration tests.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "screen", description: "Simulated screenshot for integration tests.", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  active++;
  const atStart = active;
  try {
    await setTimeout(40);
    if (request.params.name === "screen") return { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4cAAAAASUVORK5CYII=" }] };
    return { content: [{ type: "text", text: JSON.stringify({ atStart, text: request.params.arguments?.text }) }] };
  } finally { active--; }
});
await server.connect(new StdioServerTransport());
