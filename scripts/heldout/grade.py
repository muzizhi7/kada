"""Independent fixed checks; never invoked during a model run or fed back to it."""
import collections
import csv
import hashlib
import io
import json
import math
import os
import pathlib
import posixpath
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import unicodedata
import urllib.parse
import zipfile


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def nfc(value): return unicodedata.normalize("NFC", value)
def rows(path):
    with path.open(newline="", encoding="utf-8-sig") as f: return list(csv.DictReader(f))
def numeric(value):
    if isinstance(value, bool): raise ValueError("boolean is not a numeric measurement")
    if value is None or str(value).strip() == "": return None
    number = float(value)
    if not math.isfinite(number): raise ValueError("non-finite number")
    return number
def near(actual, expected, tolerance=0.000006):
    a = numeric(actual)
    return a is None if expected is None else a is not None and abs(a - expected) <= tolerance * max(1, abs(expected) * 0.000001)
def must(condition, detail):
    if not condition: raise AssertionError(detail)
def csv_equal(path, expected, keys, numeric_keys):
    actual = rows(path); must(len(actual) == len(expected), "row count %d != %d" % (len(actual), len(expected)))
    for index, (a, e) in enumerate(zip(actual, expected)):
        for key in keys:
            must(key in a, "missing column " + key)
            good = near(a[key], e[key]) if key in numeric_keys else a[key] == str(e[key])
            must(good, "row %d %s: actual %r expected %r" % (index, key, a.get(key), e[key]))
def json_equal(path, expected):
    actual = json.loads(path.read_text())
    for key, value in expected.items():
        must(key in actual, "missing JSON field " + key)
        good = near(actual[key], value) if isinstance(value, (int, float)) else actual[key] == value
        must(good, "%s: actual %r expected %r" % (key, actual[key], value))


def climate_expected(inputs):
    lines = (inputs / "nasa-global.csv").read_text().splitlines()
    nasa = {int(r["Year"]): r for r in csv.DictReader(lines[1:])}
    def noaa(name):
        return {int(fields[0]): float(fields[1]) for line in (inputs / name).read_text().splitlines() if (fields := line.split()) and not line.startswith("#")}
    means = noaa("noaa-co2-annual.txt"); growth = noaa("noaa-co2-growth.txt")
    annual = [{"year": year, "temp_anomaly_c": numeric(nasa[year]["J-D"]) if nasa[year]["J-D"] != "***" else None,
               "co2_ppm": means.get(year), "co2_mean_delta_ppm": means[year] - means[year-1] if year in means and year-1 in means else None,
               "noaa_growth_ppm": growth.get(year)} for year in range(2015, 2026)]
    ys = [r["temp_anomaly_c"] for r in annual]
    slope = sum((r["year"] - 2020) * r["temp_anomaly_c"] for r in annual) / sum((r["year"] - 2020) ** 2 for r in annual) * 10
    summary = {"temp_mean_2015_2025": statistics.mean(ys), "temp_change_2015_2025": ys[-1] - ys[0], "co2_change_2015_2025": means[2025] - means[2015],
               "temp_slope_c_per_decade": slope, "warmest_year": min(r["year"] for r in annual if r["temp_anomaly_c"] == max(ys)),
               "excluded_partial_years": [year for year, row in nasa.items() if year >= 2015 and row["J-D"] == "***" and any(row[m] != "***" for m in ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])]}
    return annual, summary


