> Public-source note: this is the recorded handover index. Its generated ZIP and normalized upstream source are retained privately and are not bundled in this repository; filenames below describe the original delivery.

# Handover index: normalized Click source snapshot

This directory is a *normalized* handover copy of the material in the
original `incoming/` tree. The originals stay in `incoming/`; this copy
is not a byte-for-byte backup of them.

## Statistics (recounted from the files on disk)

| key | value |
| --- | --- |
| source_files | 185 |
| text_files | 181 |
| binary_files | 4 |
| changed_files | 4 |
| source_bytes | 1,687,185 |
| target_bytes | 1,687,176 |
| skipped_symlinks | 0 |

## Contents

- [manifest.csv](manifest.csv) - one row per source file: source, target,
  kind, real source/target SHA-256, real source/target byte lengths and
  the changed flag, sorted by the Unicode NFC form of `source`.
- [audit.json](audit.json) - the same statistics as machine-readable JSON.
- `release.zip` - ZIP_STORED archive of `normalized/` plus
  `manifest.csv`, `audit.json` and this `INDEX.md`, with fixed metadata.
- `normalized/` - the normalized copy; its layout mirrors the relative
  paths of `incoming/`, including hidden files, empty files and empty
  directories.

## Normalization rules and limits

Text files are those whose original bytes decode as strict UTF-8 and
contain no NUL byte (the empty file counts as text). For text, at most
one leading UTF-8 BOM is removed and then CRLF and lone CR are replaced
with LF; nothing else is altered. Other files are binary and were copied
byte for byte.

Normalization is **irreversible**: BOM and original line endings are not
recorded, so this package is NOT a backup from which the original bytes
can be restored. Use `incoming/` and `inputs/provenance.json` (which lists
sizes and SHA-256 for the declared originals) for that. Symlinks are
skipped, never followed.

Source code semantics were not checked. No Click module was imported or
executed, no build or tests of Click were run, and no release or public
API claims are made here.

## License

- The normalized Click license is at
  `normalized/LICENSE.txt`; it is the
  `incoming/LICENSE.txt` file carried through unchanged by normalization.
- LICENSE.txt bytes in this package: 1475.

## Recorded provenance (as declared, not independently verified)

- repository: https://github.com/pallets/click
- expectedCommit: 2247b35ea1c47c727d7a06e51fa280e12a863ff6
- source: Previously pinned Click snapshot from the local feedback regression materials
- license: incoming/LICENSE.txt
- symlinkPolicy: staging skips links without following them; this example has no symlink inputs
- Declared in: `provenance.json`
