"""Independent, task-specific end-state grading. Never sends feedback to trial agents."""
import argparse
import csv
import hashlib
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

METRICS = {
    "electric-car-sales.csv": "ev_sales",
    "electric-car-sales-share.csv": "ev_sales_share_pct",
    "electric-car-stocks.csv": "ev_stock",
    "share-car-stocks-electric.csv": "ev_stock_share_pct",
}
MARKETS = ["World", "China", "Europe", "European Union (27)", "United States", "India", "Norway", "Germany"]
CHARTS = ["sales-trend", "share-trend", "sales-vs-stock", "scenarios-2027"]


def rows(path):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def reference(inputs):
    joined, audit = {}, {"sources": {}}
    for file, field in METRICS.items():
        data, seen = rows(inputs / file), set()
        for row in data:
            key = row["Entity"], int(row["Year"])
            if key in seen:
                raise ValueError("Duplicate key")
            seen.add(key)
            record = joined.setdefault(key, {"entity": key[0], "code": row["Code"], "year": key[1], **{f: None for f in METRICS.values()}})
            value = row[list(row)[-1]]
            number = None if value.strip() == "" else float(value)
            if number is not None and (not math.isfinite(number) or (field.endswith("_pct") and not 0 <= number <= 100)):
                raise ValueError("Invalid value")
            record[field] = number
        audit["sources"][file] = {"rows": len(data), "unique_keys": len(seen), "duplicate_keys": 0, "latest_year": max(int(r["Year"]) for r in data)}
    normalized = [joined[k] for k in sorted(joined)]
    audit["normalized_rows"] = len(normalized)
    audit["missing_counts"] = {f: sum(r[f] is None for r in normalized) for f in METRICS.values()}
    metrics = []
    for row in normalized:
        if row["entity"] not in MARKETS:
            continue
        prev = joined.get((row["entity"], row["year"] - 1), {})
        sales, share, psales, pshare = row["ev_sales"], row["ev_sales_share_pct"], prev.get("ev_sales"), prev.get("ev_sales_share_pct")
        metrics.append({k: v for k, v in {**row, "sales_yoy_pct": (sales / psales - 1) * 100 if sales is not None and psales is not None and psales > 0 else None,
                         "sales_share_change_pp": share - pshare if share is not None and pshare is not None else None}.items() if k != "code"})
    scenarios = []
    for market in MARKETS:
        old, new = joined[market, 2022], joined[market, 2025]
        g = (new["ev_sales"] / old["ev_sales"]) ** (1 / 3) - 1
        d = (new["ev_sales_share_pct"] - old["ev_sales_share_pct"]) / 3
        for scenario, f in [("downside", 0.5), ("base", 1), ("upside", 1.5)]:
            rate = max(-0.05, min(0.5, g * f))
            scenarios.append({"entity": market, "scenario": scenario, "base_year": 2025, "target_year": 2027,
                              "annual_growth_pct": rate * 100, "annual_share_change_pp": d * f,
                              "ev_sales_2027": new["ev_sales"] * (1 + rate) ** 2,
                              "ev_sales_share_2027_pct": max(0, min(100, new["ev_sales_share_pct"] + 2 * d * f))})
    return normalized, metrics, scenarios, audit


def compare(path, expected, keys):
    try:
        actual = rows(path)
        index = {}
        for row in actual:
            key = tuple(str(row.get(k, "")) for k in keys)
            if key in index:
                return 0.0, ["Duplicate output key: " + str(key)]
            index[key] = row
        failures, good, total = [], 0, 0
        for record in expected:
            key = tuple(str(record[k]) for k in keys)
            row = index.pop(key, None)
            for field, value in record.items():
                total += 1
                got = row.get(field) if row is not None else "<missing row>"
                try:
                    if value is None:
                        ok = got == ""
                    elif isinstance(value, (int, float)):
                        number = float(got)
                        tolerance = 0.5 if field == "ev_sales_2027" else 0.000001
                        ok = math.isfinite(number) and abs(number - value) <= tolerance
                    else:
                        ok = got == value
                except (ValueError, TypeError):
                    ok = False
                good += int(ok)
                if not ok and len(failures) < 16:
                    failures.append(f"{key} {field}: expected {value!r}, got {got!r}")
        total += sum(len(r) for r in index.values())
        if index:
            failures.append(f"Unexpected rows: {len(index)}")
        return good / total if total else 0, failures
    except Exception as error:
        return 0.0, [str(error)]


