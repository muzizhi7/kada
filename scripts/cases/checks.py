# -*- coding: utf-8 -*-
"""Independent semantic oracles/probes. Not delivered inside Agent workspaces."""
import csv,json,sys,re,hashlib,subprocess,tempfile,shutil,zipfile,sqlite3,importlib.util
from pathlib import Path
from collections import defaultdict
HERE=Path(__file__).resolve().parent

def rows(path):
 with Path(path).open(encoding='utf-8-sig',newline='')as f:return list(csv.DictReader(f))
def equal(a,b):
 assert a==b,f'Expected {str(b)[:350]}, got {str(a)[:350]}'
def keyed(values,key):
 assert len({x[key]for x in values})==len(values),'Duplicate output keys'
 return {x[key]:x for x in values}
def reconciliation(src):
 orders=keyed(rows(src/'orders.csv'),'order_id');active={k:x for k,x in orders.items()if x['status']=='active'}
 received=defaultdict(int);paid=defaultdict(int);errors=[]
 for kind,name,dest in [('receipts','receipt_id',received),('payments','payment_id',paid)]:
  grouped=defaultdict(list)
  for x in rows(src/(kind+'.csv')):grouped[x[name]].append(x)
  for group in grouped.values():
   x=sorted(group,key=lambda r:int(r['revision']))[-1]
   if x['status']=='void':continue
   if x['order_id']not in active:errors.append(dict(source=kind,id=x[name],reason='unknown-order'if x['order_id']not in orders else'cancelled-order'))
   else:dest[x['order_id']]+=int(x['amount_cents'])
 results=[];totals=defaultdict(lambda:[0,0,0])
 for oid,x in sorted(active.items()):
  order=int(x['ordered_cents']);r=received[oid];p=paid[oid]
  results.append(dict(order_id=oid,currency=x['currency'],ordered_cents=str(order),received_cents=str(r),paid_cents=str(p),balance_cents=str(order-p),payment_status='settled'if p==order else'under'if p<order else'over',receipt_status='complete'if r==order else'unreceived'if r==0 else'partial'if r<order else'over'))
  for i,n in enumerate([order,p,order-p]):totals[x['currency']][i]+=n
 return results,[dict(zip(['currency','ordered_cents','paid_cents','balance_cents'],[k,*map(str,v)]))for k,v in sorted(totals.items())],sorted(errors,key=lambda x:(x['source'],x['id']))

def crm_expected(root):
 valid=[];rejected=[]
 for raw in rows(root/'inputs/contacts.csv'):
  r=dict(raw);r['email']=r['email'].strip().lower();r['phone']=re.sub(r'[ +()\-]','',r['phone'])
  reason='email'if r['email']and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+',r['email'])else'phone'if r['phone']and not re.fullmatch(r'\d{5,}',r['phone'])else None
  if reason:rejected.append(dict(id=r['id'],reason=reason))
  else:valid.append(r)
 groups=[]
 # Deliberately use component expansion, not the union-find implementation a model may choose.
 remaining=set(range(len(valid)))
 while remaining:
  component={min(remaining)}
  while True:
   expanded=component|{i for i in remaining for j in component if any(valid[i][k]and valid[i][k]==valid[j][k]for k in ['email','phone'])}
   if expanded==component:break
   component=expanded
  remaining-=component;groups.append([valid[i]for i in component])
 out=[];mapping=[]
 for group in groups:
  group.sort(key=lambda x:(x['updated_at'],x['id']));ids=sorted(x['id']for x in group);record={'customer_id':ids[0]}
  for key in ['name','email','phone','revenue_cents']:
   values=[x[key]for x in group if x[key]!=''];record[key]=values[-1]if values else None
  if record['revenue_cents']is not None:record['revenue_cents']=int(record['revenue_cents'])
  flags={x['consent']for x in group};record['consent']=False if'no'in flags else True if'yes'in flags else None
  record['source_ids']=';'.join(ids);out.append(record);mapping.extend(dict(id=i,customer_id=ids[0])for i in ids)
 return sorted(out,key=lambda x:x['customer_id']),sorted(mapping,key=lambda x:x['id']),sorted(rejected,key=lambda x:x['id'])

