# Mixed-source handover package (Click snapshot)

This workspace turns a mixed binary/text source tree (`incoming/`, a pinned
Click snapshot) into a deterministic, reviewable handover package
(`deliverables/`), using a repaired standard-library builder at
`project/build.py`.

- Python 3.9+, standard library only. No network, no dependency installation,
  no execution or import of the Click sources, no desktop operations.
- Inputs are read only. `incoming/`, `inputs/`, `acceptance/` and `TASK.md`
  are not modified.

## Commands (as actually run, from the workspace root)

```sh
python3 project/build.py                       # --inputs incoming --out deliverables
python3 project/build.py --inputs incoming --out /tmp/fresh   # any other output directory
python3 -m unittest discover -s tests -v       # 9 tests, all OK
python3 acceptance/check.py                    # read-only acceptance checker
```

Observed results at the time of writing:

- `python3 project/build.py` printed
  `{"binary_files": 4, "changed_files": 4, "out": "deliverables", "skipped_symlinks": 0, "source_bytes": 1687185, "source_files": 185, "target_bytes": 1687176, "text_files": 181}`.
- `python3 -m unittest discover -s tests -v` ran 9 tests, all `ok`.
- `python3 acceptance/check.py` exited 0 and printed exactly one line:
  `{"passed": true, "actualBytesAndZip": true, "freshRepeatChangedDeleted": true, "ownTestsExecuted": 9, "source_files": 185, "text_files": 181, "binary_files": 4, "changed_files": 4, "source_bytes": 1687185, "target_bytes": 1687176, "skipped_symlinks": []}`.
  The checker's stdout does not list input paths or digests; those are
  computed inside the checker and recorded in the `task_verify` receipt for
  this command, not printed by it.

Rebuilding is deterministic: `release.zip` is byte-identical when built into
`deliverables/` and into any other fresh output directory, and on repeated
runs over the same input. No local path or timestamp is embedded.

## What the builder produces

For every regular file below `--inputs`, without following symlinks:

| input shape | classification | output |
| --- | --- | --- |
| strict UTF-8, no NUL (empty file included) | `text` | at most one leading BOM removed, then CRLF→LF and lone CR→LF |
| invalid UTF-8 or contains NUL | `binary` | byte-for-byte copy |

Hidden files, empty files, nested relative paths and empty directories are
all kept (`normalized/` mirrors the input layout, including empty
directories). Symlinks are skipped, never followed, and are listed in
`audit.json` → `skipped_symlinks`.

`deliverables/` contains:

- `normalized/` – the normalized copy of the input tree.
- `manifest.csv` – fixed columns
  `source,target,kind,source_sha256,target_sha256,source_bytes,target_bytes,changed`,
  one row per source file, hashes/lengths taken from the real bytes on both
  sides, sorted by the Unicode NFC form of `source`. `target` is
  `normalized/<source>`.
- `audit.json` – `source_files`, `text_files`, `binary_files`,
  `changed_files`, `source_bytes`, `target_bytes`, `skipped_symlinks`, all
  recounted from the files actually written.
- `INDEX.md` – the same statistics, links to `manifest.csv`, `audit.json`
  and `release.zip`, and the handover limits (see below).
- `release.zip` – `ZIP_STORED` archive whose file members are exactly the
  files under `normalized/` plus `manifest.csv`, `audit.json` and
  `INDEX.md`, plus directory entries for every normalized directory
  (including empty ones). Entries have fixed timestamps
  (1980‑01‑01), fixed Unix mode, relative POSIX names only, no duplicates,
  and are written in a fixed order.

Every rebuild first deletes stale output *inside* `--out` (the previous
`normalized/`, `manifest.csv`, `audit.json`, `INDEX.md`, `release.zip` and any
other entry left in that directory), then recomputes everything from the
current input. Nothing outside `--out` is touched. If `--inputs` and
`--out` are the same path or one contains the other, the builder exits with
status 2 and an error instead of writing.

## Changes relative to the legacy `project/build.py`

The delivered builder is a repair of the existing file; the CLI is unchanged
(`--inputs` defaults to `incoming`, `--out` defaults to `deliverables`).

1. Hidden files are no longer skipped; empty files are no longer skipped,
   and empty directories are now preserved.
2. Text/binary is decided by strict UTF-8 decoding plus a NUL scan instead
   of `errors="replace"`; invalid bytes are preserved as `binary` rather
   than being replaced with U+FFFD.
3. A single leading BOM is stripped, and lone CR is converted to LF in
   addition to CRLF; no other bytes change.
4. The manifest lists `target`, `kind` and both real hashes/lengths, is
   sorted by NFC path, and uses LF line endings.
5. `audit.json` now carries all seven required counters, measured from the
   real files; `skipped_symlinks` is populated from symlinks that are not
   followed.
6. `INDEX.md` states honestly that the copy is normalized, irreversible and
   not a byte-restorable backup, points to `incoming/` for originals, gives
   the normalized `LICENSE.txt`, and records that source semantics were not
   checked; the earlier `# Exact backup` / "restores all original bytes"
   wording is gone.
7. `release.zip` uses `ZIP_STORED` with fixed metadata and a fixed member
   list/order instead of `ZIP_DEFLATED` over a live recursive walk (which
   embedded local timestamps and depended on directory order).
8. Rebuilds clear stale output inside `--out` only, and overlapping
   input/output paths are refused before anything is written.
9. Only standard-library modules are used, and code paths that need
   Python 3.10+ (`Path.write_text(newline=...)`) are avoided.

## Tests (`tests/test_build.py`, 9 cases)

Each test builds into a temporary directory; nothing is written to
`incoming/`, `inputs/` or the workspace `deliverables/`.

- Edge-file classification, normalization bytes, hashes and `changed` flags.
- Single leading BOM removal (double BOM keeps the second; BOM-only file
  becomes empty).
- Manifest columns, source hashes/lengths, and NFC sort ordering.
- `audit.json` statistics and `INDEX.md` numbers vs. real on-disk bytes,
  including symlink skipping.
- ZIP members, `ZIP_STORED`, fixed timestamps, directory entries, safe
  names, and member bytes equal to the files on disk.
- Byte-identical ZIP across output directories and repeated builds, and no
  embedded temporary path.
- Stale output removal, input add/delete recomputation, unrelated files
  outside `--out` preserved.
- Overlap refusal (library and CLI, exit code 2) with inputs unchanged.
- CLI defaults (`incoming`/`deliverables`) and a custom `--out`.

## Verification scope and limits

Verified by the commands above: byte-level manifest consistency, audit
counters, empty-directory retention, ZIP member set/order/metadata and
member bytes, determinism across directories and repeats, stale-output
cleanup inside `--out`, refusal of overlapping paths, and that the original
input bytes are unchanged before/after builds (the acceptance checker
compares every input file's SHA-256).

Not verified / out of scope:

- Click source semantics, imports, test suite, or build results – the sources
  are treated as opaque bytes; nothing in `incoming/` is imported or run.
- The upstream commit/repository claims: they are repeated from
  `inputs/provenance.json` as *declared* provenance, not independently
  re-fetched (no network access).
- Restoration of original bytes: BOM and original line endings are not
  recorded, so the package cannot reproduce `incoming/` byte for byte; use
  `incoming/` itself for that.
- Cross-platform byte identity beyond this machine (e.g. different archive
  writers or a normalization-sensitive filesystem producing duplicate NFC
  paths); the builder normalizes its own output, but no other platform was
  exercised.
- Symlink handling is exercised only with test-local symlinks, since the
  supplied `incoming/` contains none.
