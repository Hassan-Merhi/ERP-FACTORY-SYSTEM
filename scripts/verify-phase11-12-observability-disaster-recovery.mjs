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
  "workflow_dispatch:",
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

if (!/^  schedule:/m.test(resilienceWorkflow)) {
  failures.push("Resilience rehearsal must retain its scheduled trigger.");
}
if (!/^  workflow_dispatch:/m.test(resilienceWorkflow)) {
  failures.push("Resilience rehearsal must remain manually dispatchable.");
}
if (/^  push:/m.test(resilienceWorkflow)) {
  failures.push("Resilience rehearsal must not run on every push after Wave 4 consolidation.");
}
if (!/retention-days:\s*(?:[3-9]\d|[1-9]\d{2,})/.test(resilienceWorkflow)) {
  failures.push("Resilience evidence must be retained for at least 30 days.");
}

const liveBackupWorkflow = requireMarkers(".github/workflows/backup-restore-verification.yml", [
  "Maintenance - Backup Restore Verification",
  "schedule:",
  "workflow_dispatch:",
  "Create fresh logical backup",
  "pg_dump",
  "Restore into isolated PostgreSQL service",
  "Verify restored fingerprint and core tables",
]);
if (/^  push:/m.test(liveBackupWorkflow)) {
  failures.push("Live backup verification must remain scheduled/manual rather than an every-push test.");
}

requireMarkers(".github/workflows/main-certification.yml", [
  "name: Main Certification",
  "Verify exact merged main SHA",
  "verify:observability",
  "verify-phase11-12-observability-disaster-recovery.mjs",
  "verify:stabilization",
  "context='Main Certification'",
]);

requireMarkers("scripts/verify-final-production-readiness.mjs", [
  ".github/workflows/main-certification.yml",
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
