"""Unit tests for project/build.py (standard library unittest only).

Run from the workspace root:

    python3 -m unittest discover -s tests -v

Every test builds into a throwaway directory; no test writes to incoming/,
inputs/ or to the workspace deliverables/.
"""
import csv
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unicodedata
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUILD_PY = ROOT / "project" / "build.py"
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


def load_builder():
    spec = importlib.util.spec_from_file_location("handover_build", BUILD_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_module = load_builder()


def make_tree(root):
    """Create a small input tree with every declared edge case shape."""
    files = {
        ".hidden": b"  \r\n\r\n",
        "bom.txt": b"\xef\xbb\xbf\xe4\xb8\xad\xe6\x96\x87\r\nsecond\r\n",
        "crlf.txt": b"one\r\ntwo\rend\n",
        "empty": b"",
        "invalid.bin": b"\x80\xff\r\n",
        "nul.dat": b"binary\x00\r\n",
        "space name.txt": b"a\r\nb\rc\n",
        "nested/deep.txt": b"plain\n",
        "\u00e9/caf\u00e9.txt": b"x\r\n",
        "e\u0301/mark.txt": b"y\r\n",
    }
    root.mkdir(parents=True)
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (root / "empty-dir").mkdir()
    (root / "nested" / "empty-dir-2").mkdir()
    return files


class TempCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="build-test-")
        self.tmp = Path(self._tmp.name)
        self.inputs = self.tmp / "incoming"
        self.files = make_tree(self.inputs)
        self.out = self.tmp / "out"

    def tearDown(self):
        self._tmp.cleanup()

    def manifest(self):
        with (self.out / "manifest.csv").open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream)
            rows = list(reader)
            self.assertEqual(reader.fieldnames, COLUMNS)
        return rows

    def audit(self):
        return json.loads((self.out / "audit.json").read_text(encoding="utf-8"))


