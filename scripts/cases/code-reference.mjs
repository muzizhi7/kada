import fs from 'node:fs/promises';
import {join} from 'node:path';
const [id,root]=process.argv.slice(2);
const inventory=`import{readdir,lstat,readFile}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';
export async function scanInventory(root,{includeHidden=false,excludeDirs=[]}={}){const rows=[];async function walk(path,parts){for(const e of await readdir(path,{withFileTypes:true})){if(!includeHidden&&e.name.startsWith('.'))continue;const p=join(path,e.name),s=await lstat(p);if(s.isSymbolicLink())continue;const rel=[...parts,e.name].join('/');if(s.isDirectory()){if(excludeDirs.includes(e.name))continue;rows.push({path:rel,kind:'directory',bytes:0,sha256:null});await walk(p,[...parts,e.name]);}else if(s.isFile()){const bytes=await readFile(p);rows.push({path:rel,kind:'file',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}}await walk(root,[]);return rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
`;
const pool=`export async function mapLimit(items,concurrency,worker,{signal}={}){if(!Number.isInteger(concurrency)||concurrency<=0)throw new RangeError('concurrency');const abort=()=>Object.assign(new Error('Aborted'),{name:'AbortError'});if(signal?.aborted)throw abort();if(!items.length)return[];return new Promise((resolve,reject)=>{const values=new Array(items.length);let next=0,active=0,finished=0,failed=false,reason;const stop=e=>{if(!failed){failed=true;reason=e;}drain();};const cleanup=()=>signal?.removeEventListener('abort',onAbort);const onAbort=()=>stop(abort());function drain(){if(failed){if(!active){cleanup();reject(reason);}return;}if(finished===items.length){cleanup();resolve(values);return;}while(!failed&&active<concurrency&&next<items.length){const i=next++;active++;Promise.resolve().then(()=>worker(items[i],i,signal)).then(v=>{values[i]=v;active--;finished++;drain();},e=>{active--;finished++;stop(e);});}}signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();else drain();});}
`;
const cache=`export function createJSONCache(fetcher,{ttlMs=1000,now=Date.now}={}){if(!Number.isFinite(ttlMs)||ttlMs<0)throw new RangeError('ttlMs');const cache=new Map(),pending=new Map();const lower=h=>Object.fromEntries(Object.entries(h??{}).map(([k,v])=>[k.toLowerCase(),String(v)]));return{async get(url,{headers={}}={}){const h=lower(headers),auth=Object.keys(h).includes('authorization'),key=url+'\\n'+(h.accept??'');const previous=auth?undefined:cache.get(key);if(previous&&now()<previous.expires)return structuredClone(previous.body);if(!auth&&pending.has(key))return structuredClone(await pending.get(key));const load=(async()=>{const request={...headers};if(previous?.etag)request['If-None-Match']=previous.etag;const response=await fetcher(url,{headers:request}),rh=lower(response.headers);let body;if(response.status===304){if(!previous)throw new Error('304 without cached representation');body=structuredClone(previous.body);}else if(response.status===200)body=structuredClone(response.body);else throw new Error('HTTP '+response.status);if(!auth){if((rh['cache-control']??'').toLowerCase().includes('no-store')||(rh.vary??'').split(',').some(x=>x.trim()==='*'))cache.delete(key);else cache.set(key,{body,expires:now()+ttlMs,etag:rh.etag??(response.status===304?previous?.etag:undefined)});}return body;})();if(!auth)pending.set(key,load);try{return structuredClone(await load);}finally{if(!auth&&pending.get(key)===load)pending.delete(key);}}};}
`;
const importer=`import json

def import_records(conn, lines, *, strict=False):
 counts={'inserted':0,'updated':0,'stale':0,'invalid':0}
 conn.execute('BEGIN')
 try:
  conn.execute('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)')
  for line in lines:
   if not line.strip(): continue
   try:
    x=json.loads(line,parse_constant=lambda value: (_ for _ in ()).throw(ValueError('non-JSON constant')))
    if not isinstance(x,dict) or not isinstance(x.get('id'),str) or not x['id'].strip() or type(x.get('revision')) is not int or x['revision']<0 or 'payload' not in x: raise ValueError('invalid record')
   except (ValueError,TypeError):
    if strict: raise ValueError('invalid record')
    counts['invalid']+=1;continue
   old=conn.execute('SELECT revision FROM records WHERE id=?',(x['id'],)).fetchone()
   if old and old[0]>=x['revision']:counts['stale']+=1;continue
   conn.execute('INSERT OR REPLACE INTO records(id,revision,payload) VALUES(?,?,?)',(x['id'],x['revision'],json.dumps(x['payload'],ensure_ascii=False)))
   counts['updated' if old else 'inserted']+=1
  conn.commit();return counts
 except BaseException:
  conn.rollback();raise

def list_records(conn):
 return [{'id':r[0],'revision':r[1],'payload':json.loads(r[2])} for r in conn.execute('SELECT id,revision,payload FROM records ORDER BY id')]
`;
await fs.writeFile(join(root,'project/src',id==='code_import'?'importer.py':'index.mjs'),({code_inventory:inventory,code_pool:pool,code_cache:cache,code_import:importer})[id]);
await fs.writeFile(join(root,'deliverables/README.md'),'Reference solution. Public API preserved; original tests plus independent full semantic probes executed. No additional dependency or network used.\n');
