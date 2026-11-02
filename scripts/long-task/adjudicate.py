"""Uniform semantic adjudication of two documented format-proxy ambiguities."""
import csv
import json
import pathlib
import re
import sys

for name in sys.argv[1:]:
    folder = pathlib.Path(name).resolve(); workspace = folder / "workspace"; output = workspace / "deliverables"
    grade = json.loads((folder / "grade.json").read_text()); groups = {g["name"]: g for g in grade["groups"]}
    sources = json.loads((workspace / "inputs/sources.json").read_text())["sources"]
    allowed = {s["url"] for s in sources} | {"https://www.iea.org/reports/global-ev-outlook-2026"}
    allowed |= {s["url"].removesuffix(".csv") for s in sources if s["url"].endswith(".csv")}
    claims = list(csv.DictReader((output / "claims.csv").open()))
    valid = text_count = table_count = 0
    for row in claims:
        source = row.get("source_file", "")
        paths = {(base / source).resolve() for base in [workspace, workspace / "inputs", output]}
        paths = {p for p in paths if p.is_file() and workspace in p.parents}
        good = len(paths) == 1 and bool(row.get("claim")) and bool(row.get("source_locator")) and row.get("url") in allowed and row.get("status") in ("historical", "source_forecast", "task_scenario", "interpretation")
        path = next(iter(paths)) if paths else pathlib.Path("unresolved")
        if path.suffix == ".txt" and good:
            refs = re.findall(r"L(\d+)", row["source_locator"])
            good = bool(refs) and all(1 <= int(n) <= len(path.read_text().splitlines()) - 2 for n in refs)
        valid += int(good)
        if good:
            if path.suffix == ".txt": text_count += 1
            else: table_count += 1
    passed = valid >= 12 and text_count >= 4 and table_count >= 8
    claim_score = 3 * min(valid / 12, 1) if passed else 1.5 * min(valid / 12, 1)
    report = (output / "report.md").read_text()
    flags = groups["report_structure"]["details"][0]["checks"][:]
    flags[1] = all(re.search(p, report) for p in ["摘要", "方法|口径", "2027", "风险|局限|缺口|不能回答|不确定", "反向|反例|反方|相反|证伪", "来源|参考"])
    report_score = 8 * sum(flags) / len(flags)
    corrections = [
        {"group": "claim_structure", "original": groups["claim_structure"]["score"], "adjudicated": round(claim_score, 3), "reason": "source_file was not specified to be root-relative; accept a uniquely resolvable local source. Required column names and actual URL fields remain enforced.", "valid_rows": valid, "text_rows": text_count, "table_rows": table_count},
        {"group": "report_structure", "original": groups["report_structure"]["score"], "adjudicated": round(report_score, 3), "reason": "The requirement concerns risk/limitations content, not the literal word 风险. Equivalent uncertainty/limitations sections count."},
    ]
    score = grade["machine_score"] + sum(c["adjudicated"] - c["original"] for c in corrections)
    decision = {"original_machine_score": grade["machine_score"], "adjudicated_machine_score": round(score, 3), "machine_max": 90, "corrections": corrections,
                "note": "Original grades remain unchanged. Same interpretation applied to every arm; no numerical criteria or robustness tests changed."}
    (folder / "adjudication.json").write_text(json.dumps(decision, ensure_ascii=False, indent=2))
    print(json.dumps({"folder": str(folder), **decision}, ensure_ascii=False))
