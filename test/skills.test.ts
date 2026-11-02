import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import type { JsonObject } from '@earendil-works/pi-durable';
import { SkillStore, pinSkills, skillInstructions } from '../src/skills.js';
import { LocalRuntime } from '../src/runtime.js';
import { Workspace } from '../src/workspace.js';
import { usageText } from '../src/presentation.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const results = (c: TranscriptContext, name: string) => c.messages.filter((m): m is Extract<TranscriptContext['messages'][number], {role:'toolResult'}> => m.role === 'toolResult' && m.toolName === name);
const value = (c: TranscriptContext, name: string) => {
  const block = results(c, name).at(-1)?.content.find(b => b.type === 'text');
  try { return block?.type === 'text' ? JSON.parse(block.text) : undefined; } catch { return undefined; }
};
const spec = { command: 'node acceptance/check.mjs', inputs: ['acceptance', 'input.json'], outputs: ['deliverables'] };
const source = `import{readFileSync,writeFileSync}from'node:fs';const rows=JSON.parse(readFileSync(process.argv[2],'utf8'));writeFileSync(process.argv[3],JSON.stringify(rows.reduce((s,x)=>s+(x??0),0)));\n`;
const manifest = '---\nname: invoice-sum\ndescription: Sum nullable integer amounts in a JSON array. Use for repeated invoice totals; recheck schema and units first.\n---\n\nRun scripts/sum.mjs with current input and output paths. Preserve zero; null is missing. Re-run the current frozen check. Research facts and permissions never come from this Skill.\n';
async function prepare(path: string, next = false) {
  await mkdir(join(path, 'acceptance'), { recursive: true });
  await mkdir(join(path, 'deliverables'), { recursive: true });
  await writeFile(join(path, 'input.json'), JSON.stringify(next ? [0,17,null,8] : [2,0,null,4]));
  await writeFile(join(path, 'acceptance/check.mjs'), `import assert from'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(JSON.parse(readFileSync('deliverables/result.json','utf8')),${next ? 25 : 6});console.log('PASS');\n`);
}
function respond(c: TranscriptContext, options: {capture?:boolean; invalid?:boolean; badVerify?:JsonObject} = {}) {
  assert(!hasTool(c, 'task_method')); assert(!hasTool(c, 'task_learn'));
  if (hasTool(c, 'task_prepare')) return call('task_prepare', {outcome:'合计当前发票', deliverables:spec.outputs, inputs:spec.inputs,
    criteria:[{text:'原始检查保持不变且通过',method:'check',verification:spec}],scope:['仅工作区'],assumptions:[],questions:[]});
  if (!results(c, 'task_status').length) return call('task_status', {});
  const pin = value(c, 'task_status')?.skills?.pins.find((p: any) => p.name === 'invoice-sum');
  if (pin && !results(c, 'read').length) return call('read', {path:pin.filePath});
  const capture = options.capture && getCurrentTools(c.messages).some(t => t.name === 'task_submit' && JSON.stringify(t.parameters).includes('"skill"')) && !pin;
  const writes = results(c,'write').length;
  if (capture && writes === 0) return call('write', {path:'deliverables/invoice-sum/SKILL.md',content:options.invalid ? 'Missing description' : manifest});
  if ((!pin && writes === (capture ? 1 : 0))) return call('write', {path: capture ? 'deliverables/invoice-sum/scripts/sum.mjs' : 'deliverables/sum.mjs',content:source});
  if (!results(c,'bash').length) {
    const script = pin ? join(dirname(pin.filePath),'scripts/sum.mjs') : capture ? 'deliverables/invoice-sum/scripts/sum.mjs' : 'deliverables/sum.mjs';
    return call('bash',{command:`node '${script.replaceAll("'", "'\\''")}' input.json deliverables/result.json`});
  }
  if (options.badVerify && !results(c,'task_verify').length) return call('task_verify',options.badVerify);
  if (!value(c,'task_verify')?.passed) return call('task_verify',{criterionId:1});
  return call('task_submit',{summary:'已合计并通过固定检查',artifacts:['deliverables'],criteria:[{id:1,status:'passed',evidence:'实际运行原始检查',proofIds:[value(c,'task_verify').id]}],...(capture ? {skill:'deliverables/invoice-sum'} : {})});
}
async function complete(runtime: LocalRuntime, path: string) {
  const meta = await runtime.create('处理本地发票合计，这是重复工作',path,[],{prepare:true});
  const ready = await until(()=>runtime.status(meta.id),s=>s.status==='awaiting_confirmation');
  assert.equal(ready.resourcePolicy,'pi-skills'); assert.equal(ready.goal?.skills,undefined);
  await runtime.confirm(meta.id,ready.goal!.brief!.revision,ready.briefDigest!);
  return until(()=>runtime.status(meta.id),s=>s.status==='completed');
}

