#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const releasePath = process.env.PHASE9_I18N_RELEASE_BASELINE || "config/i18n-phase9-final-release.json";
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "phase9-i18n-"));
const reportPath = path.join(temporaryDirectory, "report.json");

try {
  const audit = spawnSync(
    process.execPath,
    ["scripts/audit-i18n.mjs", "--json-out", reportPath],
    { encoding: "utf8", stdio: "pipe" },
  );

  if (audit.stdout) process.stdout.write(audit.stdout);
  if (audit.stderr) process.stderr.write(audit.stderr);
  if (audit.status !== 0) process.exit(audit.status ?? 1);

  const approved = JSON.parse(fs.readFileSync(releasePath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const errors = [];

  if (approved.schemaVersion !== 2) {
    errors.push(`Unsupported Phase 9 release schema: ${approved.schemaVersion ?? "missing"}.`);
  }
  if (report.detectorVersion !== approved.detectorVersion) {
    errors.push(`Detector version changed: expected ${approved.detectorVersion}, received ${report.detectorVersion}.`);
  }

  const unclassifiedExpected = approved.policy?.unclassifiedMustEqual;
  if (report.totals.unclassified !== unclassifiedExpected) {
    errors.push(
      `Unclassified findings changed: expected ${unclassifiedExpected}, received ${report.totals.unclassified}.`,
    );
  }

  const totalActionableCap = approved.policy?.totalActionableMustNotExceed;
  if (!Number.isFinite(totalActionableCap) || report.totals.actionable > totalActionableCap) {
    errors.push(
      `Total actionable findings exceed the reviewed cap: ${report.totals.actionable} > ${totalActionableCap}.`,
    );
  }

  const approvedModules = Object.keys(approved.modules ?? {}).sort();
  const reportModules = Object.keys(report.modules ?? {}).sort();
  if (
    approved.policy?.requireExactModuleSet === true &&
    JSON.stringify(reportModules) !== JSON.stringify(approvedModules)
  ) {
    errors.push(`Module set changed: expected ${approvedModules.join(", ")}, received ${reportModules.join(", ")}.`);
  }

  for (const [module, rule] of Object.entries(approved.modules ?? {})) {
    const actual = report.modules[module]?.actionable;
    if (!Number.isFinite(actual)) {
      errors.push(`Module ${module} is missing from the audit report.`);
      continue;
    }
    if (!Number.isFinite(rule.maxActionable)) {
      errors.push(`Module ${module} is missing a numeric maxActionable rule.`);
      continue;
    }
    if (actual > rule.maxActionable) {
      errors.push(`Module ${module} exceeds its reviewed cap: ${actual} > ${rule.maxActionable}.`);
    }
    if (rule.mustRemainZero === true && actual !== 0) {
      errors.push(`Module ${module} must remain at zero actionable findings; received ${actual}.`);
    }
  }

  if (errors.length > 0) {
    console.error("Phase 9 multilingual release-ratchet verification failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "phase9-release-ratchet-passed",
        detectorVersion: report.detectorVersion,
        actionable: report.totals.actionable,
        actionableCap: totalActionableCap,
        unclassified: report.totals.unclassified,
        candidates: report.totals.candidates,
        excluded: report.totals.excluded,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
