"""Export deidentified observations and explicit grading sensitivities after review.

This reporting step was added AFTER the frozen experiment. It never changes
candidate files, frozen grades, the masked review, or the primary summary.
It makes no model calls. Raw sessions and paths stay in the ignored study dir.
"""
import argparse
import csv
import json
import pathlib
import statistics


ARMS = ("pi", "prompt", "extension")


def aggregate(records, passed):
    result = {}
    for arm in ARMS:
        selected = [row for row in records if row["arm"] == arm]
        result[arm] = {
            "attempts": len(selected),
            "qualifiedDeliveries": sum(passed(row) and row["hostDeclaredComplete"] for row in selected),
            "artifactPasses": sum(passed(row) for row in selected),
            "estimatedCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in selected),
            "failedAttemptCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in selected
                                        if not (passed(row) and row["hostDeclaredComplete"])),
            "incorrectCompletionClaims": sum(row["completionClaim"] and not passed(row) for row in selected),
            "goodArtifactsNotDelivered": sum(passed(row) and not row["hostDeclaredComplete"] for row in selected),
            "actualFollowupMessages": sum(row["operatorFollowupMessages"] for row in selected),
            "runsRequestingUserInput": sum(row["requestsUserInput"] for row in selected),
        }
    return result


def screen(records, passed):
    wins = []
    ratios = []
    for task in sorted({row["task"] for row in records}):
        repeated = []
        for repeat in (1, 2):
            cell = {row["arm"]: row for row in records if row["task"] == task and row["repeat"] == repeat}
            success = {arm: passed(row) and row["hostDeclaredComplete"] for arm, row in cell.items()}
            repeated.append(success["extension"] and not success["pi"] and not success["prompt"])
            if success["extension"] and success["pi"]:
                ratios.append({"task": task, "repeat": repeat,
                               "costRatio": cell["extension"]["budget"]["estimatedCostUsd"]
                               / cell["pi"]["budget"]["estimatedCostUsd"]})
        if all(repeated):
            wins.append(task)
    return {"repeatedUniqueWins": wins, "pairedSuccessfulRuns": ratios,
            "medianPairedSuccessCostRatio": statistics.median(row["costRatio"] for row in ratios) if ratios else None,
            "costGateAssessable": bool(ratios), "repeatedBenefitGatePassed": len(wins) >= 2}


