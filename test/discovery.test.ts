import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { LocalDiscovery, scanLocalAgents, localContextInstructions } from '../src/discovery.js';
import { LocalRuntime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import { serve } from '../src/server.js';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { hasTool, scriptedFixture, until } from './helpers.js';

async function fixture() {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'pi-discovery-'))),home=join(directory,'home'),data=join(directory,'state');
  await mkdir(home); const put=async(path:string,text:string)=>{const {dirname}=await import('node:path');await mkdir(dirname(join(home,path)),{recursive:true});await writeFile(join(home,path),text);};
  const skill=async(path:string,name:string)=>put(path+'/SKILL.md',`---\nname: ${name}\ndescription: Calculate a local total with the provided script.\n---\n\nPRIVATE_SKILL_BODY only loaded when needed. Use scripts/sum.mjs with input/output arguments.\n`);
  return {directory,home,data,put,skill,async close(){await rm(directory,{recursive:true,force:true});}};
}
async function populated() {
  const f=await fixture();
  await f.skill('.agents/skills/sum','invoice-total');
  await f.put('.agents/skills/sum/scripts/sum.mjs',`import{readFileSync,writeFileSync}from'node:fs';const xs=JSON.parse(readFileSync(process.argv[2],'utf8'));writeFileSync(process.argv[3],JSON.stringify(xs.reduce((a,x)=>a+(x??0),0)));\n`);
  await f.put('.codex/config.toml','model = "gpt-test"\napi_key = "CONFIG_SECRET"\n[mcp_servers.private_db]\ncommand = "touch"\nargs = ["NEVER_EXECUTE"]\n[mcp_servers.private_db.env]\nTOKEN="MCP_SECRET"\n');
  await f.put('.codex/AGENTS.md','PRIVATE_USER_GUIDANCE stays local until relevant.');
  await f.put('.codex/plugins/cache/local/native/1.0.0/.codex-plugin/plugin.json','{"name":"codex-native","hooks":{"command":"NEVER_EXECUTE"}}');
  await f.skill('.codex/plugins/cache/local/native/1.0.0/skills/native','codex-native-skill');
  await f.put('.claude/settings.json',JSON.stringify({model:'claude-test',language:'zh-CN',env:{API_KEY:'ENV_SECRET'},enabledPlugins:{'review@local':false}}));
  await f.put('.claude.json',JSON.stringify({mcpServers:{claude_global:{command:'NEVER_EXECUTE',env:{TOKEN:'GLOBAL_MCP_SECRET'}}},disabledMcpServers:['claude_global'],oauthAccount:{token:'OAUTH_SECRET'},projects:{private:'PRIVATE_PROJECT_SECRET'}}));
  const plugin='.claude/plugins/cache/local/review/1.0.0';
  await f.put(plugin+'/.claude-plugin/plugin.json',JSON.stringify({name:'review',hooks:{command:`touch ${join(f.directory,'NEVER_EXECUTE')}`},mcpServers:{remote:{url:'https://host/?token=URL_SECRET',env:{TOKEN:'PLUGIN_SECRET'}}}}));
  await f.skill(plugin+'/skills/check','plugin-check');
  await f.put('.claude/plugins/installed_plugins.json',JSON.stringify({version:2,plugins:{'review@local':[{installPath:join(f.home,plugin)}]}}));
  await f.put('.cursor/mcp.json','{ // allowed JSONC\n "mcpServers": {"cursor_db":{"env":{"TOKEN":"CURSOR_SECRET"},"disabled":true}},\n}');
  await f.put('.config/opencode/opencode.jsonc','{ "plugin": ["@local/review"], "provider": {"x":{"options":{"apiKey":"OPENCODE_SECRET"}}}, }');
  await f.put('.gemini/settings.json','{"model":{"name":"gemini-test"},"security":{"auth":{"apiKey":"GEMINI_SECRET"}}}');
  await f.put('.gemini/extensions/test/gemini-extension.json','{"name":"gemini-extension","mcpServers":{"gemini_mcp":{"command":"NEVER_EXECUTE"}}}');
  await f.put('.pi/agent/settings.json',JSON.stringify({defaultModel:'pi-test',packages:['npm:@local/pi-tools','https://name:' + 'URL_SECRET@host/repo'],skills:['extra/SKILL.md']}));
  await f.skill('.pi/agent/extra','extra-pi');
  await f.skill('.pi/agent/npm/node_modules/native-package/skills/native','package-pi');
  await f.put('.pi/agent/extensions/helper.ts',`throw new Error('NEVER_EXECUTE');`);
  return f;
}

