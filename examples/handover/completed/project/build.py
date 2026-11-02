"""Build a handover package from a mixed binary/text source tree.

Python 3.9+ standard library only. This module is a plain CLI:

    python3 project/build.py --inputs incoming --out deliverables

What it does (see README.md for the full contract):

* Walks every regular file below ``--inputs`` without following symlinks.
  Hidden files, empty files, relative paths and empty directories are kept;
  symlinks are counted as ``skipped_symlinks`` and never followed.
* A file is *text* when its raw bytes decode as strict UTF-8 and contain no
  NUL byte (the empty file is text).  Text loses at most one leading BOM and
  then has CRLF -> LF and lone CR -> LF applied; nothing else changes.
  Everything else is *binary* and is copied byte for byte.
* Writes ``manifest.csv`` (fixed 8 columns, sorted by NFC form of the source
  path), ``audit.json`` (statistics recounted from disk), ``INDEX.md`` and a
  ``release.zip`` (ZIP_STORED, fixed metadata, fixed order) whose members are
  exactly the normalized tree plus the three handover files.
* Rebuilds are deterministic: the same input produces the same ZIP bytes in
  the default directory and in any other fresh output directory.
* Every rebuild first removes stale output *inside* ``--out`` only, and
  refuses to run when ``--inputs`` and ``--out`` overlap.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import unicodedata
import zipfile

COLUMNS = [
    "source",
    "target",
    "kind",
    "source_sha256",
    "target_sha256",
    "source_bytes",
    "target_bytes",
    "changed",
]

BOM = b"\xef\xbb\xbf"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
ZIP_FILE_MODE = 0o100644
ZIP_DIR_MODE = 0o40755
AUDIT_KEYS = [
    "source_files",
    "text_files",
    "binary_files",
    "changed_files",
    "source_bytes",
    "target_bytes",
    "skipped_symlinks",
]


class BuildError(Exception):
    """Raised for usage problems such as overlapping input/output paths."""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def classify(raw):
    """Return (kind, value) for original bytes.

    ``kind`` is ``"text"`` when the bytes are strict UTF-8 without NUL, and
    ``"binary"`` otherwise.  Text is normalized as described by the module
    docstring; binary keeps its exact bytes.
    """
    try:
        raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return "binary", raw
    if b"\0" in raw:
        return "binary", raw
    value = raw[len(BOM):] if raw.startswith(BOM) else raw
    value = value.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return "text", value


def nfc(name):
    return unicodedata.normalize("NFC", name)


def walk_inputs(inputs):
    """Collect (files, directories, skipped) for ``inputs`` without following links.

    ``files`` is a list of (relative POSIX source path, absolute Path) and
    ``directories`` a sorted list of relative POSIX directory paths; an
    empty string stands for the input root itself and is not emitted.
    """
    inputs = Path(inputs)
    files, directories, skipped = [], [], []
    for parent, dirnames, filenames in os.walk(inputs, followlinks=False):
        parent_path = Path(parent)
        keep = []
        for name in sorted(dirnames):
            path = parent_path / name
            if path.is_symlink():
                skipped.append(path.relative_to(inputs).as_posix())
            else:
                keep.append(name)
                directories.append(path.relative_to(inputs).as_posix())
        dirnames[:] = keep
        for name in sorted(filenames):
            path = parent_path / name
            rel = path.relative_to(inputs).as_posix()
            if path.is_symlink():
                skipped.append(rel)
                continue
            if path.is_file():
                files.append((rel, path))
    files.sort(key=lambda item: nfc(item[0]))
    directories.sort(key=nfc)
    skipped.sort(key=nfc)
    return files, directories, skipped


def check_paths(inputs, out):
    inputs, out = Path(inputs), Path(out)
    if not inputs.is_dir():
        raise BuildError("input directory does not exist: %s" % inputs)
    a = inputs.resolve()
    b = out.resolve()
    if a == b or a in b.parents or b in a.parents:
        raise BuildError(
            "input %s and output %s overlap; choose an output outside the input tree" % (a, b)
        )


def clean_output(out):
    """Remove stale products inside ``out`` only, then recreate it."""
    out = Path(out)
    for name in ["normalized", "manifest.csv", "audit.json", "INDEX.md", "release.zip"]:
        path = out / name
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    # Anything else left in a previous build is stale too; it is still
    # strictly inside --out, which the caller has checked against --inputs.
    if out.is_dir():
        for child in sorted(out.iterdir()):
            if child.is_symlink() or child.is_file():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
    out.mkdir(parents=True, exist_ok=True)


def render_index(audit, lines, license_note):
    def stat(key):
        return "{:,}".format(audit[key])

    text = [
        "# Handover index: normalized Click source snapshot",
        "",
        "This directory is a *normalized* handover copy of the material in the",
        "original `incoming/` tree. The originals stay in `incoming/`; this copy",
        "is not a byte-for-byte backup of them.",
        "",
        "## Statistics (recounted from the files on disk)",
        "",
        "| key | value |",
        "| --- | --- |",
        "| source_files | %s |" % stat("source_files"),
        "| text_files | %s |" % stat("text_files"),
        "| binary_files | %s |" % stat("binary_files"),
        "| changed_files | %s |" % stat("changed_files"),
        "| source_bytes | %s |" % stat("source_bytes"),
        "| target_bytes | %s |" % stat("target_bytes"),
        "| skipped_symlinks | %d |" % len(audit["skipped_symlinks"]),
        "",
        "## Contents",
        "",
        "- [manifest.csv](manifest.csv) - one row per source file: source, target,",
        "  kind, real source/target SHA-256, real source/target byte lengths and",
        "  the changed flag, sorted by the Unicode NFC form of `source`.",
        "- [audit.json](audit.json) - the same statistics as machine-readable JSON.",
        "- [release.zip](release.zip) - ZIP_STORED archive of `normalized/` plus",
        "  `manifest.csv`, `audit.json` and this `INDEX.md`, with fixed metadata.",
        "- `normalized/` - the normalized copy; its layout mirrors the relative",
        "  paths of `incoming/`, including hidden files, empty files and empty",
        "  directories.",
        "",
        "## Normalization rules and limits",
        "",
        "Text files are those whose original bytes decode as strict UTF-8 and",
        "contain no NUL byte (the empty file counts as text). For text, at most",
        "one leading UTF-8 BOM is removed and then CRLF and lone CR are replaced",
        "with LF; nothing else is altered. Other files are binary and were copied",
        "byte for byte.",
        "",
        "Normalization is **irreversible**: BOM and original line endings are not",
        "recorded, so this package is NOT a backup from which the original bytes",
        "can be restored. Use `incoming/` and `inputs/provenance.json` (which lists",
        "sizes and SHA-256 for the declared originals) for that. Symlinks are",
        "skipped, never followed.",
        "",
        "Source code semantics were not checked. No Click module was imported or",
        "executed, no build or tests of Click were run, and no release or public",
        "API claims are made here.",
        "",
        "## License",
        "",
        "- The normalized Click license is at",
        "  [normalized/LICENSE.txt](normalized/LICENSE.txt); it is the",
        "  `incoming/LICENSE.txt` file carried through unchanged by normalization.",
        license_note,
        "",
        "## Recorded provenance (as declared, not independently verified)",
        "",
    ]
    text.extend(lines)
    text.append("")
    return "\n".join(text)


def provenance_lines(inputs):
    """Read provenance metadata if declared next to the input tree."""
    lines = []
    candidates = [
        Path(inputs).parent / "inputs" / "provenance.json",
        Path(inputs) / "provenance.json",
    ]
    data = None
    used = None
    for candidate in candidates:
        try:
            if candidate.is_file():
                data = json.loads(candidate.read_text(encoding="utf-8"))
                used = candidate
                break
        except (OSError, ValueError):
            data = None
    if not isinstance(data, dict):
        return ["- No provenance file was readable beside the input tree."]
    for key in ["repository", "expectedCommit", "source", "license", "symlinkPolicy"]:
        if key in data:
            lines.append("- %s: %s" % (key, data[key]))
    if used is not None:
        lines.append("- Declared in: `%s`" % used.name)
    return lines


def write_manifest(out, rows):
    path = out / "manifest.csv"
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, COLUMNS, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_audit(out, audit):
    text = json.dumps(audit, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    (out / "audit.json").write_bytes(text.encode("utf-8"))


def zipinfo(name, is_dir):
    info = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = ((ZIP_DIR_MODE if is_dir else ZIP_FILE_MODE) << 16) | (
        0x10 if is_dir else 0
    )
    if is_dir:
        info.filename = name if name.endswith("/") else name + "/"
    return info


def zip_order(directories, file_names):
    """Directory entries and files in one stable, path-based order.

    Names are emitted as ``normalized/``, then each normalized directory entry
    (parents before children), then ``manifest.csv``, ``audit.json`` and
    ``INDEX.md``. Directory entries come before the files they contain.
    """
    ordered = []
    seen = set()
    for name in ["normalized/"] + directories:
        entry = name if name.endswith("/") else name + "/"
        if entry not in seen:
            seen.add(entry)
            ordered.append((entry, True))
    return ordered + [(name, False) for name in file_names]


def write_zip(out):
    files = []
    for parent, dirnames, filenames in os.walk(out, followlinks=False):
        for name in filenames:
            path = Path(parent) / name
            if path.name == "release.zip" and Path(parent) == out:
                continue
            files.append(path.relative_to(out).as_posix())
    dirs = []
    for parent, dirnames, filenames in os.walk(out, followlinks=False):
        for name in dirnames:
            dirs.append((Path(parent) / name).relative_to(out).as_posix())
    normalized_dirs = sorted(
        [d for d in dirs if d == "normalized" or d.startswith("normalized/")], key=lambda v: (v.count("/"), v)
    )
    normalized_files = sorted(f for f in files if f.startswith("normalized/"))
    handover = ["manifest.csv", "audit.json", "INDEX.md"]
    missing = [name for name in handover if name not in files]
    if missing:
        raise BuildError("missing handover files: %s" % ", ".join(missing))
    tmp = out / (".release.zip.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as archive:
        for name, is_dir in zip_order(normalized_dirs, normalized_files + handover):
            if is_dir:
                archive.writestr(zipinfo(name, True), b"")
            else:
                data = (out / name).read_bytes()
                info = zipinfo(name, False)
                info.file_size = len(data)
                archive.writestr(info, data)
    os.replace(tmp, out / "release.zip")


def build(inputs="incoming", out="deliverables", provenance=True):
    """Build the package and return the audit dictionary."""
    inputs, out = Path(inputs), Path(out)
    check_paths(inputs, out)
    clean_output(out)

    files, directories, skipped = walk_inputs(inputs)
    rows = []
    for source, path in files:
        raw = path.read_bytes()
        kind, value = classify(raw)
        target = "normalized/" + source
        destination = out / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(value)
        rows.append(
            {
                "source": source,
                "target": target,
                "kind": kind,
                "source_sha256": sha256(raw),
                "target_sha256": sha256(value),
                "source_bytes": str(len(raw)),
                "target_bytes": str(len(value)),
                "changed": "true" if raw != value else "false",
            }
        )
    rows.sort(key=lambda row: nfc(row["source"]))

    for name in directories:
        (out / "normalized" / name).mkdir(parents=True, exist_ok=True)

    audit = {
        "source_files": len(rows),
        "text_files": sum(row["kind"] == "text" for row in rows),
        "binary_files": sum(row["kind"] == "binary" for row in rows),
        "changed_files": sum(row["changed"] == "true" for row in rows),
        "source_bytes": sum(int(row["source_bytes"]) for row in rows),
        "target_bytes": sum(int(row["target_bytes"]) for row in rows),
        "skipped_symlinks": skipped,
    }
    write_manifest(out, rows)
    write_audit(out, audit)
    lines = provenance_lines(inputs) if provenance else []
    note = ""
    license_path = out / "normalized" / "LICENSE.txt"
    if not license_path.is_file():
        note = "- (No LICENSE.txt was present in the input tree.)"
    else:
        note = "- LICENSE.txt bytes in this package: %d." % license_path.stat().st_size
    (out / "INDEX.md").write_bytes(render_index(audit, lines, note).encode("utf-8"))
    write_zip(out)
    return audit


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Normalize a mixed source tree into a deterministic handover package."
    )
    parser.add_argument("--inputs", default="incoming", help="input tree (default: incoming)")
    parser.add_argument("--out", default="deliverables", help="output directory (default: deliverables)")
    args = parser.parse_args(argv)
    try:
        audit = build(args.inputs, args.out)
    except BuildError as error:
        parser.exit(2, "error: %s\n" % error)
    print(
        json.dumps(
            {"out": args.out, **{key: audit[key] for key in AUDIT_KEYS[:-1]},
             "skipped_symlinks": len(audit["skipped_symlinks"])},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
