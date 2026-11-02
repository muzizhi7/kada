"""Read-only task checks; candidate builds/tests execute only in disposable copies."""
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import unicodedata
import zipfile

ROOT = Path(__file__).resolve().parent.parent
COLUMNS = ["source", "target", "kind", "source_sha256", "target_sha256", "source_bytes", "target_bytes", "changed"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def expected(incoming):
    rows, targets, directories, skipped = [], {}, set(), []
    for parent, dirs, files in os.walk(incoming, followlinks=False):
        for name in list(dirs):
            path = Path(parent) / name
            if path.is_symlink():
                skipped.append(path.relative_to(incoming).as_posix())
                dirs.remove(name)
            else:
                directories.add("normalized/" + path.relative_to(incoming).as_posix() + "/")
        for name in files:
            path = Path(parent) / name
            if path.is_symlink():
                skipped.append(path.relative_to(incoming).as_posix())
                continue
            if not path.is_file():
                continue
            source = path.relative_to(incoming).as_posix()
            raw = path.read_bytes()
            try:
                raw.decode("utf-8", errors="strict")
                assert b"\0" not in raw
                value = (raw[3:] if raw.startswith(b"\xef\xbb\xbf") else raw).replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                kind = "text"
            except (UnicodeError, AssertionError):
                value, kind = raw, "binary"
            target = "normalized/" + source
            targets[target] = value
            rows.append(dict(source=source, target=target, kind=kind, source_sha256=digest(raw), target_sha256=digest(value),
                             source_bytes=str(len(raw)), target_bytes=str(len(value)), changed=str(raw != value).lower()))
    rows.sort(key=lambda row: unicodedata.normalize("NFC", row["source"]))
    audit = dict(source_files=len(rows), text_files=sum(row["kind"] == "text" for row in rows),
                 binary_files=sum(row["kind"] == "binary" for row in rows), changed_files=sum(row["changed"] == "true" for row in rows),
                 source_bytes=sum(int(row["source_bytes"]) for row in rows), target_bytes=sum(int(row["target_bytes"]) for row in rows),
                 skipped_symlinks=sorted(skipped, key=lambda value: unicodedata.normalize("NFC", value)))
    return rows, targets, directories, audit


def validate(incoming, out):
    rows, targets, directories, audit = expected(incoming)
    with (out / "manifest.csv").open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == COLUMNS, "manifest columns/order"
        assert list(reader) == rows, "manifest differs from original bytes/classification/normalization"
    actual = {p.relative_to(out).as_posix() for p in (out / "normalized").rglob("*") if p.is_file()}
    assert actual == set(targets), "missing or stale normalized files"
    assert not any(p.is_symlink() for p in out.rglob("*")), "output symlink"
    for name, data in targets.items():
        assert (out / name).read_bytes() == data, "incorrect bytes: " + name
    for name in directories:
        assert (out / name).is_dir(), "missing input directory: " + name
    result = json.loads((out / "audit.json").read_text())
    for key, value in audit.items():
        assert result.get(key) == value, "audit mismatch: " + key
    index = (out / "INDEX.md").read_text()
    for text in ["manifest.csv", "audit.json", "release.zip", "incoming", "normalized/LICENSE.txt"]:
        assert text in index, "INDEX handover link/original location missing: " + text
    for key in ["source_files", "text_files", "binary_files", "changed_files", "source_bytes", "target_bytes"]:
        match = re.search(re.escape(key) + r"[^\d\n]*([\d][\d, _\u00a0]*)", index)
        assert match and int(re.sub(r"\D", "", match.group(1))) == audit[key], "INDEX statistic mismatch: " + key
    assert re.search(r"不可逆|不能.*还原|not.*(?:backup|revers)|cannot.*(?:recover|restor)", index, re.I), "INDEX must explain lossy normalization"
    members = {*targets, "manifest.csv", "audit.json", "INDEX.md"}
    with zipfile.ZipFile(out / "release.zip") as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        assert len(names) == len(set(names)), "duplicate ZIP members"
        assert {entry.filename for entry in entries if not entry.is_dir()} == members, "ZIP file members differ"
        for entry in entries:
            assert not entry.filename.startswith("/") and ".." not in Path(entry.filename).parts, "unsafe ZIP path"
            assert entry.compress_type == zipfile.ZIP_STORED, "ZIP_STORED required"
            if not entry.is_dir():
                assert archive.read(entry) == (out / entry.filename).read_bytes(), "ZIP member bytes differ"
        empty = [name for name in directories if not any(target.startswith(name) for target in targets)]
        assert all(name in names for name in empty), "empty directories missing from ZIP"
    return audit


def command(args, cwd, success=True):
    env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT"}}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=45)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise AssertionError("candidate command timed out")
    assert (process.returncode == 0) == success, output.decode(errors="replace")[-2500:]
    return output.decode(errors="replace")


def original_bytes(path):
    return sorted((p.relative_to(path).as_posix(), digest(p.read_bytes())) for p in path.rglob("*") if p.is_file() and not p.is_symlink())


def main():
    original = validate(ROOT / "incoming", ROOT / "deliverables")
    assert (ROOT / "deliverables/release.zip").stat().st_size > 1048576, "real source package must exceed 1 MiB"
    delivered = (ROOT / "deliverables/release.zip").read_bytes()
    compile((ROOT / "project/build.py").read_text(), "build.py", "exec")
    assert (ROOT / "README.md").stat().st_size > 0, "missing README"
    with tempfile.TemporaryDirectory(prefix="handover-check-") as temp:
        work = Path(temp) / "workspace"
        shutil.copytree(ROOT, work, symlinks=True)
        shutil.rmtree(work / "deliverables")
        sentinel = work / "unrelated.txt"
        sentinel.write_text("preserve")
        args = [sys.executable, str(work / "project/build.py"), "--inputs", str(work / "incoming"), "--out", str(work / "fresh")]
        def rebuild():
            before = original_bytes(work / "incoming")
            command(args, work)
            assert original_bytes(work / "incoming") == before, "builder changed original input bytes"
        rebuild()
        validate(work / "incoming", work / "fresh")
        assert (work / "fresh/release.zip").read_bytes() == delivered, "ZIP differs across output directories"
        rebuild()
        assert (work / "fresh/release.zip").read_bytes() == delivered, "ZIP differs on repeat"
        (work / "incoming/_edge_cases/crlf.txt").write_bytes(b"\xef\xbb\xbfnew\r\nvalue\rend\n")
        (work / "incoming/_edge_cases/invalid.bin").write_bytes(b"\xffchanged\r\n")
        added = work / "incoming/added.txt"
        added.write_bytes(b"added\r\n")
        rebuild()
        validate(work / "incoming", work / "fresh")
        added.unlink()
        shutil.rmtree(work / "incoming/_edge_cases/empty-dir")
        rebuild()
        validate(work / "incoming", work / "fresh")
        assert not (work / "fresh/normalized/_edge_cases/empty-dir").exists(), "stale empty directory"
        assert sentinel.read_text() == "preserve", "unrelated file changed"
        before = original_bytes(work / "incoming")
        command([*args[:-1], str(work / "incoming")], work, success=False)
        assert original_bytes(work / "incoming") == before, "overlap refusal changed inputs"
    with tempfile.TemporaryDirectory(prefix="handover-tests-") as temp:
        work = Path(temp) / "workspace"
        shutil.copytree(ROOT, work, symlinks=True)
        output = command([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], work)
        match = re.search(r"Ran (\d+) tests?", output)
        assert match and int(match.group(1)) >= 5, "need at least five executed unittest cases"
    print(json.dumps({"passed": True, "actualBytesAndZip": True, "freshRepeatChangedDeleted": True,
                      "ownTestsExecuted": int(match.group(1)), **original}, ensure_ascii=False))


if __name__ == "__main__":
    main()
