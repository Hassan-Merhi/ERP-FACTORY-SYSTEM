#!/usr/bin/env node

import { readFileSync } from "node:fs";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const runner = source("scripts/run-business-regression.mjs");
const contract = source("tests/business-regression-suite.test.ts");
const documentation = source("docs/archive/engineering/phase12-business-regression-suite.md");

const requiredSuites = [
  "tests/workflow.test.ts",
  "tests/factory-container-lifecycle.test.ts",
  "tests/pos.test.ts",
  "tests/vouchers.test.ts",
  "tests/accounting.test.ts",
  "tests/reports.test.ts",
  "tests/company-context-enforcement.test.ts",
  "tests/factory-mix-batch-stable-cost.test.ts",
  "tests/factory-locked-rate-migration.test.ts",
];

for (const suite of requiredSuites) {
  if (!runner.includes(suite)) throw new Error(`Phase 12 runner is missing ${suite}`);
}

for (const required of ["--smoke", "--list", "--maxWorkers=1", "--no-file-parallelism"]) {
  if (!runner.includes(required)) throw new Error(`Phase 12 runner is missing ${required}`);
}

if (!contract.includes("Phase 12 business regression suite contracts")) {
  throw new Error("Phase 12 contract test is missing");
}
if (!documentation.includes("rollback-safe")) {
  throw new Error("Phase 12 documentation must describe rollback safety");
}

console.log("Phase 12 business regression suite contract verified.");
