# -*- coding: utf-8 -*-
"""Reference scripts are evaluation assets, never copied into model workspaces."""
import sys,csv,json,shutil,subprocess
from pathlib import Path
CASE,ROOT=sys.argv[1:3];root=Path(ROOT);d=root/'deliverables'
RECONCILE='''# -*- coding: utf-8 -*-
import csv,sys,json
from pathlib import Path
from collections import defaultdict
src,out=map(Path,sys.argv[1:3]);out.mkdir(parents=True,exist_ok=True)
def read(name):
 with (src/(name+'.csv')).open(encoding='utf-8-sig',newline='')as f:return list(csv.DictReader(f))
def write(name,fields,rows):
 with (out/name).open('w',encoding='utf-8',newline='')as f:
  w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
orders={x['order_id']:x for x in read('orders')};active={k:v for k,v in orders.items()if v['status']=='active'};sums={'receipts':defaultdict(int),'payments':defaultdict(int)};errors=[]
for kind,key in [('receipts','receipt_id'),('payments','payment_id')]:
 latest={}
 for x in read(kind):
  if x[key]not in latest or int(x['revision'])>int(latest[x[key]]['revision']):latest[x[key]]=x
 for x in latest.values():
  if x['status']=='void':continue
  oid=x['order_id']
  if oid not in active:errors.append({'source':kind,'id':x[key],'reason':'unknown-order'if oid not in orders else'cancelled-order'})
  else:sums[kind][oid]+=int(x['amount_cents'])
rows=[];totals={}
for oid,o in sorted(active.items()):
 ordered=int(o['ordered_cents']);received=sums['receipts'][oid];paid=sums['payments'][oid]
 rows.append(dict(order_id=oid,currency=o['currency'],ordered_cents=ordered,received_cents=received,paid_cents=paid,balance_cents=ordered-paid,payment_status='settled'if paid==ordered else'under'if paid<ordered else'over',receipt_status='complete'if received==ordered else'unreceived'if received==0 else'partial'if received<ordered else'over'))
 t=totals.setdefault(o['currency'],dict(currency=o['currency'],ordered_cents=0,paid_cents=0,balance_cents=0))
 for k,v in [('ordered_cents',ordered),('paid_cents',paid),('balance_cents',ordered-paid)]:t[k]+=v
write('reconcile.csv',['order_id','currency','ordered_cents','received_cents','paid_cents','balance_cents','payment_status','receipt_status'],rows)
write('currency_totals.csv',['currency','ordered_cents','paid_cents','balance_cents'],[totals[k]for k in sorted(totals)])
write('exceptions.csv',['source','id','reason'],sorted(errors,key=lambda x:(x['source'],x['id'])))
(out/'summary.md').write_text('采购对账完成。来源orders.csv、receipts.csv和payments.csv，最新版本去重，取消及无订单流水独立列示；币种分别合计，不进行汇率换算。'+json.dumps(totals,ensure_ascii=False),encoding='utf-8')
'''
PACKAGE='''# -*- coding: utf-8 -*-
import csv,sys,hashlib,zipfile
from pathlib import Path
src,out=map(Path,sys.argv[1:3]);out.mkdir(parents=True,exist_ok=True)
rows=[];groups={};directories=[]
for p in sorted(src.rglob('*')):
 rel=p.relative_to(src).as_posix();included=rel.startswith('public/')and not rel.startswith('public/draft/')
 if p.is_dir():
  if included and not any(p.iterdir()):directories.append('empty/'+rel+'/')
  continue
 if not p.is_file():continue
 row=dict(source_path=rel,archive_path='',sha256='',size='',disposition='excluded')
 if included:
  content=p.read_bytes();h=hashlib.sha256(content).hexdigest();category='documents'if p.suffix in['.md','.txt']else'tables'if p.suffix=='.csv'else'assets';g=groups.setdefault((category,h),{'representative':p,'content':content});dest=category+'/'+g['representative'].stem+'--'+h[:8]+g['representative'].suffix
  row.update(archive_path=dest,sha256=h,size=len(content),disposition='included')
 rows.append(row)
with (out/'manifest.csv').open('w',encoding='utf-8',newline='')as f:
 w=csv.DictWriter(f,fieldnames=['source_path','archive_path','sha256','size','disposition']);w.writeheader();w.writerows(rows)
entries={r['archive_path']:(src/r['source_path']).read_bytes()for r in rows if r['disposition']=='included'};entries.update({p:b''for p in directories})
with zipfile.ZipFile(out/'bundle.zip','w',compression=zipfile.ZIP_DEFLATED)as z:
 for name,data in sorted(entries.items()):
  info=zipfile.ZipInfo(name,(2020,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(0o40755 if name.endswith('/')else 0o100644)<<16;z.writestr(info,data)
(out/'summary.md').write_text('客户资料交接包。源文件保留，私有及草稿文件排除，空文件/目录保留，按类别和内容哈希去重；映射涵盖全部输入文件。',encoding='utf-8')
'''
if CASE=='office_reconcile':
 (d/'reconcile.py').write_text(RECONCILE);subprocess.run([sys.executable,str(d/'reconcile.py'),str(root/'inputs'),str(d)],check=True)
elif CASE=='office_handover':
 (d/'package.py').write_text(PACKAGE);subprocess.run([sys.executable,str(d/'package.py'),str(root/'inputs'),str(d/'package')],check=True)
elif CASE=='office_minutes':
 shutil.copy(Path(__file__).parent/'golden/brief.docx',d/'brief.docx')
 rows=[['A1','完成接口清单','林华','2026-10-28','done','notes/2026-10-26.md;updates.csv'],['A2','完成测试计划','张敏','2026-11-04','open','notes/2026-10-26.md;updates.csv'],['A3','完成法务确认','','','open','notes/2026-10-26.md'],['A4','发送旧版报价','周宁','2026-10-30','cancelled','notes/2026-10-26.md;updates.csv'],['A5','完成演示','林华','2026-11-03','open','notes/2026-10-26.md;updates.csv'],['A6','完成数据导入','周宁','2026-11-02','blocked','notes/2026-10-26.md;updates.csv']]
 with (d/'actions.csv').open('w',encoding='utf-8',newline='')as f:w=csv.writer(f);w.writerow(['id','action','owner','due','status','source_files']);w.writerows(rows)
elif CASE=='office_crm':
 shutil.copy(Path(__file__).parent/'golden/clean.xlsx',d/'clean.xlsx')
 from checks import crm_expected
 expected,mapping,rejected=crm_expected(root)
 for name,fields,rows in [('merge_map.csv',['id','customer_id'],mapping),('rejected.csv',['id','reason'],rejected)]:
  with (d/name).open('w',encoding='utf-8',newline='')as f:w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
 (d/'quality.md').write_text('CRM清洗结果来源contacts.csv。按非空邮箱或电话传递合并，保留ID与电话前导零；收入真实零保留、缺失留空，拒绝错误邮箱/电话行。',encoding='utf-8')
else:raise ValueError(CASE)
