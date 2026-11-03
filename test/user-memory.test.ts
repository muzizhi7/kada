import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { LocalDiscovery, localContextInstructions } from '../src/discovery.js';
import { LocalRuntime } from '../src/runtime.js';
import type { UserMemory } from '../src/user-memory.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-user-memory-'))), home = join(directory, 'home'), data = join(directory, 'state');
  await mkdir(home);
  const put = async (path: string, text: string) => { await mkdir(dirname(join(home, path)), { recursive: true }); await writeFile(join(home, path), text); };
  const discovery = new LocalDiscovery(data, { home, locale: 'zh-CN', timezone: 'Asia/Shanghai' });
  return { directory, home, data, put, discovery, async read() { return JSON.parse(await readFile(join(data, 'local-context/user-memory.json'), 'utf8')) as UserMemory; }, async close() { await rm(directory, { recursive: true, force: true }); } };
}
function fact(sourceId: string, quote: string, extra: Record<string, unknown> = {}) {
  return { text: quote, category: 'preferences', scope: 'global', certainty: 'stated', evidence: [{ sourceId, quote }], ...extra };
}
async function remember(f: Awaited<ReturnType<typeof fixture>>, facts: unknown[], userMessages: string[] = [], operation = 'operation-1') {
  const extension = f.discovery.memory.extension('task-1', f.home, () => f.discovery.load());
  const api = { taskId: operation, commit: async (fn: any) => fn({ doc: async () => ({ objective: '', userMessages }) }) };
  return (extension.tools![0]!.execute as any)({ facts }, api, {});
}

