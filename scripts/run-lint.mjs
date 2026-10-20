#!/usr/bin/env node
/**
 * run-lint.mjs
 *
 * `npm run lint`. Runs ESLint once and enforces the ceilings in
 * config/lint-warning-ratchet.json.
 *
 * Why this is a script and not `eslint --max-warnings <n>`
 * -------------------------------------------------------
 * The cap used to be typed directly into the package.json script as
 * `--max-warnings 12358`. Nothing measured that number, so it recorded the day
 * it was written and nothing else: by the time it was checked the repository
 * was at 12,304, leaving 54 warnings of headroom that any change could spend
 * without CI noticing. Every other quality gate here reads its threshold from
 * config/ and is audited against the live measurement; this one did not, so it
 * was the only gate that could not be tightened deliberately.
 *
 * The ceiling now lives in config/lint-warning-ratchet.json next to the
 * coverage floors and the type-escape baselines, and this script is what reads
 * it. It also writes the machine-readable report to
 * artifacts/lint/eslint-report.json so scripts/audit-lint-warnings.mjs can
 * check the per-rule ratchet without paying for a second full lint run - the
 * same split as vitest enforcing coverage floors while
 * audit-coverage-ratchet.mjs reports the headroom.
 *
 * Usage:
 *   npm run lint
 *   node scripts/run-lint.mjs --quiet     # report only, exit 0 regardless
 *
 * Exits non-zero when there is any error, or when warnings exceed the ceiling.
 */
import { loadESLint } from "eslint";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const ROOT = process.cwd();
const CONFIG_PATH = resolve(ROOT, "config/lint-warning-ratchet.json");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const { patterns, reportPath } = config.scan;
const { warningCeiling, errorCeiling } = config.totals;
const step = config.scan.step;
const quiet = process.argv.includes("--quiet");

const ESLint = await loadESLint({ useFlatConfig: true });
const eslint = new ESLint();
const results = await eslint.lintFiles(patterns);

// Written before any threshold check so the report exists even on a red run -
// that is exactly when someone wants to see which rule moved.
const reportFile = resolve(ROOT, reportPath);
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(reportFile, `${JSON.stringify(results, null, 2)}\n`);

let errors = 0;
let warnings = 0;
for (const result of results) {
  errors += result.errorCount;
  warnings += result.warningCount;
}

// Errors print in full — there should never be any, so the whole list is the
// finding. Warnings do not: the backlog is five figures, and dumping it would
// bury the handful of new ones that actually broke the build. Those get a
// per-rule count and a capped sample instead, with the full detail on disk.
if (errors > errorCeiling) {
  const formatter = await eslint.loadFormatter("stylish");
  console.log(await formatter.format(results.filter((result) => result.errorCount > 0)));
}

if (warnings > warningCeiling) {
  const SAMPLE = 20;
  const byRule = {};
  const sample = [];
  for (const result of results) {
    for (const message of result.messages) {
      if (message.severity !== 1) continue;
      const rule = message.ruleId ?? "(no-rule)";
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      if (sample.length < SAMPLE) {
        sample.push(`   ${result.filePath}:${message.line}:${message.column}  ${rule}`);
      }
    }
  }
  console.log("\nWarnings by rule:");
  for (const [rule, count] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(6)}  ${rule}`);
  }
  console.log(`\nFirst ${Math.min(SAMPLE, sample.length)} warning location(s):`);
  for (const line of sample) console.log(line);
  console.log(`\nCompare the counts above against perRule in config/lint-warning-ratchet.json to`);
  console.log(`see which rule moved. Every warning is in ${reportPath}.`);
}

console.log(
  `Linted ${results.length} files: ${errors} error(s), ${warnings} warning(s) ` +
    `against a ceiling of ${warningCeiling}. Report: ${reportPath}`
);

if (errors > errorCeiling) {
  console.error(
    `\n${errors} ESLint error(s), ceiling is ${errorCeiling}. Errors are not part of the\n` +
      `warning drawdown and have no baseline — fix them.`
  );
  process.exit(quiet ? 0 : 1);
}

if (warnings > warningCeiling) {
  console.error(
    `\n${warnings} warnings exceeds the ceiling of ${warningCeiling} by ${warnings - warningCeiling}.\n` +
      `Remove the new warnings. Do not raise totals.warningCeiling in\n` +
      `config/lint-warning-ratchet.json — it is a one-way ratchet and may only fall.`
  );
  process.exit(quiet ? 0 : 1);
}

if (warnings <= warningCeiling - step) {
  console.log(
    `\nThe ceiling has ${warningCeiling - warnings} warnings of headroom, at or past the ${step}-warning\n` +
      `step. Lower totals.warningCeiling to ${warnings} (and the matching perRule entries) in the\n` +
      `same change that removed them — run \`npm run audit:lint-ratchet\` for the per-rule numbers.`
  );
}
