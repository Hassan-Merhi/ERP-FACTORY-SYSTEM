#!/usr/bin/env node

/**
 * Generates a review worksheet from a combined Program 6C inventory audit report.
 *
 * Usage:
 *   node scripts/generate-program6c-inventory-classifications.mjs \
 *     --report=tmp/program6c-report.json \
 *     --output=docs/program-6c-inventory-classifications.json
 *
 * The generated document is intentionally incomplete: reviewers must replace the
 * placeholder status and evidence before the strict validator can pass.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function readArg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function readJson(filePath, label) {
  if (!filePath) fail(`Missing --${label}=<path>`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to read ${label} JSON at ${filePath}: ${error.message}`);
  }
}

const reportPath = readArg("report");
const outputPath = readArg("output");
if (!outputPath) fail("Missing --output=<path>");

const report = readJson(reportPath, "report");
if (report.program !== "6C" || !report.audits) {
  fail("The report is not a combined Program 6C inventory review report");
}

const findings = [
  ...(report.audits.stockItems?.findings ?? []).map((finding) => ({
    ...finding,
    audit: "stock-items",
  })),
  ...(report.audits.inventoryPayloads?.findings ?? []).map((finding) => ({
    ...finding,
    audit: "inventory-payloads",
  })),
]
  .filter((finding) => finding.severity === "high" || finding.severity === "review")
  .sort((a, b) =>
    `${a.severity}:${a.audit}:${a.file ?? ""}:${a.line ?? 0}:${a.id}`.localeCompare(
      `${b.severity}:${b.audit}:${b.file ?? ""}:${b.line ?? 0}:${b.id}`,
    ),
  );

// The source audits report every occurrence, including repeated references in
// the same file. Finding IDs intentionally identify a logical finding rather
// than one individual line. Only generate one review row per logical finding;
// reject ID reuse across different findings rather than hiding a collision.
const seen = new Map();
const uniqueFindings = [];
for (const finding of findings) {
  if (!finding.id || typeof finding.id !== "string") {
    fail("Every review finding must include a stable string id");
  }
  const signature = JSON.stringify([
    finding.audit, finding.file, finding.endpoint,
    finding.classification ?? finding.category ?? null, finding.severity,
  ]);
  const existing = seen.get(finding.id);
  if (existing !== undefined) {
    if (existing !== signature) fail(`Conflicting finding id in report: ${finding.id}`);
    continue;
  }
  seen.set(finding.id, signature);
  uniqueFindings.push(finding);
}

const document = {
  program: "6C",
  generatedFrom: reportPath,
  generatedAt: new Date().toISOString(),
  instructions: [
    "Replace status 'deferred' only after reviewing the finding.",
    "Fill reviewer, evidence, blocker, and nextEvidenceNeeded for every entry before validation.",
    "Use verified-unbounded-read, bounded-by-design, mutation-or-cache-only, false-positive, or deferred.",
    "Document preservation of company isolation, ordering, totals, running balances, reversals, traceability, and history for behavior-affecting changes.",
  ],
  classifications: uniqueFindings.map((finding) => ({
    findingId: finding.id,
    audit: finding.audit,
    severity: finding.severity,
    file: finding.file ?? null,
    line: finding.line ?? null,
    endpoint: finding.endpoint ?? null,
    classification: finding.classification ?? finding.category ?? null,
    status: "deferred",
    reviewer: "",
    evidence: "",
    blocker: "Review not completed",
    nextEvidenceNeeded: "Inspect the referenced caller or route and record bounding and behavior-preservation evidence",
  })),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`Program 6C classification worksheet written to ${outputPath}`);
console.log(`Review findings included: ${document.classifications.length}`);
