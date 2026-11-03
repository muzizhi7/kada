import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "smol-toml";
import { parse as parseJson, type ParseError } from "jsonc-parser";
import { atomicJson, readJson, SerialQueue } from "./util.js";
import { UserMemoryStore, userMemoryInstructions, type MemoryContext } from "./user-memory.js";

export type LocalSkill = { name: string; description: string; path: string; owner: string; disabled: boolean };
export type LocalPlugin = { name: string; owner: string; kind: "plugin" | "extension" | "package" | "mcp"; source: string; enabled?: boolean };
export type LocalAgent = { id: string; name: string; root: string; model?: string; language?: string };
export type LocalInventory = {
  schema: 1; scannedAt: number; home: string; platform: string; locale: string; timezone: string;
  agents: LocalAgent[]; skills: LocalSkill[]; plugins: LocalPlugin[]; guidance: { owner: string; path: string }[];
  notices: string[];
};
export type DiscoveryOptions = { home?: string; locale?: string; timezone?: string; maxEntries?: number; maxMs?: number };
export type LocalContext = { overview: string; catalogue: string; guidance: string[]; summary: string; skills: LocalSkill[]; memory?: MemoryContext };
const secret = /(?:sk-[a-z0-9_-]{16,}|(?:ghp|gho|github_pat|xox[baprs])[_-][a-z0-9_-]{12,}|AIza[a-z0-9_-]{16,})/i;
function label(value: unknown, max = 120): string | undefined {
  return typeof value === "string" && value.length <= max && !value.includes("://") && /^[\p{L}\p{N}@][\p{L}\p{N} _./:@+()-]*$/u.test(value) && !secret.test(value) ? value : undefined;
}
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

