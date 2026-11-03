#!/usr/bin/env node
/**
 * Inventory all registered repository tests and highlight modules without a
 * specifically-named suite. This is an inventory, never proof of coverage.
 * Automatic discovery picks up new tests without maintaining a hand-written
 * allowlist or silently ignoring an unrecognized suite.
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const OUTPUT = path.join(ROOT, "artifacts/nightly-system-coverage");
const ROOTS = ["tests", "server", "shared", "client/src"];
const SKIP = new Set(["node_modules", "dist", ".git", "coverage", "artifacts", "build", "fixtures"]);
const domains = [
  { key: "sales_pos", label: "ERP sales / POS / invoice / returns", regex: /pos|sales|invoice|receipt|return|credit.note|checkout/i },
  { key: "inventory", label: "Inventory / stock / transfers / allocations", regex: /inventory|stock|transfer|allocation|warehouse|costing|bale|barcode/i },
  { key: "accounting", label: "Accounting / vouchers / ledger / financial reconciliation", regex: /account|voucher|ledger|journal|daybook|finance|cash|bank|payment|profit|debit|credit|fx|tax/i },
  { key: "factory_production", label: "Factory production / pressing / scanning / targets", regex: /production|press|scan|machine|worker|target|mix|batch|ground|bale/i },
  { key: "raw_materials", label: "Raw materials / suppliers / containers / offload", regex: /supplier|raw|container|offload|freight|shipment|purchas/i },
  { key: "payroll", label: "Payroll / attendance / advances / bonuses", regex: /payroll|salary|wage|attendance|advance|bonus|employee|worker|leave/i },
  { key: "reports", label: "Reports / analytics / net position / dashboards", regex: /report|analytic|net.position|dashboard|financial.statement|historical|summary|reconciliation/i },
  { key: "rental", label: "Rentals / properties / tenants", regex: /rent|property|tenant|lease|landlord/i },
  { key: "tracking", label: "Tracking / shipment / orders / logistics", regex: /tracking|shipment|delivery|order|dispatch|logistics|container/i },
  { key: "security", label: "Authentication / permissions / company isolation / security", regex: /auth|permission|company.context|company.scope|access|security|session|role|tenant|audit/i },
  { key: "ui", label: "UI / mobile / device / offline / accessibility", regex: /ui\/|mobile|responsive|offline|browser|accessibility|i18n|translation|localization|realtime/i },
  { key: "training", label: "Help / training / documentation / publication", regex: /training|help|documentation|publication/i },
];
function normalize(value) { return value.split(path.sep).join("/"); }
function isTest(file) { return /(?:\.test|\.spec)\.(?:ts|tsx|mjs|js)$/.test(file); }

async function enumerate(dir) {
  let items;
  try {
    items = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const entry of items) {
    if (SKIP.has(entry.name)) continue;
    const rel = normalize(path.join(dir, entry.name));
    if (entry.isDirectory()) out.push(...await enumerate(rel));
    else if (entry.isFile() && isTest(rel)) out.push(rel);
  }
  return out;
}

const files = (await Promise.all(ROOTS.map(enumerate))).flat().sort();
if (files.length === 0) throw new Error("No tests discovered; refusing a meaningless whole-system report");
const categories = domains.map(({ key, label, regex }) => {
  const matching = files.filter((file) => regex.test(file));
  return {
    key, label, recognizedTestFiles: matching.length,
    suiteExamples: matching.slice(0, 12),
    testFilenameEvidence: matching.length ? "present" : "none-found",
    independentlyVerifiedInThisInventory: false,
  };
});
const unmatched = files.filter((file) => !domains.some(({ regex }) => regex.test(file)));
const report = {
  generatedAt: new Date().toISOString(),
  sourceSha: process.env.GITHUB_SHA || null,
  reportType: "test-file-inventory-not-transaction-proof",
  totalDiscoveredTestFiles: files.length,
  categories,
  unmatchedTestFiles: unmatched,
  explanation: [
    "A matching filename is evidence that a test suite exists, not that the tests pass.",
    "The backend and frontend jobs independently execute their registered suites and enforce measured coverage thresholds.",
    "The disposable browser job performs actual ERP and Factory sample transactions.",
    "A domain with no matching test filenames needs explicit review, not an automatic claim of zero test coverage.",
    "All real company behavior is out of scope. Never run fake transaction jobs against production.",
  ],
};
await fs.mkdir(OUTPUT, { recursive: true });
await fs.writeFile(path.join(OUTPUT, "inventory.json"), JSON.stringify(report, null, 2) + "\n");
const markdown = [
  "# Nightly whole-system automated test inventory",
  "",
  "> **Not a 100% coverage certificate.** This report inventories the suites found in the repository. CI test execution and coverage metrics are separate evidence.",
  "",
  "Test files discovered: " + files.length,
  "",
  "| System domain | Matching suite files | Inventory status |",
  "| --- | ---: | --- |",
  ...categories.map(({ label, recognizedTestFiles, testFilenameEvidence }) =>
    "| " + label + " | " + recognizedTestFiles + " | " + testFilenameEvidence + " |"),
  "",
  "Unclassified test files: " + unmatched.length,
  "",
  "## Gaps and follow-up",
  "",
  ...categories.filter((c) => !c.recognizedTestFiles).map((c) => "- Explicitly review missing named tests for: " + c.label),
  "",
  "Test pass/fail must come from Vitest/browser artifacts, not from this filename inventory.",
].join("\n");
await fs.writeFile(path.join(OUTPUT, "inventory.md"), markdown + "\n");
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
console.log(JSON.stringify({ totalTestFiles: files.length, categories: categories.map(({key, recognizedTestFiles}) => ({key, recognizedTestFiles})), unclassified: unmatched.length }));
