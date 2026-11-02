import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Workspace } from "./workspace.js";

// Task-specific evidence only. Pi stores the actual calls and their results.
export const WebUse = defineDoc<{ queries: string[]; pages: string[] }>({
  scope: "session", kind: "local.web_use", version: 1, initial: () => ({ queries: [], pages: [] }), checkpointWhen: () => true,
});
export function needsWeb(text: string): boolean {
  const request = text.replace(/(?:不要|无需|不用)(?:查资料|联网搜索|联网检索|联网查询)/g, "");
  return /查资料|联网(?:搜索|检索|查询)|网上(?:搜索|查询)|search the web|web research/i.test(request);
}

export function webExtension(workspace: Workspace, options: { key?: string; fetch?: typeof fetch } = {}) {
  const key = options.key ?? process.env.DEEPSEEK_API_KEY;
  const request = options.fetch ?? fetch;
  const reach = async (args: string[], api: ToolExecutionApi, context: Context) => {
    if (!api.env) throw new Error("No local execution environment for Agent Reach");
    let text = "";
    const result = await api.env.exec(["agent-reach", "web", ...args, "--timeout", "30"], {
      timeout: 35, inheritEnv: false,
      onOutput(chunk) { text += chunk; if (text.length > 1_000_000) throw new Error("Agent Reach result exceeds 1 MB"); },
    }, context);
    if (!result.ok) throw result.error;
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(`Agent Reach: ${data.error?.code}: ${data.error?.message ?? "request failed"}`);
    return data.items as { title?: string; url?: string; text?: string; published_at?: string }[];
  };
  const deepseek = async (endpoint: string, body: unknown, context: Context) => {
    const response = await request(`https://api.deepseek.com/v1/tools/${endpoint}`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: context.abortSignal ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(`DeepSeek ${endpoint}: HTTP ${response.status}: ${String(data.error?.message ?? "request failed").slice(0, 600)}`), { status: response.status });
    return data;
  };
  const saved = async (kind: string, input: string, data: unknown) => {
    const path = `.sources/${kind}-${createHash("sha256").update(input).digest("hex").slice(0, 20)}.json`;
    await workspace.write(path, JSON.stringify({ retrievedAt: new Date().toISOString(), input, ...data as object }, null, 2));
    return workspace.path(path);
  };
  const usage = (paid: boolean) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: paid ? 0.00075 : 0 } });
  return defineExtension({ name: "local_web", tools: [
    defineTool({ name: "web_search", description: "Search live web sources, preferably through DeepSeek's official Search API; Agent Reach is the fallback when no key is configured. Returns source URLs, dates and summaries, not proof that page bodies were read. Save and cite actual sources; use web_fetch for the body.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 128 }), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), replay: "safe",
      execute: async (args, api, context) => {
        const count = args.count ?? 5;
        const results = key ? (await deepseek("search", { query: args.query, count, need_content: false }, context)).results as { title: string; url: string; date?: string; summary?: string; snippet?: string }[]
          : (await reach(["search", args.query, "--limit", String(count)], api, context)).map(i => ({ title: i.title ?? "", url: i.url ?? "", date: i.published_at, summary: i.text, snippet: undefined }));
        const sources = results.map(r => ({ title: r.title, url: r.url, publishedAt: r.date ?? null, summary: (r.summary ?? r.snippet ?? "").slice(0, 1500) }));
        const file = await saved("search", args.query, { sources });
        if (sources.length) await api.commit(async tx => { const state = await tx.doc(WebUse); if (!state.queries.includes(args.query)) state.queries.push(args.query); }, context);
        return { output: [{ type: "text", text: JSON.stringify({ provider: key ? "deepseek" : "agent-reach", file, sources }) }], usage: usage(Boolean(key && sources.length)) };
      },
    }),
    defineTool({ name: "web_fetch", description: "Read a real HTTP(S) page body using DeepSeek Fetch. Ordinary unavailable pages may fall back to the installed Agent Reach CLI. Authentication, policy and rate-limit errors are not bypassed. Stores the full fetched content locally and returns a bounded preview; use Pi read with offsets for more.",
      parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192 }) }), replay: "safe",
      execute: async (args, api, context) => {
        const url = new URL(args.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Expected a public HTTP(S) URL without credentials");
        let page: { title: string; content: string } | undefined;
        if (key) {
          try { page = await deepseek("fetch", { url: args.url }, context); }
          catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
        }
        const provider = page ? "deepseek" : "agent-reach";
        if (!page) { const items = await reach(["read", args.url], api, context); page = { title: items[0]?.title ?? "", content: items.map(i => i.text ?? "").join("\n") }; }
        if (!page.content?.trim()) throw new Error("No readable page body was retrieved");
        const file = await saved("page", args.url, { url: args.url, ...page, provider });
        await api.commit(async tx => { const state = await tx.doc(WebUse); if (!state.pages.includes(args.url)) state.pages.push(args.url); }, context);
        return { output: [{ type: "text", text: JSON.stringify({ url: args.url, title: page.title, provider, file, content: page.content.slice(0, 16_000), truncated: page.content.length > 16_000 }) }], usage: usage(provider === "deepseek") };
      },
    }),
  ] });
}