COUNTRIES = ["Brazil", "China", "France", "Germany", "India", "Japan", "United Kingdom", "United States"]
REGIONS = COUNTRIES + ["World"]
def electricity_expected(inputs):
    mappings = [("electricity-generation.csv", "Total electricity", "generation_twh"), ("carbon-intensity-electricity.csv", "Carbon intensity", "intensity_gco2e_kwh"),
                ("share-electricity-renewables.csv", "Renewables", "renewable_pct"), ("share-electricity-fossil-fuels.csv", "Fossil fuels", "fossil_pct")]
    data = {}
    for file, column, output in mappings:
        seen = set()
        for row in rows(inputs / file):
            key = row["Entity"], int(row["Year"])
            must(key not in seen, "reference input duplicate key"); seen.add(key)
            data.setdefault(key, {})[output] = numeric(row[column])
    panel = []
    for entity in REGIONS:
        for year in range(2015, 2026):
            raw = data.get((entity, year), {}); previous = data.get((entity, year-1), {})
            g, intensity = raw.get("generation_twh"), raw.get("intensity_gco2e_kwh")
            pg, r, pr = previous.get("generation_twh"), raw.get("renewable_pct"), previous.get("renewable_pct")
            panel.append({"entity": entity, "year": year, **{key: raw.get(key) for _, _, key in mappings},
                          "implied_lifecycle_mtco2e": g * intensity / 1000 if g is not None and intensity is not None else None,
                          "generation_yoy_pct": (g / pg - 1) * 100 if g is not None and pg not in (None, 0) else None,
                          "renewable_change_pp": r-pr if r is not None and pr is not None else None})
    sample = []
    for year in range(2015, 2026):
        selected = [row for row in panel if row["year"] == year and row["entity"] != "World"]
        complete = all(row["generation_twh"] is not None and row["intensity_gco2e_kwh"] is not None for row in selected)
        total = sum(row["generation_twh"] for row in selected) if all(row["generation_twh"] is not None for row in selected) else None
        implied = sum(row["implied_lifecycle_mtco2e"] for row in selected) if complete else None
        sample.append({"year": year, "generation_twh": total, "weighted_intensity_gco2e_kwh": implied * 1000 / total if complete and total else None,
                       "simple_mean_intensity_gco2e_kwh": statistics.mean(row["intensity_gco2e_kwh"] for row in selected) if complete else None,
                       "implied_lifecycle_mtco2e": implied})
    gains = {entity: data[(entity, 2025)]["renewable_pct"] - data[(entity, 2015)]["renewable_pct"] for entity in COUNTRIES}
    best = min(gains, key=lambda entity: (-gains[entity], entity)); latest = sample[-1]
    summary = {"latest_year": 2025, "sample_generation_twh": latest["generation_twh"], "sample_weighted_intensity_gco2e_kwh": latest["weighted_intensity_gco2e_kwh"],
               "sample_simple_mean_intensity_gco2e_kwh": latest["simple_mean_intensity_gco2e_kwh"], "sample_implied_lifecycle_mtco2e": latest["implied_lifecycle_mtco2e"],
               "largest_renewable_gain_entity": best, "largest_renewable_gain_pp": gains[best]}
    return panel, sample, summary


def research_data(workspace, task, out=None):
    output = out or workspace / "deliverables"
    if task == "research-climate":
        annual, summary = climate_expected(workspace / "inputs")
        csv_equal(output / "annual.csv", annual, list(annual[0]), set(annual[0]) - {"year"})
    else:
        panel, sample, summary = electricity_expected(workspace / "inputs")
        actual = rows(output / "panel.csv")
        ordered = sorted(actual, key=lambda row: (REGIONS.index(row["entity"]), int(row["year"])))
        temporary = io.StringIO(); writer = csv.DictWriter(temporary, fieldnames=list(panel[0])); writer.writeheader(); writer.writerows(ordered)
        expected_file = output / "panel.csv"
        must(len(actual) == 99, "panel must have 99 rows")
        for a, e in zip(ordered, panel):
            for key, value in e.items():
                must(a[key] == str(value) if key in ("entity", "year") else near(a[key], value), "panel %s %s %s: %r != %r" % (e["entity"], e["year"], key, a.get(key), value))
        csv_equal(output / "sample.csv", sample, list(sample[0]), set(sample[0]) - {"year"})
    json_equal(output / "summary.json", summary)


