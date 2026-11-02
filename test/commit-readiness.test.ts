import{test}from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,writeFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{fileURLToPath}from'node:url';
import{createRequire}from'node:module';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
const execute=promisify(execFile),loader=createRequire(import.meta.url).resolve('tsx'),script=fileURLToPath(new URL('../scripts/check-commit.ts',import.meta.url));

test('commit check accepts ignored credentials but rejects a force-staged private file without exposing its value',async()=>{
  const path=await mkdtemp(join(tmpdir(),'pi-commit-check-'));
  try{
    await execute('git',['init','-q'],{cwd:path});await writeFile(join(path,'.gitignore'),'.env\n.harness/\n');
    const key='sk-'+'a'.repeat(32);await writeFile(join(path,'.env'),'OPENAI_API_KEY='+key+'\n');
    await writeFile(join(path,'index.ts'),'export const version=1;\n');
    assert.match((await execute(process.execPath,['--import',loader,script],{cwd:path})).stdout,/Commit candidates checked/);
    await execute('git',['add','-f','.env'],{cwd:path});
    await assert.rejects(execute(process.execPath,['--import',loader,script],{cwd:path}),error=>{
      const text=String((error as any).stderr);assert(text.includes('.env'));assert(!text.includes(key));return true;
    });
  }finally{await rm(path,{recursive:true,force:true});}
});

test('commit check detects a credential pasted into source, not just credential filenames',async()=>{
  const path=await mkdtemp(join(tmpdir(),'pi-commit-check-'));
  try{
    await execute('git',['init','-q'],{cwd:path});const key='sk-'+'b'.repeat(32);
    await writeFile(join(path,'index.ts'),'export const credential='+JSON.stringify(key)+';\n');
    await assert.rejects(execute(process.execPath,['--import',loader,script],{cwd:path}),error=>{
      const text=String((error as any).stderr);assert(text.includes('index.ts'));assert(!text.includes(key));return true;
    });
  }finally{await rm(path,{recursive:true,force:true});}
});
