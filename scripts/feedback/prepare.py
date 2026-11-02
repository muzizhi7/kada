"""Prepare two new inputs from already pinned downloads. No model calls."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
from tasks import COMMON, TASKS

base = Path(sys.argv[1]).resolve()
assert not (base / "frozen.json").exists(), "Never change inputs after freeze"
manifest = json.loads((base / "source-manifest.json").read_text())
tsc = Path("node_modules/typescript/bin/tsc").resolve()
assert tsc.is_file()
tasks = []
for task in TASKS:
    root = base / "fixtures" / task["id"]
    assert not root.exists(), "Keep existing fixture; use a fresh experiment directory to prepare again"
    (root / "acceptance").mkdir(parents=True)
    (root / "inputs").mkdir()
    if task["category"] == "files":
        shutil.copytree(base / "sources/click", root / "incoming")
        edge = root / "incoming/_edge_cases"
        edge.mkdir()
        for name, data in {
            "crlf.txt": b"alpha\r\nbeta\rgamma\n",
            "bom.txt": b"\xef\xbb\xbf" + "中文\r\nsecond\r\n".encode(),
            "invalid.bin": b"\x80\xff\r\n",
            "nul.dat": b"binary\x00\r\n",
            "empty": b"",
            "space name.txt": b"one\r\ntwo\r",
            ".hidden": b"  \r\n\r\n",
        }.items():
            (edge / name).write_bytes(data)
        (edge / "local-link.txt").symlink_to("crlf.txt")
        shutil.copy2(Path(__file__).with_name("check-release.py"), root / "acceptance/check_release.py")
        readonly = ["incoming", "acceptance", "inputs", "TASK.md", "BRIEF.json"]
    else:
        shutil.copytree(base / "sources/clsx", root / "project")
        shutil.copy2(Path(__file__).with_name("clsx-public.test.mjs"), root / "acceptance/clsx-public.test.mjs")
        (root / "tools").mkdir()
        (root / "tools/typecheck.mjs").write_text(
            "import {spawnSync} from 'node:child_process';\n"
            + "const run=spawnSync(process.execPath,[" + json.dumps(str(tsc))
            + ", '--ignoreConfig','--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022',"
              "'acceptance/types.mts','acceptance/types.cts'],{stdio:'inherit'});\n"
              "if(run.error)throw run.error;process.exit(run.status??1);\n")
        esm = """import clsxDefault, {clsx, type ClassArray, type ClassValue, type ClassDictionary} from '../project/clsx.mjs';
const nested = ['a', ['b', {active: true}] as const] as const;
const a: string = clsx(nested, ['c'] as const);
const b: string = clsxDefault(nested);
const old: ClassArray = ['mutable']; old.push('still mutable');
const dictionary: ClassDictionary = {key: true};
const value: ClassValue = nested;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type ReturnIsString = Assert<Equal<ReturnType<typeof clsx>, string>>;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type ParameterIsNotAny = Assert<Equal<IsAny<Parameters<typeof clsx>[number]>, false>>;
// @ts-expect-error Symbol input is not the class-value API
clsx(Symbol('invalid'));
"""
        cjs = esm.replace("import clsxDefault, {clsx, type ClassArray, type ClassValue, type ClassDictionary} from '../project/clsx.mjs';",
                          "import clsxDefault = require('../project/clsx');\nconst clsx = clsxDefault.clsx;\ntype ClassArray = clsxDefault.ClassArray; type ClassValue = clsxDefault.ClassValue; type ClassDictionary = clsxDefault.ClassDictionary;")
        (root / "acceptance/types.mts").write_text(esm)
        (root / "acceptance/types.cts").write_text(cjs)
        readonly = ["acceptance", "tools", "inputs", "TASK.md", "BRIEF.json"]
    (root / "inputs/provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
    checks = [dict(type="file_exists", path=path) for path in task["artifacts"]]
    task_text = "# " + task["name"] + "\n" + COMMON + "\n" + task["text"]
    (root / "TASK.md").write_text(task_text)
    brief = dict(revision=1, outcome=task["name"], deliverables=task["artifacts"], inputs=readonly,
                 criteria=[dict(text=text, method=method) for text, method in task["criteria"]],
                 scope=["仅本评测工作区；原始资料、验收、工具、配置与凭据不得修改；不使用桌面或网络"],
                 assumptions=["输入和目标已确认；现成验收可自由运行，不是全部质量证明"], questions=[], checks=checks,
                 budget=dict(maxEstimatedCostUsd=.25, maxDurationMs=3600000))
    (root / "BRIEF.json").write_text(json.dumps(brief, ensure_ascii=False, indent=2) + "\n")
    tasks.append({"id": task["id"], "category": task["category"], "name": task["name"], "readonly": readonly,
                  "mutableProject": ["src/index.js", "clsx.d.mts", "clsx.d.ts", "readme.md"] if task["category"] == "code" else []})
(base / "tasks.json").write_text(json.dumps(tasks, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"fixtures": len(tasks), "typescriptCliProvided": True}))
