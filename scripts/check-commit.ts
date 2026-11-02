import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";

// Read candidate paths, never `git add` user files or dump matched secret values.
const execute = promisify(execFile);
const { stdout } = await execute("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBuffer: 4_000_000 });
const paths = [...new Set(stdout.split("\0").filter(Boolean))], issues: string[] = [];
const privatePath = /(?:^|\/)(?:\.harness|local-context|node_modules|dist|auth\.json|token|harness\.config\.json)(?:\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))/;
const secrets = [
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /https?:\/\/[^\s/@]+:[^\s/@]+@[^\s/]+/,
];
for (const path of paths) {
  if (privatePath.test(path)) { issues.push(`${path}: private/generated file must stay outside the commit`); continue; }
  const info = await lstat(path).catch(() => undefined);
  if (!info) continue; // Tracked deletion.
  if (info.isSymbolicLink()) { issues.push(`${path}: inspect symbolic link before committing`); continue; }
  if (!info.isFile()) continue;
  if (info.size > 4_000_000) { issues.push(`${path}: review large candidate file`); continue; }
  const bytes = await readFile(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (secrets.some(pattern => pattern.test(text))) issues.push(`${path}: possible credential/private key (value withheld)`);
  if (/^(?:<{7}|={7}|>{7}) /m.test(text)) issues.push(`${path}: unresolved conflict marker`);
}
if (issues.length) { console.error(issues.join("\n")); process.exitCode = 1; }
else console.log(`Commit candidates checked: ${paths.length} files; no private/generated paths, recognized credentials or conflict markers found. Nothing staged or committed.`);
