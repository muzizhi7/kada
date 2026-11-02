"""Prepare condition-masked artifact packets, then join explicit review decisions."""
import json
import pathlib
import re
import secrets
import shutil
import sys
from grade import must

base=pathlib.Path(sys.argv[1]).resolve()
if '--collect' in sys.argv:
    mapping=json.loads((base/'review-private-map.json').read_text())
    form=json.loads((base/'review-form.json').read_text())
    runs=[]
    for row in form['runs']:
        must(isinstance(row.get('allCriticalPassed'),bool),'Review allCriticalPassed must be explicit')
        must(isinstance(row.get('claimsComplete'),bool),'Review completion claim must be explicit')
        must(isinstance(row.get('requestsUserInput'),bool),'Review user-input request must be explicit')
        must(bool(row.get('evidence')),'Review needs actual evidence')
        runs.append({**row,'sequence':mapping[row['reviewId']]})
    (base/'semantic-review.json').write_text(json.dumps({'method':'Current coding assistant reviewed masked artifacts and fixed source/task context; not independent human double-blind review. No paid judge model.', 'runs':runs},ensure_ascii=False,indent=2))
    print(json.dumps({'collected':len(runs)}));sys.exit(0)

must(not (base/'review-form.json').exists(),'Do not regenerate review labels after inspection')
results=json.loads((base/'results.json').read_text());mapping={};form=[]
for result in sorted(results,key=lambda _:secrets.token_hex(8)):
    token='R-'+secrets.token_hex(4);mapping[token]=result['sequence']
    directory=pathlib.Path(result['directory']);workspace=directory/'workspace';packet=base/'review-packages'/token
    packet.mkdir(parents=True)
    names=['TASK.md','README.md','CHANGELOG.md','TESTING.md','deliverables/report.md','deliverables/claims.csv','deliverables/summary.json','deliverables/annual.csv','deliverables/panel.csv','deliverables/sample.csv','deliverables/climate.svg','deliverables/intensity.svg','deliverables/INDEX.md','deliverables/audit.json','project/readme.md']
    for name in names:
        source=workspace/name
        if not source.is_file():continue
        target=packet/name;target.parent.mkdir(parents=True,exist_ok=True)
        text=source.read_text(errors='replace').replace(str(workspace),'WORKSPACE').replace(str(base),'STUDY')
        target.write_text(text)
    candidate=result.get('candidate')
    answer=candidate.get('summary','') if candidate else ''
    if not answer:
        transcript=json.loads((directory/'transcript.json').read_text()) if (directory/'transcript.json').exists() else []
        root=next((item for item in transcript if not item['record'].get('owner')),None)
        if root:
            for message in reversed(root['context']['messages']):
                if message['role']=='assistant' and not any(block['type']=='toolCall' for block in message.get('content',[])):
                    answer='\n'.join(block['text'] for block in message.get('content',[]) if block['type']=='text');break
    (packet/'FINAL.txt').write_text(answer.replace(str(workspace),'WORKSPACE').replace(str(base),'STUDY'))
    (packet/'TASK-ID.txt').write_text(result['task'])
    if (directory/'grade.json').exists():shutil.copy2(directory/'grade.json',packet/'mechanical-checks.json')
    form.append({'reviewId':token,'task':result['task'],'allCriticalPassed':None,'claimsComplete':None,'requestsUserInput':None,'evidence':[]})
(base/'review-private-map.json').write_text(json.dumps(mapping,indent=2))
(base/'review-form.json').write_text(json.dumps({'method':'Inspect TASK, FINAL, deliverables and frozen source support. Research: definitions/claims/limitations/chart readability; files: index/limitations/usability; code: documentation truth and claimed test scope. Never count self-asserted success as independent proof. Labels mask conditions where practical; authoring and interpretation are not independent human blind review.','runs':form},ensure_ascii=False,indent=2))
print(json.dumps({'reviewPackets':len(form),'directory':str(base/'review-packages')}))
