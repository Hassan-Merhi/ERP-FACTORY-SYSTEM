#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const smokeSuites = [
  "tests/workflow.test.ts",
  "tests/factory-container-lifecycle.test.ts",
];

const fullSuites = [
  ...smokeSuites,
  "tests/pos.test.ts",
  "tests/vouchers.test.ts",
  "tests/accounting.test.ts",
  "tests/reports.test.ts",
  "tests/company-context-enforcement.test.ts",
  "tests/factory-mix-batch-stable-cost.test.ts",
  "tests/factory-locked-rate-migration.test.ts",
];

const mode = process.argv.includes("--smoke") ? "smoke" : "full";
const selectedSuites = mode === "smoke" ? smokeSuites : fullSuites;
const missingSuites = selectedSuites.filter((path) => !existsSync(path));

if (missingSuites.length > 0) {
  console.error("Phase 12 business regression suite is incomplete.");
  for (const path of missingSuites) console.error(`Missing: ${path}`);
  process.exit(1);
}

if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ mode, suites: selectedSuites }, null, 2));
  process.exit(0);
}

const vitest = "node_modules/vitest/vitest.mjs";
if (!existsSync(vitest)) {
  console.error("Vitest is not installed. Run npm install before executing Phase 12.");
  process.exit(1);
}

console.log(`Running Phase 12 ${mode} business regression suite (${selectedSuites.length} files).`);
const result = spawnSync(process.execPath, [vitest, "run", ...selectedSuites, "--maxWorkers=1", "--no-file-parallelism"], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
