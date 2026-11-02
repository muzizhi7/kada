// Independent behavior probes. Run only after all model executions have stopped.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [kind, workspace, output] = process.argv.slice(2);
const checks = [];
const check = (id, fn) => { try { fn(); checks.push({id,passed:true}); } catch(error) { checks.push({id,passed:false,detail:String(error.stack ?? error).slice(0,2200)}); } };
const deepFreeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };
try {
 if(kind === 'code-cache') {
  const {default: Cache} = await import(pathToFileURL(resolve(workspace,'project/index.js')));
  check('existing-basic',()=>{const c=new Cache({maxSize:4}); assert.equal(c.set('x',1),c); assert.equal(c.get('x'),1); assert(c.has('x')); c.delete('x'); assert(!c.has('x')); c.set('a',1);c.clear();assert.equal(c.size,0);});
  check('existing-ttl',()=>{const old=Date.now;let t=1000;Date.now=()=>t;try{const events=[];const c=new Cache({maxSize:4,maxAge:20,onEviction:(...x)=>events.push(x)});c.set('x',2);t=1021;assert.equal(c.get('x'),undefined);assert.deepEqual(events,[['x',2]]);}finally{Date.now=old;}});
  check('existing-iteration-resize',()=>{const c=new Cache({maxSize:3});for(let i=0;i<7;i++)c.set(i,i);c.resize(2);assert(c.size<=2);const entries=[...c.entriesAscending()];assert.equal(new Set(entries.map(x=>x[0])).size,entries.length);assert(entries.every(([k,v])=>c.get(k)===v));});
  check('factory-miss',()=>{const c=new Cache({maxSize:3});let n=0;const obj={x:1};assert.equal(c.getOrCreate('a',k=>{assert.equal(k,'a');n++;return obj;}),obj);assert.equal(c.get('a'),obj);assert.equal(n,1);});
  check('factory-falsey-hits',()=>{for(const value of [undefined,null,false,0,'']){const c=new Cache({maxSize:4});let n=0;c.set('a',value);assert.equal(c.getOrCreate('a',()=>{n++;return 9;}),value);assert.equal(n,0);assert(c.has('a'));}});
  check('factory-validation',()=>{const c=new Cache({maxSize:3});c.set('a',1);for(const bad of [null,{},4,'fn',undefined]){assert.throws(()=>c.getOrCreate('a',bad),TypeError);assert.throws(()=>c.getOrCreate('new',bad),TypeError);}assert.equal(c.get('a'),1);});
  check('factory-exception',()=>{const c=new Cache({maxSize:3});c.set('keep',3);const error=new Error('sentinel');assert.throws(()=>c.getOrCreate('x',()=>{throw error;}),e=>e===error);assert(!c.has('x'));assert.equal(c.get('keep'),3);});
  check('factory-expiration-and-options',()=>{const old=Date.now;let t=1000;Date.now=()=>t;try{const events=[];const c=new Cache({maxSize:10,maxAge:100,onEviction:(...v)=>events.push(v)});let n=0;c.set('a',1,{maxAge:5});t=1006;assert.equal(c.getOrCreate('a',()=>{n++;return 2;},{maxAge:20}),2);assert.equal(c.expiresIn('a'),20);assert.equal(n,1);assert.deepEqual(events,[['a',1]]);t=1010;assert.equal(c.getOrCreate('a',()=>99,{maxAge:500}),2);assert.equal(c.expiresIn('a'),16);assert.deepEqual(events,[['a',1]]);}finally{Date.now=old;}});
  check('factory-default-ttl',()=>{const old=Date.now;let t=10;Date.now=()=>t;try{const c=new Cache({maxSize:5,maxAge:30});c.getOrCreate('a',()=>4);assert.equal(c.expiresIn('a'),30);t=41;assert.equal(c.getOrCreate('a',()=>7),7);}finally{Date.now=old;}});
  check('factory-explicit-side-effect',()=>{for(const v of [undefined,0,{tag:'explicit'}]){const c=new Cache({maxSize:5});const returned=c.getOrCreate('a',()=>{c.set('a',v);return 'ignored';});assert.equal(returned,v);assert.equal(c.get('a'),v);}});
  check('factory-object-key-identity',()=>{const c=new Cache({maxSize:5});const a={},b={};c.getOrCreate(a,key=>{assert.equal(key,a);return 4;});assert(!c.has(b));assert.equal(c.getOrCreate(b,()=>8),8);assert.equal(c.get(a),4);});
  check('factory-promotes-like-get',()=>{const a=new Cache({maxSize:2}),b=new Cache({maxSize:2});for(const c of [a,b])c.set('a',1).set('b',2);a.get('a');b.getOrCreate('a',()=>99);for(const c of [a,b])c.set('c',3).set('d',4);assert.deepEqual([...a.entriesAscending()],[...b.entriesAscending()]);});
 } else {
  const {default: parse} = await import(pathToFileURL(resolve(workspace,'project/src/index.js')));
  check('existing-basic',()=>{assert.deepEqual(parse(['-x','1234','-y','5.67','-z','1e7','-w','10f','--hex','0xdeadbeef','789']),{_:['789'],x:1234,y:5.67,z:1e7,w:'10f',hex:0xdeadbeef});});
  check('existing-alias-default-repeat',()=>{assert.deepEqual(parse(['-n','Ada','-n','Bea'],{alias:{n:'name'},default:{count:3}}),{_:[],n:['Ada','Bea'],name:['Ada','Bea'],count:3});});
  check('existing-negation-terminator',()=>{assert.deepEqual(parse(['--no-cache','--','-2','--x']),{_:['-2','--x'],cache:false});});
  check('options-frozen',()=>{const o=deepFreeze({alias:{n:['number']},boolean:['v'],string:['name'],default:{n:3}});assert.deepEqual(parse(['-n','7','--name','Ada'],o),{_:[],n:7,number:7,name:'Ada'});});
  check('options-repeat-no-mutation',()=>{const o={alias:{n:['number','N']},boolean:['v'],string:['name'],default:{n:3}};const before=JSON.stringify(o);const a=['-n','8','--name','Ada'];const first=parse(a,o);for(let i=0;i<4;i++)assert.deepEqual(parse(a,o),first);assert.equal(JSON.stringify(o),before);assert.deepEqual(a,['-n','8','--name','Ada']);});
  check('default-object-identity',()=>{const value=Object.freeze({config:1});const o=Object.freeze({default:Object.freeze({data:value})});assert.equal(parse([],o).data,value);});
  check('negative-values',()=>{for(const token of ['-2','-2.5','-.5','-2e-3','-4E+2','-0']){const result=parse(['--amount',token]);assert.equal(result.amount,Number(token));if(token==='-0')assert(Object.is(result.amount,-0));assert.deepEqual(result._,[]);}});
  check('negative-positionals',()=>{for(const token of ['-2','-2.5','-.5','-2e-3','-0'])assert.deepEqual(parse([token,'tail'])._,[token,'tail']);});
  check('negative-string-alias',()=>{assert.deepEqual(parse(['-n','-2e-3'],{alias:{n:'number'},string:['number']}),{_:[],n:'-2e-3',number:'-2e-3'});});
  check('boolean-does-not-consume-negative',()=>{assert.deepEqual(parse(['-v','-2'],{alias:{v:'verbose'},boolean:['verbose']}),{_:['-2'],v:true,verbose:true});});
  check('short-cluster-negative',()=>{assert.deepEqual(parse(['-abn','-2'],{boolean:['a','b']}),{_:[],a:true,b:true,n:-2});});
  check('negative-equals-next-flag',()=>{assert.deepEqual(parse(['--x=-2','--next']),{_:[],x:-2,next:true});});
  check('unknown-callback-retained',()=>{const calls=[];const fn=flag=>(calls.push(flag),'blocked');const o=Object.freeze({alias:Object.freeze({x:Object.freeze(['value'])}),unknown:fn});assert.equal(parse(['--bad'],o),'blocked');assert.deepEqual(calls,['--bad']);assert.equal(o.unknown,fn);});
  check('non-numbers-remain-flags',()=>{for(const token of ['-abc','-Infinity','-NaN','-0xFF']){const out=parse(['--amount',token]);assert.equal(out.amount,true);assert(!out._.includes(token));}});
 }
} catch(error) { checks.push({id:'module-load',passed:false,detail:String(error.stack??error)}); }
await writeFile(output,JSON.stringify({checks},null,2));
