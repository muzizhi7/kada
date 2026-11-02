"""Combine frozen controls, independent grades and audited usage; no model calls."""
import hashlib
import json
import pathlib
import sys

main, corrected = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:3])
manifests = [json.loads((p / "manifest.json").read_text()) for p in (main, corrected)]
for key in ("model", "piVersion", "maxDurationMs", "maxEstimatedCostUsd", "maxSubagents", "objectiveSha256", "fixture", "compaction", "toolSchemaSha256"):
    assert manifests[0][key] == manifests[1][key], "Control mismatch: " + key

required = ["deliverables/normalized.csv", "deliverables/market_metrics.csv", "deliverables/scenarios_2027.csv", "deliverables/audit.json", "deliverables/claims.csv", "deliverables/report.md", "deliverables/checks.json", "build.py", "tests/test_pipeline.py", "README.md"]
required += ["deliverables/charts/" + name + ".svg" for name in ("sales-trend", "share-trend", "sales-vs-stock", "scenarios-2027")]
records = []
for label, folder in [("pi", main / "pi"), ("prompt", corrected / "prompt"), ("extension", main / "extension"), ("prompt_pilot", main / "prompt")]:
    result = json.loads((folder / "result.json").read_text())
    observation = json.loads((folder / "observations.json").read_text())
    grade = json.loads((folder / "grade.json").read_text())
    adjudication = json.loads((folder / "adjudication.json").read_text())
    manual = json.loads((folder / "manual.json").read_text())
    limits = {"evidence": 2, "facts": 3, "analysis": 2, "coverage": 2, "charts": 1}
    assert all(0 <= manual[k] <= limit for k, limit in limits.items())
    assert grade["machine_max"] == 90
    score = round(adjudication["adjudicated_machine_score"] + sum(manual[k] for k in limits), 3)
    missing = [p for p in required if not (folder / "workspace" / p).is_file()]
    rubric_passed = not grade["critical_failures"] and not missing and score >= 90
    usage = result["budget"]
    records.append({"arm": label, "folder": str(folder), "execution": result["execution"], "score": score,
                    "machine_score": adjudication["adjudicated_machine_score"], "machine_score_original": grade["machine_score"], "manual_score": sum(manual[k] for k in limits),
                    "rubric_passed": rubric_passed,
                    "full_contract_passed": manual["full_contract_passed"],
                    "unresolved_findings": manual["unresolved_findings"],
                    "correction_messages_required": manual["correction_messages_required"],
                    "unattended_rubric_qualified": rubric_passed and observation["operatorFollowupMessages"] == 0 and result["execution"] in ("done", "completed"),
                    "critical_failures": grade["critical_failures"], "missing": missing,
                    "elapsed_seconds": round(result["elapsedMs"] / 1000, 3), **usage,
                    "cost_without_prompt_cache_usd": round((usage["inputTokens"] + usage["cachedTokens"]) * manifests[0]["modelCost"]["input"] / 1e6 + usage["outputTokens"] * manifests[0]["modelCost"]["output"] / 1e6, 6),
                    "operator_followups": observation["operatorFollowupMessages"], "user_information_requests": result["userInformationRequests"],
                    "workers": observation["workers"], "compactions": observation["compactionsAllConversations"], "tool_calls": observation["totalToolCalls"],
                    "automatic_continuations": result["automaticContinuations"], "post_supervisor_tools": observation["postSupervisorTools"],
                    "tool_schema_sha256": observation["rootToolSchemaSha256"], "manual_notes": manual.get("notes", [])})
assert len({r["tool_schema_sha256"] for r in records}) == 1, "Actual tool schemas differed"
summary = {"controls_match": True, "model": manifests[0]["model"], "formal": records[:3], "pilot": records[3],
           "formal_estimated_cost_usd": sum(r["estimatedCostUsd"] for r in records[:3]),
           "total_estimated_cost_with_pilot_usd": sum(r["estimatedCostUsd"] for r in records),
           "note": "One real task, one formal run per arm. A >=90 rubric score does not mean every requirement is met. All reports retain material defects; the additional messages needed to correct them were not measured. Prompt placement pilot kept separately; no general success-rate or causal component claim."}
(main / "comparison-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
