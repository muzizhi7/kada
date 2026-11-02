"""Free checker calibration on reviewed reference and negative outputs, never a model run."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

workspace = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("checks", workspace / "acceptance/check.py")
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

# A known-correct reference used only to calibrate the demonstration checker.
# Not staged in the model workspace. This is an example, not an unseen benchmark.
REFERENCE = '''import argparse,csv,hashlib,json,os,shutil,unicodedata,zipfile
from pathlib import Path
def build(inputs,out):
 inputs,out=Path(inputs).resolve(),Path(out).resolve()
 if inputs==out or inputs in out.parents or out in inputs.parents or out==Path(out.anchor): raise ValueError('overlap')
 if out.exists(): shutil.rmtree(out)
 (out/'normalized').mkdir(parents=True)
 rows=[]; skipped=[]
 for parent,dirs,files in os.walk(inputs,followlinks=False):
  for name in list(dirs):
   p=Path(parent)/name
   if p.is_symlink(): skipped.append(p.relative_to(inputs).as_posix());dirs.remove(name)
   else: (out/'normalized'/p.relative_to(inputs)).mkdir(parents=True,exist_ok=True)
  for name in files:
   p=Path(parent)/name; source=p.relative_to(inputs).as_posix()
   if p.is_symlink(): skipped.append(source);continue
   raw=p.read_bytes()
   try:
    raw.decode('utf-8');assert b'\\0' not in raw
    value=(raw[3:] if raw.startswith(b'\\xef\\xbb\\xbf') else raw).replace(b'\\r\\n',b'\\n').replace(b'\\r',b'\\n');kind='text'
   except (UnicodeError,AssertionError): value=raw;kind='binary'
   target='normalized/'+source;(out/target).parent.mkdir(parents=True,exist_ok=True);(out/target).write_bytes(value)
   rows.append(dict(source=source,target=target,kind=kind,source_sha256=hashlib.sha256(raw).hexdigest(),target_sha256=hashlib.sha256(value).hexdigest(),source_bytes=len(raw),target_bytes=len(value),changed=str(raw!=value).lower()))
 rows.sort(key=lambda r:unicodedata.normalize('NFC',r['source']))
 with (out/'manifest.csv').open('w',encoding='utf-8',newline='') as f:
  w=csv.DictWriter(f,['source','target','kind','source_sha256','target_sha256','source_bytes','target_bytes','changed']);w.writeheader();w.writerows(rows)
 audit=dict(source_files=len(rows),text_files=sum(r['kind']=='text' for r in rows),binary_files=sum(r['kind']=='binary' for r in rows),changed_files=sum(r['changed']=='true' for r in rows),source_bytes=sum(r['source_bytes'] for r in rows),target_bytes=sum(r['target_bytes'] for r in rows),skipped_symlinks=sorted(skipped))
 (out/'audit.json').write_text(json.dumps(audit,sort_keys=True)+'\\n')
 (out/'INDEX.md').write_text('# Normalized handover\\nNot a byte-exact backup; cannot restore original BOM/newlines. Originals: incoming/. License: normalized/LICENSE.txt. Source semantics not checked.\\n[manifest.csv](manifest.csv) [audit.json](audit.json) [release.zip](release.zip)\\n'+'\\n'.join(str(k)+': '+str(v) for k,v in audit.items())+'\\n')
 with zipfile.ZipFile(out/'release.zip','w') as z:
  for p in sorted(out.rglob('*')):
   if p.name=='release.zip':continue
   name=p.relative_to(out).as_posix()+('/' if p.is_dir() else '')
   info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_STORED;info.create_system=3;info.external_attr=(0o40755 if p.is_dir() else 0o100644)<<16
   z.writestr(info,b'' if p.is_dir() else p.read_bytes())
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--inputs',default='incoming');p.add_argument('--out',default='deliverables');a=p.parse_args();build(a.inputs,a.out)
'''

with tempfile.TemporaryDirectory(prefix="showcase-preflight-") as directory:
    root = Path(directory)
    reference = root / "reference.py"
    reference.write_text(REFERENCE)
    out = root / "bundle"
    subprocess.run([sys.executable, str(reference), "--inputs", str(workspace / "incoming"), "--out", str(out)], check=True, capture_output=True)
    audit = checks.validate(workspace / "incoming", out)
    rejected = []
    for name, mutate in [
        ("binary corruption", lambda p: (p / "normalized/_edge_cases/nul.dat").write_bytes(b"wrong")),
        ("missing empty file", lambda p: (p / "normalized/_edge_cases/empty").unlink()),
        ("false statistics", lambda p: (p / "audit.json").write_text('{"source_files":0}')),
        ("missing empty directory", lambda p: shutil.rmtree(p / "normalized/_edge_cases/empty-dir")),
    ]:
        bad = root / name.replace(" ", "-")
        shutil.copytree(out, bad)
        mutate(bad)
        try:
            checks.validate(workspace / "incoming", bad)
        except (AssertionError, OSError, KeyError):
            rejected.append(name)
        else:
            raise AssertionError("checker missed " + name)
    legacy = root / "legacy"
    subprocess.run([sys.executable, str(workspace / "project/build.py"), "--inputs", str(workspace / "incoming"), "--out", str(legacy)], check=True, capture_output=True)
    try:
        checks.validate(workspace / "incoming", legacy)
    except (AssertionError, OSError):
        rejected.append("initial legacy builder")
    else:
        raise AssertionError("legacy unexpectedly passed")
result = {"referencePassed": True, "negativeOutputsRejected": rejected, **audit}
(workspace.parent / "preflight.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
