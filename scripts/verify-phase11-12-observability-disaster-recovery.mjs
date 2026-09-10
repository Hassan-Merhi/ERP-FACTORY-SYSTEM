#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
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
      failures.push(`${relativePath}: missing required Phase 11/12 marker: ${marker}`);
    }
  }
  return source;
}

requireMarkers("server/routes/admin/operationalMonitoringRoutes.ts", [
  '"/api/admin/operational-monitoring"',
  'requireRole("Admin", "Owner")',
]);

requireMarkers("server/services/operations/operationalHealthService.ts", [
  "http_server_error_rate",
  "slow_request_rate",
  "database_pool_waiting",
  "heap_usage",
  "recent_critical_events",
]);

requireMarkers("server/lib/operationalAlerts.ts", [
  "OBSERVABILITY_ALERT_COOLDOWN_MS",
  "OBSERVABILITY_ALERT_HISTORY_LIMIT",
  "OBSERVABILITY_ALERT_WEBHOOK_URL",
  "AbortSignal.timeout(3_000)",
  "Operational alert delivery failed",
]);

requireMarkers("server/lib/operationalAlertRuntime.ts", [
  'OBSERVABILITY_ALERTS_ENABLED !== "true"',
  "Math.max(60_000, parsedInterval)",
  'role === "admin" || role === "developer"',
]);

requireMarkers("docs/operations/external-alerting-checklist.md", [
  "Do not send request bodies",
  "Group repeated errors",
  "recovery notification",
  "Operational validation status",
]);

const recoveryRunbook = requireMarkers("docs/operations/database-backup-rollback-recovery.md", [
  "Repository rehearsal objectives",
  "weekly disposable restore rehearsal",
  "critical-row fingerprint",
  "rehearsal recovery-time budget",
  "Production RPO and RTO",
  "cannot certify the production backup frequency",
]);

if (recoveryRunbook.includes("production RPO is certified") || recoveryRunbook.includes("production RTO is certified")) {
  failures.push("Recovery runbook must not claim production RPO/RTO certification from CI rehearsal evidence.");
}

const resilienceWorkflow = requireMarkers(".github/workflows/resilience-rehearsal.yml", [
  "schedule:",
  "cron:",
  'DR_REHEARSAL_RTO_SECONDS: "300"',
  "npm run verify:observability",
  'DATABASE_URL: postgresql://postgres:postgres@localhost:5432/heliumdb',
  "RESTORE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/heliumdb_restore",
  "source-critical-counts.tsv",
  "restore-critical-counts.tsv",
  "diff -u",
  "resilience-evidence.json",
  "Upload resilience evidence",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
]);

// The rehearsal used to name every observability and disaster-recovery file in a
// `pull_request` paths filter. "Run checks only on main" (#1320) removed that
// trigger, so those path markers no longer exist anywhere. The guarantee they
// encoded — a change to those files always rehearses — is now carried by running
// on every push to main with no paths filter, which is strictly broader coverage.
// Assert that trigger instead, so the guarantee stays enforced rather than dropped.
if (!/^on:\n\s*push:\n\s*branches:\s*\[\s*main\s*\]/m.test(resilienceWorkflow)) {
  failures.push(
    ".github/workflows/resilience-rehearsal.yml must run on every push to main so observability and disaster-recovery changes always rehearse."
  );
}
if (/^\s*paths(?:-ignore)?:/m.test(resilienceWorkflow)) {
  failures.push(
    ".github/workflows/resilience-rehearsal.yml must not narrow its triggers with a paths filter; every main commit must rehearse."
  );
}

if (resilienceWorkflow.includes("secrets.")) {
  failures.push("Resilience rehearsal must not reference repository or environment secrets; it must stay on disposable localhost PostgreSQL.");
}

if (!/retention-days:\s*(?:[3-9]\d|[1-9]\d{2,})/.test(resilienceWorkflow)) {
  failures.push("Resilience evidence must be retained for at least 30 days.");
}

requireMarkers(".github/workflows/exact-main-certification.yml", [
  "verify-phase11-12-observability-disaster-recovery.mjs",
  'DR_REHEARSAL_RTO_SECONDS: "300"',
  "exact-main-source-critical-counts.tsv",
  "exact-main-restore-critical-counts.tsv",
  "diff -u",
]);

requireMarkers("scripts/verify-final-production-readiness.mjs", [
  "verify-phase11-12-observability-disaster-recovery.mjs",
  "source-critical-counts.tsv",
  "resilience-evidence.json",
  "DR_REHEARSAL_RTO_SECONDS",
]);

if (failures.length > 0) {
  console.error("Phase 11/12 observability and disaster-recovery verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Phase 11/12 observability and disaster-recovery contracts verified.");
console.log("Repository rehearsal evidence does not by itself certify production backup cadence, production RPO/RTO, or external alert delivery.");