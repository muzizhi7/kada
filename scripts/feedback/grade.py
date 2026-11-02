"""Frozen post-execution checks. Run only after reviewing candidate code scope."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import hashlib

base = Path(sys.argv[1]).resolve()
assert "--reviewed" in sys.argv, "Review candidate build/code/tests before executing them in temporary copies"
scripts = Path(__file__).resolve().parent
tasks = {row["id"]: row for row in json.loads((base / "tasks.json").read_text())}
spec = importlib.util.spec_from_file_location("release_oracle", scripts / "check-release.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
environment = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SHELL"}}
environment["PYTHONDONTWRITEBYTECODE"] = "1"


def tree(root):
    result = {}
    if root.is_file():
        return {"": hashlib.sha256(root.read_bytes()).hexdigest()}
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name != "__pycache__"]
        for name in [*files, *dirs]:
            path = Path(directory) / name
            key = path.relative_to(root).as_posix()
            if path.is_symlink():
                result[key] = "symlink:" + os.readlink(path)
                if name in dirs:
                    dirs.remove(name)
            elif path.is_file() and name != ".DS_Store":
                result[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def command(args, cwd, log, seconds=45):
    process = subprocess.Popen(args, cwd=cwd, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        data, _ = process.communicate(timeout=seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        data, _ = process.communicate()
        Path(log).write_bytes(data)
        raise AssertionError("Evaluation command timed out; its process group was stopped")
    Path(log).write_bytes(data)
    assert process.returncode == 0, "command exit " + str(process.returncode) + ": " + data.decode(errors="replace")[-2500:]
    return data.decode(errors="replace")


for run in json.loads((base / "results.json").read_text()):
    root = Path(run["directory"]) / "workspace"
    fixture = base / "fixtures" / run["task"]
    logs = base / "evaluation-logs" / str(run["sequence"])
    logs.mkdir(parents=True, exist_ok=True)
    checks = []

    def check(name, action):
        try:
            action()
            checks.append(dict(id=name, passed=True))
        except Exception as error:
            checks.append(dict(id=name, passed=False, detail=str(error)[:3000]))

    def immutable():
        for name in tasks[run["task"]]["readonly"]:
            assert tree(root / name) == tree(fixture / name), "readonly input differs: " + name
        if run["category"] == "code":
            original, changed = tree(fixture / "project"), tree(root / "project")
            allowed = set(tasks[run["task"]]["mutableProject"])
            assert all(original.get(name) == changed.get(name) for name in original.keys() | changed.keys() if name not in allowed), "unrelated project files changed"
    check("input-and-scope-integrity", immutable)
    required = json.loads((fixture / "BRIEF.json").read_text())["deliverables"]
    check("required-artifacts", lambda: [(_ for _ in ()).throw(AssertionError("missing/empty artifact: " + name))
                                          for name in required if not (root / name).is_file() or not (root / name).stat().st_size])

    with tempfile.TemporaryDirectory(prefix="pi-feedback-grade-") as directory:
        work = Path(directory) / "workspace"
        shutil.copytree(root, work, symlinks=True)
        if run["category"] == "files":
            check("actual-normalized-package", lambda: oracle.validate(work))

            def rebuild():
                out = work / "fresh-output"
                if (work / "deliverables").exists():
                    shutil.rmtree(work / "deliverables")
                sentinel = work / "unrelated-sentinel.txt"
                sentinel.write_text("preserve")
                args = ["python3", str(work / "build.py"), "--inputs", str(work / "incoming"), "--out", str(out)]
                command(args, work, logs / "fresh-build.log")
                oracle.validate(work, out)
                # Includes ZIP bytes, not just extracted content. Compare to the final delivered package.
                assert tree(out) == tree(root / "deliverables"), "fresh output differs from delivered package"
                before = tree(out)
                command(args, work, logs / "repeat-build.log")
                assert tree(out) == before, "repeat build changed bytes"
                assert sentinel.read_text() == "preserve", "builder changed an unrelated file"
                edge = work / "incoming/_edge_cases/crlf.txt"
                edge.write_bytes(b"\xef\xbb\xbfnew\r\nvalue\rend\n")
                binary = work / "incoming/_edge_cases/invalid.bin"
                binary.write_bytes(b"\xffchanged\r\n")
                extra = work / "incoming/new-input.txt"
                extra.write_bytes(b"added\r\n")
                command(args, work, logs / "changed-build.log")
                oracle.validate(work, out)
                extra.unlink()
                command(args, work, logs / "removed-input-build.log")
                oracle.validate(work, out)
                assert sentinel.read_text() == "preserve"
            check("fresh-idempotent-and-changed-input-build", rebuild)

            def own_tests():
                output = command(["python3", "-m", "unittest", "discover", "-s", "tests", "-v"], work, logs / "own-tests.log")
                count = re.search(r"Ran (\d+) tests?", output)
                assert count and int(count.group(1)) >= 5, "fewer than five executed unittest cases"
            # A clean copy prevents prior mutation probes from becoming the suite's real inputs.
            shutil.rmtree(work)
            shutil.copytree(root, work, symlinks=True)
            check("own-tests-actually-executed", own_tests)
        else:
            check("public-behavior", lambda: command(["node", "--test", "acceptance/clsx-public.test.mjs"], work, logs / "public-tests.log"))
            check("typescript-contract", lambda: command(["node", "tools/typecheck.mjs"], work, logs / "types.log"))

            def probes():
                command(["node", str(scripts / "code-probes.mjs"), str(work), str(base / "sources/clsx"), str(logs / "code-probes.json")], work, logs / "code-probes.log")
                report = json.loads((logs / "code-probes.json").read_text())
                assert all(row["passed"] for row in report["checks"]), json.dumps([row for row in report["checks"] if not row["passed"]], ensure_ascii=False)
            check("frozen-external-behavior", probes)

            def own_tests():
                files = [path for path in (work / "tests").rglob("*") if path.is_file() and path.suffix in {".mjs", ".cjs", ".js", ".ts"}
                         and ("test" in path.name or "spec" in path.name)]
                assert files, "no self-authored Node tests found"
                output = command(["node", "--test", *map(str, files)], work, logs / "own-tests.log")
                count = re.search(r"(?:# |ℹ )?tests (\d+)", output)
                assert count and int(count.group(1)) >= 5, "fewer than five executed Node test cases"
            check("own-tests-actually-executed", own_tests)
    grade = dict(task=run["task"], checks=checks, machineAllCriticalPassed=all(row["passed"] for row in checks), semanticReviewRequired=True)
    (Path(run["directory"]) / "grade.json").write_text(json.dumps(grade, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"sequence": run["sequence"], "machinePassed": grade["machineAllCriticalPassed"], "failed": [row["id"] for row in checks if not row["passed"]]}), flush=True)
