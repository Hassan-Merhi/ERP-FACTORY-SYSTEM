#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const VITEST = resolve(ROOT, "node_modules/vitest/vitest.mjs");
const coverage = process.argv.includes("--coverage");
const SHARD_COUNT = Number(process.env.BACKEND_TEST_SHARDS ?? 8);
// The budget belongs to the pass being run, not to the command line. --complete
// runs a plain pass and then a coverage pass, and coverage instrumentation is
// measurably slower: in one certification run the same shard took 127.5s plain
// and 188.2s under coverage. Deriving the budget from `--coverage` being present
// in argv charged that coverage pass the plain 210s budget and aborted a run
// whose shards had all passed.
const PLAIN_SHARD_BUDGET_SECONDS = Number(process.env.BACKEND_TEST_SHARD_BUDGET_SECONDS ?? 210);
const COVERAGE_SHARD_BUDGET_SECONDS = Number(
  process.env.BACKEND_TEST_SHARD_BUDGET_SECONDS ??
    process.env.BACKEND_TEST_COVERAGE_SHARD_BUDGET_SECONDS ??
    360
);

function shardBudgetSeconds(withCoverage) {
  return withCoverage ? COVERAGE_SHARD_BUDGET_SECONDS : PLAIN_SHARD_BUDGET_SECONDS;
}
const requestedShard = process.env.BACKEND_TEST_SHARD_INDEX;
const complete = process.argv.includes("--complete");
const listOnly = process.argv.includes("--list");
const mergeOnly = process.argv.includes("--merge-only");

if (!Number.isInteger(SHARD_COUNT) || SHARD_COUNT < 1) throw new Error("BACKEND_TEST_SHARDS must be a positive integer");
if (!Number.isFinite(PLAIN_SHARD_BUDGET_SECONDS) || PLAIN_SHARD_BUDGET_SECONDS <= 0) {
  throw new Error("BACKEND_TEST_SHARD_BUDGET_SECONDS must be positive");
}
if (!Number.isFinite(COVERAGE_SHARD_BUDGET_SECONDS) || COVERAGE_SHARD_BUDGET_SECONDS <= 0) {
  throw new Error("BACKEND_TEST_COVERAGE_SHARD_BUDGET_SECONDS must be positive");
}
if (requestedShard !== undefined && (!/^\d+$/.test(requestedShard) || Number(requestedShard) >= SHARD_COUNT)) {
  throw new Error(`BACKEND_TEST_SHARD_INDEX must be between 0 and ${SHARD_COUNT - 1}`);
}

function discoverTests(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (absolute.includes(`${resolve(ROOT, "tests")}/ui`)) continue;
      result.push(...discoverTests(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      result.push(absolute);
    }
  }
  return result;
}

const files = discoverTests(resolve(ROOT, "tests"))
  .concat(discoverTests(resolve(ROOT, "server")))
  .concat(discoverTests(resolve(ROOT, "shared")))
  .filter((file, index, all) => all.indexOf(file) === index)
  .sort();

const shards = Array.from({ length: SHARD_COUNT }, () => []);
files.forEach((file, index) => shards[index % SHARD_COUNT].push(file));

if (listOnly) {
  console.log(JSON.stringify({
    fileCount: files.length,
    shardCount: SHARD_COUNT,
    shards: shards.map((shard, index) => ({ index, fileCount: shard.length, files: shard.map((file) => file.slice(ROOT.length + 1)) })),
  }, null, 2));
  process.exit(0);
}

function run(command, args, label, env = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test", ...env },
  });
  const seconds = (Date.now() - started) / 1000;
  console.log(`${label}: ${result.status === 0 ? "passed" : "failed"} in ${seconds.toFixed(1)}s`);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return seconds;
}

function bootstrapDatabase() {
  // The bridge imports the factory bilingual/trilingual and RLS bridges before
  // applying the supplier migration. Running it once per verification avoids
  // repeating four idempotent database passes in every forked test file.
  run(
    process.execPath,
    ["--import", "./server/supplierCompanyScopeBridge.mjs", "-e", ""],
    "database bootstrap"
  );
}

function parseReporterOutput(file) {
  if (!existsSync(file)) return [];
  try {
    const report = JSON.parse(readFileSync(file, "utf8"));
    return (report.testResults ?? []).map((entry) => ({
      file: entry.name,
      durationMs: (entry.endTime ?? 0) - (entry.startTime ?? 0),
    }));
  } catch {
    return [];
  }
}

