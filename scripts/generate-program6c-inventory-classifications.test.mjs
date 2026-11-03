import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runGenerator(findings) {
  const directory = mkdtempSync(join(tmpdir(), "program6c-nightly-test-"));
  const report = join(directory, "report.json");
  const output = join(directory, "worksheet.json");
  writeFileSync(report, JSON.stringify({
    program: "6C",
    audits: { stockItems: { findings }, inventoryPayloads: { findings: [] } },
  }));
  const result = spawnSync(process.execPath, [
    "scripts/generate-program6c-inventory-classifications.mjs",
    "--report=" + report,
    "--output=" + output,
  ], { encoding: "utf8" });
  let worksheet;
  if (result.status === 0) worksheet = JSON.parse(readFileSync(output, "utf8"));
  rmSync(directory, { recursive: true, force: true });
  return { ...result, worksheet };
}

test("repeated occurrences of the same logical inventory finding need one review row", () => {
  const finding = {
    id: "one-logical-issue",
    file: "client/src/pages/inventory.tsx",
    severity: "review",
    classification: "client-read-review-required",
    endpoint: "/api/inventory/history",
  };
  const r = runGenerator([{ ...finding, line: 10 }, { ...finding, line: 70 }]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.worksheet.classifications.length, 1);
  assert.equal(r.worksheet.classifications[0].findingId, "one-logical-issue");
  assert.equal(r.worksheet.classifications[0].status, "deferred");
});

test("same ID reused for a distinct finding must still fail loudly", () => {
  const finding = {
    id: "collision",
    file: "client/src/pages/inventory.tsx",
    severity: "review",
    classification: "client-read-review-required",
    endpoint: "/api/inventory/history",
  };
  const r = runGenerator([finding, { ...finding, endpoint: "/api/other/history" }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Conflicting finding id in report/);
});
