import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { loadConfig } from "../../src/config.js";
import { cloudModels, validateModel } from "../../src/models.js";
import { localExecution, taskCompaction } from "../../src/execution.js";
import { goalExtension } from "../../src/goal.js";
import { delegationExtension } from "../../src/delegation.js";
import { verificationExtension } from "../../src/verification.js";
import { Workspace } from "../../src/workspace.js";
import { launchRun } from "./launch.js";
import { save, sha, type Arm, type RunConfig } from "./common.js";

try { loadEnvFile(".env"); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
const base = resolve(process.argv[2] ?? ".harness/benchmarks/heldout-2026-10-31");
const freezeFile = join(base, "frozen.json");
const execute = process.argv.includes("--execute");
const config = await loadConfig(), models = cloudModels(), model = validateModel(models, config.model);
if (config.computer) throw new Error("The experiment never starts a computer-use driver");

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.name==="__pycache__" || entry.name===".DS_Store") continue;
    const path=join(directory,entry.name);
    if(entry.isDirectory()) result.push(...await files(path)); else if(entry.isFile()) result.push(path);
  }
  return result.sort();
}
async function hashes(directory:string) {
  const result:Record<string,string>={};
  for(const file of await files(directory)) result[file.slice(directory.length+1)]=sha(await readFile(file));
  return result;
}
async function intact(frozen:{frozen:string;hashes:Record<string,string>;fixtureHashes:Record<string,string>;studyHashes:Record<string,string>}) {
  for(const [path,digest] of Object.entries(frozen.hashes)) if(sha(await readFile(join(frozen.frozen,path)))!==digest) throw new Error("Frozen evaluation source changed: "+path);
  for(const [path,digest] of Object.entries(frozen.fixtureHashes)) if(sha(await readFile(join(base,"fixtures",path)))!==digest) throw new Error("Frozen task input changed: "+path);
  for(const [path,digest] of Object.entries(frozen.studyHashes)) if(sha(await readFile(join(base,path)))!==digest) throw new Error("Frozen study metadata changed: "+path);
}

if (!await stat(freezeFile).catch(()=>undefined)) {
  if(execute) throw new Error("Freeze the protocol and all checks before paid execution; first run without --execute");
  const frozen = join(base,"frozen"); await mkdir(frozen,{recursive:true});
  const filter=(path:string)=>!path.includes("__pycache__")&&!path.endsWith(".pyc");
  for(const directory of ["src","methods","scripts/heldout"]) await cp(resolve(directory),join(frozen,directory),{recursive:true,filter});
  for(const file of ["package.json","package-lock.json"]) await cp(resolve(file),join(frozen,file));
  await cp(resolve("docs/experiments/2026-10-31-heldout-protocol.md"),join(frozen,"PROTOCOL.md"));
  await cp(resolve(".harness/benchmarks/ev-2026-10-30/goal-driven-template.txt"),join(base,"goal-driven-template.txt"));
  const studyHashes:Record<string,string>={};
  for(const file of ["tasks.json","source-manifest.json","goal-driven-template.txt"]){await cp(join(base,file),join(frozen,file));studyHashes[file]=sha(await readFile(join(base,file)));}
  const tasks=JSON.parse(await readFile(join(base,"tasks.json"),"utf8")) as {id:string;category:string;name:string;fixture:string;crash?:{watch:string}}[];
  if(tasks.length!==6)throw new Error("Expected six fixed tasks");
  const orders:Arm[][]=[["pi","prompt","extension"],["pi","extension","prompt"],["prompt","pi","extension"],["prompt","extension","pi"],["extension","pi","prompt"],["extension","prompt","pi"]];
  const shuffled=[...tasks]; for(let i=shuffled.length-1;i>0;i--){const j=randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j]!,shuffled[i]!];}
  const runs:RunConfig[]=[];
  for(let repeat=1;repeat<=2;repeat++)for(const [index,task] of shuffled.entries())for(const arm of orders[(index+(repeat-1)*3)%6]!) {
    const sequence=runs.length+1;const directory=join(base,"runs",String(sequence).padStart(2,"0")+"-"+randomUUID().slice(0,8));
    runs.push({directory,workspace:join(directory,"workspace"),study:base,frozen,task:task.id,category:task.category,arm,repeat,sequence,model,
      maxEstimatedCostUsd:.25,maxDurationMs:3600000,maxSubagents:3,compactAtTokens:48000,
      transientFault:task.id==="code-cli",...(task.crash?{crashWatch:task.crash.watch}:{})});
  }
  const coding=localExecution(),goal=goalExtension({advisoryPlan:true}),verification=verificationExtension(await Workspace.open(join(base,"tool-probe")));
  const rootTools=[coding,delegationExtension("<workspace>",3,model,[goal,verification]),goal,verification].flatMap(extension=>extension.tools??[]).map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters})).sort((a,b)=>a.name.localeCompare(b.name));
  const record={createdAt:Date.now(),frozen,hashes:await hashes(frozen),fixtureHashes:await hashes(join(base,"fixtures")),studyHashes,model,piVersion:"1.4.0",harnessVersion:"0.5.0",
    rootTools:rootTools.map(tool=>tool.name),rootToolSchemaSha256:sha(JSON.stringify(rootTools)),workerTools:coding.tools!.map(tool=>tool.name).sort(),
    modelCost:models.getModel(model.provider,model.modelId)!.cost,compaction:taskCompaction(models,[model],48000),
    goalDrivenCommit:"c8e54ba3e9a4cf65df8fd9d92d0f9b231cab7f45",goalDrivenSha256:sha(await readFile(join(base,"goal-driven-template.txt"))),
    budget:{perRunUsd:.25,perRunDurationMs:3600000,nominalAllRunsUsd:9,aggregateStopUsd:10,batchDurationMs:12*3600000},
    repetitions:2,runCount:runs.length,runs,scope:"Preconfirmed execution only; Pi SDK with shared tools, pinned Goal-Driven user prompt, frozen production LocalRuntime. No live web or computer use. All six tasks complete before independent grading; no external follow-up or grader feedback during execution."};
  await save(freezeFile,record);
  await writeFile(join(base,"interventions.jsonl"),"");
  console.log(JSON.stringify({frozen:true,base,tasks:tasks.map(task=>({id:task.id,name:task.name})),runs:runs.length,model,budget:record.budget,rootTools:record.rootTools}));
  process.exit(0);
}