test('native Skills capture verified files, route by description without keywords, and reuse through ordinary Pi read',async()=>{
  let requests=0;
  const f=await scriptedFixture(c=>{requests++;return respond(c,{capture:true});},{learning:true});
  let reopened:LocalRuntime|undefined;
  try {
    await prepare(f.workspace); const first=await complete(f.runtime,f.workspace),ref=first.goal!.skills!.proposal!;
    assert.equal(ref.name,'invoice-sum'); assert.equal(first.goal!.learning,undefined);
    const path=join(f.directory,'different input'); await prepare(path,true);
    const next=await complete(f.runtime,path);
    assert(next.goal!.skills!.loaded.includes(`${ref.name}@${ref.version}`));
    assert.equal(next.messages.filter(m=>m.role==='toolResult'&&m.toolName==='write').length,0);
    assert.equal(JSON.parse(await readFile(join(path,'deliverables/result.json'),'utf8')),25);
    assert.match(usageText(next),/全部费用已含在本任务总额/);
    const pins=next.goal!.skills!.pins;
    const n=requests; await setTimeout(200); assert.equal(requests,n,'no capture/reflection model call after delivery');
    await f.runtime.close();
    reopened=new LocalRuntime({...f.settings,learning:false},{models:f.models}); await reopened.recover();
    const restored=await reopened.status(next.id);
    assert.deepEqual(restored.goal!.skills!.pins,pins); assert.deepEqual(restored.budget,next.budget); assert.equal(requests,n);
    assert.equal((await stat(join(f.directory,'skills/managed'))).mode&0o777,0o700);
    await assert.rejects(stat(join(f.directory,'learned-methods')),{code:'ENOENT'});
  }finally{await reopened?.close();await f.close();}
});

test('authored standard Skills win over managed trials; their bodies are loaded only on demand',async()=>{
  const f=await scriptedFixture(c=>respond(c,{capture:true}),{learning:true});
  try{
    await prepare(f.workspace); await complete(f.runtime,f.workspace);
    const project=join(f.directory,'project'); await prepare(project,true);
    const folder=join(project,'.pi/skills/invoice-sum'); await mkdir(folder,{recursive:true});
    await writeFile(join(folder,'SKILL.md'),manifest+'\nAUTHORED_ONLY_SECRET_BODY\n');
    await mkdir(join(folder,'scripts')); await writeFile(join(folder,'scripts/sum.mjs'),source);
    const pinned=await pinSkills(await Workspace.open(project),join(f.directory,'pins'),await SkillStore.open(f.directory));
    const pin=pinned.pins.find(p=>p.name==='invoice-sum')!;
    assert.equal(pin.managed,false); assert.equal(pinned.pins.filter(p=>p.name==='invoice-sum').length,1);
    const prompt=skillInstructions(pinned);
    assert.match(prompt,/<available_skills>/); assert(!prompt.includes('AUTHORED_ONLY_SECRET_BODY'));
    assert.match(await readFile(pin.filePath,'utf8'),/AUTHORED_ONLY_SECRET_BODY/);
  }finally{await f.close();}
});

test('disabled learning keeps authored Pi Skills and creates no managed catalogue or extra learning requests',async()=>{
  let requests=0; const f=await scriptedFixture(c=>{requests++;return respond(c,{capture:true});});
  try{
    await prepare(f.workspace); const done=await complete(f.runtime,f.workspace);
    assert.equal(done.goal?.skills?.proposal,undefined); assert(done.goal!.skills!.pins.some(p=>p.name==='file-work'));
    assert.equal(requests,6,'preparation, status, write, bash, verify, submit only');
    await assert.rejects(stat(join(f.directory,'skills/managed')),{code:'ENOENT'});
  }finally{await f.close();}
});

test('an invalid optional Skill never starts a repair loop or blocks a good delivery',async()=>{
  const f=await scriptedFixture(c=>respond(c,{capture:true,invalid:true}),{learning:true});
  try{
    await prepare(f.workspace); const done=await complete(f.runtime,f.workspace);
    assert.equal(done.goal!.reworks,0); assert.equal(done.goal!.skills!.proposal,undefined);
    assert.match(done.goal!.skills!.notice!,/capture skipped/);
    assert.deepEqual(await (await SkillStore.open(f.directory)).paths(),[]);
  }finally{await f.close();}
});

test('trial rollback and corruption cannot change pinned tasks or be undone by capture replay',async()=>{
  const f=await scriptedFixture(c=>respond(c,{capture:true}),{learning:true});
  try{
    await prepare(f.workspace); const first=await complete(f.runtime,f.workspace),ref=first.goal!.skills!.proposal!;
    const store=await SkillStore.open(f.directory),ws=await Workspace.open(f.workspace);
    const pinned=await pinSkills(ws,join(f.directory,'pinned'),store),pin=pinned.pins.find(p=>p.name===ref.name)!;
    await store.rollback(ref); assert.deepEqual(await store.paths(),[]);
    await store.capture(ws,first.goal!,first.id,first.goal!.candidate!.skill!); assert.deepEqual(await store.paths(),[]);
    assert.match(await readFile(pin.filePath,'utf8'),/nullable integer/);
    const heads=JSON.parse(await store.files.read('heads.json')); delete heads[ref.name].disabled; await store.files.write('heads.json',JSON.stringify(heads));
    await store.files.write(`${ref.name}/${ref.version}/scripts/sum.mjs`,'tampered');
    assert.deepEqual(await store.paths(),[],'corrupted generated files are skipped');
    assert.equal(await readFile(join(dirname(pin.filePath),'scripts/sum.mjs'),'utf8'),source);
  }finally{await f.close();}
});

