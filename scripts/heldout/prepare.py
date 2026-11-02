"""Build six versioned local work packages from actual public snapshots."""
import hashlib
import html.parser
import json
import pathlib
import shutil
import sys
from tasks import TASKS, COMMON

BASE = pathlib.Path(sys.argv[1]).resolve()
SOURCES = BASE / "sources"
FIXTURES = BASE / "fixtures"
if (BASE / "frozen.json").exists():
    raise SystemExit("The study is frozen; do not regenerate its inputs")
manifest = json.loads((BASE / "source-manifest.json").read_text())
source_urls = {item["file"]: item["url"] for item in manifest["sources"]}


class Text(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.skip = 0; self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "nav", "header", "footer", "svg", "form"):
            self.skip += 1
        if not self.skip and tag in ("p", "div", "h1", "h2", "h3", "h4", "li", "tr", "br"):
            self.parts.append("\n")
    def handle_endtag(self, tag):
        if tag in ("script", "style", "nav", "header", "footer", "svg", "form"):
            self.skip = max(0, self.skip - 1)
        if not self.skip and tag in ("p", "div", "li", "h1", "h2", "h3", "h4", "tr"):
            self.parts.append("\n")
    def handle_data(self, text):
        if not self.skip: self.parts.append(text)


def notes(name):
    parser = Text(); parser.feed((SOURCES / (name + ".html")).read_text())
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines() if line.strip()]
    return "Source: " + source_urls[name + ".html"] + "\nFrozen: 2026-10-31\n" + "\n".join("L%04d: %s" % (i, line) for i, line in enumerate(lines, 1)) + "\n"


def write(root, path, text):
    destination = root / path; destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text)


CACHE_SMOKE = r"""import test from 'node:test';
import assert from 'node:assert/strict';
import QuickLRU from '../project/index.js';
test('existing set/get, falsey values and resize remain usable', () => {
 const cache = new QuickLRU({maxSize: 4}); cache.set('zero',0).set('false',false).set('nil',undefined);
 assert.equal(cache.get('zero'),0); assert.equal(cache.get('false'),false); assert.equal(cache.has('nil'),true);
 cache.resize(2); assert(cache.size<=2);
});
test('getOrCreate computes once and does not overwrite cached undefined', () => {
 const cache = new QuickLRU({maxSize: 4}); let calls=0;
 assert.equal(cache.getOrCreate('k',key=>{calls++; assert.equal(key,'k'); return undefined;}),undefined);
 assert.equal(cache.getOrCreate('k',()=>{calls++; return 10;}),undefined);
 assert.equal(calls,1); assert.equal(cache.has('k'),true);
});
"""

CLI_SMOKE = r"""import test from 'node:test';
import assert from 'node:assert/strict';
import parse from '../project/src/index.js';
test('existing aliases and defaults',()=>{
 assert.deepEqual(parse(['--name','Ada','file'],{alias:{name:'n'},default:{count:3}}),{_:['file'],name:'Ada',n:'Ada',count:3});
});
test('frozen reusable options and negative argument',()=>{
 const options=Object.freeze({alias:Object.freeze({n:Object.freeze(['number'])}),boolean:Object.freeze(['verbose']),string:Object.freeze([])});
 assert.deepEqual(parse(['-n','-2.5'],options),{_:[],n:-2.5,number:-2.5});
 assert.deepEqual(parse(['-n','-2.5'],options),{_:[],n:-2.5,number:-2.5});
});
"""

records = []
for task in TASKS:
    root = FIXTURES / task["id"]
    if root.exists(): shutil.rmtree(root)
    root.mkdir(parents=True)
    sources = []
    if task["id"] == "research-climate":
        for name in ["nasa-global.csv", "noaa-co2-annual.txt", "noaa-co2-growth.txt"]:
            write(root, "inputs/" + name, (SOURCES / name).read_text())
            sources.append({"file": "inputs/" + name, "url": source_urls[name]})
        for name in ["nasa-faq", "noaa-notes"]:
            write(root, "inputs/" + name + ".txt", notes(name))
            sources.append({"file": "inputs/" + name + ".txt", "url": source_urls[name + ".html"]})
    elif task["id"] == "research-electricity":
        for slug in ["electricity-generation", "carbon-intensity-electricity", "share-electricity-renewables", "share-electricity-fossil-fuels"]:
            for extension in ["csv", "metadata.json"]:
                name = slug + "." + extension
                write(root, "inputs/" + name, (SOURCES / name).read_text())
                sources.append({"file": "inputs/" + name, "url": source_urls[name]})
    elif task["id"] == "files-archive":
        for name in ["quick-lru", "mri", "book"]:
            shutil.copytree(SOURCES / name, root / "inbox" / name)
            sources.append({"directory": "inbox/" + name, **manifest["repositories"][name]})
    elif task["id"] == "files-markdown":
        shutil.copytree(SOURCES / "book" / "src", root / "vault")
        sources.append({"directory": "vault", **manifest["repositories"]["book"], "selection": "src regular files only; keep mdBook directives as source"})
        for name in ["LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT"]:
            if (SOURCES / "book" / name).exists():
                write(root, "inputs/licenses/" + name, (SOURCES / "book" / name).read_text())
    else:
        name = "quick-lru" if task["id"] == "code-cache" else "mri"
        shutil.copytree(SOURCES / name, root / "project")
        write(root, "acceptance/public.test.mjs", CACHE_SMOKE if name == "quick-lru" else CLI_SMOKE)
        sources.append({"directory": "project", **manifest["repositories"][name], "selection": "unmodified upstream regular files; offline tests added outside project"})
    for source in sources:
        if "file" in source:
            data = (root / source["file"]).read_bytes()
            source["sha256"] = hashlib.sha256(data).hexdigest()
    write(root, "inputs/sources.json", json.dumps({"frozen_at": "2026-10-31", "sources": sources}, ensure_ascii=False, indent=2))
    checks = [{"type": "file_exists", "path": name} for name in task["artifacts"]]
    brief = {
        "revision": 1, "outcome": task["name"], "deliverables": task["artifacts"], "inputs": task["inputs"],
        "criteria": [{"text": text, "method": method} for text, method in task["criteria"]],
        "scope": ["仅当前工作区；读取共同方法；不安装依赖、不访问其他方案/评分器/凭据。"],
        "assumptions": ["输入为冻结的真实公开资料/代码；语义审阅与客观检查分开记录。"],
        "questions": [], "checks": checks, "budget": {"maxEstimatedCostUsd": 0.25, "maxDurationMs": 3600000},
    }
    text = "# " + task["name"] + "\n\n" + task["text"] + "\n" + COMMON + "\n总费用上限 USD0.25，执行时限60分钟；到限停止，不自动补预算。\n"
    write(root, "TASK.md", text)
    write(root, "BRIEF.json", json.dumps(brief, ensure_ascii=False, indent=2))
    hashes = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}
    records.append({"id": task["id"], "category": task["category"], "name": task["name"], "fixture": str(root), "sha256": hashes, "readonly": task["readonly"], "mutable_project": task.get("mutable_project", []), "crash": task.get("crash")})
(BASE / "tasks.json").write_text(json.dumps(records, ensure_ascii=False, indent=2))
print(json.dumps({"tasks": [{"id": t["id"], "files": len(t["sha256"])} for t in records], "estimatedNominalMaximumUsd": 9, "aggregateStopUsd": 10}, ensure_ascii=False))