def export(base, destination):
    raw = json.loads((base / "qualified-records.json").read_text())
    review = json.loads((base / "semantic-review.json").read_text())
    frozen = json.loads((base / "frozen.json").read_text())
    reviews = {row["sequence"]: row for row in review["runs"]}
    assert len(raw) == len(reviews) == 36
    assert len({(row["task"], row["arm"], row["repeat"]) for row in raw}) == 36
    for row in reviews.values():
        assert all(type(row[key]) is bool for key in ("allCriticalPassed", "claimsComplete", "requestsUserInput"))

    records = []
    for row in raw:
        semantic = reviews[row["sequence"]]
        records.append({
            **{key: row[key] for key in ("sequence", "task", "category", "arm", "repeat", "execution",
                "elapsedMs", "budget", "workerCount", "compactions", "reworks", "automaticContinuations",
                "operatorFollowupMessages", "hostDeclaredComplete", "machineAllCriticalPassed",
                "semanticAllCriticalPassed", "artifactAllCriticalPassed", "autonomousQualifiedDelivery",
                "incorrectCompletionClaim", "failedChecks")},
            "reviewId": semantic["reviewId"],
            "completionClaim": row["hostDeclaredComplete"] if row["arm"] == "extension" else semantic["claimsComplete"],
            "requestsUserInput": bool(row.get("userInformationRequests")) or semantic["requestsUserInput"],
            "injectedTransientError": bool(row.get("fault", {}).get("injected")),
            "plannedCrash": bool(row.get("interruption", {}).get("planned")),
            "actualCrash": bool(row.get("interruption", {}).get("injected")),
            "restarts": row.get("interruption", {}).get("restarts", 0),
            "semanticEvidence": semantic["evidence"],
        })

    def primary(row):
        return row["artifactAllCriticalPassed"]

    def citation_adjudicated(row):
        # TASK requires traceable evidence, not an external URL for local computed rows.
        # Only these two fully reviewed records have that as their sole mechanical failure.
        return primary(row) or (row["semanticAllCriticalPassed"]
                                and row["failedChecks"] == ["citation-trace-structure"])

    def types_relaxed(row):
        # Explicit sensitivity, not a change to the requirement to preserve unknown's type.
        return citation_adjudicated(row) or row["reviewId"] == "R-9b65d5c1"

    profiles = {}
    for name, predicate in (("frozenMechanicalOnly", lambda row: row["machineAllCriticalPassed"]),
                            ("frozenMechanicalAndSemantic", primary),
                            ("traceableLocalComputedCitationsAccepted", citation_adjudicated),
                            ("alsoAllowUnknownCallbackReturnWidening", types_relaxed)):
        profiles[name] = {"arms": aggregate(records, predicate), "screen": screen(records, predicate)}

    categories = {}
    totals = {}
    for arm in ARMS:
        selected = [row for row in records if row["arm"] == arm]
        totals[arm] = {
            "elapsedMinutes": sum(row["elapsedMs"] for row in selected) / 60000,
            "medianTaskCostUsd": statistics.median(row["budget"]["estimatedCostUsd"] for row in selected),
            "usage": {key: sum(row["budget"][key] for row in selected) for key in selected[0]["budget"]},
            **{key: sum(row[key] for row in selected) for key in ("compactions", "workerCount", "reworks",
                "automaticContinuations", "operatorFollowupMessages", "injectedTransientError", "actualCrash", "restarts")},
            "budgetLimited": sum(row["execution"] == "budget_limited" for row in selected),
        }
        categories[arm] = {}
        for category in ("research", "files", "code"):
            subset = [row for row in selected if row["category"] == category]
            categories[arm][category] = {
                "attempts": len(subset), "strictDeliveries": sum(row["autonomousQualifiedDelivery"] for row in subset),
                "citationAdjudicatedDeliveries": sum(citation_adjudicated(row) and row["hostDeclaredComplete"] for row in subset),
                "estimatedCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in subset),
            }

    output = {
        "scope": "Six authored real-source tasks, three matched execution conditions, two repetitions; not out-of-box Pi CLI, not a population completion-rate estimate.",
        "model": frozen["model"], "piVersion": frozen["piVersion"], "harnessVersion": frozen["harnessVersion"],
        "goalDrivenCommit": frozen["goalDrivenCommit"], "budget": frozen["budget"],
        "rootToolSchemaSha256": json.loads((base / "execution-audit.json").read_text())["rootToolHashes"],
        "profiles": profiles, "totals": totals, "categories": categories, "runs": records,
        "assessmentNotes": [
            "Primary frozen grades and semantic review are unchanged; reporting added after review.",
            "URL-required-for-local-computed-citation check was stricter than TASK. Accepting traceable local rows adds runs 1 and 19 only.",
            "MRI unknown callback void->any is rejected under literal type preservation; allowing it adds run 24 only. Run 6 also added readonly fields.",
            "Uniform QuickLRU source review reproduced undefined-hit rotation, old expiresIn compatibility and maxAge=0 factory-return failures missed by finite frozen probes.",
            "Markdown multiline HTML and footnote inventory are ambiguous in the frozen grader; conservative scope recheck still fails all six. No repaired grader replaced original scores.",
            "Review labels partly masked; same author designed tasks and reviewed, not independent human double-blind assessment.",
            "Zero followups was fixed by design. Necessary human corrections were not measured and cannot be inferred from failed zero-message attempts.",
            "Pi ledger estimates include workers and compaction; exclude this Codex authoring/review, local CPU and possibly unreturned interrupted-request usage.",
            "No successful productive hour-long task, live web search, computer-use or goal-clarification usability is established by this experiment.",
        ],
    }
    payload = json.dumps(output, ensure_ascii=False, indent=2) + "\n"
    assert "/Users/" not in payload and ".env" not in payload and "api_key" not in payload.lower()
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "results.json").write_text(payload)
    columns = ["sequence", "task", "repeat", "arm", "reviewId", "execution", "machinePass", "semanticPass",
               "strictDelivery", "citationAdjudicatedDelivery", "estimatedCostUsd", "elapsedMinutes",
               "actualFollowupMessages", "requestsUserInput", "reworks", "compactions", "workers", "actualCrash"]
    with (destination / "runs.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        for row in records:
            writer.writerow(dict(zip(columns, [row["sequence"], row["task"], row["repeat"], row["arm"], row["reviewId"],
                row["execution"], row["machineAllCriticalPassed"], row["semanticAllCriticalPassed"],
                row["autonomousQualifiedDelivery"], citation_adjudicated(row) and row["hostDeclaredComplete"],
                row["budget"]["estimatedCostUsd"], row["elapsedMs"] / 60000, row["operatorFollowupMessages"],
                row["requestsUserInput"], row["reworks"], row["compactions"], row["workerCount"], row["actualCrash"]])))
    print(json.dumps({"attempts": len(records), "estimatedCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in records),
                      "profiles": {name: {arm: value["qualifiedDeliveries"] for arm, value in profile["arms"].items()}
                                   for name, profile in profiles.items()}}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study", type=pathlib.Path)
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    export(args.study.resolve(), args.destination.resolve())
