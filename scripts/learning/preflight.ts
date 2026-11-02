import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, families } from "./fixtures.js";
import { Workspace } from "../../src/workspace.js";
import { hashFiles } from "../../src/verification.js";

/** Verify that each frozen checker accepts a reference and rejects a real defect before paid work. */
export async function preflight(directory: string, offset = 0, nativeSkills = false) {
  const execute = promisify(execFile), records = [];
  for (const family of families) for (let index = 0; index < 3; index++) {
    const variant = index + offset;
    const path = join(directory, `${family}-${variant}`), brief = await fixture(path, family, variant, nativeSkills), ws = await Workspace.open(path);
    const original = await hashFiles(ws, brief.criteria[0]!.verification!.inputs);
    if (family === "files") {
      await writeFile(join(path, "deliverables/summarize.mjs"), `import{readdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';const sums={};for(const name of readdirSync(process.argv[2])){if(!name.endsWith('.csv'))continue;for(const line of readFileSync(join(process.argv[2],name),'utf8').trim().split(/\\r?\\n/).slice(1)){const[id,currency,amount,status]=line.split(',');if(status==='paid')sums[currency]=(sums[currency]??0)+Number(amount);}}writeFileSync(process.argv[3],JSON.stringify(sums));\n`);
      await execute(process.execPath, ["deliverables/summarize.mjs", "incoming", "deliverables/totals.json"], { cwd: path });
    } else {
      await writeFile(join(path, "project/merge.mjs"), `const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);const copy=x=>Array.isArray(x)?x.map(copy):object(x)?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)])):x;
export function mergeConfig(base,patch){if(patch===undefined)return copy(base);if(!object(base)||!object(patch))return copy(patch);const result=copy(base);for(const k of Object.keys(patch))result[k]=mergeConfig(base[k],patch[k]);return result;}\n`);
    }
    await writeFile(join(path, "deliverables/README.md"), "Reference preflight only. Current original input and acceptance checks remain unchanged. This is not a model-generated result.\n");
    await execute(process.execPath, ["acceptance/check.mjs"], { cwd: path, timeout: 15000 });
    if (family === "files") await writeFile(join(path, "deliverables/totals.json"), '{}');
    else await writeFile(join(path, "project/merge.mjs"), "export function mergeConfig(base,patch){return {...base,...patch};}\n");
    await assert.rejects(execute(process.execPath, ["acceptance/check.mjs"], { cwd: path, timeout: 15000 }));
    assert.deepEqual(await hashFiles(ws, brief.criteria[0]!.verification!.inputs), original);
    records.push({ family, variant, referenceAccepted: true, defectRejected: true, immutableInputs: true });
  }
  return records;
}
