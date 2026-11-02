"""Legacy source handover builder. Repair this CLI without adding dependencies."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import zipfile


def build(inputs, out):
    inputs, out = Path(inputs), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for source in sorted(inputs.rglob("*")):
        if not source.is_file() or source.name.startswith(".") or source.stat().st_size == 0:
            continue
        raw = source.read_bytes()
        value = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").encode("utf-8")
        name = source.relative_to(inputs).as_posix()
        target = out / "normalized" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)
        rows.append(dict(source=name, target="normalized/" + name, kind="text",
                         source_sha256=hashlib.sha256(raw).hexdigest(), target_sha256=hashlib.sha256(value).hexdigest(),
                         source_bytes=len(raw), target_bytes=len(value), changed=str(raw != value).lower()))
    columns = ["source", "target", "kind", "source_sha256", "target_sha256", "source_bytes", "target_bytes", "changed"]
    with (out / "manifest.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, columns)
        writer.writeheader()
        writer.writerows(rows)
    (out / "audit.json").write_text(json.dumps({"source_files": len(rows)}), encoding="utf-8")
    (out / "INDEX.md").write_text("# Exact backup\nThis restores all original bytes.\n", encoding="utf-8")
    with zipfile.ZipFile(out / "release.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(out.rglob("*")):
            if path.is_file() and path.name != "release.zip":
                archive.write(path, path.relative_to(out))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", default="incoming")
    parser.add_argument("--out", default="deliverables")
    args = parser.parse_args()
    build(args.inputs, args.out)
