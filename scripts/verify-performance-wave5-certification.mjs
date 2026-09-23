#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

const failures = [];
const read = (file) => {
  if (!fs.existsSync(file)) {
    failures.push("Missing required file: " + file);
    return "";
  }
  return fs.readFileSync(file, "utf8");
};
const requireMarkers = (file, markers) => {
  const source = read(file);
  for (const marker of markers) {
    if (!source.includes(marker)) failures.push(file + ": missing marker: " + marker);
  }
  return source;
};

const runner = requireMarkers("scripts/run-performance-wave5-production-certification.mjs", [
  "/api/health/ready",
  "/api/health/db",
  "/api/health/performance.json",
  "ERP_PERF_CERT_USERNAME",
  "ERP_PERF_CERT_PASSWORD",
  "ERP_PERF_CERT_MIN_ROUTE_SAMPLES",
  "budgetBreaches",
  "artifacts/performance-wave5",
  "credentials: \"same-origin\"",
  "Wave 5 production performance certification passed",
]);

for (const writeMethod of ['method: "POST"', 'method: "PUT"', 'method: "PATCH"', 'method: "DELETE"']) {
  if (runner.includes(writeMethod)) {
    failures.push("Wave 5 production certification must remain read-only; found " + writeMethod + ".");
  }
}

requireMarkers("docs/performance-wave5-production-certification.md", [
  "PR #1599",
  "PR #1600",
  "PR #1601",
  "PR #1608",
  "npm run certify:performance-wave5",
  "read-only",
  "Admin or Developer",
]);

requireMarkers("docs/production-deployment-checklist.md", [
  "certify:performance-wave5",
  "performance-wave5/report.json",
]);

requireMarkers(".github/workflows/main-certification.yml", [
  "npm run verify:performance-wave5",
]);

requireMarkers("config/doc-index.json", [
  '"docs/performance-wave5-production-certification.md": "reference"',
]);

const packageJson = JSON.parse(read("package.json") || "{}");
if (
  packageJson.scripts?.["verify:performance-wave5"] !==
  "node scripts/verify-performance-wave5-certification.mjs"
) {
  failures.push("package.json has an invalid verify:performance-wave5 script.");
}
if (
  packageJson.scripts?.["certify:performance-wave5"] !==
  "node scripts/run-performance-wave5-production-certification.mjs"
) {
  failures.push("package.json has an invalid certify:performance-wave5 script.");
}

if (failures.length > 0) {
  console.error("Wave 5 performance certification contract failed:");
  for (const failure of failures) console.error("- " + failure);
  process.exit(1);
}

console.log(
  "Wave 5 performance certification contract verified: live certification remains explicit, read-only, and tied to existing production budgets."
);
