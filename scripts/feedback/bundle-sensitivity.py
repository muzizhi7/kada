"""Post-run sensitivity: compare the specified bundle, retain frozen raw grades.

The frozen grader compares every output file, including unshipped builder state.
This uniformly checks the task's declared bundle for all four file attempts.
Review candidate source before invoking; never run on original workspaces.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile

base = Path(sys.argv[1]).resolve()
assert "--reviewed" in sys.argv
spec = importlib.util.spec_from_file_location("oracle", base / "frozen/scripts/feedback/check-release.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
mapping = json.loads((base / "review-private-map.json").read_text())
runs = {row["sequence"]: row for row in json.loads((base / "results.json").read_text())}
allowed = {"normalized", "manifest.csv", "audit.json", "INDEX.md", "release.zip"}
environment = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"}}
environment["PYTHONDONTWRITEBYTECODE"] = "1"
copies = base / "evaluation-copies"
copies.mkdir(exist_ok=True)


def tree(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file() and not p.is_symlink()
            and p.relative_to(root).parts[0] in allowed}


def build(work, out):
    proc = subprocess.Popen(["python3", str(work / "build.py"), "--inputs", str(work / "incoming"), "--out", str(out)],
                            cwd=work, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        data, _ = proc.communicate(timeout=45)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise AssertionError("builder timed out")
    assert proc.returncode == 0, data.decode(errors="replace")[-2000:]
    oracle.validate(work, out)


records = []
for token in mapping:
    row = runs[mapping[token]]
    if row["category"] != "files":
        continue
    root = Path(row["directory"]) / "workspace"
    result = {"reviewId": token, "task": row["task"], "checks": []}

    def check(name, action):
        try:
            assert action() is not False, name
            result["checks"].append({"id": name, "passed": True})
        except Exception as error:
            detail = str(error).replace(str(base), "STUDY")
            result["checks"].append({"id": name, "passed": False, "detail": detail[:2000]})

    with tempfile.TemporaryDirectory(prefix="bundle-sensitivity-", dir=copies) as directory:
        work = Path(directory) / "workspace"
        shutil.copytree(root, work, symlinks=True)
        delivered = tree(root / "deliverables")
        check("delivered-package-oracle", lambda: oracle.validate(work))
        shutil.rmtree(work / "deliverables")
        out = work / "fresh-output"
        sentinel = work / "unrelated-sentinel.txt"
        sentinel.write_text("preserve")
        check("fresh-output-oracle", lambda: build(work, out))
        fresh = tree(out)
        result["changedBundleFilesAcrossOutputDirectories"] = sorted(name for name in delivered.keys() | fresh.keys() if delivered.get(name) != fresh.get(name))
        result["unshippedLocalStateFiles"] = sorted(p.relative_to(out).as_posix() for p in out.rglob("*")
                                                     if p.is_file() and p.relative_to(out).parts[0] not in allowed)
        check("declared-bundle-and-zip-identical-across-output-directories", lambda: fresh == delivered)
        check("repeat-output-oracle", lambda: build(work, out))
        check("repeat-bundle-identical", lambda: tree(out) == fresh)
        (work / "incoming/_edge_cases/crlf.txt").write_bytes(b"\xef\xbb\xbfnew\r\nvalue\rend\n")
        (work / "incoming/_edge_cases/invalid.bin").write_bytes(b"\xffchanged\r\n")
        extra = work / "incoming/new-input.txt"
        extra.write_bytes(b"added\r\n")
        check("changed-and-added-input-oracle", lambda: build(work, out))
        extra.unlink()
        check("deleted-input-and-stale-output-oracle", lambda: build(work, out))
        check("unrelated-file-preserved", lambda: sentinel.read_text() == "preserve")
    result["allPassed"] = all(item["passed"] for item in result["checks"])
    records.append(result)

assert len(records) == 4
output = {"method": "Uniform post-run interpretation of the specified bundle for all four file attempts; raw frozen grades remain unchanged. Excludes only local state files not shipped in the ZIP. Candidate programs were reviewed and run in disposable copies.", "runs": records}
(base / "bundle-sensitivity.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(output, ensure_ascii=False, indent=2))