/** Known Agent locations only. No home-wide crawl, credential/history reads, imports or processes. */
export async function scanLocalAgents(options: DiscoveryOptions = {}): Promise<LocalInventory> {
  const home = await realpath(options.home ?? homedir());
  const result: LocalInventory = { schema: 1, scannedAt: Date.now(), home, platform: process.platform,
    locale: options.locale ?? Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    agents: [], skills: [], plugins: [], guidance: [], notices: [] };
  const deadline = Date.now() + (options.maxMs ?? 5000), maxEntries = options.maxEntries ?? 8000;
  let rootDeadline = deadline;
  let entries = 0, truncated = false;
  const disabledPluginRoots: string[] = [];
  const seen = new Set<string>(), skillFiles: { path: string; owner: string }[] = [];
  const withinBudget = () => {
    if (++entries <= maxEntries && Date.now() < Math.min(deadline, rootDeadline)) return true;
    truncated = true; return false;
  };
  const read = async (path: string) => {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 262144) { result.notices.push(`Skipped oversized/non-file metadata: ${path}`); return; }
      const bytes = Buffer.alloc(262145), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 262144) return;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.notices.push(`Unreadable metadata: ${path}`);
    } finally { await handle?.close(); }
  };
  const json = async (path: string) => {
    const text = await read(path); if (text === undefined) return {};
    try {
      if (path.endsWith(".toml")) return record(parseToml(text));
      const errors: ParseError[] = [], parsed = parseJson(text, errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length) throw new Error("Invalid JSON");
      return record(parsed);
    } catch { result.notices.push(`Malformed metadata: ${path}`); return {}; }
  };
  const addPlugin = (owner: string, kind: LocalPlugin["kind"], value: unknown, source: string, enabled?: boolean) => {
    const name = label(value); if (!name || result.plugins.length >= 512) return;
    if (disabledPluginRoots.some(path => source.startsWith(path + sep))) enabled = false;
    if (!result.plugins.some(p => p.owner === owner && p.kind === kind && p.name === name && p.source === source)) result.plugins.push({ name, owner, kind, source, ...(enabled === undefined ? {} : { enabled }) });
  };
  const localPath = (value: unknown, base: string) => {
    if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n\0]/.test(value) || /^[a-z]+:/i.test(value)) return;
    return value.startsWith("~/") ? join(home, value.slice(2)) : isAbsolute(value) ? value : resolve(base, value);
  };
  const configs = async (owner: string, path: string) => {
    const config = await json(path);
    for (const [name, item] of Object.entries(record(config.mcpServers ?? config.mcp_servers ?? config.mcp))) {
      const spec = record(item);
      addPlugin(owner, "mcp", name, path, spec.disabled === true || (Array.isArray(config.disabledMcpServers) && config.disabledMcpServers.includes(name)) ? false : typeof spec.enabled === "boolean" ? spec.enabled : undefined);
    }
    for (const [name, enabled] of Object.entries(record(config.enabledPlugins))) addPlugin(owner, "plugin", name, path, enabled === true);
    for (const value of [...(Array.isArray(config.plugin) ? config.plugin : []), ...(Array.isArray(config.packages) ? config.packages : [])]) {
      // Package declarations may contain credential-bearing git URLs. Keep safe identifiers only.
      addPlugin(owner, "package", typeof value === "string" ? value : record(value).source, path);
    }
    return config;
  };
  const walk = async (path: string, owner: string, mode: "skills" | "plugins", depth = 0): Promise<void> => {
    if (!withinBudget()) return;
    if (depth > 8) { truncated = true; return; }
    let canonical: string, children;
    try {
      canonical = await realpath(path);
      const identity = `${mode}:${canonical}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      if ((await stat(canonical)).isFile() && basename(canonical) === "SKILL.md") canonical = dirname(canonical);
      children = await readdir(canonical, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.notices.push(`Unreadable capability directory: ${path}`);
      return;
    }
    // Feed only bounded individual manifests into Pi, avoiding an unbounded/symlink-cyclic recursive loader.
    if (children.some(c => c.name === "SKILL.md")) {
      const file = join(canonical, "SKILL.md");
      try {
        const actual = await realpath(file), info = await stat(actual);
        if (skillFiles.length >= 512) truncated = true;
        else if (basename(actual) !== "SKILL.md" || !info.isFile() || info.size > 131072) result.notices.push(`Skipped oversized/non-standard Skill manifest: ${file}`);
        else if (!skillFiles.some(s => s.path === actual)) skillFiles.push({ path: actual, owner });
      } catch { result.notices.push(`Unreadable Skill: ${file}`); }
      return;
    }
    if (mode === "plugins") {
      for (const file of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", "gemini-extension.json"]) {
        if (!children.some(c => c.name === file.split("/")[0])) continue;
        const manifest = join(canonical, file), info = await json(manifest);
        if (label(info.name)) {
          addPlugin(owner, file === "gemini-extension.json" ? "extension" : "plugin", info.name, manifest);
          for (const name of Object.keys(record(info.mcpServers))) addPlugin(owner, "mcp", name, manifest);
        }
      }
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!withinBudget()) break;
      if (["node_modules", ".git", "sessions", "history", "logs", "marketplaces"].includes(child.name) ||
        (child.name.startsWith(".") && child.name !== ".system")) continue;
      if (child.isDirectory() || child.isSymbolicLink()) await walk(join(canonical, child.name), owner, mode, depth + 1);
      else if (mode === "plugins" && /\.(?:ts|js|mjs|cjs)$/.test(child.name) && depth === 0) addPlugin(owner, "extension", child.name, join(canonical, child.name));
    }
  };
  // Explicit paths stay predictable; existence denotes local configuration, not authentication/readiness.
  const agents = [
    ["shared", "Agent Skills", ".agents", []],
    ["pi", "Pi", ".pi/agent", ["settings.json", "mcp.json"]],
    ["codex", "Codex", ".codex", ["config.toml"]],
    ["claude", "Claude Code", ".claude", ["settings.json", ".mcp.json", "../.claude.json"]],
    ["cursor", "Cursor", ".cursor", ["mcp.json"]],
    ["opencode", "OpenCode", ".config/opencode", ["opencode.json", "opencode.jsonc"]],
    ["gemini", "Gemini CLI", ".gemini", ["settings.json"]],
    ["copilot", "Copilot CLI", ".copilot", ["config.json", "mcp-config.json"]],
  ] as const;
  const skillRoots: { path: string; owner: string }[] = [], pluginRoots: { path: string; owner: string }[] = [];
  for (const [id, name, location, filenames] of agents) {
    if (!withinBudget()) break;
    const root = join(home, location);
    if (!(await stat(root).catch(() => undefined))?.isDirectory() && !(id === "claude" && (await stat(join(home, ".claude.json")).catch(() => undefined))?.isFile())) continue;
    const agent: LocalAgent = { id, name, root }; result.agents.push(agent);
    const extraSkills: string[] = [];
    let pluginSettings: Record<string, any> = {};
    for (const filename of filenames) {
      const config = await configs(id, join(root, filename));
      const model = label(typeof config.model === "string" ? config.model : record(config.model).name ?? config.defaultModel, 100), language = label(config.language ?? record(config.general).language, 50);
      if (!agent.model && model) agent.model = model;
      if (!agent.language && language) agent.language = language;
      if (id === "claude" && config.enabledPlugins !== undefined) pluginSettings = record(config.enabledPlugins);
      // Pi's explicit skill paths are resources, not executable extensions or packages.
      if (id === "pi" && Array.isArray(config.skills)) for (const value of config.skills) {
        const path = localPath(value, root); if (path) extraSkills.push(path);
      }
    }
    for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const path = join(root, file);
      if ((await stat(path).catch(() => undefined))?.isFile()) result.guidance.push({ owner: id, path });
    }
    skillRoots.push({ path: join(root, "skills"), owner: id }, ...extraSkills.map(path => ({ path, owner: id })));
    if (id === "claude") {
      const path = join(root, "plugins/installed_plugins.json"), installed = await json(path);
      for (const [name, versions] of Object.entries(record(installed.plugins))) {
        addPlugin(id, "plugin", name, path, typeof pluginSettings[name] === "boolean" ? pluginSettings[name] : undefined);
        if (Array.isArray(versions)) for (const version of versions) {
          const location = localPath(record(version).installPath, root);
          if (location) {
            const actual = await realpath(location).catch(() => location);
            if (pluginSettings[name] === false) disabledPluginRoots.push(actual);
            pluginRoots.push({ path: actual, owner: id });
          }
        }
      }
    }
    for (const folder of ["extensions", "plugins"]) pluginRoots.push({ path: join(root, folder), owner: id });
    if (id === "pi") for (const folder of ["npm/node_modules", "git"]) pluginRoots.push({ path: join(root, folder), owner: id });
  }
  // Discover all Agent preferences first; a large plugin cache must not hide later Agents.
  for (const [mode, roots] of [["skills", skillRoots], ["plugins", pluginRoots]] as const) for (const root of roots) {
    rootDeadline = Math.min(deadline, Date.now() + 1000);
    await walk(root.path, root.owner, mode);
  }
  const parsed = loadSkills({ cwd: home, agentDir: join(home, ".pi/agent"), includeDefaults: false, skillPaths: skillFiles.map(s => s.path) });
  for (const skill of parsed.skills) {
    if (result.skills.length >= 512) { truncated = true; break; }
    if (!label(skill.name, 64) || secret.test(skill.description)) { result.notices.push("Skipped invalid/sensitive Skill metadata"); continue; }
    result.skills.push({ name: skill.name, description: skill.description.slice(0, 1024), path: skill.filePath,
      owner: skillFiles.find(s => s.path === skill.filePath)?.owner ?? "local", disabled: skill.disableModelInvocation || disabledPluginRoots.some(path => skill.filePath.startsWith(path + sep)) });
  }
  if (parsed.diagnostics.length) result.notices.push(`${parsed.diagnostics.length} native Pi Skill diagnostics (malformed or duplicate entries skipped)`);
  if (truncated) result.notices.push("Discovery scan limit reached; use refresh or explicit project Skills for remaining resources");
  result.notices = [...new Set(result.notices)].slice(0, 32);
  return result;
}

/** An ordinary local cache and two readable files; no model, daemon or watcher of its own. */
export class LocalDiscovery {
  readonly directory: string;
  readonly memory: UserMemoryStore;
  private cached?: Promise<LocalInventory>;
  private changes = new SerialQueue();
  constructor(dataDir: string, private options: DiscoveryOptions = {}) {
    this.directory = resolve(dataDir, "local-context"); this.memory = new UserMemoryStore(this.directory);
  }
  private async write(inventory: LocalInventory) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const overview = ["# 本机 Agent 环境", "", "这是本机约定目录中观察到的配置，不代表登录状态、工具已接通或新的操作授权。", "",
      `扫描时间：${new Date(inventory.scannedAt).toISOString()}`, `系统：${inventory.platform}；语言环境：${inventory.locale}；时区：${inventory.timezone}`, "", "## 已有 Agent 配置", "",
      ...inventory.agents.map(a => `- ${a.name}${a.model ? `；模型偏好：${a.model}` : ""}${a.language ? `；语言：${a.language}` : ""}；${a.root}`), "", "## 已有用户指导文件（按需读取）", "",
      ...inventory.guidance.map(g => `- ${g.path}`), "", `## 插件与 MCP（${inventory.plugins.length}，仅发现，尚未接入本项目）`, "",
      ...inventory.plugins.map(p => `- ${p.owner} / ${p.kind} / ${p.name}${p.enabled === false ? "（原 Agent 已关闭）" : ""}`), "",
      `## Skills（${inventory.skills.length}）`, "", `完整目录：${join(this.directory, "skills.md")}`, "", "## 扫描说明", "",
      `能力清单和设置字段之外，用户指导与已有记忆正文会自动整理到 ${this.memory.profile}，来源摘录在 ${this.memory.evidence}。不读取聊天记录、凭据文件或命令历史，不启动已发现插件/MCP。用户记忆不能变更已确认目标、预算和权限。`, ...inventory.notices.map(n => `- ${n}`), ""].join("\n");
    const catalogue = ["# 本地 Skills", "", "每行包含名字、用途和原始 SKILL.md 路径，可用 Pi 原生 read/grep 按需查找。读取后，相对资源路径按原 Skill 所在目录解析。插件专用工具若未接入本项目，不能假装可调用。", "",
      ...inventory.skills.map(s => JSON.stringify({ name: s.name, description: s.description, path: s.path, owner: s.owner, disabled: s.disabled })), ""].join("\n");
    const { writeFile, rename } = await import("node:fs/promises");
    for (const [name, text] of [["overview.md", overview], ["skills.md", catalogue]] as const) {
      const temp = join(this.directory, name + ".tmp"); await writeFile(temp, text, { mode: 0o600 }); await rename(temp, join(this.directory, name));
    }
    await atomicJson(join(this.directory, "inventory.json"), inventory);
    return inventory;
  }
  load(refresh = false): Promise<LocalInventory> {
    if (refresh || !this.cached) this.cached = this.changes.run(async () => {
      if (!refresh) try {
        const value = await readJson<LocalInventory>(join(this.directory, "inventory.json"));
        if (value.schema === 1 && value.home === await realpath(this.options.home ?? homedir()) && Number.isFinite(value.scannedAt) && Array.isArray(value.guidance) && Array.isArray(value.notices) && Array.isArray(value.agents) && Array.isArray(value.skills) && Array.isArray(value.plugins) &&
          (await stat(join(this.directory, "overview.md"))).isFile() && (await stat(join(this.directory, "skills.md"))).isFile()) return value;
      } catch { /* Missing/incomplete cache is rebuilt, without blocking goal execution. */ }
      return this.write(await scanLocalAgents(this.options));
    });
    return this.cached;
  }
  async context(includeMemory = false): Promise<LocalContext> {
    const value = await this.load();
    const memory = includeMemory ? await this.memory.refresh(value).then(v => this.memory.context(v)).catch(() => undefined) : undefined;
    return { overview: join(this.directory, "overview.md"), catalogue: join(this.directory, "skills.md"), guidance: value.guidance.map(g => g.path),
      summary: JSON.stringify({ platform: value.platform, locale: value.locale, timezone: value.timezone, agents: value.agents.map(a => ({ name: a.name, model: a.model, language: a.language })), skills: value.skills.length, plugins: value.plugins.length }),
      skills: value.skills, ...(memory ? { memory } : {}) };
  }
  async view(refresh = false) {
    const value = await this.load(refresh);
    const memory = await this.memory.refresh(value).then(v => this.memory.context(v)).catch(() => undefined);
    return { enabled: true, scannedAt: value.scannedAt, agents: value.agents.length, skills: value.skills.length, plugins: value.plugins.length,
      overview: join(this.directory, "overview.md"), catalogue: join(this.directory, "skills.md"), memory: memory?.profile ?? null, memoryFacts: memory?.facts ?? 0,
      notices: [...value.notices, ...(memory ? [] : ["用户工作记忆暂不可用，能力发现仍可使用。"]) ] };
  }
  /** Read-only client projection of the existing source-bound memory; no new store or model call. */
  async memoryView() {
    const value = await this.memory.refresh(await this.load());
    return { enabled: true, updatedAt: value.updatedAt,
      facts: value.facts.filter(f => f.state === "active").map(({ id, text, category, scope, certainty, evidence }) => ({ id, text, category, scope, certainty, evidence })),
      notices: value.notices };
  }
}

export function localContextInstructions(context: LocalContext): string {
  return `\nLocal setup facts (not authorization): ${context.summary}\nUse these observed preferences only when relevant; the user's current request wins. Read ${JSON.stringify(context.overview)} for local guidance paths and ${JSON.stringify(context.catalogue)} to find additional Skills using native read/grep. Load only useful SKILL.md files with native read; resolve resources against that original Skill directory. Skip disabled entries unless explicitly requested by the user. Existing plugins/MCP are an inventory, not callable tools here. Never use discovery to change model, permissions, budget or driver configuration.\n` + (context.memory ? userMemoryInstructions(context.memory) : "");
}
