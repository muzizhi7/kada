/** Explicit paid integration smoke with a synthetic home; never sends the real local inventory. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { cloudModels } from '../src/models.js';
import { LocalRuntime } from '../src/runtime.js';
import { atomicJson } from '../src/util.js';

try{loadEnvFile('.env');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const args=parseArgs({options:{execute:{type:'boolean'}}});
if(!args.values.execute){console.log('Explicit cloud smoke: npm run test:live:discovery -- --execute; synthetic home, USD0.03 / 2 minutes, all attempts retained.');process.exit(0);}
const base=resolve('.harness/discovery-tests',randomUUID()),home=join(base,'home'),workspace=join(base,'workspace'),dataDir=join(base,'state');
await mkdir(join(home,'.agents/skills/invoice-total/scripts'),{recursive:true});await mkdir(join(home,'.codex'),{recursive:true});
await writeFile(join(home,'.codex/config.toml'),'model = "other-agent-preference"\napi_key = "SYNTHETIC_CREDENTIAL_DO_NOT_COPY"\n');
await writeFile(join(home,'.agents/skills/invoice-total/SKILL.md'),'---\nname: invoice-total\ndescription: Sum nullable integer entries in a JSON input array using an existing local script.\n---\n\nUse native read to inspect this file. Run `scripts/sum.mjs <input.json> <output.json>` against current workspace paths, resolving the script relative to this Skill directory. This script already exists; do not rewrite it. Verify with the task checker.\n');
await writeFile(join(home,'.agents/skills/invoice-total/scripts/sum.mjs'),"import{readFileSync,writeFileSync}from'node:fs';const a=JSON.parse(readFileSync(process.argv[2],'utf8'));writeFileSync(process.argv[3],JSON.stringify({total:a.reduce((s,x)=>s+(x??0),0)}));\n");
await mkdir(join(workspace,'acceptance'),{recursive:true});await writeFile(join(workspace,'input.json'),'[5,0,null,8]');
await writeFile(join(workspace,'acceptance/check.mjs'),"import assert from'node:assert/strict';import{readFileSync}from'node:fs';assert.deepEqual(JSON.parse(readFileSync('result.json','utf8')),{total:13});console.log('DISCOVERY_DELIVERY_PASS');\n");
const settings=await loadConfig();assert(settings.model,'Configure the existing online model first');
const runtime=new LocalRuntime({...settings,dataDir,port:0,discovery:true,learning:false,web:false,review:false,maxSubagents:1,maxEstimatedCostUsd:.03,maxDurationMs:120000},{models:cloudModels(),discovery:{home}});
let id:string|undefined;
try{
  const setup=await runtime.localSetup();assert(setup.skills===1&&setup.agents===2);
  assert.equal((await runtime.list()).length,0,'discovery itself creates no model task');
  const task=await runtime.create('集成测试：使用本机已自动发现的 invoice-total Skill 汇总工作区 input.json，交付 result.json。先通过本机Skills目录找到它，再用原生read读取SKILL.md，使用已有scripts/sum.mjs，不重写计算代码。只在本工作区写结果，保留输入与acceptance。固定核对为 node acceptance/check.mjs，inputs为acceptance和input.json，outputs为result.json。交付标准仅此一项并引用实际proof。资料、权限、口径已明确；先提出简洁任务说明，不必提问。总预算USD0.03、2分钟，无联网、无下载、无需插件。其他Agent模型偏好不能更换当前模型。',workspace,[],{prepare:true});id=task.id;
  const wait=async(predicate:(s:Awaited<ReturnType<LocalRuntime['status']>>)=>boolean)=>{
    const end=Date.now()+150000;
    while(Date.now()<end){const s=await runtime.status(task.id);if(predicate(s))return s;if(['failed','needs_attention','blocked','waiting_user','budget_limited'].includes(s.status))throw new Error(`Stopped: ${s.status}: ${s.goal?.reason}`);await setTimeout(250);}
    throw new Error('Smoke timeout');
  };
  const ready=await wait(s=>['awaiting_confirmation','clarifying'].includes(s.status));
  assert.equal(ready.status,'awaiting_confirmation');assert.equal(ready.goal?.brief?.questions.length,0);assert(ready.goal!.brief!.criteria.some(c=>c.verification?.command==='node acceptance/check.mjs'));
  await runtime.confirm(task.id,ready.goal!.brief!.revision,ready.briefDigest!);
  const done=await wait(s=>s.status==='completed');
  assert.deepEqual(done.model,settings.model);assert.equal(done.budget.costLimit,.03);assert((done.goal!.localSkillReads?.length??0)>0,'must actually read the discovered Skill through native Pi read');
  const {readFile}=await import('node:fs/promises');assert.deepEqual(JSON.parse(await readFile(join(workspace,'result.json'),'utf8')),{total:13});
  assert.equal((await readFile(join(home,'.codex/config.toml'),'utf8')).includes('SYNTHETIC_CREDENTIAL_DO_NOT_COPY'),true);
  const result={passed:true,model:done.model,budget:done.budget,externalSkillReads:done.goal!.localSkillReads!.length,confirmations:done.goal!.events.filter(e=>e.type==='confirmed').length,reworks:done.goal!.reworks,record:base};
  await atomicJson(join(base,'result.json'),result);console.log(JSON.stringify(result));
}catch(error){await atomicJson(join(base,'failure.json'),{error:String(error),taskId:id,record:base,...(id?{status:await runtime.status(id).catch(()=>null)}:{})});throw error;}
finally{await runtime.close();}