test('first discovery uses native Pi Skills and allowlisted settings without executing plugins or retaining secrets/history',async()=>{
  const f=await populated();
  try{
    await f.put('.codex/history.jsonl','HISTORY_SECRET');
    await f.put('.codex/auth.json','AUTH_SECRET');
    const before=await readFile(join(f.home,'.codex/config.toml'),'utf8');
    const discovery=new LocalDiscovery(f.data,{home:f.home,locale:'zh-CN',timezone:'Asia/Shanghai'}),value=await discovery.load();
    assert(value.agents.some(a=>a.id==='codex'&&a.model==='gpt-test'));
    assert(value.agents.some(a=>a.id==='claude'&&a.language==='zh-CN'));
    assert.deepEqual(new Set(value.skills.map(s=>s.name)),new Set(['invoice-total','extra-pi','plugin-check','codex-native-skill','package-pi']));
    assert(value.plugins.some(p=>p.name==='private_db'&&p.kind==='mcp'));
    assert(value.plugins.some(p=>p.name==='cursor_db'&&p.enabled===false));
    assert(value.plugins.some(p=>p.name==='claude_global'&&p.enabled===false));
    assert(value.plugins.some(p=>p.name==='codex-native'&&p.kind==='plugin'));
    assert(value.plugins.some(p=>p.name==='review@local'&&p.enabled===false));
    assert(value.skills.find(s=>s.name==='plugin-check')?.disabled, 'an installed but disabled plugin is not silently activated');
    assert(value.plugins.some(p=>p.name==='gemini-extension'));
    assert(value.plugins.some(p=>p.name==='@local/review'));
    const persisted=JSON.stringify(value)+await readFile(join(f.data,'local-context/overview.md'),'utf8')+await readFile(join(f.data,'local-context/skills.md'),'utf8');
    for(const sentinel of ['CONFIG_SECRET','MCP_SECRET','ENV_SECRET','URL_SECRET','PLUGIN_SECRET','CURSOR_SECRET','OPENCODE_SECRET','GEMINI_SECRET','GLOBAL_MCP_SECRET','OAUTH_SECRET','PRIVATE_PROJECT_SECRET','HISTORY_SECRET','AUTH_SECRET','PRIVATE_SKILL_BODY','PRIVATE_USER_GUIDANCE','NEVER_EXECUTE'])assert(!persisted.includes(sentinel),sentinel);
    await assert.rejects(stat(join(f.directory,'NEVER_EXECUTE')),{code:'ENOENT'});
    assert.equal(await readFile(join(f.home,'.codex/config.toml'),'utf8'),before);
    assert(!localContextInstructions(await discovery.context()).includes('invoice-total'),'global catalog is on demand, not every-turn metadata');
    if(process.platform!=='win32'){assert.equal((await stat(join(f.data,'local-context'))).mode&0o777,0o700);assert.equal((await stat(join(f.data,'local-context/inventory.json'))).mode&0o777,0o600);}
  }finally{await f.close();}
});

test('cache survives restart, repeated startup does not scan again, and explicit refresh picks up new capabilities',async()=>{
  const f=await populated();
  try{
    const first=await new LocalDiscovery(f.data,{home:f.home}).load();
    await f.skill('.agents/skills/new','new-skill');
    const store=new LocalDiscovery(f.data,{home:f.home});
    assert.deepEqual(await store.load(),first);
    assert(!(await store.load()).skills.some(s=>s.name==='new-skill'));
    const [changed, concurrent]=await Promise.all([store.load(true),store.load(true)]);assert(changed.skills.some(s=>s.name==='new-skill'));assert(concurrent.skills.some(s=>s.name==='new-skill'));
    assert((await readFile(join(f.data,'local-context/skills.md'),'utf8')).includes('new-skill'));
    await writeFile(join(f.data,'local-context/inventory.json'),'broken cache');
    const recovered=await new LocalDiscovery(f.data,{home:f.home}).load();assert(recovered.skills.some(s=>s.name==='new-skill'));
  }finally{await f.close();}
});

test('large early plugin caches cannot hide the remaining Agent configuration inventory',async()=>{
  const f=await populated();try{
    for(let i=0;i<50;i++)await mkdir(join(f.home,'.codex/plugins/cache',String(i)),{recursive:true});
    const result=await scanLocalAgents({home:f.home,maxEntries:30});
    assert(result.agents.some(a=>a.id==='gemini'));assert(result.agents.some(a=>a.id==='cursor'));
    assert(result.notices.some(n=>n.includes('limit')));
  }finally{await f.close();}
});