function runShard(index, shard, withCoverage) {
  const outputDir = resolve(ROOT, ".artifacts/backend-verification");
  mkdirSync(outputDir, { recursive: true });
  const reporterPath = resolve(outputDir, `shard-${index}.json`);
  const args = [
    VITEST,
    "run",
    "--config",
    "vitest.config.backend-shard.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${reporterPath}`,
    ...shard,
  ];
  const shardCoverageDir = resolve(ROOT, `coverage/backend-shards/shard-${index}`);
  if (withCoverage) {
    rmSync(shardCoverageDir, { recursive: true, force: true });
    args.splice(4, 0, "--coverage", `--coverage.reportsDirectory=${shardCoverageDir}`);
  }
  const seconds = run(process.execPath, args, `backend shard ${index + 1}/${SHARD_COUNT}`);
  const budget = shardBudgetSeconds(withCoverage);
  if (seconds > budget) {
    console.error(`Shard ${index} exceeded its ${budget}s budget (${seconds.toFixed(1)}s).`);
    process.exit(1);
  }
  return { index, seconds, files: shard.length, tests: parseReporterOutput(reporterPath) };
}

function mergeCoverage() {
  const { createCoverageMap } = requireCoverage();
  const map = createCoverageMap({});
  for (let index = 0; index < SHARD_COUNT; index += 1) {
    const file = resolve(ROOT, `coverage/backend-shards/shard-${index}/coverage-final.json`);
    if (!existsSync(file)) throw new Error(`Missing coverage output for shard ${index}: ${file}`);
    map.merge(JSON.parse(readFileSync(file, "utf8")));
  }

  const destination = resolve(ROOT, "coverage/backend");
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, "coverage-final.json"), `${JSON.stringify(map.toJSON())}\n`);
  const summary = { total: map.getCoverageSummary().toJSON() };
  for (const file of map.files()) summary[file] = map.fileCoverageFor(file).toSummary().toJSON();
  writeFileSync(resolve(destination, "coverage-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  assertCoverage(summary);
}

function requireCoverage() {
  // This is a transitive dependency of the locked V8 coverage provider and is
  // intentionally loaded only by the coverage verification path.
  return require("istanbul-lib-coverage");
}

function assertCoverage(summary) {
  const config = JSON.parse(readFileSync(resolve(ROOT, "config/coverage-thresholds.json"), "utf8")).backend;
  const metricNames = ["lines", "statements", "functions", "branches"];
  const failures = [];
  for (const metric of metricNames) {
    if (summary.total[metric].pct < config.global[metric]) {
      failures.push(`backend global ${metric}: ${summary.total[metric].pct}% < ${config.global[metric]}%`);
    }
  }
  for (const [file, floors] of Object.entries(config.perFile)) {
    const entry = summary[resolve(ROOT, file)] ?? summary[file];
    if (!entry) {
      failures.push(`backend gated file missing from merged coverage: ${file}`);
      continue;
    }
    for (const metric of metricNames) {
      if (entry[metric].pct < floors[metric]) failures.push(`${file} ${metric}: ${entry[metric].pct}% < ${floors[metric]}%`);
    }
  }
  if (failures.length) {
    console.error("Merged backend coverage is below the configured floor:\n" + failures.map((line) => ` - ${line}`).join("\n"));
    process.exit(1);
  }
  console.log(`Merged backend coverage passed ${metricNames.length} global and ${Object.keys(config.perFile).length * metricNames.length} per-file thresholds.`);
}

function runVerification(withCoverage) {
  bootstrapDatabase();
  const selected = requestedShard === undefined ? shards.map((_, index) => index) : [Number(requestedShard)];
  const results = selected.map((index) => runShard(index, shards[index], withCoverage));
  const slowest = results
    .flatMap((result) => result.tests.map((test) => ({ ...test, shard: result.index })))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 20);
  console.log("\nSlowest backend test files:");
  for (const test of slowest) console.log(` ${(test.durationMs / 1000).toFixed(2)}s shard=${test.shard} ${test.file}`);
  console.log(`Completed ${selected.length} shard(s), ${selected.reduce((total, index) => total + shards[index].length, 0)} test files.`);
  if (withCoverage && requestedShard === undefined) mergeCoverage();
}

if (!existsSync(VITEST)) throw new Error(`Vitest is not installed: ${VITEST}`);
if (mergeOnly) {
  mergeCoverage();
  process.exit(0);
}
if (complete) {
  runVerification(false);
  runVerification(true);
} else {
  runVerification(coverage);
}