def import_checks(root):
 spec=importlib.util.spec_from_file_location('subject_importer',root/'project/src/importer.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 c=sqlite3.connect(':memory:')
 payloads=[None,0,False,'',[],{'nested':{'zero':0}}];lines=[json.dumps(dict(id=f'{i:03d}',revision=2,payload=p))for i,p in enumerate(payloads)]
 first=m.import_records(c,lines);equal(first,dict(inserted=6,updated=0,stale=0,invalid=0));equal([x['payload']for x in m.list_records(c)],payloads)
 equal(m.import_records(c,lines),dict(inserted=0,updated=0,stale=6,invalid=0))
 bad=['not-json',json.dumps({'id':'x','revision':True,'payload':0}),json.dumps({'id':'x','revision':-1,'payload':0}),json.dumps({'id':'','revision':0,'payload':0}),json.dumps({'id':'x','revision':1})]
 equal(m.import_records(c,bad),dict(inserted=0,updated=0,stale=0,invalid=5))
 before=m.list_records(c)
 try:m.import_records(c,[json.dumps({'id':'000','revision':9,'payload':'changed'}),'{bad'],strict=True)
 except ValueError:pass
 else:raise AssertionError('strict invalid input did not raise ValueError')
 equal(m.list_records(c),before)
 attack="q' OR 1=1 --";equal(m.import_records(c,[json.dumps({'id':attack,'revision':0,'payload':None})]),dict(inserted=1,updated=0,stale=0,invalid=0));equal(len(m.list_records(c)),7)
 equal(m.import_records(c,[json.dumps({'id':'000','revision':3,'payload':False})]),dict(inserted=0,updated=1,stale=0,invalid=0));equal(m.list_records(c)[0]['payload'],False);c.close()

def grade(case,root):
 root=Path(root);d=root/'deliverables';checks=[]
 def check(name,fn):
  try:fn();checks.append(dict(name=name,passed=True))
  except Exception as e:checks.append(dict(name=name,passed=False,detail=str(e)[:1500]))
 if case=='office_reconcile':
  expected,totals,errors=reconciliation(root/'inputs')
  check('current order values/statuses and stable IDs',lambda:equal(rows(d/'reconcile.csv'),expected))
  check('currency scope and separate amounts',lambda:equal(rows(d/'currency_totals.csv'),totals))
  check('orphan/cancelled exceptions',lambda:equal(rows(d/'exceptions.csv'),errors))
  def replay():
   with tempfile.TemporaryDirectory(prefix='reconcile-probe-')as t:
    p=Path(t);shutil.copytree(root/'inputs',p/'new inputs');src=p/'new inputs';orders=rows(src/'orders.csv');orders=[x for x in orders if x['order_id']!='0001'];orders.append(dict(order_id='0000',currency='JPY',ordered_cents='0',status='active'))
    with (src/'orders.csv').open('w',newline='')as f:w=csv.DictWriter(f,fieldnames=list(orders[0]));w.writeheader();w.writerows(orders)
    out=p/'new output';subprocess.run([sys.executable,str(d/'reconcile.py'),str(src),str(out)],check=True,capture_output=True,timeout=15)
    e,t,e2=reconciliation(src);equal(rows(out/'reconcile.csv'),e);equal(rows(out/'currency_totals.csv'),t);equal(rows(out/'exceptions.csv'),e2)
  check('parameterized rerun with deleted order/new zero currency',replay)
 elif case=='office_minutes':
  expected={'A1':('林华','2026-10-28','done','接口清单'),'A2':('张敏','2026-11-04','open','测试计划'),'A3':('','','open','法务确认'),'A4':('周宁','2026-10-30','cancelled','旧版报价'),'A5':('林华','2026-11-03','open','演示'),'A6':('周宁','2026-11-02','blocked','数据导入')}
  def csv_check():
   current=keyed(rows(d/'actions.csv'),'id');equal(set(current),set(expected))
   for key,(owner,due,status,topic)in expected.items():
    x=current[key];equal((x['owner'],x['due'],x['status']),(owner,due,status));assert topic in x['action'];assert 'notes/2026-10-26.md'in x['source_files']
    if key!='A3':assert 'updates.csv'in x['source_files']
  check('latest updates, missing values and provenance',csv_check)
  def doc_check():
   from docx import Document
   doc=Document(d/'brief.docx');text='\n'.join([p.text for p in doc.paragraphs]+[c.text for t in doc.tables for r in t.rows for c in r.cells]);assert'项目周会跟进'in text;assert'2026-11-02'in text;assert'20000'in text.replace(',','');assert'客户'in text and any(s in text for s in ['待客户确认','尚未确认','未确认','待确认']);assert'A1'in text and'A4'in text
   tables=[t for t in doc.tables if len(t.columns)==5];assert tables,'Missing five-column action table';t=tables[0];current={r.cells[0].text.strip():[c.text for c in r.cells]for r in t.rows[1:]};equal(set(current),{'A2','A3','A5','A6'})
   for key in current:
    cells=current[key];owner,due,status,topic=expected[key];assert topic in cells[1];assert(owner or'待明确')in cells[2];assert(due or'待明确')in cells[3];assert status in cells[4]or({'open':'进行中','blocked':'阻塞'}[status])in cells[4]
   assert 'notes/2026-10-26.md'in text and'updates.csv'in text
  check('DOCX open actions and decision uncertainty',doc_check)
 elif case=='office_crm':
  expected,mapping,rejected=crm_expected(root)
  def workbook():
   from openpyxl import load_workbook
   w=load_workbook(d/'clean.xlsx',data_only=True);equal(w.sheetnames,['CRM']);s=w['CRM'];fields=['customer_id','name','email','phone','revenue_cents','consent','source_ids'];equal([c.value for c in s[1]],fields)
   actual=[]
   for row in s.iter_rows(min_row=2):
    if all(c.value is None for c in row):continue
    record=dict(zip(fields,[c.value for c in row]));actual.append(record)
    assert type(record['customer_id'])is str
    if record['phone']is not None:assert type(record['phone'])is str
    if record['revenue_cents']is not None:assert type(record['revenue_cents'])in[int,float]
    if record['consent']is not None:assert type(record['consent'])is bool
   equal(actual,expected)
  check('XLSX transitive groups, typed IDs/zero/false/null',workbook)
  check('complete provenance mapping',lambda:equal(rows(d/'merge_map.csv'),mapping));check('invalid rows separated',lambda:equal(rows(d/'rejected.csv'),rejected))
 elif case=='office_handover':
  def contents(src,out):
   manifest=rows(out/'manifest.csv');files=sorted(p for p in src.rglob('*')if p.is_file());equal([x['source_path']for x in manifest],[p.relative_to(src).as_posix()for p in files]);groups=defaultdict(list)
   for p in files:
    rel=p.relative_to(src).as_posix()
    if rel.startswith('public/')and not rel.startswith('public/draft/'):
     category='documents'if p.suffix in['.md','.txt']else'tables'if p.suffix=='.csv'else'assets';groups[(category,hashlib.sha256(p.read_bytes()).hexdigest())].append(p)
   expected={}
   for(category,h),group in groups.items():
    representative=min(group);name=category+'/'+representative.stem+'--'+h[:8]+representative.suffix;expected[name]=representative.read_bytes()
    for p in group:
     r=next(x for x in manifest if x['source_path']==p.relative_to(src).as_posix());equal(r,dict(source_path=p.relative_to(src).as_posix(),archive_path=name,sha256=h,size=str(p.stat().st_size),disposition='included'))
   for r in manifest:
    if not(r['source_path'].startswith('public/')and not r['source_path'].startswith('public/draft/')):equal((r['disposition'],r['archive_path'],r['sha256'],r['size']),('excluded','','',''))
   expected.update({'empty/'+p.relative_to(src).as_posix()+'/':b''for p in src.rglob('*')if p.is_dir()and not any(p.iterdir())and p.relative_to(src).as_posix().startswith('public/')and not p.relative_to(src).as_posix().startswith('public/draft/')})
   with zipfile.ZipFile(out/'bundle.zip')as z:
    equal(z.namelist(),sorted(expected));assert len(z.namelist())==len(set(z.namelist()))
    for info in z.infolist():equal(info.date_time,(2020,1,1,0,0,0));equal(z.read(info.filename),expected[info.filename]);assert '..'not in info.filename.split('/')and not info.filename.startswith('/')
  check('archive bytes, dedup, exclusions and full manifest',lambda:contents(root/'inputs',d/'package'))
  def replay():
   with tempfile.TemporaryDirectory(prefix='handover-probe-')as t:
    p=Path(t);shutil.copytree(root/'inputs',p/'new inputs');src=p/'new inputs';out=p/'output';script=d/'package.py'
    def run():subprocess.run([sys.executable,str(script),str(src),str(out)],check=True,capture_output=True,timeout=15)
    run();first=(out/'bundle.zip').read_bytes();run();equal((out/'bundle.zip').read_bytes(),first);(src/'public/team 0/item 0.md').unlink();(src/'public/new zero.txt').write_text('');run();contents(src,out)
  check('repeatable ZIP and incremental new/deleted sources',replay)
 elif case=='code_import':check('strict transactions, revisions, null/zero/false and SQL IDs',lambda:import_checks(root))
 else:
  def node_checks():
   p=subprocess.run(['node',str(HERE/'code-checks.mjs'),case,str(root)],capture_output=True,text=True,timeout=15)
   assert p.returncode==0,(p.stdout+p.stderr)[-2400:]
  check('independent async/path/cache probes',node_checks)
 return dict(passed=all(x['passed']for x in checks),checks=checks)
if __name__=='__main__':
 result=grade(sys.argv[1],Path(sys.argv[2]));print(json.dumps(result,ensure_ascii=False));sys.exit(0 if result['passed']else 1)
