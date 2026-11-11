import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeIntegrity, REQUIRED } from "../scripts/audit-database-integrity.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("no anomalies is a clean snapshot", () => {
  const result = summarizeIntegrity({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.metricErrors, []);
});

test("missing safeguards block; legacy unvalidated constraints produce explicit warnings", () => {
  const result = summarizeIntegrity({
    missingConstraints: ["voucher_entries.ledger_account_id_fkey"],
    invalidConstraints: ["voucher_entries.single_side"],
    missingTriggers: ["vouchers.balance_guard"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingConstraints.length, 1);
  assert.equal(result.invalidConstraints.length, 1);
  assert.equal(result.warnings.length, 1);
});

test("a single accounting anomaly fails integrity verification", () => {
  const result = summarizeIntegrity({
    metrics: { orphan_voucher_entries: 1, unbalanced_active_nonoptional_vouchers: 0 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.metricErrors, [{ name: "orphan_voucher_entries", count: 1 }]);
});

test("audit is strictly read-only and redacts detail rows", () => {
  const src = read("scripts/audit-database-integrity.mjs");
  assert.match(src, /BEGIN READ ONLY/);
  assert.match(src, /ROLLBACK/);
  assert.match(src, /COUNT\(\*\)/i);
  assert.doesNotMatch(src, /client\.query\(\s*["'`]?(?:UPDATE|DELETE|INSERT|CREATE|ALTER|DROP)\s/i);
  assert.ok(REQUIRED.triggers.some(([, x]) => x === "voucher_entries_balance_guard"));
});

test("historically NOT VALID constraints are warnings when no other defect exists", () => {
  const result = summarizeIntegrity({ invalidConstraints: ["voucher_entries.voucher_entries_single_side"] });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});
test("CLI parses only arguments after script name and refuses RLS-hidden incomplete scans", () => {
  const source = read("scripts/audit-database-integrity.mjs");
  assert.match(source, /process\.argv\.slice\(2\)/);
  assert.match(source, /SET LOCAL row_security = off/);
  assert.match(source, /BEGIN READ ONLY/);
});

test("gross voucher imbalance is review-only pending history and stock exemption analysis", () => {
  const result = summarizeIntegrity({ metrics: { unbalanced_active_nonoptional_vouchers: 3 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.metricErrors, []);
  assert.ok(result.warnings.some((x) => x.includes("3 gross imbalance")));
});