def report_table(workspace, task, output=None):
    text = ((output or workspace / "deliverables") / "report.md").read_text()
    tables = []
    for line in text.splitlines():
        if "|" in line:
            tables.append([re.sub(r"[`*_]", "", value).strip() for value in line.strip().strip("|").split("|")])
    def display_near(value, expected):
        clean = value.replace(",", "").replace("，", "").replace("%", "").strip()
        try: return near(clean, expected, .006)
        except (ValueError, TypeError): return False
    if task == "research-climate":
        expected, _ = climate_expected(workspace / "inputs")
        for row in expected:
            alternatives = [r for r in tables if len(r) >= 5 and r[0] == str(row["year"])]
            must(any(all(display_near(a[i], row[k]) for i, k in enumerate(["temp_anomaly_c", "co2_ppm", "co2_mean_delta_ppm", "noaa_growth_ppm"], 1)) for a in alternatives), "report annual table missing/wrong for " + str(row["year"]))
    else:
        panel, _, _ = electricity_expected(workspace / "inputs")
        for row in (r for r in panel if r["year"] == 2025):
            aliases = {"Brazil": ["巴西"], "China": ["中国"], "France": ["法国"], "Germany": ["德国"], "India": ["印度"], "Japan": ["日本"], "United Kingdom": ["英国", "联合王国"], "United States": ["美国"], "World": ["全球", "世界"]}
            names = [row["entity"], *aliases[row["entity"]]]
            alternatives = [r for r in tables if len(r) >= 6 and any(part.strip() in names for part in re.split(r"[()（）]", r[0]))]
            must(any(all(display_near(a[i], row[k]) for i, k in enumerate(["generation_twh", "intensity_gco2e_kwh", "renewable_pct", "fossil_pct", "implied_lifecycle_mtco2e"], 1)) for a in alternatives), "report 2025 table missing/wrong for " + row["entity"])


def citations(workspace, task):
    source_list = json.loads((workspace / "inputs/sources.json").read_text())["sources"]
    def url_key(url):
        parts = urllib.parse.urlsplit(url)
        return (parts.hostname or "").removeprefix("www.").lower() + urllib.parse.unquote(parts.path).rstrip("/")
    urls = {url_key(source["url"]) for source in source_list if "url" in source}
    urls |= {url.removesuffix(".metadata.json").removesuffix(".csv") for url in list(urls)}
    claims = rows(workspace / "deliverables/claims.csv")
    must(len(claims) >= (8 if task == "research-climate" else 10), "too few claims")
    seen = set(); files = set()
    for claim in claims:
        must(all(claim.get(k, "").strip() for k in ["claim_id", "claim", "source_file", "source_locator", "url", "kind"]), "incomplete claim")
        must(claim["claim_id"] not in seen, "duplicate claim id"); seen.add(claim["claim_id"])
        name = claim["source_file"]
        candidates = {(base / name).resolve() for base in [workspace, workspace / "inputs", workspace / "deliverables"]}
        candidates = {p for p in candidates if p.is_file() and workspace.resolve() in p.parents}
        must(len(candidates) == 1, "ambiguous/nonexistent source " + name)
        files.add(next(iter(candidates)).name)
        must(url_key(claim["url"]) in urls, "URL is outside frozen sources")
        must(claim["kind"] in ("source", "computed"), "invalid claim kind")
    must(len(files) >= (4 if task == "research-climate" else 5), "insufficient source coverage")
    required = {"nasa-global.csv", "noaa-co2-annual.txt", "noaa-co2-growth.txt", "nasa-faq.txt"} if task == "research-climate" else {"electricity-generation.csv", "carbon-intensity-electricity.csv", "share-electricity-renewables.csv", "share-electricity-fossil-fuels.csv"}
    must(required <= files, "missing required raw-source coverage")


def source_files(root): return sorted([p for p in root.rglob("*") if p.is_file() and not p.is_symlink()], key=lambda p: nfc(p.relative_to(root).as_posix()))
def archive_expected(inputs):
    files = source_files(inputs); groups = collections.defaultdict(list)
    for path in files: groups[digest(path)].append(path)
    canonical = {key: min(paths, key=lambda p: nfc(p.relative_to(inputs).as_posix())) for key, paths in groups.items()}
    manifest = []
    for path in files:
        source = path.relative_to(inputs).as_posix(); key = digest(path); first = canonical[key].relative_to(inputs).as_posix()
        manifest.append({"source": source, "target": "files/" + key + canonical[key].suffix.lower(), "sha256": key, "bytes": path.stat().st_size, "canonical_source": first, "is_duplicate": "true" if source != first else "false"})
    audit = {"source_files": len(files), "unique_files": len(groups), "duplicate_files": len(files)-len(groups), "source_bytes": sum(p.stat().st_size for p in files), "unique_bytes": sum(p.stat().st_size for p in canonical.values()),
             "skipped_symlinks": sorted(p.relative_to(inputs).as_posix() for p in inputs.rglob("*") if p.is_symlink())}
    return manifest, audit