class ClassificationTests(TempCase):
    def test_edge_files_classified_and_normalized(self):
        build_module.build(self.inputs, self.out)
        rows = {row["source"]: row for row in self.manifest()}
        expected = {
            ".hidden": ("text", b"  \n\n"),
            "bom.txt": ("text", "\u4e2d\u6587\nsecond\n".encode("utf-8")),
            "crlf.txt": ("text", b"one\ntwo\nend\n"),
            "empty": ("text", b""),
            "invalid.bin": ("binary", b"\x80\xff\r\n"),
            "nul.dat": ("binary", b"binary\x00\r\n"),
            "space name.txt": ("text", b"a\nb\nc\n"),
        }
        for name, (kind, value) in expected.items():
            row = rows[name]
            raw = self.files[name]
            self.assertEqual(row["kind"], kind, name)
            self.assertEqual(row["source_sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(row["target_sha256"], hashlib.sha256(value).hexdigest())
            self.assertEqual((int(row["source_bytes"]), int(row["target_bytes"])), (len(raw), len(value)))
            self.assertEqual(row["changed"], "true" if raw != value else "false")
            self.assertEqual((self.out / row["target"]).read_bytes(), value)
            self.assertEqual(row["target"], "normalized/" + name)
        self.assertEqual(rows["empty"]["changed"], "false")
        self.assertEqual(rows["nul.dat"]["changed"], "false")

    def test_only_one_leading_bom_removed_and_bom_only_file(self):
        (self.inputs / "double-bom.txt").write_bytes(b"\xef\xbb\xbf\xef\xbb\xbfx\r\n")
        (self.inputs / "bom-only.txt").write_bytes(b"\xef\xbb\xbf")
        build_module.build(self.inputs, self.out)
        rows = {row["source"]: row for row in self.manifest()}
        self.assertEqual((self.out / "normalized/double-bom.txt").read_bytes(), b"\xef\xbb\xbfx\n")
        self.assertEqual(rows["double-bom.txt"]["kind"], "text")
        self.assertEqual((self.out / "normalized/bom-only.txt").read_bytes(), b"")


class ManifestTests(TempCase):
    def test_columns_hashes_and_nfc_sort_order(self):
        build_module.build(self.inputs, self.out)
        rows = self.manifest()
        self.assertEqual([list(row) for row in rows[:1]], [COLUMNS])
        self.assertEqual(len(rows), len(self.files))
        names = [row["source"] for row in rows]
        self.assertEqual(names, sorted(names, key=lambda n: unicodedata.normalize("NFC", n)))
        # NFC/NFD spellings collapse onto one name on a normalization-insensitive
        # filesystem; on a sensitive one both rows must be kept.
        distinct = {unicodedata.normalize("NFC", n) for n in names}
        self.assertTrue({"\u00e9/caf\u00e9.txt", "\u00e9/mark.txt"} <= distinct)
        self.assertEqual(len(rows), len({unicodedata.normalize("NFC", n) for n in names})
                         if len(rows) != len(distinct) else len(rows))
        for row in rows:
            data = (self.inputs / row["source"]).read_bytes()
            self.assertEqual(row["source_sha256"], hashlib.sha256(data).hexdigest())
            self.assertTrue(row["changed"] in {"true", "false"})
            self.assertEqual(int(row["source_bytes"]), len(data))


class AuditAndIndexTests(TempCase):
    def test_audit_and_index_numbers_agree_with_disk(self):
        os.symlink(self.inputs / "crlf.txt", self.inputs / "link.txt")
        os.symlink(self.inputs / "nested", self.inputs / "link-dir")
        try:
            build_module.build(self.inputs, self.out)
        finally:
            (self.inputs / "link.txt").unlink()
            (self.inputs / "link-dir").unlink()
        audit = self.audit()
        rows = self.manifest()
        self.assertEqual(audit["source_files"], len(rows))
        self.assertEqual(audit["text_files"], sum(r["kind"] == "text" for r in rows))
        self.assertEqual(audit["binary_files"], sum(r["kind"] == "binary" for r in rows))
        self.assertEqual(audit["changed_files"], sum(r["changed"] == "true" for r in rows))
        self.assertEqual(audit["source_bytes"], sum(int(r["source_bytes"]) for r in rows))
        self.assertEqual(audit["target_bytes"], sum(int(r["target_bytes"]) for r in rows))
        self.assertEqual(audit["skipped_symlinks"], ["link-dir", "link.txt"])
        on_disk = [p for p in (self.out / "normalized").rglob("*") if p.is_file()]
        self.assertEqual(len(on_disk), audit["source_files"])
        self.assertEqual(sum(p.stat().st_size for p in on_disk), audit["target_bytes"])
        self.assertFalse((self.out / "normalized/link.txt").exists())
        index = (self.out / "INDEX.md").read_text(encoding="utf-8")
        for name in ["manifest.csv", "audit.json", "release.zip", "incoming", "normalized/LICENSE.txt"]:
            self.assertIn(name, index)
        self.assertIn("%d" % audit["source_files"], index)
        self.assertIn("irreversible", index)
        self.assertNotIn("Exact backup", index)


class ZipTests(TempCase):
    def test_zip_members_modes_dirs_and_bytes(self):
        build_module.build(self.inputs, self.out)
        with zipfile.ZipFile(self.out / "release.zip") as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            self.assertEqual(len(names), len(set(names)))
            files = {name for name in names if not name.endswith("/")}
            expected = {
                (self.out / "normalized").relative_to(self.out).as_posix() + "/" + rel
                for rel in (
                    list(self.files) + ["empty-dir", "nested/empty-dir-2"]
                )
            }
            normalized_files = {
                p.relative_to(self.out).as_posix()
                for p in (self.out / "normalized").rglob("*")
                if p.is_file()
            }
            self.assertEqual(files, normalized_files | {"manifest.csv", "audit.json", "INDEX.md"})
            self.assertTrue(expected)
            dirs = {name for name in names if name.endswith("/")}
            self.assertIn("normalized/empty-dir/", dirs)
            self.assertIn("normalized/nested/empty-dir-2/", dirs)
            for entry in entries:
                self.assertEqual(entry.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertFalse(entry.filename.startswith("/"))
                self.assertNotIn("..", Path(entry.filename).parts)
                if not entry.is_dir():
                    self.assertEqual(archive.read(entry), (self.out / entry.filename).read_bytes())
                    self.assertEqual(entry.create_system, 3)

    def test_rebuild_is_byte_identical_in_other_directory(self):
        build_module.build(self.inputs, self.out)
        other = self.tmp / "elsewhere" / "fresh"
        build_module.build(self.inputs, other)
        first = (self.out / "release.zip").read_bytes()
        self.assertEqual(first, (other / "release.zip").read_bytes())
        build_module.build(self.inputs, self.out)
        self.assertEqual(first, (self.out / "release.zip").read_bytes())
        self.assertEqual(
            (self.out / "manifest.csv").read_bytes(), (other / "manifest.csv").read_bytes()
        )
        self.assertNotIn(str(self.tmp).encode(), first)


class RebuildTests(TempCase):
    def test_stale_outputs_removed_and_unrelated_files_kept(self):
        build_module.build(self.inputs, self.out)
        sentinel = self.tmp / "outside.txt"
        sentinel.write_text("keep me", encoding="utf-8")
        (self.out / "stale-extra.txt").write_text("stale", encoding="utf-8")
        (self.inputs / "nested/deep.txt").unlink()
        shutil.rmtree(self.inputs / "nested")
        (self.inputs / "nested").mkdir()
        (self.inputs / "nested/new.txt").write_bytes(b"new\r\n")
        build_module.build(self.inputs, self.out)
        names = {row["source"] for row in self.manifest()}
        self.assertNotIn("nested/deep.txt", names)
        self.assertIn("nested/new.txt", names)
        self.assertFalse((self.out / "normalized/nested/deep.txt").exists())
        self.assertFalse((self.out / "stale-extra.txt").exists())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me")

    def test_overlapping_paths_refused(self):
        before = sorted(p.relative_to(self.inputs).as_posix() for p in self.inputs.rglob("*"))
        for bad in [self.inputs, self.inputs / "sub", self.tmp]:
            with self.assertRaises(build_module.BuildError):
                build_module.build(self.inputs, bad)
        after = sorted(p.relative_to(self.inputs).as_posix() for p in self.inputs.rglob("*"))
        self.assertEqual(before, after)
        result = subprocess.run(
            [sys.executable, str(BUILD_PY), "--inputs", str(self.inputs), "--out", str(self.inputs)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"overlap", result.stderr)


class CliTests(TempCase):
    def test_cli_defaults_and_custom_out(self):
        result = subprocess.run(
            [sys.executable, str(BUILD_PY), "--help"],
            cwd=str(self.tmp),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"--inputs", result.stdout)
        self.assertIn(b"incoming", result.stdout)
        self.assertIn(b"deliverables", result.stdout)
        work = self.tmp / "cwd"
        work.mkdir()
        (work / "incoming").mkdir()
        (work / "incoming/a.txt").write_bytes(b"a\r\n")
        result = subprocess.run(
            [sys.executable, str(BUILD_PY)], cwd=str(work),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((work / "deliverables/release.zip").is_file())
        self.assertTrue((work / "deliverables/audit.json").is_file())
        self.assertEqual(json.loads(result.stdout)["source_files"], 1)


if __name__ == "__main__":
    unittest.main()
