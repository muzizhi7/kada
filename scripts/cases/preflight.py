# -*- coding: utf-8 -*-
"""Positive controls plus explicit defect mutations. Free, deterministic; never calls a model."""
import sys,json,subprocess,tempfile,hashlib,csv,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from fixtures import prepare,CASES
from checks import grade
HERE=Path(__file__).resolve().parent

def tree(root):
 if root.is_file():return [(root.name,hashlib.sha256(root.read_bytes()).hexdigest())]
 return [(str(p.relative_to(root)),hashlib.sha256(p.read_bytes()).hexdigest())for p in sorted(root.rglob('*'))if p.is_file()]
def replace_zip(path,member,fn):
 with zipfile.ZipFile(path)as z:entries={n:z.read(n)for n in z.namelist()}
 entries[member]=fn(entries[member])
 with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED)as z:
  for n,b in entries.items():z.writestr(n,b)
def run(case,path):
 spec=prepare(case,path);before=tree(path/'inputs');protected=[(name,tree(path/name))for name in spec['inputs']]
 command=['node',str(HERE/'code-reference.mjs'),case,str(path)]if case.startswith('code_')else[sys.executable,str(HERE/'office-reference.py'),case,str(path)]
 subprocess.run(command,check=True)
 subprocess.run([sys.executable,'acceptance/check.py'],cwd=path,check=True,capture_output=True,timeout=20)
 positive=grade(case,path);assert positive['passed'],positive
 d=path/'deliverables';mutations=[]
 def mutation(label,files,modify):
  old={p:p.read_bytes()for p in files};modify();bad=grade(case,path);assert not bad['passed'],f'Mutation accepted: {case}: {label}';mutations.append({'name':label,'rejected':True})
  for p,b in old.items():p.write_bytes(b)
 if case=='office_reconcile':
  p=d/'reconcile.csv'
  def bad_value():
   with p.open(newline='')as f:r=list(csv.DictReader(f));fields=list(r[0]);r[0]['paid_cents']='999999'
   with p.open('w',newline='')as f:w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(r)
  mutation('wrong paid amount',[p],bad_value);script=d/'reconcile.py';mutation('non-reusable no-op script',[script],lambda:script.write_text('pass\n'))
 elif case=='office_minutes':
  p=d/'actions.csv';mutation('cancelled action reopened',[p],lambda:p.write_text(p.read_text().replace('cancelled','open')))
  p=d/'brief.docx';mutation('cancelled action in current table',[p],lambda:replace_zip(p,'word/document.xml',lambda b:b.replace(b'>A2<',b'>A4<')))
 elif case=='office_crm':
  p=d/'clean.xlsx'
  def change_cell(address,value):
   def rewrite(b):
    root=ET.fromstring(b);c=root.find('.//{*}c[@r="'+address+'"]');assert c is not None
    for child in list(c):c.remove(child)
    c.set('t','n');ET.SubElement(c,'{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v').text=str(value);return ET.tostring(root)
   replace_zip(p,'xl/worksheets/sheet1.xml',rewrite)
  mutation('zero lost/replaced',[p],lambda:change_cell('E3',999));mutation('leading-zero ID coerced to number',[p],lambda:change_cell('A2',1))
 elif case=='office_handover':
  p=d/'package/bundle.zip'
  def leak():
   with zipfile.ZipFile(p,'a')as z:z.writestr('private.txt','CASE_PRIVATE_NEVER_COPY')
  mutation('private material in ZIP',[p],leak);p=d/'package.py';mutation('non-incremental no-op builder',[p],lambda:p.write_text('pass\n'))
 else:
  p=path/('project/src/importer.py'if case=='code_import'else'project/src/index.mjs')
  substitutions={'code_inventory':[('raw bytes treated as text',"bytes:bytes.length","bytes:bytes.toString('utf8').length"),('zero-byte file dropped','s.isFile()','s.isFile()&&s.size>0')],
   'code_pool':[('unbounded launch','active<concurrency','active<items.length'),('pre-aborted empty input resolves',"if(signal?.aborted)throw abort();",'')],
   'code_import':[('falsey payload erased',"json.dumps(x['payload'],ensure_ascii=False)","json.dumps(x['payload'] or {},ensure_ascii=False)"),('equal revision overwrites',"old[0]>=x['revision']","old[0]>x['revision']")],
   'code_cache':[('cached body alias',"return structuredClone(previous.body)","return previous.body"),('authenticated response cached',"auth=Object.keys(h).includes('authorization')","auth=false")]}
  for label,old,new in substitutions[case]:
   assert old in p.read_text(),label;mutation(label,[p],lambda old=old,new=new:p.write_text(p.read_text().replace(old,new)))
 if case=='code_pool':
  p=path/'project/src/index.mjs';original=p.read_text();cleanup="const cleanup=()=>signal?.removeEventListener('abort',onAbort);";assert cleanup in original
  mutation('actual listener leak on successful completion',[p],lambda:p.write_text(original.replace(cleanup,'const cleanup=()=>{};')))
  mutation('early failure with active workers',[p],lambda:p.write_text(original.replace('if(!active){cleanup();reject(reason);}','if(active<=1){cleanup();reject(reason);}')))
  mutation('falsey failure reason forgotten',[p],lambda:p.write_text(original.replace('failed=true;reason=e;','failed=Boolean(e);reason=e;')))
  # Removing a listener twice is harmless: reject leaked listeners, not implementation choices.
  p.write_text(original.replace(cleanup,"const cleanup=()=>{signal?.removeEventListener('abort',onAbort);signal?.removeEventListener('abort',onAbort);};"))
  assert grade(case,path)['passed'],'Idempotent listener cleanup incorrectly rejected'
  p.write_text(original)
 equal=tree(path/'inputs')==before;assert equal,'Preflight changed original inputs'
 current=[(name,tree(path/name))for name in spec['inputs']];assert current==protected
 assert grade(case,path)['passed'],'Mutation restoration failed'
 result={'case':case,'referenceAccepted':True,'visibleAccepted':True,'mutations':mutations,'originalInputsUnchanged':True}
 if case=='code_pool':result['idempotentCleanupAccepted']=True
 return result
if __name__=='__main__':
 requested=sys.argv[1:]or CASES
 with tempfile.TemporaryDirectory(prefix='pi-case-preflight-')as d:
  result=[run(case,Path(d)/case)for case in requested]
 print(json.dumps(result,ensure_ascii=False))