const frozen=JSON.parse(await readFile(freezeFile,"utf8")) as {frozen:string;hashes:Record<string,string>;fixtureHashes:Record<string,string>;studyHashes:Record<string,string>;goalDrivenSha256:string;runs:RunConfig[];budget:{aggregateStopUsd:number;perRunUsd:number;batchDurationMs:number}};
await intact(frozen);
if(sha(await readFile(join(base,"goal-driven-template.txt")))!==frozen.goalDrivenSha256)throw new Error("Pinned template changed");
if(!execute){console.log(JSON.stringify({frozen:true,base,runs:frozen.runs.length,budget:frozen.budget,paidExecutionStarted:false}));process.exit(0);}
let startedAt=await readFile(join(base,"execution.json"),"utf8").then(data=>(JSON.parse(data) as {startedAt:number}).startedAt).catch(()=>undefined);
if(!startedAt){startedAt=Date.now();await save(join(base,"execution.json"),{startedAt,authorization:"User explicitly requested the real three-category matched-model/tools/budget comparison; conservative caps announced before execution."});}
const results:Record<string,unknown>[]=[];
for(const run of frozen.runs) {
  const existing=await readFile(join(run.directory,"result.json"),"utf8").then(data=>JSON.parse(data) as Record<string,unknown>).catch(()=>null);
  if(existing){results.push(existing);continue;}
  const used=results.reduce((sum,result)=>sum+((result.budget as {estimatedCostUsd?:number}|null)?.estimatedCostUsd??0),0);
  if(used+run.maxEstimatedCostUsd>frozen.budget.aggregateStopUsd || Date.now()-startedAt>frozen.budget.batchDurationMs){
    await save(join(base,"stopped.json"),{reason:"aggregate budget/time boundary",estimatedCostUsd:used,completed:results.length,planned:frozen.runs.length});break;
  }
  await intact(frozen);
  const fixture=join(base,"fixtures",run.task); await mkdir(run.directory,{recursive:true});
  if(!await stat(run.workspace).catch(()=>undefined))await cp(fixture,run.workspace,{recursive:true,errorOnExist:true,force:false});
  const result=await launchRun(run,join(frozen.frozen,"scripts/heldout/worker.ts"));
  results.push(result);
  await save(join(base,"results.json"),results);
  if(!(result as Record<string,unknown>).budget) {
    await save(join(base,"stopped.json"),{reason:"worker did not leave an auditable usage ledger",sequence:run.sequence});
    break;
  }
  const manifests=(result as Record<string,unknown>).toolManifests as {worker:boolean;names:string[];schemaSha256:string}[]|undefined;
  const roots=results.flatMap(item=>((item.toolManifests as typeof manifests)??[]).filter(item=>!item.worker&&item.names.length));
  if(new Set(roots.map(item=>item.schemaSha256)).size>1 || manifests?.some(item=>item.names.length && item.names.length!==(item.worker?4:11))) {
    await save(join(base,"stopped.json"),{reason:"Observed model tool schemas differ",sequence:run.sequence});break;
  }
  await save(join(base,"batch-progress.json"),{completed:results.length,planned:frozen.runs.length,elapsedMs:Date.now()-startedAt,estimatedCostUsd:results.reduce((sum,item)=>sum+((item.budget as {estimatedCostUsd?:number}|null)?.estimatedCostUsd??0),0)});
  console.log(JSON.stringify({runFinished:run.sequence,task:run.task,arm:run.arm,repeat:run.repeat,execution:(result as Record<string,unknown>).execution,budget:(result as Record<string,unknown>).budget,completed:results.length}));
}
await save(join(base,"results.json"),results);
console.log(JSON.stringify({executionsFinished:true,completed:results.length,planned:frozen.runs.length,base}));