def main():
    args = argparse.ArgumentParser(); args.add_argument("workspace"); args.add_argument("fixture"); args.add_argument("--out", required=True); args.add_argument("--rebuild", action="store_true")
    a = args.parse_args(); workspace, fixture = pathlib.Path(a.workspace).resolve(), pathlib.Path(a.fixture).resolve()
    out = workspace / "deliverables"
    normalized, metrics, scenarios, audit = reference(fixture / "inputs")
    result = {"workspace": str(workspace), "grader_version": 2, "groups": [], "critical_failures": [], "manual_points_available": 10}

    def add(name, score, maximum, passed, details=None, critical=False):
        result["groups"].append({"name": name, "score": round(score, 3), "max": maximum, "passed": passed, "details": details or []})
        if critical and not passed:
            result["critical_failures"].append(name)

    altered = [str(p.relative_to(fixture)) for p in fixture.rglob("*") if p.is_file() and (not (workspace / p.relative_to(fixture)).is_file() or hashlib.sha256(p.read_bytes()).digest() != hashlib.sha256((workspace / p.relative_to(fixture)).read_bytes()).digest())]
    add("input_integrity", 0, 0, not altered, altered, critical=True)
    for name, values, key, weight in [("normalized", normalized, ["entity", "year"], 25), ("market_metrics", metrics, ["entity", "year"], 15), ("scenarios_2027", scenarios, ["entity", "scenario"], 15)]:
        ratio, errors = compare(out / (name + ".csv"), values, key)
        add(name, weight * ratio, weight, ratio == 1, errors, critical=True)
    try:
        got = json.loads((out / "audit.json").read_text())
        flags = [got.get("normalized_rows") == audit["normalized_rows"], got.get("missing_counts") == audit["missing_counts"]]
        flags.extend(all(got.get("sources", {}).get(file, {}).get(k) == v for k, v in data.items()) for file, data in audit["sources"].items())
        add("audit", 5 * sum(flags) / len(flags), 5, all(flags), ["Expected audit", audit] if not all(flags) else [])
    except Exception as error:
        add("audit", 0, 5, False, [str(error)])

    try:
        claims = rows(out / "claims.csv"); valid = 0; kinds = {}
        sources = json.loads((fixture / "inputs/sources.json").read_text())["sources"]
        allowed = {s["url"] for s in sources}
        allowed.add("https://www.iea.org/reports/global-ev-outlook-2026")
        allowed.update("https://ourworldindata.org/grapher/" + file.removesuffix(".csv") for file in METRICS)
        for claim in claims:
            path = (workspace / claim.get("source_file", "")).resolve()
            status = claim.get("status", "")
            good = path.is_file() and workspace in path.parents and bool(claim.get("claim")) and bool(claim.get("source_locator")) and claim.get("url") in allowed and status in ("historical", "source_forecast", "task_scenario", "interpretation")
            if path.suffix == ".txt" and good:
                locators = re.findall(r"L(\d+)", claim["source_locator"])
                nlines = len(path.read_text().splitlines()) - 2
                good = bool(locators) and all(1 <= int(n) <= nlines for n in locators)
            valid += int(good); kinds["text" if path.suffix == ".txt" else "table"] = kinds.get("text" if path.suffix == ".txt" else "table", 0) + int(good)
        passed = valid >= 12 and kinds.get("text", 0) >= 4 and kinds.get("table", 0) >= 8
        add("claim_structure", 3 * min(valid / 12, 1) if passed else 1.5 * min(valid / 12, 1), 3, passed, [{"rows": len(claims), "valid": valid, "types": kinds}])
    except Exception as error:
        add("claim_structure", 0, 3, False, [str(error)])

    try:
        report = (out / "report.md").read_text(); chinese = len(re.findall(r"[\u4e00-\u9fff]", report))
        flags = [chinese >= 3300, all(re.search(p, report) for p in ["摘要", "方法|口径", "2027", "风险", "反向|反例|反方|相反|证伪", "来源|参考"]),
                 all(re.search(p, report, re.I) for p in ["全球|World", "中国|China", "欧洲|Europe", "欧盟|EU27|European Union", "美国|United States", "印度|India", "挪威|Norway", "德国|Germany"]),
                 all(chart + ".svg" in report for chart in CHARTS), "claims.csv" in report, bool(re.search("假设|机械|外推", report))]
        add("report_structure", 8 * sum(flags) / len(flags), 8, all(flags), [{"chinese_characters": chinese, "checks": flags}])
    except Exception as error:
        add("report_structure", 0, 8, False, [str(error)])
    chart_errors = []
    for name in CHARTS:
        try:
            tree = ET.parse(out / "charts" / (name + ".svg")); root = tree.getroot()
            assert root.tag.endswith("svg") and len(list(root.iter())) >= 20, "Not a substantive SVG chart"
            assert sum(1 for t in root.iter() if t.tag.endswith("text")) >= 8, "Missing readable labels"
        except Exception as error:
            chart_errors.append(name + ": " + str(error))
    add("charts", 4 - len(chart_errors), 4, not chart_errors, chart_errors)

    if a.rebuild:
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL")}
        def run(command):
            try:
                p = subprocess.run(command, cwd=workspace, env=env, capture_output=True, text=True, timeout=90)
                return p.returncode, (p.stdout + p.stderr)[-5000:]
            except Exception as error:
                return -1, str(error)
        with tempfile.TemporaryDirectory(prefix="pi-ev-grade-") as temp:
            temp = pathlib.Path(temp)
            cases = [("fresh_rebuild", None, True, 3), ("changed_source", "perturb", True, 3), ("missing_and_zero", "missing", True, 3),
                     ("duplicate_rejected", "duplicate", False, 2), ("invalid_share_rejected", "invalid_share", False, 1), ("invalid_number_rejected", "invalid_number", False, 1)]
            base_valid = False
            for case, mutation, should_pass, points in cases:
                inputs, target = temp / case / "inputs", temp / case / "out"
                shutil.copytree(fixture / "inputs", inputs)
                if mutation:
                    filename = "electric-car-sales-share.csv" if mutation == "invalid_share" else "electric-car-sales.csv"
                    data = rows(inputs / filename); fields = list(data[0]); value = fields[-1]
                    if mutation == "duplicate":
                        data.append(data[0].copy())
                    else:
                        for row in data:
                            if mutation == "perturb" and row["Entity"] == "World" and row["Year"] == "2025": row[value] = str(float(row[value]) * 1.013)
                            if mutation == "missing" and row["Entity"] == "World" and row["Year"] == "2010": row[value] = ""
                            if mutation == "missing" and row["Entity"] == "India" and row["Year"] == "2015": row[value] = "0"
                            if mutation == "invalid_share" and row["Entity"] == "World" and row["Year"] == "2025": row[value] = "101"
                            if mutation == "invalid_number" and row["Entity"] == "World" and row["Year"] == "2025": row[value] = "NaN"
                    with open(inputs / filename, "w", newline="") as handle:
                        writer = csv.DictWriter(handle, fieldnames=fields); writer.writeheader(); writer.writerows(data)
                    # A changed-source test is a new test snapshot. Keep its manifest
                    # consistent so checksum validation is not mistaken for data validation.
                    source_manifest = json.loads((inputs / "sources.json").read_text())
                    for source in source_manifest["sources"]:
                        path = inputs / pathlib.Path(source["file"]).name
                        source["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                        source["bytes"] = path.stat().st_size
                    source_manifest["assessment_mutation"] = case
                    (inputs / "sources.json").write_text(json.dumps(source_manifest, indent=2))
                code, output = run([os.sys.executable, "build.py", "--inputs", str(inputs), "--out", str(target)])
                passed = code == 0 if should_pass else code != 0 and base_valid
                errors = []
                if should_pass and passed:
                    refs = reference(inputs)
                    for file, values, key in [("normalized", refs[0], ["entity", "year"]), ("market_metrics", refs[1], ["entity", "year"]), ("scenarios_2027", refs[2], ["entity", "scenario"])]:
                        ratio, detail = compare(target / (file + ".csv"), values, key)
                        passed &= ratio == 1; errors.extend(detail[:3])
                if case == "fresh_rebuild":
                    passed &= all((target / "charts" / (name + ".svg")).is_file() for name in CHARTS) and (target / "audit.json").is_file()
                    base_valid = passed
                add(case, points if passed else 0, points, passed, errors or [output[-1500:]], critical=case == "fresh_rebuild")
        code, output = run([os.sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"])
        count = re.search(r"Ran (\d+) tests?", output)
        passed = code == 0 and bool(count) and int(count.group(1)) >= 5
        add("agent_tests", 2 if passed else 0, 2, passed, [output])
    result["machine_score"] = round(sum(g["score"] for g in result["groups"]), 3)
    result["machine_max"] = sum(g["max"] for g in result["groups"])
    result["reference"] = {"normalized_rows": len(normalized), "market_rows": len(metrics), "scenario_rows": len(scenarios), "audit": audit}
    pathlib.Path(a.out).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"machine_score": result["machine_score"], "machine_max": result["machine_max"], "critical_failures": result["critical_failures"], "out": a.out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