def zip_matches(output, name, directories, filenames):
    expected = set(filenames)
    for directory in directories: expected |= {p.relative_to(output).as_posix() for p in (output / directory).rglob("*") if p.is_file()}
    with zipfile.ZipFile(output / name) as archive:
        entries = [info.filename for info in archive.infolist() if not info.is_dir()]
        must(len(entries) == len(set(entries)), "duplicate ZIP entries")
        must(set(entries) == expected, "ZIP content list differs from delivery")
        for file in entries:
            must(not file.startswith("/") and ".." not in pathlib.PurePosixPath(file).parts, "unsafe ZIP path")
            must(archive.read(file) == (output / file).read_bytes(), "ZIP bytes differ: " + file)


def archive_data(workspace, output=None):
    output = output or workspace / "deliverables"; expected, audit = archive_expected(workspace / "inbox")
    actual = rows(output / "manifest.csv"); must(len(actual) == len(expected), "manifest coverage/count")
    for a, e in zip(actual, expected):
        for key, value in e.items(): must(a.get(key) == str(value), "manifest %s %s" % (e["source"], key))
    entities = set()
    for row in expected:
        path = output / row["target"]; entities.add(row["target"])
        must(path.is_file() and digest(path) == row["sha256"] and path.stat().st_size == row["bytes"], "missing/corrupt entity " + row["source"])
    must({p.relative_to(output).as_posix() for p in (output / "files").rglob("*") if p.is_file()} == entities, "extra/missing deduplicated entities")
    json_equal(output / "audit.json", audit)
    zip_matches(output, "archive.zip", ["files"], ["manifest.csv", "audit.json", "INDEX.md"])


def link_spans(text):
    masked = list(text); offset = 0; fence = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if fence:
            for i in range(offset, offset+len(line)): masked[i] = " "
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= fence[1] and not line[marker.end():].strip(): fence = None
        elif marker:
            fence = (marker.group(1)[0], len(marker.group(1)))
            for i in range(offset, offset+len(line)): masked[i] = " "
        offset += len(line)
    without_fences = "".join(masked)
    for match in re.finditer(r"(`+)([^\n]*?)\1", without_fences):
        for i in range(*match.span()): masked[i] = " "
    active = "".join(masked); spans = {}
    patterns = [r"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))", r"^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))", r"<img\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"']"]
    for pattern in patterns:
        for match in re.finditer(pattern, active, re.MULTILINE | re.IGNORECASE):
            group = 1 if match.group(1) is not None else 2
            start, end = match.span(group); spans[(start, end)] = text[start:end]
    return [(start, end, value) for (start, end), value in sorted(spans.items())]


def markdown_expected(inputs):
    files = source_files(inputs); markdown = [p for p in files if p.suffix == ".md"]; assets = [p for p in files if p.suffix != ".md"]
    mapping = {p.relative_to(inputs).as_posix(): "pages/%04d.md" % (i+1) for i, p in enumerate(markdown)}
    groups = collections.defaultdict(list)
    for p in assets: groups[digest(p)].append(p)
    for key, paths in groups.items():
        canonical = min(paths, key=lambda p: nfc(p.relative_to(inputs).as_posix()))
        for p in paths: mapping[p.relative_to(inputs).as_posix()] = "assets/" + key + canonical.suffix.lower()
    texts = {}; links = []
    for p in markdown:
        source = p.relative_to(inputs).as_posix(); text = p.read_text(); changes = []
        for start, end, original in link_spans(text):
            target, status = original, "unchanged"
            if not original.startswith(("#", "/")) and not urllib.parse.urlsplit(original).scheme:
                split = re.search(r"[?#]", original)
                path = original[:split.start()] if split else original; suffix = original[split.start():] if split else ""
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), urllib.parse.unquote(path)))
                if resolved in mapping:
                    target = posixpath.relpath(mapping[resolved], posixpath.dirname(mapping[source])) + suffix; status = "rewritten"
                else: status = "unresolved"
            links.append({"source": source, "original": original, "target": target, "status": status})
            changes.append((start, end, target))
        for start, end, target in reversed(changes): text = text[:start]+target+text[end:]
        texts[mapping[source]] = text.encode()
    for p in assets: texts[mapping[p.relative_to(inputs).as_posix()]] = p.read_bytes()
    rows_ = [{"source": p.relative_to(inputs).as_posix(), "target": mapping[p.relative_to(inputs).as_posix()], "source_sha256": digest(p), "target_sha256": hashlib.sha256(texts[mapping[p.relative_to(inputs).as_posix()]]).hexdigest(), "kind": "markdown" if p.suffix == ".md" else "asset"} for p in files]
    counts = collections.Counter(link["status"] for link in links)
    audit = {"source_files": len(files), "markdown_files": len(markdown), "asset_files": len(assets), "unique_assets": len(groups), "rewritten_links": counts["rewritten"], "unchanged_links": counts["unchanged"], "unresolved_links": counts["unresolved"]}
    return rows_, texts, links, audit


