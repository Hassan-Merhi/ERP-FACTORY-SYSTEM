#!/usr/bin/env node
/**
 * Merge isolated Vitest V8 shard coverage maps. Every shard runs against its
 * own disposable PostgreSQL service; no backend test file is skipped.
 *
 * Usage: node scripts/merge-backend-ci-coverage.mjs <shard-artifact-directory>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import coverageLib from "istanbul-lib-coverage";

const { createCoverageMap } = coverageLib;
const root = process.cwd();
const dir = path.resolve(process.argv[2] ?? "coverage/shards");
const count = Number(process.env.BACKEND_CI_SHARD_COUNT ?? 3);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error("Invalid shard count");
}
const merged = createCoverageMap({});
for (let index = 1; index <= count; index += 1) {
  const file = path.join(dir, `backend-coverage-shard-${index}`, "coverage-final.json");
  if (!existsSync(file)) {
    throw new Error(`Missing coverage report for shard ${index}: ${file}`);
  }
  const report = JSON.parse(readFileSync(file, "utf8"));
  if (Object.keys(report).length === 0) {
    throw new Error(`Empty coverage report for shard ${index}`);
  }
  merged.merge(createCoverageMap(report));
}
const config = JSON.parse(
  readFileSync(path.join(root, "config/coverage-thresholds.json"), "utf8")
).backend;
const metrics = ["lines", "statements", "functions", "branches"];
const summary = { total: merged.getCoverageSummary().toJSON() };
for (const file of merged.files()) {
  summary[file] = merged.fileCoverageFor(file).toSummary().toJSON();
}
let failures = 0;
function verify(label, actual, floors) {
  for (const metric of metrics) {
    if (floors[metric] === undefined) continue;
    if (!actual || actual[metric].pct < floors[metric]) {
      console.error(
        `${label} ${metric}: ${actual?.[metric]?.pct ?? "absent"}% below floor ${floors[metric]}%`
      );
      failures += 1;
    }
  }
}
verify("backend total", summary.total, config.global);
for (const [file, floors] of Object.entries(config.perFile)) {
  verify(file, summary[path.resolve(root, file)] ?? summary[file], floors);
}
mkdirSync(path.join(root, "coverage/backend"), { recursive: true });
writeFileSync(
  path.join(root, "coverage/backend/coverage-summary.json"),
  JSON.stringify(summary, null, 2) + "\n"
);
console.log(
  `Combined ${count} isolated backend shards; ${merged.files().length} covered files; ${failures} floor violations`
);
if (failures) process.exitCode = 1;