test('missing Agent configurations, malformed files, huge metadata and broken links fail softly',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual((await scanLocalAgents({home:f.home})).agents,[]);
    await f.put('.codex/config.toml','unterminated = "');await f.put('.claude/settings.json','{bad');
    await f.put('.gemini/settings.json','x'.repeat(262145));await f.skill('.agents/skills/good','good');
    await symlink(join(f.home,'missing'),join(f.home,'.agents/skills/broken'));
    const value=await scanLocalAgents({home:f.home});assert(value.skills.some(s=>s.name==='good'));
    assert(value.notices.some(n=>n.startsWith('Malformed')));assert(value.notices.some(n=>n.includes('oversized')));
  }finally{await f.close();}
});

test('symlink aliases deduplicate and cycles cannot trigger an unbounded native skill crawl',async()=>{
  const f=await fixture();
  try{
    await f.skill('.agents/skills/original','one-skill');await mkdir(join(f.home,'.codex/skills'),{recursive:true});
    await symlink(join(f.home,'.agents/skills/original'),join(f.home,'.codex/skills/alias'));
    await mkdir(join(f.home,'.agents/skills/cycle'));await symlink(join(f.home,'.agents/skills'),join(f.home,'.agents/skills/cycle/back'));
    const result=await scanLocalAgents({home:f.home,maxEntries:100,maxMs:1000});assert.equal(result.skills.length,1);
    const limited=await scanLocalAgents({home:f.home,maxEntries:2});assert(limited.notices.some(n=>n.includes('limit')));
  }finally{await f.close();}
});

const call=(name:string,args:any)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const toolResults=(c:TranscriptContext,name:string)=>c.messages.filter((m):m is Extract<TranscriptContext['messages'][number],{role:'toolResult'}>=>m.role==='toolResult'&&m.toolName===name);

test('a newly confirmed task discovers another Agent Skill, reads it natively and delivers checked output without importing its plugins',async()=>{
  const home=await populated();let data='';let requests=0;
  const checker={command:'node acceptance/check.mjs',inputs:['acceptance','input.json'],outputs:['result.json']};
  const f=await scriptedFixture(c=>{
    requests++;
    const context=JSON.stringify(c.messages);assert(context.includes('Local setup facts'));assert(context.includes('gpt-test'));
    if(hasTool(c,'task_prepare')){
      if(!toolResults(c,'read').length)return call('read',{path:join(data,'local-context/skills.md')});
      if(toolResults(c,'read').length===1)return call('read',{path:join(home.home,'.agents/skills/sum/SKILL.md')});
      return call('task_prepare',{outcome:'汇总输入',deliverables:['result.json'],inputs:checker.inputs,scope:['只处理工作区，使用本机已有Skill脚本'],assumptions:[],questions:[],criteria:[{text:'通过原核对',method:'check',verification:checker}]});
    }
    const path=join(home.home,'.agents/skills/sum');
    if(toolResults(c,'read').length===1)return call('read',{path:join(path,'SKILL.md')});
    if(!toolResults(c,'bash').length)return call('bash',{command:`node '${join(path,'scripts/sum.mjs').replaceAll("'","'\\''")}' input.json result.json`});
    if(!toolResults(c,'task_verify').length)return call('task_verify',{criterionId:1});
    const text=toolResults(c,'task_verify').at(-1)!.content.find(b=>b.type==='text')!;
    return call('task_submit',{summary:'用已有Skill脚本生成并核对结果',artifacts:['result.json'],criteria:[{id:1,status:'passed',evidence:'真实原核对',proofIds:[JSON.parse((text as any).text).id]}]});
  },{discovery:true},()=>[],{discovery:{home:home.home}});
  let reopened:LocalRuntime|undefined;
  try{
    data=f.directory;await mkdir(join(f.workspace,'acceptance'));
    await writeFile(join(f.workspace,'input.json'),'[5,0,null,8]');
    await writeFile(join(f.workspace,'acceptance/check.mjs'),"import assert from'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(JSON.parse(readFileSync('result.json','utf8')),13);\n");
    await f.runtime.localSetup();assert.equal(requests,0,'first scan never calls the model');
    const task=await f.runtime.create('使用已有本地Skills汇总资料',f.workspace,[],{prepare:true});
    const ready=await until(()=>f.runtime.status(task.id),s=>s.status==='awaiting_confirmation');
    assert.equal(ready.discovery,true);assert.equal(ready.goal!.localSkillReads!.length,1);assert.equal(ready.goal!.skills,undefined);await assert.rejects(stat(join(f.workspace,'result.json')),{code:'ENOENT'});
    assert.equal(ready.model.modelId,'scripted','discovered model preferences cannot replace configured provider');
    await f.runtime.confirm(task.id,1,ready.briefDigest!);
    const done=await until(()=>f.runtime.status(task.id),s=>s.status==='completed');
    assert.equal(done.goal!.reworks,0);assert.equal(done.goal!.localSkillReads!.length,1);
    assert.equal(await readFile(join(f.workspace,'result.json'),'utf8'),'13');
    assert.equal(done.budget.costLimit,ready.goal!.brief!.budget.maxEstimatedCostUsd);
    const n=requests;await f.runtime.close();reopened=new LocalRuntime(f.settings,{models:f.models,discovery:{home:home.home}});await reopened.recover();
    assert.equal((await reopened.status(task.id)).status,'completed');assert.equal(requests,n);
    await assert.rejects(stat(join(home.directory,'NEVER_EXECUTE')),{code:'ENOENT'});
  }finally{await reopened?.close();await f.close();await home.close();}
});

