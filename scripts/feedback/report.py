"""Post-review export only; does not change frozen checks or candidates."""
import csv
import json
from pathlib import Path
import statistics
import sys

base = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
raw = json.loads((base / "results.json").read_text())
semantic = {row["sequence"]: row for row in json.loads((base / "semantic-review.json").read_text())["runs"]}
audit = {row["sequence"]: row for row in json.loads((base / "submission-audit.json").read_text())}
sensitivity = json.loads((base / "bundle-sensitivity.json").read_text())
bundles = {row["reviewId"]: row for row in sensitivity["runs"]}
assert len(raw) == len(semantic) == len(audit) == 8
records = []
for row in raw:
    judgment = semantic[row["sequence"]]
    assert all(type(judgment[key]) is bool for key in ["allCriticalPassed", "claimsComplete", "requestsUserInput"])
    grade = json.loads((Path(row["directory"]) / "grade.json").read_text())
    failed = [item["id"] for item in grade["checks"] if not item["passed"]]
    bundle = bundles.get(judgment["reviewId"])
    # Uniform task-level interpretation, not an arm-specific exemption. Never
    # erase the frozen failure or pardon a mismatch inside the actual bundle.
    corrected = (row["category"] == "files" and
                 failed == ["fresh-idempotent-and-changed-input-build"] and
                 bundle is not None and bundle["allPassed"])
    adjudicated = grade["machineAllCriticalPassed"] or corrected
    strict_artifact = grade["machineAllCriticalPassed"] and judgment["allCriticalPassed"]
    artifact = adjudicated and judgment["allCriticalPassed"]
    delivered = artifact and row["hostDeclaredComplete"]
    records.append({**{key: row[key] for key in ["sequence", "task", "category", "arm", "repeat", "execution", "budget", "elapsedMs",
        "workerCount", "compactions", "reworks", "operatorFollowupMessages", "hostDeclaredComplete", "maxReworks", "instructionsSha256"]},
        "reviewId": judgment["reviewId"], "machinePass": grade["machineAllCriticalPassed"], "semanticPass": judgment["allCriticalPassed"],
        "strictArtifactPass": strict_artifact,
        "strictQualifiedDelivery": strict_artifact and row["hostDeclaredComplete"],
        "adjudicatedMachinePass": adjudicated, "bundleInterpretationApplied": corrected,
        "artifactPass": artifact, "qualifiedDelivery": delivered,
        "wrongHostCompletion": row["hostDeclaredComplete"] and not artifact,
        "wrongModelCompletionClaim": judgment["claimsComplete"] and not artifact,
        "goodArtifactNotDelivered": artifact and not row["hostDeclaredComplete"],
        "requestsUserInput": bool(row.get("userInformationRequests")) or judgment["requestsUserInput"],
        "feedbackMessages": audit[row["sequence"]]["admittedFeedbackMessages"],
        "rejectedSubmissions": row["automaticContinuations"],
        "failedChecks": failed, "evidence": judgment["evidence"]})
summary = {}
for arm in ["pi", "extension"]:
    selected = [row for row in records if row["arm"] == arm]
    summary[arm] = {"attempts": len(selected),
        **{key: sum(row[key] for row in selected) for key in ["machinePass", "strictArtifactPass", "strictQualifiedDelivery",
            "adjudicatedMachinePass", "bundleInterpretationApplied", "semanticPass", "artifactPass", "qualifiedDelivery", "wrongHostCompletion",
            "wrongModelCompletionClaim", "goodArtifactNotDelivered", "requestsUserInput", "feedbackMessages", "rejectedSubmissions", "compactions", "workerCount", "operatorFollowupMessages"]},
        "estimatedCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in selected),
        "failedDeliveryAttemptCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in selected if not row["qualifiedDelivery"]),
        "medianTaskCostUsd": statistics.median(row["budget"]["estimatedCostUsd"] for row in selected),
        "elapsedMinutes": sum(row["elapsedMs"] for row in selected) / 60000,
        "tokens": {key: sum(row["budget"][key] for row in selected) for key in ["totalTokens", "cachedTokens", "inputTokens", "outputTokens"]}}
