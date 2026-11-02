"""Free positive/negative oracle checks; no candidate or model execution."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

base = Path(sys.argv[1]).resolve()
sys.argv = [sys.argv[0]]
scripts = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_oracle", scripts / "check-release.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


class AcceptanceTests(unittest.TestCase):
    def test_known_byte_examples(self):
        rows, targets, audit = oracle.inventory(base / "fixtures/files-normalize")
        self.assertEqual(targets["normalized/_edge_cases/crlf.txt"], b"alpha\nbeta\ngamma\n")
        self.assertEqual(targets["normalized/_edge_cases/bom.txt"], "中文\nsecond\n".encode())
        self.assertEqual(targets["normalized/_edge_cases/invalid.bin"], b"\x80\xff\r\n")
        self.assertEqual(targets["normalized/_edge_cases/empty"], b"")
        self.assertEqual(audit["skipped_symlinks"], ["_edge_cases/local-link.txt"])
        self.assertEqual(audit["source_files"], 185)
        self.assertEqual(audit["changed_files"], 4)

    def test_gold_package_and_corrupted_member(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(base / "fixtures/files-normalize/incoming", root / "incoming", symlinks=True)
            out = root / "deliverables"
            out.mkdir()
            rows, targets, audit = oracle.inventory(root)
            for name, data in targets.items():
                path = out / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            import csv
            with (out / "manifest.csv").open("w", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)
            (out / "audit.json").write_text(json.dumps(audit))
            (out / "INDEX.md").write_text("manifest.csv release.zip normalized/LICENSE.txt")
            with zipfile.ZipFile(out / "release.zip", "w", compression=zipfile.ZIP_STORED) as archive:
                for path in sorted(out.rglob("*")):
                    if path.is_file() and path.name != "release.zip":
                        archive.write(path, path.relative_to(out).as_posix())
            oracle.validate(root)
            (out / "normalized/_edge_cases/crlf.txt").write_bytes(b"wrong")
            with self.assertRaises(AssertionError):
                oracle.validate(root)

    def test_code_original_fails_new_contract_but_gold_passes(self):
        original = base / "sources/clsx"
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root = Path(directory)
            shutil.copytree(base / "fixtures/code-clsx", root, dirs_exist_ok=True)
            def probes():
                process = subprocess.run(["node", str(scripts / "code-probes.mjs"), str(root), str(original), str(root / "grade.json")], capture_output=True, timeout=20)
                self.assertEqual(process.returncode, 0, process.stderr.decode())
                return json.loads((root / "grade.json").read_text())["checks"]
            before = probes()
            self.assertTrue(any(not row["passed"] for row in before))
            self.assertTrue(next(row for row in before if row["id"] == "legacy-ordinary-differential")["passed"])
            path = root / "project/src/index.js"
            value = path.read_text().replace("if (mix[k])", "if (Object.prototype.hasOwnProperty.call(mix, k) && mix[k])")
            value = value.replace("if (mix[y])", "if (Object.prototype.hasOwnProperty.call(mix, y) && mix[y])")
            path.write_text(value)
            for name in ["clsx.d.mts", "clsx.d.ts"]:
                path = root / "project" / name
                path.write_text(path.read_text().replace("ClassArray | ClassDictionary", "ClassArray | ReadonlyArray<ClassValue> | ClassDictionary"))
            self.assertTrue(all(row["passed"] for row in probes()))
            result = subprocess.run(["node", "--test", "acceptance/clsx-public.test.mjs"], cwd=root, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
            result = subprocess.run(["node", "tools/typecheck.mjs"], cwd=root, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
            (root / "project/clsx.d.mts").write_text("export type ClassValue=any;export type ClassArray=any[];export type ClassDictionary=any;export function clsx(...a:any[]):any;export default clsx;")
            result = subprocess.run(["node", "tools/typecheck.mjs"], cwd=root, capture_output=True, timeout=20)
            self.assertNotEqual(result.returncode, 0, "type widening must be detected")


if __name__ == "__main__":
    unittest.main()