test('startup discovery works with no model and authenticated refresh is separate from task execution',async()=>{
  const f=await populated();const model=await scriptedFixture(()=>{throw new Error('Discovery must not call a model');});
  await writeFile(join(f.home,'USER.md'),'偏好中文，交付时保留原始来源。');
  const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address()as any).port;await new Promise<void>(r=>socket.close(()=>r()));
  const server=await serve({...model.settings,port,model:undefined,discovery:true},{models:model.models,discovery:{home:f.home}});
  try{
    const token=(await readFile(join(model.directory,'token'),'utf8')).trim(),headers={Authorization:`Bearer ${token}`};
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/environment`)).status,401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/environment/memory`)).status,401);
    const first=await(await fetch(`http://127.0.0.1:${port}/v1/environment`,{headers})).json()as any;assert(first.agents>0);assert(first.skills>0);
    const memory=await(await fetch(`http://127.0.0.1:${port}/v1/environment/memory`,{headers})).json()as any;
    assert.equal(memory.enabled,true);assert(memory.facts.some((x:any)=>x.text.includes('偏好中文')&&x.evidence.some((e:any)=>e.quote.includes('保留原始来源'))));
    assert.equal(memory.sources,undefined,'the client projection does not expose full source documents');
    await writeFile(join(f.home,'USER.md'),'偏好简短答复，保留可回查的依据。');
    const changedMemory=await(await fetch(`http://127.0.0.1:${port}/v1/environment/memory`,{headers})).json()as any;
    assert(!changedMemory.facts.some((x:any)=>x.text.includes('偏好中文')),'obsolete facts are not presented as current memory');
    assert(changedMemory.facts.some((x:any)=>x.text.includes('偏好简短答复')));
    await f.skill('.agents/skills/refresh','refresh-skill');
    const rejected=await fetch(`http://127.0.0.1:${port}/v1/environment/refresh`,{method:'POST',headers:{...headers,Origin:'https://untrusted'}});assert.equal(rejected.status,403);
    const changed=await(await fetch(`http://127.0.0.1:${port}/v1/environment/refresh`,{method:'POST',headers})).json()as any;assert.equal(changed.skills,first.skills+1);
    assert.equal((await server.runtime.list()).length,0);
  }finally{await server.close();await model.close();await f.close();}
});

test('discovery can be disabled and old tasks do not acquire personal context on recovery',async()=>{
  const home=await populated();const f=await scriptedFixture(c=>{
    assert(!JSON.stringify(c.messages).includes('Local setup facts'));
    return call('task_submit',{summary:'已回答',artifacts:[]});
  },{discovery:false});let reopened:LocalRuntime|undefined;
  try{
    const task=await f.runtime.create('给一个纯文本答案');await until(()=>f.runtime.status(task.id),s=>s.status==='completed');
    const disabled=await f.runtime.localSetup();assert.equal(disabled.enabled,false);assert.equal(disabled.memory,null);assert.equal(disabled.memoryFacts,0);
    assert.deepEqual(await f.runtime.localMemory(),{enabled:false,updatedAt:null,facts:[],notices:[]});await f.runtime.close();
    reopened=new LocalRuntime({...f.settings,discovery:true},{models:f.models,discovery:{home:home.home}});await reopened.recover();
    assert.equal((await reopened.status(task.id)).discovery,undefined);
    await assert.rejects(stat(join(f.directory,'local-context')),{code:'ENOENT'});
  }finally{await reopened?.close();await f.close();await home.close();}
});

test('configuration enables discovery on first install and rejects non-boolean switches',async()=>{
  const f=await fixture();try{
    assert.equal((await loadConfig(join(f.directory,'missing.json'))).discovery,true);
    await writeFile(join(f.directory,'config.json'),'{"discovery":false}');assert.equal((await loadConfig(join(f.directory,'config.json'))).discovery,false);
    await writeFile(join(f.directory,'config.json'),'{"discovery":"yes"}');await assert.rejects(loadConfig(join(f.directory,'config.json')),/discovery must be a boolean/);
  }finally{await f.close();}
});
