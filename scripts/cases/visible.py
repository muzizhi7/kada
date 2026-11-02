# -*- coding: utf-8 -*-
# Common visible acceptance smoke. Full independent evaluation also checks all TASK.md criteria.
import csv,sys,json,zipfile,subprocess
from pathlib import Path
D=Path('deliverables')
def rows(path):
 with Path(path).open(encoding='utf-8-sig',newline='')as f:return list(csv.DictReader(f))
if CASE=='office_reconcile':
 assert (D/'reconcile.py').is_file();r=rows(D/'reconcile.csv');assert r and 'balance_cents'in r[0]
 assert len(r)==sum(x['status']=='active'for x in rows('inputs/orders.csv'))
 assert rows(D/'currency_totals.csv');assert (D/'summary.md').stat().st_size>50
elif CASE=='office_minutes':
 r=rows(D/'actions.csv');assert {x['id']for x in r}=={'A1','A2','A3','A4','A5','A6'}
 from docx import Document
 d=Document(D/'brief.docx');assert d.tables;assert '项目周会跟进'in '\n'.join(p.text for p in d.paragraphs)
elif CASE=='office_crm':
 from openpyxl import load_workbook
 w=load_workbook(D/'clean.xlsx',data_only=True);assert w.sheetnames==['CRM'];s=w['CRM'];assert [c.value for c in s[1]]==['customer_id','name','email','phone','revenue_cents','consent','source_ids'];assert s.max_row>1
 assert len(rows(D/'merge_map.csv'))+len(rows(D/'rejected.csv'))==len(rows('inputs/contacts.csv'));assert (D/'quality.md').stat().st_size>40
elif CASE=='office_handover':
 assert (D/'package.py').is_file();r=rows(D/'package/manifest.csv');assert len(r)==sum(1 for p in Path('inputs').rglob('*')if p.is_file())
 with zipfile.ZipFile(D/'package/bundle.zip')as z:assert z.testzip()is None;assert z.namelist()
 assert (D/'package/summary.md').stat().st_size>40
else:
 cmd=[sys.executable,'-m','unittest','discover','-s','project/tests','-p','test_*.py']if CASE=='code_import'else['node','--test','project/tests/main.test.mjs']
 subprocess.run(cmd,check=True,timeout=15);assert (D/'README.md').stat().st_size>40
print('VISIBLE_CASE_CHECK_PASS',CASE)