def markdown_data(workspace, output=None):
    output = output or workspace / "deliverables"; expected, texts, links, audit = markdown_expected(workspace / "vault")
    actual = rows(output / "mapping.csv"); must(actual == expected, "mapping coverage/order/targets/hashes differ")
    for target, data in texts.items(): must((output / target).read_bytes() == data, "migrated document/asset differs: " + target)
    actual_targets = {p.relative_to(output).as_posix() for d in ["pages", "assets"] for p in (output/d).rglob("*") if p.is_file()}
    must(actual_targets == set(texts), "extra or missing migration targets")
    fields = ["source", "original", "target", "status"]
    must(collections.Counter(tuple(row[k] for k in fields) for row in rows(output / "links.csv")) == collections.Counter(tuple(row[k] for k in fields) for row in links), "link inventory differs, including duplicate links")
    json_equal(output / "audit.json", audit)
    index = (output / "INDEX.md").read_text()
    for row in expected:
        if row["kind"] == "markdown": must(row["source"] in index and row["target"] in index, "index omits a document")
    zip_matches(output, "library.zip", ["pages", "assets"], ["mapping.csv", "links.csv", "audit.json", "INDEX.md"])


def run_command(arguments, cwd, timeout=90):
    names = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SHELL"]
    env = {name: os.environ[name] for name in names if name in os.environ}
    try:
        result = subprocess.run(arguments, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return result.returncode, result.stdout.decode(errors="replace")[-12000:]
    except subprocess.TimeoutExpired as error: return -1, "timeout: " + str(error)


def integrity(workspace, spec):
    import fnmatch
    mutable = {"project/" + p for p in spec.get("mutable_project", [])}
    for name, expected in spec["sha256"].items():
        readonly = name in ("TASK.md", "BRIEF.json") or any(fnmatch.fnmatch(name, pattern) for pattern in spec["readonly"]) or (name.startswith("project/") and name not in mutable)
        if readonly: must((workspace/name).is_file() and digest(workspace/name) == expected, "changed immutable input " + name)


def grade(workspace, spec, output, rebuild=True):
    checks = []
    def check(name, function):
        try: function(); checks.append({"id": name, "passed": True})
        except Exception as error: checks.append({"id": name, "passed": False, "detail": str(error)[:2500]})
    task = spec["id"]
    check("input-integrity", lambda: integrity(workspace, spec))
    brief = json.loads((pathlib.Path(spec["fixture"])/"BRIEF.json").read_text())
    def required():
        for path in brief["deliverables"]: must((workspace/path).is_file(), "missing " + path)
    check("required-files", required)
    if task.startswith("research"):
        check("independent-calculations", lambda: research_data(workspace, task))
        check("report-table-consistency", lambda: report_table(workspace, task))
        check("citation-trace-structure", lambda: citations(workspace, task))
        def svg():
            import xml.etree.ElementTree as ET
            file = "climate.svg" if task == "research-climate" else "intensity.svg"
            root = ET.parse(workspace / "deliverables" / file).getroot()
            must(root.tag.endswith("svg") and len(list(root.iter())) >= 10, "empty/invalid SVG")
            must(file in (workspace / "deliverables/report.md").read_text(), "chart not linked in report")
        check("chart-delivery", svg)
    elif task == "files-archive": check("archive-content-and-zip", lambda: archive_data(workspace))
    elif task == "files-markdown": check("migration-content-links-and-zip", lambda: markdown_data(workspace))
    else:
        node_output = output.parent / "behavior.json"
        code, log = run_command(["node", str(pathlib.Path(__file__).with_name("code-grade.mjs")), task, str(workspace), str(node_output)], workspace)
        if code == 0 and node_output.exists(): checks.extend(json.loads(node_output.read_text())["checks"])
        else: checks.append({"id": "behavior-probes", "passed": False, "detail": log})
        def public():
            code, log = run_command(["node", "--test", "acceptance/public.test.mjs"], workspace)
            must(code == 0, log)
        check("immutable-public-smoke", public)
        def types():
            repo_root = next(parent for parent in pathlib.Path(__file__).resolve().parents if (parent/"node_modules/.bin/tsc").exists())
            if task == "code-cache":
                source = '''import QuickLRU from IMPORT;
const cache = new QuickLRU<string, number>({maxSize: 3});
const value = cache.getOrCreate('a', key => { const text: string = key; return text.length; }, {maxAge: 20});
const number: number = value;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type ReturnIsTyped = AssertFalse<IsAny<typeof value>>;
// @ts-expect-error wrong factory value
cache.getOrCreate('a', () => 'wrong');
// @ts-expect-error wrong key
cache.getOrCreate(4, () => 1);
// @ts-expect-error wrong options
cache.getOrCreate('a', () => 1, {maxAge: 'wrong'});
'''.replace("IMPORT", json.dumps(str(workspace/"project/index.js")))
                extension = ".mts"
            else:
                source = '''import parse = require(IMPORT);
const args = Object.freeze(['-n', '-2']);
const options = Object.freeze({alias: Object.freeze({n: Object.freeze(['number'])}), string: Object.freeze(['name']), boolean: Object.freeze(['v'])});
const result = parse<{name: string}>(args, options);
const name: string = result.name;
const positionals: string[] = result._;
// @ts-expect-error args must be string values
parse([{}]);
// @ts-expect-error wrong string option
parse([], {string: [3]});
'''.replace("IMPORT", json.dumps(str(workspace/"project")))
                extension = ".cts"
            with tempfile.TemporaryDirectory(prefix="pi-heldout-types-") as temporary:
                file = pathlib.Path(temporary)/("probe"+extension); file.write_text(source)
                code, log = run_command([str(repo_root/"node_modules/.bin/tsc"), "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", str(file)], workspace)
                must(code == 0, log)
        check("public-type-contract", types)
    if rebuild and not task.startswith("code"):
        def rebuilding():
            with tempfile.TemporaryDirectory(prefix="pi-heldout-rebuild-") as temporary:
                copy = pathlib.Path(temporary)/"workspace"
                shutil.copytree(workspace, copy, ignore=shutil.ignore_patterns("deliverables", "agents", "__pycache__", "node_modules", ".git"))
                destination = copy / "fresh-output"
                source = "inputs" if task.startswith("research") else "inbox" if task == "files-archive" else "vault"
                command = [sys.executable, "build.py", "--inputs", source, "--out", "fresh-output"]
                code, log = run_command(command, copy)
                must(code == 0, "fresh rebuild failed: " + log)
                checker = (lambda: research_data(copy, task, destination)) if task.startswith("research") else (lambda: archive_data(copy, destination)) if task == "files-archive" else (lambda: markdown_data(copy, destination))
                checker()
                if task.startswith("research"): report_table(copy, task, destination)
                code, log = run_command(command, copy); must(code == 0, "repeat build failed: " + log); checker()
        check("fresh-rebuild-and-idempotence", rebuilding)
        def changed_inputs():
            with tempfile.TemporaryDirectory(prefix="pi-heldout-change-") as temporary:
                copy = pathlib.Path(temporary)/"workspace"
                shutil.copytree(workspace, copy, ignore=shutil.ignore_patterns("deliverables", "agents", "__pycache__", "node_modules", ".git"))
                source = "inputs" if task.startswith("research") else "inbox" if task == "files-archive" else "vault"
                command = [sys.executable, "build.py", "--inputs", source, "--out", "changed-output"]
                if task == "research-climate":
                    file = copy/"inputs/nasa-global.csv"; lines = file.read_text().splitlines(); values = list(csv.DictReader(lines[1:])); fields = list(values[0])
                    for row in values:
                        if row["Year"] == "2025": row["J-D"] = str(float(row["J-D"]) + .17)
                    with file.open("w", newline="") as f:
                        f.write(lines[0]+"\n"); writer = csv.DictWriter(f, fieldnames=fields); writer.writeheader(); writer.writerows(values)
                elif task == "research-electricity":
                    file = copy/"inputs/carbon-intensity-electricity.csv"; values = rows(file); fields = list(values[0])
                    for row in values:
                        if row["Entity"] == "France" and row["Year"] == "2025": row["Carbon intensity"] = str(float(row["Carbon intensity"]) + 3.21)
                    with file.open("w", newline="") as f:
                        writer = csv.DictWriter(f, fieldnames=fields); writer.writeheader(); writer.writerows(values)
                elif task == "files-archive":
                    first = source_files(copy/"inbox")[0]
                    (copy/"inbox/New 资料").mkdir(); (copy/"inbox/New 资料/空.txt").write_bytes(b"")
                    (copy/"inbox/duplicate.bin").write_bytes(first.read_bytes())
                else:
                    first = next(p for p in source_files(copy/"vault") if p.suffix == ".md").relative_to(copy/"vault").as_posix()
                    encoded = urllib.parse.quote(first)
                    (copy/"vault/新增 文档.md").write_text('# 新资料\n\n[原文]('+encoded+'#part)\n\n```md\n[x]('+encoded+')\n```\n\n`[x]('+encoded+')`\n')
                    (copy/"vault/extra.bin").write_bytes(b"\x00\x01\x02")
                if task.startswith("research"):
                    file = copy/"inputs/sources.json"; metadata = json.loads(file.read_text())
                    for item in metadata["sources"]:
                        if "file" in item and "sha256" in item: item["sha256"] = digest(copy/item["file"])
                    file.write_text(json.dumps(metadata))
                code, log = run_command(command, copy); must(code == 0, "changed-input rebuild failed: " + log)
                destination = copy/"changed-output"
                if task.startswith("research"):
                    research_data(copy, task, destination); report_table(copy, task, destination)
                    svg = "climate.svg" if task == "research-climate" else "intensity.svg"
                    must((destination/svg).read_bytes() != (workspace/"deliverables"/svg).read_bytes(), "chart did not respond to changed data")
                elif task == "files-archive": archive_data(copy, destination)
                else: markdown_data(copy, destination)
        check("changed-inputs-not-hardcoded", changed_inputs)
    result = {"task": task, "checks": checks, "machineAllCriticalPassed": all(c["passed"] for c in checks),
              "semanticReviewRequired": True, "note": "All critical conditions must pass; source support, interpretation, documentation truth and visual readability are reviewed separately. No aggregate score replaces a failed critical condition."}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    base = pathlib.Path(sys.argv[1]).resolve()
    tasks = {task["id"]: task for task in json.loads((base/"tasks.json").read_text())}
    results = json.loads((base/"results.json").read_text())
    summary = []
    for result in results:
        directory = pathlib.Path(result["directory"])
        item = grade(directory/"workspace", tasks[result["task"]], directory/"grade.json")
        summary.append({"sequence": result["sequence"], "task": result["task"], "arm": result["arm"], "repeat": result["repeat"], "machineAllCriticalPassed": item["machineAllCriticalPassed"], "failed": [c["id"] for c in item["checks"] if not c["passed"]]})
    (base/"machine-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False))
