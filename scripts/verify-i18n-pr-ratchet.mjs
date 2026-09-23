#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const [basePath, currentPath] = process.argv.slice(2);
if (!basePath || !currentPath) {
  console.error("Usage: node scripts/verify-i18n-pr-ratchet.mjs <base-report.json> <current-report.json>");
  process.exit(2);
}

function readReport(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const base = readReport(basePath);
const current = readReport(currentPath);
const failures = [];

if (base.detectorVersion !== current.detectorVersion) {
  failures.push(
    `Detector version changed from ${base.detectorVersion ?? "unknown"} to ${current.detectorVersion ?? "unknown"}; re-review the i18n policy instead of comparing unlike scans.`
  );
}
if (base.policyDigest !== current.policyDigest) {
  failures.push("I18n audit policy changed in this PR; re-review the policy/baseline explicitly.");
}

const baseTotal = Number(base.totals?.actionable ?? 0);
const currentTotal = Number(current.totals?.actionable ?? 0);
if (currentTotal > baseTotal) {
  failures.push(`Total actionable literals increased from ${baseTotal} to ${currentTotal}.`);
}

const moduleNames = new Set([
  ...Object.keys(base.modules ?? {}),
  ...Object.keys(current.modules ?? {}),
]);
for (const name of [...moduleNames].sort()) {
  const before = Number(base.modules?.[name]?.actionable ?? 0);
  const after = Number(current.modules?.[name]?.actionable ?? 0);
  if (after > before) {
    failures.push(`${name} actionable literals increased from ${before} to ${after}.`);
  }
}

const baseUnclassified = Number(base.totals?.unclassified ?? 0);
const currentUnclassified = Number(current.totals?.unclassified ?? 0);
if (currentUnclassified > baseUnclassified) {
  failures.push(
    `Unclassified literals increased from ${baseUnclassified} to ${currentUnclassified}.`
  );
}

if (failures.length > 0) {
  console.error("PR i18n ratchet failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `PR i18n ratchet passed: actionable ${baseTotal} → ${currentTotal}; no module or unclassified count increased.`
);
