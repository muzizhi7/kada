"""Public, read-only acceptance for the normalized source handover task (stdlib)."""
import csv
import hashlib
import json
import os
from pathlib import Path
import sys
import unicodedata
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def order(value):
    return unicodedata.normalize("NFC", value)


def inventory(root):
    rows, targets, skipped = [], {}, []
    incoming = root / "incoming"
    for directory, dirs, files in os.walk(incoming, followlinks=False):
        for name in list(dirs):
            path = Path(directory) / name
            if path.is_symlink():
                skipped.append(path.relative_to(incoming).as_posix())
                dirs.remove(name)
        for name in files:
            path = Path(directory) / name
            source = path.relative_to(incoming).as_posix()
            if path.is_symlink():
                skipped.append(source)
                continue
            if not path.is_file():
                continue
            raw = path.read_bytes()
            try:
                raw.decode("utf-8", errors="strict")
                if b"\x00" in raw:
                    raise ValueError("NUL")
                kind = "text"
                value = raw[3:] if raw.startswith(b"\xef\xbb\xbf") else raw
                value = value.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            except (UnicodeDecodeError, ValueError):
                kind, value = "binary", raw
            target = "normalized/" + source
            targets[target] = value
            rows.append(dict(source=source, target=target, kind=kind, source_sha256=sha(raw), target_sha256=sha(value),
                             source_bytes=str(len(raw)), target_bytes=str(len(value)), changed=str(raw != value).lower()))
    rows.sort(key=lambda row: order(row["source"]))
    audit = dict(source_files=len(rows), text_files=sum(row["kind"] == "text" for row in rows),
                 binary_files=sum(row["kind"] == "binary" for row in rows), changed_files=sum(row["changed"] == "true" for row in rows),
                 source_bytes=sum(int(row["source_bytes"]) for row in rows), target_bytes=sum(int(row["target_bytes"]) for row in rows),
                 skipped_symlinks=sorted(skipped, key=order))
    return rows, targets, audit


def validate(root, out=None):
    root = Path(root).resolve()
    out = Path(out or root / "deliverables").resolve()
    rows, targets, expected_audit = inventory(root)
    expected_columns = ["source", "target", "kind", "source_sha256", "target_sha256", "source_bytes", "target_bytes", "changed"]
    with (out / "manifest.csv").open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == expected_columns, "manifest columns/order differ"
        actual = list(reader)
    assert actual == rows, "manifest differs from independently read original bytes/normalization"
    for name, data in targets.items():
        assert (out / name).read_bytes() == data, "wrong normalized bytes: " + name
    actual_targets = {path.relative_to(out).as_posix() for path in (out / "normalized").rglob("*") if path.is_file()}
    assert actual_targets == set(targets), "missing/extra normalized regular files"
    assert not any(path.is_symlink() for path in out.rglob("*")), "output symlink"
    audit = json.loads((out / "audit.json").read_text())
    for key, value in expected_audit.items():
        assert audit.get(key) == value, "audit mismatch: " + key
    index = (out / "INDEX.md").read_text()
    assert "manifest.csv" in index and "release.zip" in index and "LICENSE" in index, "INDEX handover links/license missing"
    members = {*targets, "manifest.csv", "audit.json", "INDEX.md"}
    with zipfile.ZipFile(out / "release.zip") as archive:
        items = [info for info in archive.infolist() if not info.is_dir()]
        assert len(items) == len(members) and {item.filename for item in items} == members, "ZIP file members differ"
        for item in items:
            assert item.compress_type == zipfile.ZIP_STORED, "ZIP must use STORED"
            assert not item.filename.startswith("/") and ".." not in Path(item.filename).parts, "unsafe ZIP name"
            assert archive.read(item) == (out / item.filename).read_bytes(), "ZIP bytes differ: " + item.filename
    assert (out / "release.zip").stat().st_size > 1048576, "actual corpus ZIP should exceed 1 MiB"
    return expected_audit


if __name__ == "__main__":
    result = validate(Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd())
    print(json.dumps({"checked": "actual bytes, manifest, normalization, audit, ZIP members", **result}, ensure_ascii=False))
