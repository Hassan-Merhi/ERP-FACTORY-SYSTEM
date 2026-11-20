#!/usr/bin/env node
/**
 * Enforces the per-file mutation score floors in config/mutation-testing.json
 * against the report `npm run test:mutation` writes.
 *
 * Score = (killed + timed out) / (killed + timed out + survived + no coverage),
 * Stryker's own definition. A file below its floor fails; a file with no floor
 * yet, or one scoring higher than its floor, is reported so the floor can be
 * raised in the change that improved it.
 *
 *     node scripts/check-mutation-floors.mjs [--report artifacts/mutation/mutation-report.json]
 *     node scripts/check-mutation-floors.mjs --write   # set every floor to today's score, rounded down to a whole percent
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "config/mutation-testing.json");
const reportArg = process.argv.indexOf("--report");
const reportPath = path.resolve(
  root,
  reportArg > -1 ? process.argv[reportArg + 1] : "artifacts/mutation/mutation-report.json"
);
const write = process.argv.includes("--write");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!fs.existsSync(reportPath)) {
  console.error(`No mutation report at ${path.relative(root, reportPath)}. Run npm run test:mutation first.`);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

export function scoreFile(mutants) {
  let detected = 0;
  let undetected = 0;
  for (const mutant of mutants) {
    if (DETECTED.has(mutant.status)) detected += 1;
    else if (UNDETECTED.has(mutant.status)) undetected += 1;
  }
  const total = detected + undetected;
  return { detected, undetected, score: total === 0 ? 100 : (detected / total) * 100 };
}

const scores = {};
for (const file of config.mutate) {
  const entry = report.files?.[file] ?? report.files?.[path.join(root, file)];
  if (!entry) {
    console.error(`The report has no results for ${file}; was it mutated?`);
    process.exit(1);
  }
  scores[file] = scoreFile(entry.mutants ?? []);
}

if (write) {
  config.floors = Object.fromEntries(
    config.mutate.map((file) => [file, Math.floor(scores[file].score)])
  );
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log("Floors set to the current scores.");
}

const failures = [];
for (const file of config.mutate) {
  const { score, detected, undetected } = scores[file];
  const floor = config.floors?.[file];
  const line = `${score.toFixed(1).padStart(5)}%  ${file}  (${detected} caught, ${undetected} missed)`;
  if (floor === undefined) {
    console.log(`${line}  no floor yet`);
  } else if (score + 1e-9 < floor) {
    failures.push(`${file}: ${score.toFixed(1)}% is below its floor of ${floor}%`);
    console.log(`${line}  BELOW floor ${floor}%`);
  } else {
    console.log(`${line}  floor ${floor}%${score - floor >= 1 ? " (raise the floor)" : ""}`);
  }
}

if (failures.length > 0) {
  console.error(`\nMutation score fell below its floor:\n  ${failures.join("\n  ")}`);
  console.error("Add tests that catch the surviving mutants listed in artifacts/mutation/mutation-report.html.");
  process.exit(1);
}