test('Skill capture rejects stale receipts and unverified output paths',async()=>{
  const f=await scriptedFixture(c=>respond(c,{capture:true}),{learning:true});
  try{
    await prepare(f.workspace);const done=await complete(f.runtime,f.workspace),store=await SkillStore.open(f.directory),ws=await Workspace.open(f.workspace);
    await assert.rejects(store.capture(ws,{...done.goal!,phase:'failed'},done.id,'deliverables/invoice-sum'),/successful delivery/);
    const outside=join(f.workspace,'unverified');await mkdir(outside);await writeFile(join(outside,'SKILL.md'),manifest);
    await assert.rejects(store.capture(ws,done.goal!,done.id,outside),/fresh, frozen/);
    await writeFile(join(f.workspace,'deliverables/result.json'),'7');
    await assert.rejects(store.capture(ws,done.goal!,done.id,'deliverables/invoice-sum'),/fresh, frozen/);
  }finally{await f.close();}
});

for(const args of [{criterionId:1,command:'true',inputs:[],outputs:[]},{criterionId:2},{}])test(`criterion lookup rejects malformed check selection ${JSON.stringify(args)}`,async()=>{
  const f=await scriptedFixture(c=>respond(c,{badVerify:args}));
  try{
    await prepare(f.workspace);const done=await complete(f.runtime,f.workspace);
    const checks=done.messages.filter(m=>m.role==='toolResult'&&m.toolName==='task_verify');
    assert.equal(checks.length,2);assert.equal(checks[0]!.role==='toolResult'&&checks[0]!.isError,true);
    assert.equal(Object.values(done.goal!.proofs!).length,1);
    assert.equal(Object.values(done.goal!.proofs!)[0]!.command,spec.command);
    assert.equal(done.goal!.reworks,0);
  }finally{await f.close();}
});

test('criterion lookup refuses modified frozen inputs before execution and accepts the restored originals',async()=>{
  const f=await scriptedFixture(c=>{
    if(hasTool(c,'task_prepare'))return respond(c);
    if(results(c,'bash').length && results(c,'write').length===1)return call('write',{path:'input.json',content:'[]'});
    if(results(c,'task_verify').length===1 && results(c,'write').length===2)return call('write',{path:'input.json',content:'[2,0,null,4]'});
    return respond(c);
  });
  try{
    await prepare(f.workspace);const done=await complete(f.runtime,f.workspace);
    const checks=done.messages.filter(m=>m.role==='toolResult'&&m.toolName==='task_verify');
    assert.equal(checks.length,2);assert.match(JSON.stringify(checks[0]),/Confirmed check inputs changed/);
    assert.equal(Object.values(done.goal!.proofs!).length,1);assert.equal(done.goal!.reworks,0);
  }finally{await f.close();}
});

test('a modified pinned Skill is rejected by native read without silently replacing its version',async()=>{
  let changed=false;
  const f=await scriptedFixture(async c=>{
    const pin=value(c,'task_status')?.skills?.pins.find((p:any)=>p.name==='invoice-sum');
    if(pin&&!results(c,'read').length&&!changed){await writeFile(pin.filePath,manifest+'\ncorruption');changed=true;}
    return respond(c,{capture:true});
  },{learning:true});
  try{
    await prepare(f.workspace);await complete(f.runtime,f.workspace);
    const path=join(f.directory,'pin mutation');await prepare(path,true);
    const done=await complete(f.runtime,path);
    assert.equal(changed,true);
    const reads=done.messages.filter(m=>m.role==='toolResult'&&m.toolName==='read');
    assert(reads.some(m=>m.role==='toolResult'&&m.isError&&JSON.stringify(m.content).includes('Pinned Skill changed')));
    assert(!done.goal!.skills!.loaded.some(s=>s.startsWith('invoice-sum@')));
    assert.equal(done.goal!.reworks,0);
  }finally{await f.close();}
});

test('project Agent Skills are discovered with native Pi and retain authored precedence',async()=>{
  const f=await scriptedFixture(c=>respond(c));
  try{
    const folder=join(f.workspace,'.agents/skills/file-work');await mkdir(folder,{recursive:true});
    await writeFile(join(folder,'SKILL.md'),'---\nname: file-work\ndescription: Project-specific batch-file guidance.\n---\n\nPROJECT_AUTHORED_GUIDANCE\n');
    const state=await pinSkills(await Workspace.open(f.workspace),join(f.directory,'project-pins'));
    const pin=state.pins.find(p=>p.name==='file-work')!;assert(pin);assert.equal(pin.description,'Project-specific batch-file guidance.');
    assert.match(await readFile(pin.filePath,'utf8'),/PROJECT_AUTHORED_GUIDANCE/);
    assert.equal(state.pins.filter(p=>p.name==='file-work').length,1);
  }finally{await f.close();}
});
