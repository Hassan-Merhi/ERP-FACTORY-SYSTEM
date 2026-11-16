#!/usr/bin/env node
import fs from "node:fs";

const failures = [];
const read = (file) => {
  if (!fs.existsSync(file)) {
    failures.push(`Missing required file: ${file}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
};

const workflowPath = ".github/workflows/release-verification.yml";
const workflow = read(workflowPath);
const configSource = read("config/i18n-phase9-final-release.json");
const baselineVerifier = read("scripts/verify-final-i18n-baseline.mjs");
const browserSmoke = read("scripts/run-language-browser-smoke.mjs");
const releaseTest = read("tests/final-release-gate.test.ts");
const releaseDoc = read("docs/archive/translation/phase-9-current-main-release.md");

let config = null;
try {
  config = JSON.parse(configSource);
} catch (error) {
  failures.push(`Phase 9 release configuration is invalid JSON: ${error instanceof Error ? error.message : error}`);
}

for (const token of [
  "workflow_dispatch:",
  "Current-main multilingual reconciliation",
  "scripts/verify-multilingual-phases-4-7-current-main.mjs",
  "scripts/verify-current-main-reconciliation.mjs",
  "scripts/verify-current-main-release.mjs",
  "PHASE9_ERP_SMOKE_USERNAME",
  "PHASE9_ERP_SMOKE_PASSWORD",
  "scripts/prepare-browser-smoke-fixture.mjs",
  "Prepare disposable authenticated browser fixture",
  'ERP_SMOKE_REQUIRE_AUTHENTICATED: "1"',
  'ERP_SMOKE_REQUIRE_EXACT_ROUTES: "1"',
  "Record and enforce final release result",
  'test "$status" = "success"',
]) {
  if (!workflow.includes(token)) failures.push(`Phase 9 manual release workflow is missing: ${token}`);
}

if (/^\s*(pull_request|push):/m.test(workflow)) {
  failures.push("Phase 9 final release must remain manual-only");
}
if (fs.existsSync(".github/workflows/phase9-format-probe.yml")) {
  failures.push("Obsolete Phase 9 formatting probe still exists");
}

if (config) {
  if (config.schemaVersion !== 2) failures.push(`Phase 9 release schema must be 2, received ${config.schemaVersion}`);
  if (config.detectorVersion !== 9) failures.push(`Detector version must remain 9, received ${config.detectorVersion}`);
  if (config.policy?.unclassifiedMustEqual !== 0) failures.push("Unclassified findings must remain fixed at zero");
  if (config.policy?.requireExactModuleSet !== true) failures.push("The reviewed i18n module set must remain exact");
  if (!Number.isFinite(config.policy?.totalActionableMustNotExceed)) {
    failures.push("The Phase 9 total actionable cap is missing");
  }
  for (const module of [
    "backend-messages",
    "properties-rentals",
    "reports-exports",
    "shared-ui",
    "supplier-partner",
  ]) {
    const rule = config.modules?.[module];
    if (rule?.maxActionable !== 0 || rule?.mustRemainZero !== true) {
      failures.push(`${module} must remain locked at zero actionable findings`);
    }
  }
}

for (const token of [
  "report.totals.actionable > totalActionableCap",
  "actual > rule.maxActionable",
  "rule.mustRemainZero === true && actual !== 0",
  "requireExactModuleSet",
]) {
  if (!baselineVerifier.includes(token)) failures.push(`Phase 9 i18n ratchet is missing: ${token}`);
}

for (const token of [
  "ERP_SMOKE_REQUIRE_AUTHENTICATED",
  "Authenticated browser coverage is required",
  "activateSkipNavigation",
  "assertSidebarEdge",
  'activeElementId !== "main-content"',
  '"[data-money-value]"',
  '"[data-quantity-value]"',
]) {
  if (!browserSmoke.includes(token)) failures.push(`Phase 9 browser release coverage is missing: ${token}`);
}

for (const token of [
  "enforces a reviewed current-main untranslated-text ratchet",
  "keeps the complete release matrix manual and current-main scoped",
  "Authenticated browser coverage is required",
]) {
  if (!releaseTest.includes(token)) failures.push(`Phase 9 release contract is missing: ${token}`);
}

for (const token of [
  '"verificationExecuted": false',
  '"productionReleaseAttested": false',
  "no CI checks be run",
]) {
  if (!releaseDoc.includes(token)) failures.push(`Phase 9 honest release status is missing: ${token}`);
}

if (failures.length > 0) {
  console.error("Phase 9 current-main release reconciliation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 9,
      implementation: "reconciled-on-current-main",
      automaticTriggers: false,
      authenticatedBrowserCoverageRequired: true,
      exactAuthenticatedRoutesRequired: true,
      releaseRatchetSchema: 2,
      productionReleaseAttested: false,
      sqlRequired: false,
    },
    null,
    2
  )
);
