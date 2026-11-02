"""Freeze public source material for a real three-arm local-task comparison."""
import hashlib
import html.parser
import json
import pathlib
import shutil
import sys
import urllib.request

BASE = pathlib.Path(sys.argv[1]).resolve()
SOURCE = BASE / "sources"
PACK = BASE / "fixture"
PACK.mkdir(parents=True, exist_ok=True)
(PACK / "inputs").mkdir(exist_ok=True)


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
        if not self.skip:
            self.parts.append(text)


slugs = ["electric-car-sales", "electric-car-sales-share", "electric-car-stocks", "share-car-stocks-electric"]
sources = []
for slug in slugs:
    for suffix in (".csv", ".metadata.json"):
        name = slug + suffix
        shutil.copy2(SOURCE / name, PACK / "inputs" / name)
        sources.append({"file": "inputs/" + name, "url": "https://ourworldindata.org/grapher/" + name})

pages = [
    ("iea-executive-summary", "https://www.iea.org/reports/global-ev-outlook-2026/executive-summary"),
    ("iea-trends", "https://www.iea.org/reports/global-ev-outlook-2026/trends-in-electric-cars"),
    ("iea-outlook", "https://www.iea.org/reports/global-ev-outlook-2026/outlook-for-electric-mobility-chap-9-11"),
]
for slug, url in pages:
    parser = Text(); parser.feed((SOURCE / (slug + ".html")).read_text())
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines() if line.strip()]
    assert sum(map(len, lines)) > 3000, "Expected an actual article body"
    body = "Source: " + url + "\nFrozen: 2026-10-30\n" + "\n".join(f"L{i:04}: {line}" for i, line in enumerate(lines, 1))
    (PACK / "inputs" / (slug + ".txt")).write_text(body)
    sources.append({"file": "inputs/" + slug + ".txt", "url": url})

for item in sources:
    item["sha256"] = hashlib.sha256((PACK / item["file"]).read_bytes()).hexdigest()
    item["bytes"] = (PACK / item["file"]).stat().st_size
(PACK / "inputs" / "sources.json").write_text(json.dumps({"frozen_at": "2026-10-30", "sources": sources}, indent=2))

ref = "c8e54ba3e9a4cf65df8fd9d92d0f9b231cab7f45"
url = f"https://raw.githubusercontent.com/lidangzzz/goal-driven/{ref}/README.md"
readme = urllib.request.urlopen(url, timeout=45).read().decode()
template = readme.split("# The Goal-Driven Prompt Template", 1)[1].split("```", 2)[1].strip()
assert "DEFINE YOUR GOAL HERE" in template and "DEFINE YOUR CRITERIA FOR SUCCESS HERE" in template
(BASE / "goal-driven-template.txt").write_text(template)

shutil.copy2(pathlib.Path(__file__).with_name("task.md"), PACK / "TASK.md")
checks = [{"type": "file_exists", "path": p} for p in [
    "deliverables/normalized.csv", "deliverables/market_metrics.csv", "deliverables/scenarios_2027.csv",
    "deliverables/audit.json", "deliverables/claims.csv", "deliverables/report.md", "deliverables/checks.json",
    "deliverables/charts/sales-trend.svg", "deliverables/charts/share-trend.svg",
    "deliverables/charts/sales-vs-stock.svg", "deliverables/charts/scenarios-2027.svg", "build.py", "tests/test_pipeline.py", "README.md",
]] + [{"type": "json_value", "path": "deliverables/checks.json", "pointer": "/passed", "equals": True}]
(PACK / "acceptance.json").write_text(json.dumps(checks, indent=2))
manifest = {p.relative_to(PACK).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(PACK.rglob("*")) if p.is_file()}
(BASE / "fixture-manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps({"fixture": str(PACK), "files": len(manifest), "input_bytes": sum(i["bytes"] for i in sources), "goal_driven_ref": ref}))
