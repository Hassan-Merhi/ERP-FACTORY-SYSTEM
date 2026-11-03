import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");

test("scheduled nightly work includes both transaction and full-system runs", () => {
  const parent = read(".github/workflows/nightly-training-audit.yml");
  assert.ok(parent.includes("  transactions:"));
  assert.ok(parent.includes("  whole-system:"));
  assert.ok(parent.includes("nightly-system-regression.yml"));
  assert.ok(parent.includes("needs: [transactions, whole-system]"));
});

test("full-system suite covers actual browser, backend and frontend behavior", () => {
  const workflow = read(".github/workflows/nightly-system-regression.yml");
  for (const name of ["backend", "frontend", "rendered-pages", "audits", "coverage-ratchet"]) {
    assert.ok(workflow.includes("  " + name + ":"), name);
  }
  for (const name of ["test:backend:coverage", "test:frontend:coverage", "verify-factory-mobile-browser.mjs",
    "verify-erp-mobile-program.mjs", "audit:coverage-ratchet"]) {
    assert.ok(workflow.includes(name), name);
  }
});

test("disposable fixture is mandatory for synthetic financial reconciliation", () => {
  const script = read("scripts/verify-nightly-transaction-reconciliation.mjs");
  assert.ok(script.includes("ERP_E2E_DISPOSABLE_DB"));
  assert.ok(script.includes("TRAINING_SANDBOX_VERIFIED"));
  assert.ok(script.includes("heliumdb"));
  assert.ok(script.includes("localhost"));
});
