import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskBrief } from "../../src/preparation.js";

export const families = ["files", "code"] as const;
export type Family = typeof families[number];
export async function fixture(workspace: string, family: Family, variant: number, nativeSkills = false): Promise<TaskBrief> {
  await mkdir(join(workspace, "acceptance"), { recursive: true });
  await mkdir(join(workspace, "deliverables"), { recursive: true });
  await writeFile(join(workspace, "environment.json"), JSON.stringify({ family, schema: 1, runtime: "node-esm" }));
  let request: string, inputs: string[], outputs: string[];
  if (family === "files") {
    await mkdir(join(workspace, "incoming"));
    const expected: Record<string, number> = {};
    for (let file = 0; file < 8; file++) {
      const lines = ["invoice_id,currency,amount_cents,status"];
      for (let row = 0; row < 24; row++) {
        const currency = ["CNY", "USD", "EUR"][(row + file + variant) % 3]!;
        const amount = (file * 37 + row * 19 + variant * 11) % 1700;
        const status = row % 7 === 0 ? "void" : "paid";
        lines.push(`${variant}-${file}-${row},${currency},${amount},${status}`);
        if (status === "paid") expected[currency] = (expected[currency] ?? 0) + amount;
      }
      await writeFile(join(workspace, "incoming", `部门 ${file + 1}.csv`), lines.join("\n") + "\n");
    }
    request = `这是已确认的“月度发票批处理”本地任务。incoming中8份真实格式的虚构CSV为本期资料，请按币种汇总paid行的amount_cents整数，void不计，零值保留，原文件不改。交付deliverables/totals.json（币种到整数合计的对象）、deliverables/README.md（说明口径和执行方法），以及可重新运行的参数化Node ESM脚本deliverables/summarize.mjs，参数为输入目录和输出JSON路径，目录可能含空格。脚本不得写死本期文件名、行数、币种或答案。只需支持提供的无引号CSV格式；不要扩需求。此类输入结构稳定的工作会重复，若可用本地方法工具，可在预算内复用或提炼通用步骤。先检查当前输入，再执行核对。`;
    inputs = ["acceptance", "incoming", "environment.json", "TASK.md"];
    outputs = ["deliverables"];
    await writeFile(join(workspace, "acceptance/check.mjs"), `import assert from 'node:assert/strict';import{readFileSync,mkdtempSync,rmSync,writeFileSync,mkdirSync}from'node:fs';import{execFileSync}from'node:child_process';import{join}from'node:path';import{tmpdir}from'node:os';
const expected=${JSON.stringify(expected)};
assert.deepEqual(JSON.parse(readFileSync('deliverables/totals.json','utf8')),expected);
assert(readFileSync('deliverables/README.md','utf8').length>40);
const temp=mkdtempSync(join(tmpdir(),'method-check-'));
try{const input=join(temp,'space input');mkdirSync(input);writeFileSync(join(input,'new.csv'),'invoice_id,currency,amount_cents,status\\nx,JPY,0,paid\\ny,JPY,210,paid\\nz,JPY,990,void\\n');const out=join(temp,'new.json');execFileSync(process.execPath,['deliverables/summarize.mjs',input,out]);assert.deepEqual(JSON.parse(readFileSync(out,'utf8')),{JPY:210});}finally{rmSync(temp,{recursive:true,force:true});}console.log('FILES_CURRENT_AND_PARAMETERIZED_PASS');\n`);
  } else {
    await mkdir(join(workspace, "project"));
    await writeFile(join(workspace, "project/package.json"), '{"name":"local-config-example","type":"module","scripts":{"test":"node --test merge.test.mjs"}}');
    await writeFile(join(workspace, "project/merge.mjs"), `// Existing shallow implementation; repair its public API.\nexport function mergeConfig(base,patch){return ${variant % 3 === 1 ? "{...patch,...base}" : variant % 3 === 2 ? "Object.assign(base,patch)" : "{...base,...patch}"};}\n`);
    await writeFile(join(workspace, "project/merge.test.mjs"), `import{test}from'node:test';import assert from'node:assert/strict';import{mergeConfig}from'./merge.mjs';
test('public API and deep object merge',()=>assert.deepEqual(mergeConfig({service:{port:80,host:'local'}},{service:{port:${8080 + variant}}}),{service:{port:${8080 + variant},host:'local'}}));
test('arrays replace, zero false null and undefined',()=>assert.deepEqual(mergeConfig({a:[1],b:2,c:true,d:1,e:5},{a:[],b:0,c:false,d:null,e:undefined}),{a:[],b:0,c:false,d:null,e:5}));
test('never mutate or alias either input',()=>{const base={a:{b:[1,2]}};const patch={c:{d:[3]}};const result=mergeConfig(base,patch);assert.deepEqual(base,{a:{b:[1,2]}});result.a.b.push(9);result.c.d.push(4);assert.deepEqual(base,{a:{b:[1,2]}});assert.deepEqual(patch,{c:{d:[3]}});});\n`);
    request = `这是已确认的“ESM配置合并修复”本地任务。修复project/merge.mjs中的mergeConfig(base,patch)，只处理JSON样式普通对象、数组、标量及undefined。递归合并普通对象；数组由patch整体替换；patch的undefined表示保留原值；0、false、null均为有效覆盖。返回值不应与base或patch共享对象/数组，也不得修改输入。保留导出API，运行现有npm test并补充你认为必要的自检。交付project源码目录和deliverables/README.md（修复与验证说明）。不要引入依赖或改验收程序。此类项目维护会继续进行，若有本地方法工具，可在预算内复用/提炼算法与测试方法；重新检查本项目和要求，不能盲目套用旧补丁。`;
    inputs = ["acceptance", "environment.json", "TASK.md", "project/merge.test.mjs", "project/package.json"];
    outputs = ["project", "deliverables"];
    await writeFile(join(workspace, "acceptance/check.mjs"), `import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{readFileSync}from'node:fs';import{mergeConfig}from'../project/merge.mjs';
execFileSync(process.execPath,['--test','merge.test.mjs'],{cwd:'project'});
const b={keep:{flag:false},replace:[{x:1}],zero:7},p={keep:{extra:${variant + 3}},replace:[{y:2}],zero:0};
const out=mergeConfig(b,p);assert.deepEqual(out,{keep:{flag:false,extra:${variant + 3}},replace:[{y:2}],zero:0});out.replace[0].y=99;assert.equal(p.replace[0].y,2);
assert.deepEqual(mergeConfig({x:1},{x:undefined}),{x:1});assert.deepEqual(mergeConfig({x:[1]},{x:null}),{x:null});
${nativeSkills ? `// Root values follow the same replacement/undefined contract, fixed before execution.
for(const patch of [null,0,false,[],[1],"",undefined]){const base={nested:{x:1}};const result=mergeConfig(base,patch);assert.deepEqual(result,patch===undefined?base:patch);if(result&&typeof result==='object')assert.notEqual(result,patch===undefined?base:patch);}
assert.deepEqual(mergeConfig(null,{a:[0]}),{a:[0]});assert.deepEqual(mergeConfig([1],{x:false}),{x:false});
` : ""}assert(readFileSync('deliverables/README.md','utf8').length>40);console.log('CODE_COMPATIBILITY_AND_OWNERSHIP_PASS');\n`);
  }
  const command = "node acceptance/check.mjs";
  if (nativeSkills && family === "code") request += " 根级的对象、数组、标量也遵守相同规则：patch为undefined时返回base的深复制；无法合并的类型由patch替换并深复制。";
  const objective = request + `\n工作仅限本工作区，可读取共同methods说明${nativeSkills ? "、已提供的标准Skills及其脚本，或兼容方法工具返回的固定方法" : "及task_method返回的已固定方法"}；不得读取其他运行、学习目录索引、评估器、凭据或配置。已确认总模型额度USD0.05、执行时限4分钟；主/子同模型，至多1子Agent，没有独立模型评审。必须保持${inputs.join("、")}原样。执行${command}，在task_verify中绑定这些inputs和${outputs.join("、")}作为outputs${nativeSkills ? "；有criterionId时可直接使用1" : ""}。最后调用task_submit，覆盖唯一标准ID 1并引用该proofId。不要额外等待确认或要求用户继续。`;
  await writeFile(join(workspace, "TASK.md"), objective);
  const brief: TaskBrief = { revision: 1, outcome: request, deliverables: outputs, inputs, scope: ["仅在本工作区执行，保留原始输入与核对"], assumptions: [], questions: [],
    criteria: [{ text: "满足TASK.md完整交付，保持原始核对/输入，实际通过固定命令", method: "check", verification: { command, inputs, outputs } }],
    checks: [], budget: { maxEstimatedCostUsd: .05, maxDurationMs: 240000 } };
  await writeFile(join(workspace, "BRIEF.json"), JSON.stringify(brief));
  return brief;
}
