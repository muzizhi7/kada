import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile), python = process.env.CASE_PYTHON ?? "python3";

for (const name of ["code_inventory", "code_pool", "code_import", "code_cache"]) {
  test(`case ${name}: reference accepted and two real defects rejected`, { timeout: 60000 }, async () => {
    const { stdout } = await execute(python, ["scripts/cases/preflight.py", name]);
    const [result] = JSON.parse(stdout);
    assert.equal(result.referenceAccepted, true); assert.equal(result.visibleAccepted, true);
    assert.equal(result.originalInputsUnchanged, true);
    if (name === "code_pool") assert.equal(result.idempotentCleanupAccepted, true);
    assert(result.mutations.length >= 2); assert(result.mutations.every((m: { rejected: boolean }) => m.rejected));
  });
}
// Office-only dev dependencies are optional for the application. The explicit test:cases command requires them.
for (const name of ["office_reconcile", "office_minutes", "office_crm", "office_handover"]) {
  test(`case ${name}: reference accepted and two real defects rejected`, { timeout: 60000 }, async t => {
    try { await execute(python, ["-c", "import openpyxl,docx"]); }
    catch { t.skip("Office fixture checks require scripts/cases/requirements.txt; run npm run test:cases with those dev dependencies"); return; }
    const { stdout } = await execute(python, ["scripts/cases/preflight.py", name]);
    const [result] = JSON.parse(stdout);
    assert.equal(result.referenceAccepted, true); assert.equal(result.visibleAccepted, true);
    assert.equal(result.originalInputsUnchanged, true);
    if (name === "code_pool") assert.equal(result.idempotentCleanupAccepted, true);
    assert(result.mutations.length >= 2); assert(result.mutations.every((m: { rejected: boolean }) => m.rejected));
  });
}
