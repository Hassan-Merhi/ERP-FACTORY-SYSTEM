#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`Missing required file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function requireMarkers(relativePath, markers) {
  const source = read(relativePath);
  for (const marker of markers) {
    if (!source.includes(marker)) {
      failures.push(`${relativePath}: missing required safety marker: ${marker}`);
    }
  }
  return source;
}

requireMarkers("docs/archive/final-production-readiness.md", [
  "Never test a restore by overwriting production",
  "HISTORICAL_REPLAY_APPLY_MODE",
  "Supplier Partner Phase 4 rehearsal",
  "Stop conditions",
]);

requireMarkers("docs/operations/database-backup-rollback-recovery.md", [
  "Never test a restore by overwriting the production database",
  "verify-database-backup.mjs",
  "Restore rehearsal on a disposable database",
  "/api/health/ready",
  "Repository rehearsal objectives",
  "critical-row fingerprint",
  "Production RPO and RTO",
]);

// Disaster-recovery rehearsal remains a specialist workflow. Main Certification
// owns merged-application correctness; the resilience workflow owns disposable
// dump/restore evidence until its schedule is consolidated separately.
requireMarkers(".github/workflows/resilience-rehearsal.yml", [
  "pg_dump",
  "verify-database-backup.mjs",
  "Restore into fresh disposable database",
  "pg_restore",
  "verify-ci-disposable-schema.mjs",
  "ENABLE_SCHEDULERS: \"false\"",
  "scheduler-tick-guard.test.ts",
  "schedule:",
  "source-critical-counts.tsv",
  "restore-critical-counts.tsv",
  "resilience-evidence.json",
  "DR_REHEARSAL_RTO_SECONDS",
  "verify-phase11-12-observability-disaster-recovery.mjs",
]);

// Main Certification is the single post-merge application certification. Keep
// this contract focused on what the exact merged application SHA must prove;
// security and disaster-recovery specialist workflows are verified separately.
requireMarkers(".github/workflows/main-certification.yml", [
  "name: Main Certification",
  "Verify exact merged main SHA",
  // test:backend:verify is --complete, which is the plain pass AND the coverage
  // pass. The frontend pair below still needs both names because those are two
  // separate commands; requiring test:backend:verify:coverage here as well only
  // pinned a redundant third backend pass into the certification job.
  "test:backend:verify",
  "test:frontend",
  "test:frontend:coverage",
  "test:smoke-sweep",
  "verify:server-bundle",
  "verify:final-production-readiness",
  "verify:observability",
  "verify:stabilization",
  "verify:mobile-web-routing",
  "verify:bandwidth",
  "context='Main Certification'",
]);

requireMarkers("scripts/verify-phase11-12-observability-disaster-recovery.mjs", [
  "Phase 11/12 observability and disaster-recovery contracts verified.",
  "source-critical-counts.tsv",
  "resilience-evidence.json",
  "DR_REHEARSAL_RTO_SECONDS",
]);

requireMarkers("tests/scheduler-tick-guard.test.ts", [
  "skips a tick that arrives while the previous run is still going",
  "releases the guard when a run throws",
  "absorbs the failure instead of rejecting into cron",
]);

requireMarkers("server/lib/schedulerObservability.ts", [
  "erp.scheduler.job-name",
  "resolveSchedulerMetricName",
  "cron-expression:",
]);

requireMarkers("server/lib/observabilityBootstrap.ts", [
  "resolveSchedulerMetricName(expression, callback)",
  "captureRuntimeFailures",
]);

const overdueQuerySource = requireMarkers("server/services/scheduler/overdueCustomerQuery.ts", [
  "cb.debit_amount",
  "cb.credit_amount",
  "cb.transaction_date",
  "cb.company_id = c.company_id",
]);
for (const forbiddenColumn of ["cb.entry_type", "cb.entry_date", "cb.amount"]) {
  if (overdueQuerySource.includes(forbiddenColumn)) {
    failures.push(`Overdue-customer scheduler still references removed column: ${forbiddenColumn}`);
  }
}

requireMarkers("server/routes/voucher-entries/by-account.ts", [
  "wantsBoundedPagination",
  ".limit(limit)",
  ".offset(offset)",
  "Cache-Control",
]);