pairs = []
wins = []
artifact_wins = []
for task in sorted({row["task"] for row in records}):
    delivery_improved, artifact_improved = [], []
    for repeat in [1, 2]:
        cell = {row["arm"]: row for row in records if row["task"] == task and row["repeat"] == repeat}
        p, e = cell["pi"], cell["extension"]
        delivery_improved.append(e["qualifiedDelivery"] and not p["qualifiedDelivery"])
        artifact_improved.append(e["artifactPass"] and not p["artifactPass"])
        if p["qualifiedDelivery"] and e["qualifiedDelivery"]:
            pairs.append({"task": task, "repeat": repeat, "costRatio": e["budget"]["estimatedCostUsd"] / p["budget"]["estimatedCostUsd"]})
    if all(delivery_improved):
        wins.append(task)
    if all(artifact_improved):
        artifact_wins.append(task)
prior = json.loads((base / "prior-cost.json").read_text())
frozen = json.loads((base / "frozen.json").read_text())
output = {"scope": "Matched production Pi adapters, automatic feedback off/on only; not stock Pi CLI. Two tasks, two repetitions. Initial batch invalidated wholesale for shared TS helper defect.",
          "model": frozen["model"], "piVersion": frozen["piVersion"], "harnessVersion": frozen["harnessVersion"],
          "summary": summary, "records": records, "pairedSuccessfulRuns": pairs,
          "medianPairedSuccessCostRatio": statistics.median(row["costRatio"] for row in pairs) if pairs else None,
          "repeatedQualifiedDeliveryWins": wins, "repeatedArtifactQualityWins": artifact_wins,
          "bundleSensitivity": sensitivity,
          "validTrialEstimatedCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in records),
          "invalidatedAttempts": {key: prior[key] for key in ["completedAttempts", "interruptedAttempts", "completedEstimatedCostUsd", "interruptedRecordedEstimatedCostUsd", "recordedEstimatedCostUsd", "budgetChargeUsd"]},
          "combinedRecordedEstimatedCostUsd": sum(row["budget"]["estimatedCostUsd"] for row in records) + prior["recordedEstimatedCostUsd"],
          "combinedConservativeBudgetChargeUsd": sum(row["budget"]["estimatedCostUsd"] for row in records) + prior["budgetChargeUsd"],
          "notes": ["Actual external followups fixed to zero; minimum necessary correction count not measured.",
                    "Raw mechanical grades and explicit semantic review are separate; review partly masked, by task author, not independent human double-blind.",
                    "Quality gain is distinct from filling required submission fields or verification metadata.",
                    "Strict frozen output-tree equality and uniformly adjudicated declared-bundle equality are both reported; an unshipped local marker cannot excuse a changed INDEX or ZIP.",
                    "Pi model ledger includes failed attempts, workers and compaction, excludes this Codex development/review and local CPU; interrupted unreturned calls may lack usage.",
                    "Known faulty large-ZIP gate replay is a regression, not a new task-quality win; no productive hour/computer/open-search validation."]}
payload = json.dumps(output, ensure_ascii=False, indent=2) + "\n"
assert "/Users/" not in payload and "api_key" not in payload.lower() and "Bearer " not in payload
destination.mkdir(parents=True, exist_ok=True)
(destination / "results.json").write_text(payload)
columns = ["sequence", "task", "repeat", "arm", "execution", "machinePass", "strictQualifiedDelivery", "bundleInterpretationApplied",
           "semanticPass", "artifactPass", "qualifiedDelivery", "wrongHostCompletion", "goodArtifactNotDelivered", "feedbackMessages", "requestsUserInput"]
with (destination / "runs.csv").open("w", newline="") as stream:
    writer = csv.DictWriter(stream, fieldnames=[*columns, "estimatedCostUsd", "elapsedMinutes"])
    writer.writeheader()
    for row in records:
        writer.writerow({**{key: row[key] for key in columns}, "estimatedCostUsd": row["budget"]["estimatedCostUsd"], "elapsedMinutes": row["elapsedMs"] / 60000})
print(json.dumps({"summary": summary, "validTrialEstimatedCostUsd": output["validTrialEstimatedCostUsd"], "combinedRecordedEstimatedCostUsd": output["combinedRecordedEstimatedCostUsd"],
                  "repeatedQualifiedDeliveryWins": wins, "repeatedArtifactQualityWins": artifact_wins, "pairs": pairs}, ensure_ascii=False, indent=2))