test('first startup builds categorized source-bound user memory without a model, interview, or modifying originals', async () => {
  const f = await fixture();
  try {
    const guide = '# 协作偏好\n\n请用中文回复，结论放在前面。\n\n# 工作\n\n我是独立开发者，正在做本地 Agent 产品。\n';
    await f.put('.codex/AGENTS.md', guide);
    await f.put('USER.md', '---\nsource: user\n---\n# 工作背景\n\n我负责产品设计和工程实现。\n');
    await f.put('.codex/memories/memory_summary.md', '# 项目\n\n用户正在研究桌面伙伴。\n');
    await f.put('.claude/projects/local-project/memory/MEMORY.md', '这个项目的构建命令为 npm run package。');
    const view = await f.discovery.view();
    assert(view.memoryFacts >= 5); assert.equal(view.memory, join(f.data, 'local-context/user-memory.md'));
    const value = await f.read();
    assert(value.facts.some(x => x.category === 'work' && x.text.includes('产品设计')));
    assert(value.facts.some(x => x.category === 'preferences' && x.text.includes('结论放在前面')));
    assert(value.facts.some(x => x.scope === 'project' && x.text.includes('npm run package')));
    assert(value.facts.find(x => x.text.includes('研究桌面伙伴'))?.certainty === 'inferred');
    const source = value.sources.find(x => x.path === join(f.home, '.codex/AGENTS.md'))!;
    assert.equal(source.sha256, createHash('sha256').update(guide).digest('hex'));
    assert(value.facts.find(x => x.text.includes('结论放在前面'))?.evidence.some(e => e.path === source.path && e.sha256 === source.sha256));
    const context = await f.discovery.context(true), instructions = localContextInstructions(context);
    assert(instructions.includes('User work memory')); assert(instructions.includes('结论放在前面')); assert(instructions.includes('产品设计'));
    assert(!context.memory!.summary.includes('npm run package'), 'project requirements do not silently enter global preferences');
    assert.equal(await readFile(join(f.home, '.codex/AGENTS.md'), 'utf8'), guide);
    if (process.platform !== 'win32') for (const file of ['user-memory.json', 'user-memory.md', 'user-evidence.md']) assert.equal((await stat(join(f.data, 'local-context', file))).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('memory refresh observes edits/removals with provenance, preserves cross-source disagreements, and survives restart', async () => {
  const f = await fixture();
  try {
    await f.put('.codex/AGENTS.md', '回复请保持简短。');
    await f.put('.claude/CLAUDE.md', '回复需要详细解释。');
    await f.discovery.view();
    const first = await f.read();
    assert.equal(first.facts.filter(x => x.category === 'preferences' && x.state === 'active').length, 2);
    await f.put('.codex/AGENTS.md', '回复请附上核验结果。');
    await unlink(join(f.home, '.claude/CLAUDE.md'));
    const restarted = new LocalDiscovery(f.data, { home: f.home });
    await restarted.view();
    const next = await f.read();
    assert(next.facts.some(x => x.text === '回复请附上核验结果。' && x.state === 'active'));
    const stale = next.facts.find(x => x.text === '回复需要详细解释。');
    assert.equal(stale?.state, 'stale'); assert.equal(stale?.evidence[0]?.path, join(f.home, '.claude/CLAUDE.md'));
    const summary = (await restarted.context(true)).memory!.summary;
    assert(!summary.includes('回复需要详细解释')); assert(!summary.includes('保持简短'));
  } finally { await f.close(); }
});

test('credential lines, private keys, conversations, out-of-home links, binary and oversized sources do not become memory', async () => {
  const f = await fixture();
  try {
    const credential = 'api_key = PRIVATE_CREDENTIAL_SENTINEL';
    const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    await f.put('.codex/AGENTS.md', `请用中文回复。\n\n${credential}\n{"api_key":"PRIVATE_JSON_CREDENTIAL_SENTINEL"}\n${privateKey}\nPRIVATE_KEY_BODY_SENTINEL\n-----END PRIVATE KEY-----\n`);
    await f.put('.codex/history.jsonl', 'PRIVATE_CONVERSATION_SENTINEL');
    await f.put('.codex/auth.json', 'PRIVATE_AUTH_SENTINEL');
    await f.put('USER.md', 'x'.repeat(65537));
    await f.put('MEMORY.md', 'binary\0source');
    const outside = join(f.directory, 'AGENTS.md'); await writeFile(outside, 'OUTSIDE_SOURCE_SENTINEL');
    await symlink(outside, join(f.home, 'AGENTS.md'));
    await f.discovery.view();
    const all = JSON.stringify(await f.read()) + await readFile(join(f.data, 'local-context/user-evidence.md'), 'utf8');
    for (const marker of ['PRIVATE_CREDENTIAL_SENTINEL', 'PRIVATE_JSON_CREDENTIAL_SENTINEL', 'PRIVATE_KEY_BODY_SENTINEL', 'PRIVATE_CONVERSATION_SENTINEL', 'PRIVATE_AUTH_SENTINEL', 'OUTSIDE_SOURCE_SENTINEL', 'binary']) assert(!all.includes(marker), marker);
    assert(all.includes('请用中文回复')); assert((await f.read()).notices.some(n => n.includes('oversized')));
  } finally { await f.close(); }
});

test('organization validates citations, scope and tentative Agent memories; changes during a task invalidate old excerpts', async () => {
  const f = await fixture();
  try {
    await f.put('.codex/AGENTS.md', '请用中文回复。');
    await f.put('.claude/projects/project/memory/MEMORY.md', '项目产物需要放在 build 目录。');
    await f.put('MEMORY.md', '用户可能偏好简短解释。');
    await f.discovery.view();
    const sources = (await f.read()).sources;
    const guide = sources.find(s => s.kind === 'guidance')!, project = sources.find(s => s.scope === 'project')!, memory = sources.find(s => s.kind === 'memory' && s.scope === 'global')!;
    await assert.rejects(remember(f, [fact(guide.id, '根本不存在的用户事实')]), /exact quote/);
    await assert.rejects(remember(f, [fact(project.id, '项目产物需要放在 build 目录。')]), /Project memory/);
    await assert.rejects(remember(f, [fact(memory.id, '用户可能偏好简短解释。')]), /tentative/);
    await assert.rejects(remember(f, [fact('user', '模型自己写出的个人信息')]), /actual current user/);
    await assert.rejects(remember(f, [fact('user', 'secret = DO_NOT_SAVE')], ['secret = DO_NOT_SAVE']), /credentials/);
    const before = (await f.read()).facts.filter(x => x.origin === 'organized'); assert.equal(before.length, 0);
    await f.put('.codex/AGENTS.md', '请用英文回复。');
    await assert.rejects(remember(f, [fact(guide.id, '请用中文回复。')]), /exact quote/);
    assert((await f.read()).facts.some(x => x.text === '请用中文回复。' && x.state === 'stale'));
  } finally { await f.close(); }
});

test('explicit corrections supersede old context durably and replay does not duplicate remembered facts', async () => {
  const f = await fixture();
  try {
    await f.put('.codex/AGENTS.md', '回复需要详细解释。'); await f.discovery.view();
    const old = (await f.read()).facts.find(x => x.text === '回复需要详细解释。')!;
    const quote = '以后只需要简短答复。';
    const input = fact('user', quote, { supersedes: [old.id] });
    await remember(f, [input], [quote]); await remember(f, [input], [quote]);
    const reopened = new LocalDiscovery(f.data, { home: f.home }); await reopened.view();
    const value = await f.read();
    assert.equal(value.facts.filter(x => x.origin === 'organized').length, 1);
    assert.equal(value.facts.find(x => x.id === old.id)?.state, 'superseded');
    assert(value.sources.some(s => s.kind === 'user' && s.path === 'pi-task:task-1' && s.text === quote));
    const summary = (await reopened.context(true)).memory!.summary;
    assert(summary.includes(quote)); assert(!summary.includes('需要详细解释'));
  } finally { await f.close(); }
});

test('corrupt nested derived memory rebuilds without altering user sources', async () => {
  const f = await fixture();
  try {
    await f.put('USER.md', '我的工作是产品设计。'); await f.discovery.view();
    const value = await f.read(); (value.facts[0] as any).evidence = [null];
    await writeFile(join(f.data, 'local-context/user-memory.json'), JSON.stringify(value));
    await new LocalDiscovery(f.data, { home: f.home }).view();
    assert((await f.read()).facts.some(x => x.text === '我的工作是产品设计。' && x.evidence.every(e => !!e.path)));
    assert.equal(await readFile(join(f.home, 'USER.md'), 'utf8'), '我的工作是产品设计。');
  } finally { await f.close(); }
});

const call = (name: string, args: any) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const results = (c: TranscriptContext, name: string) => c.messages.filter((m): m is Extract<TranscriptContext['messages'][number], { role: 'toolResult' }> => m.role === 'toolResult' && m.toolName === name);

test('the existing Pi preparation session organizes user memory, delivers, and a later task uses it without onboarding', async () => {
  const home = await fixture(); let second = false, requests = 0;
  await home.put('.codex/AGENTS.md', '请用中文回复。');
  const quote = '以后交付请附上简短核验说明。';
  const f = await scriptedFixture(c => {
    requests++;
    if (!hasTool(c, 'task_prepare') && !hasTool(c, 'task_submit')) {
      assert(!hasTool(c, 'user_remember'), 'delegated workers cannot write global user memory');
      return fauxAssistantMessage('独立子会话已完成核对。');
    }
    assert(hasTool(c, 'user_remember')); assert(JSON.stringify(c.messages).includes('User work memory'));
    if (second) { assert(JSON.stringify(c.messages).includes('交付附简短核验说明')); return call('task_submit', { summary: '已用中文回答，并附核验说明。', artifacts: [] }); }
    if (hasTool(c, 'task_prepare')) {
      if (!results(c, 'user_remember').length) return call('user_remember', { facts: [fact('user', quote, { text: '交付附简短核验说明' })] });
      assert(!results(c, 'user_remember').at(-1)!.isError);
      return call('task_prepare', { outcome: '给出文字说明', deliverables: ['文字答复'], inputs: [], scope: ['只回答当前问题'], assumptions: [], questions: [], criteria: [{ text: '给出中文说明', method: 'inspect' }] });
    }
    if (!results(c, 'delegate').length) return call('delegate', { tasks: [{ name: '工具边界核对', instructions: '只返回简短的核对结果。' }] });
    assert(!results(c, 'delegate').at(-1)!.isError);
    return call('task_submit', { summary: '已给出中文说明。', artifacts: [], criteria: [{ id: 1, status: 'passed', evidence: '已阅读并给出中文说明，属于自检。' }] });
  }, { discovery: true }, () => [], { discovery: { home: home.home } });
  let reopened: LocalRuntime | undefined;
  try {
    await f.runtime.localSetup(); assert.equal(requests, 0);
    const first = await f.runtime.create(`请给出一句说明。${quote}`, f.workspace, [], { prepare: true });
    const ready = await until(() => f.runtime.status(first.id), x => x.status === 'awaiting_confirmation');
    assert.deepEqual(ready.goal!.brief!.questions, []); assert.equal((await f.runtime.metadata(first.id)).userMemory, true);
    await f.runtime.confirm(first.id, ready.goal!.brief!.revision, ready.briefDigest!);
    await until(() => f.runtime.status(first.id), x => x.status === 'completed');
    const spent = requests; await f.runtime.close();
    reopened = new LocalRuntime(f.settings, { models: f.models, discovery: { home: home.home } }); await reopened.recover(); assert.equal(requests, spent);
    second = true;
    const next = await reopened.create('再给出一句说明。', f.workspace); await until(() => reopened!.status(next.id), x => x.status === 'completed');
  } finally { await reopened?.close(); await f.close(); await home.close(); }
});

test('metadata-only historical discovery tasks keep their context and tools on recovery', async () => {
  const home = await fixture(); await home.put('.codex/AGENTS.md', 'HISTORICAL_TASK_MUST_NOT_IMPORT_THIS_BODY');
  const f = await scriptedFixture(c => {
    assert(!hasTool(c, 'user_remember')); assert(!JSON.stringify(c.messages).includes('User work memory'));
    return call('task_prepare', { outcome: '文字说明', deliverables: ['答复'], inputs: [], scope: ['文字'], assumptions: [], questions: [], criteria: [{ text: '文字说明', method: 'inspect' }] });
  }, { discovery: true }, () => [], { legacyResources: true, discovery: { home: home.home } });
  let reopened: LocalRuntime | undefined;
  try {
    const task = await f.runtime.create('历史目标', f.workspace, [], { prepare: true }); await until(() => f.runtime.status(task.id), x => x.status === 'awaiting_confirmation');
    await f.runtime.close(); const path = join(f.directory, 'tasks', task.id, 'task.json');
    const meta = JSON.parse(await readFile(path, 'utf8')); meta.discovery = true; meta.resourcePolicy = 'pi-skills'; delete meta.userMemory;
    await writeFile(path, JSON.stringify(meta));
    reopened = new LocalRuntime(f.settings, { models: f.models, discovery: { home: home.home } }); await reopened.recover();
    await reopened.followUp(task.id, '把答复写得简短。'); await until(() => reopened!.status(task.id), x => x.goal?.brief?.revision === 2);
    assert.equal((await reopened.metadata(task.id)).userMemory, undefined);
  } finally { await reopened?.close(); await f.close(); await home.close(); }
});