requireMarkers("docs/archive/program-3c-database-tenant-guards.md", [
  "tenant-control-integrity-audit.mjs",
  "0013_tenant_control_integrity_guards",
  "NOT VALID",
  "explicit owner approval",
]);

requireMarkers("migrations/0013_tenant_control_integrity_guards.sql", [
  "Foreign keys are NOT VALID",
  "No historical repair, DELETE, UPDATE, or backfill",
  "tenant-control-integrity-audit.mjs",
]);

requireMarkers("scripts/tenant-control-integrity-audit.mjs", [
  'client.query("BEGIN READ ONLY")',
  'client.query("ROLLBACK")',
  "summary.ok = summary.errorCount === 0",
]);

requireMarkers("scripts/run-versioned-migrations.mjs", [
  'const APPLY_FLAG = "--apply"',
  'const REQUIRED_CONFIRMATION = "APPLY_VERSIONED_MIGRATIONS"',
  "pg_try_advisory_lock",
  "Another versioned migration process already holds the migration lock",
]);

requireMarkers("docs/archive/sp-migration-phase-4-runbook.md", [
  "/api/sp/migration/final-verification",
  "PREPARE CUTOVER",
  "FINALIZE CUTOVER",
  "ROLLBACK CUTOVER",
  "SP_SOURCE_READ_ONLY",
]);

requireMarkers("docs/archive/historical-replay-phase-8-production-readiness.md", [
  "HISTORICAL_REPLAY_APPLY_MODE=APPROVED_V8_CONTROLLED_APPLY",
  "/historical-replay/readiness",
  "/historical-replay/verification",
  "Apply is disabled unless both runtime controls are present",
  "Remove `HISTORICAL_REPLAY_APPLY_MODE`",
]);

const renderConfig = requireMarkers("render.yaml", [
  "healthCheckPath: /api/health/ready",
  "startCommand: npm start",
]);

for (const forbidden of ["HISTORICAL_REPLAY_APPLY_MODE", "HISTORICAL_REPLAY_RELEASE_ID", "MIGRATION_CONFIRMATION"]) {
  if (renderConfig.includes(forbidden)) {
    failures.push(`render.yaml must not enable dangerous release control: ${forbidden}`);
  }
}

const journalSource = read("migrations/meta/_journal.json");
if (journalSource) {
  try {
    const journal = JSON.parse(journalSource);
    const entry = journal.entries?.find((candidate) => candidate.idx === 13);
    if (!entry) {
      failures.push("Migration journal is missing index 13");
    } else if (entry.tag !== "0013_tenant_control_integrity_guards") {
      failures.push(
        `Migration journal index 13 must be 0013_tenant_control_integrity_guards, found ${entry.tag ?? "<missing>"}`,
      );
    }

    const duplicateIndexes = journal.entries
      ?.map((entryItem) => entryItem.idx)
      .filter((idx, position, all) => all.indexOf(idx) !== position);
    if (duplicateIndexes?.length) {
      failures.push(`Migration journal contains duplicate indexes: ${[...new Set(duplicateIndexes)].join(", ")}`);
    }
  } catch (error) {
    failures.push(`Migration journal is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

const packageSource = read("package.json");
if (packageSource) {
  try {
    const packageJson = JSON.parse(packageSource);
    const script = packageJson.scripts?.["verify:final-production-readiness"];
    if (script !== "node scripts/verify-final-production-readiness.mjs") {
      failures.push("package.json is missing the exact verify:final-production-readiness script");
    }
    if (String(packageJson.scripts?.start ?? "").includes("run-versioned-migrations")) {
      failures.push("npm start must not invoke the versioned migration runner");
    }
    if (String(packageJson.scripts?.start ?? "").includes("historical-replay")) {
      failures.push("npm start must not invoke Historical Replay");
    }
  } catch (error) {
    failures.push(`package.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

if (failures.length > 0) {
  console.error("Final production readiness contract verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Final production readiness contracts verified.");
console.log("This static check does not replace CI, database rehearsal, deployment, or production smoke testing.");
