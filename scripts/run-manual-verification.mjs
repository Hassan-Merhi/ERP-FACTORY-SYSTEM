#!/usr/bin/env node
/**
 * Manual verification dispatcher.
 *
 * Keeps intentionally retained one-shot verify/audit scripts addressable
 * without promoting historical or environment-specific checks into automatic CI.
 * Newly added verify/audit scripts must be added here, exposed elsewhere, or
 * deliberately wired/chained; otherwise the zero-orphan inventory gate fails.
 *
 * Usage:
 *   npm run verify:manual -- --list
 *   npm run verify:manual -- verify-program2-phase9-final-reconciliation.mjs
 *   npm run verify:manual -- verify-sp-migration-rehearsal.mjs --help
 */
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MANUAL_VERIFICATION_CATALOG = Object.freeze([
  "audit-company-scope.mjs",
  "audit-coverage-ratchet.mjs",
  "audit-doc-index.mjs",
  "audit-god-file-boundaries.mjs",
  "audit-heavy-list-endpoints.mjs",
  "audit-i18n-phase14.mjs",
  "audit-large-export-buffers.mjs",
  "audit-lint-warnings.mjs",
  "audit-platform-modernization.mjs",
  "audit-production-logs.mjs",
  "audit-program6c-inventory-payloads.mjs",
  "audit-program6c-stock-item-callers.mjs",
  "audit-program6d-database-query-risks.mjs",
  "audit-realtime-wave3.mjs",
  "audit-script-inventory.mjs",
  "audit-source-text-assertions.mjs",
  "audit-toolchain-coherence.mjs",
  "audit-type-escapes.mjs",
  "audit-ux-module-consistency.mjs",
  "audit-write-evidence.mjs",
  "audit-write-route-coverage.mjs",
  "verify-bandwidth-phase-3-sales-report.mjs",
  "verify-bandwidth-phases-1-2.mjs",
  "verify-ci-disposable-schema.mjs",
  "verify-database-backup.mjs",
  "verify-dependency-audit.mjs",
  "verify-env-documentation.mjs",
  "verify-final-production-readiness.mjs",
  "verify-group-a-phase-3.mjs",
  "verify-i18n-audit-classifier.mjs",
  "verify-lockfile-registry.mjs",
  "verify-memory-stabilization.mjs",
  "verify-migration-registry.mjs",
  "verify-mobile-responsive-phase1-browser.mjs",
  "verify-mobile-responsive-phase1-critical-flows.mjs",
  "verify-mobile-responsive-phase10-performance.mjs",
  "verify-mobile-responsive-phase11-regression.mjs",
  "verify-mobile-responsive-phase5-tables.mjs",
  "verify-mobile-responsive-phase6-core-erp.mjs",
  "verify-mobile-responsive-phase7-factory.mjs",
  "verify-mobile-responsive-phase8-pos.mjs",
  "verify-mobile-responsive-phase9-reports.mjs",
  "verify-mobile-responsive-wave2-browser.mjs",
  "verify-mobile-responsive-wave2-factory-floor.mjs",
  "verify-mobile-responsive-wave3-browser.mjs",
  "verify-mobile-responsive-wave3-erp-operations.mjs",
  "verify-mobile-responsive-wave4-browser.mjs",
  "verify-mobile-responsive-wave4-regression.mjs",
  "verify-mobile-web-routing.mjs",
  "verify-multilingual-phases-4-7-current-main.mjs",
  "verify-performance-wave5-certification.mjs",
  "verify-phase10-dialog-form-consistency.mjs",
  "verify-phase10-scheduled-attachments.mjs",
  "verify-phase10-scheduled-export-lifecycle.mjs",
  "verify-phase10-ui-consistency.mjs",
  "verify-phase11-12-observability-disaster-recovery.mjs",
  "verify-phase11-api-pagination.mjs",
  "verify-phase11-daybook-frontend-pagination.mjs",
  "verify-phase11-frontend-pagination.mjs",
  "verify-phase11-native-pagination.mjs",
  "verify-phase11-operational-monitoring.mjs",
  "verify-phase11-v5-frontend-pagination.mjs",
  "verify-phase12-business-regression.mjs",
  "verify-phase5-costing-engine-consolidation.mjs",
  "verify-phase6-chat-report-domains.mjs",
  "verify-phase6-historical-accounting-fx-repair-center.mjs",
  "verify-phase7-debug-route-extraction.mjs",
  "verify-phase7-permission-company-isolation.mjs",
  "verify-phase8-current-main-reconciliation.mjs",
  "verify-phase8-frontend-data-architecture.mjs",
  "verify-phase9-current-main-release.mjs",
  "verify-phase9-export-bridge.mjs",
  "verify-phase9-final-i18n-baseline.mjs",
  "verify-pr-protection-policy.mjs",
  "verify-production-artifact.mjs",
  "verify-production-dependencies.mjs",
  "verify-program1-observability-foundation.mjs",
  "verify-program2-phase1-accounting-foundation.mjs",
  "verify-program2-phase2-manual-vouchers.mjs",
  "verify-program2-phase3-payments-receipts.mjs",
  "verify-program2-phase4-pos-stock-transfers.mjs",
  "verify-program2-phase5-containers-freight.mjs",
  "verify-program2-phase6-supplier-partner.mjs",
  "verify-program2-phase7-payroll.mjs",
  "verify-program2-phase8-rentals.mjs",
  "verify-program2-phase9-final-reconciliation.mjs",
  "verify-program6b-financial-pagination.mjs",
  "verify-program6d-query-safety.mjs",
  "verify-program6f-export-resource-controls.mjs",
  "verify-program7a-design-system.mjs",
  "verify-program7d-accessibility-responsive.mjs",
  "verify-program8a-incomplete-workflows.mjs",
  "verify-program8b-approval-exceptions.mjs",
  "verify-program8c-reporting-traceability.mjs",
  "verify-programs-6-8-completion.mjs",
  "verify-readable-logging-phase-10.mjs",
  "verify-readable-logging-phases-1-7.mjs",
  "verify-readable-logging-phases-8-9.mjs",
  "verify-remote-control-action-registry.mjs",
  "verify-remote-support-phase17-invariants.mjs",
  "verify-remote-support-rollout-metrics.mjs",
  "verify-render-phase2-lazy-schedulers.mjs",
  "verify-render-phase3-lazy-routes.mjs",
  "verify-render-phase4-operational-routes.mjs",
  "verify-runtime-dependencies.mjs",
  "verify-server-bundle.mjs",
  "verify-sp-migration-rehearsal.mjs",
  "verify-startup-migrations.mjs",
  "verify-stock-transfer-revision-lifecycle.mjs",
  "verify-wave3-api-payload-bandwidth.mjs",
  "verify-workspace-lockfile-hygiene.mjs"
]);

function printCatalog() {
  console.log("Maintained verification scripts:");
  for (const script of MANUAL_VERIFICATION_CATALOG) console.log(`  ${script}`);
}

const [requested, ...args] = process.argv.slice(2);

if (!requested || requested === "--list") {
  printCatalog();
  process.exit(0);
}

if (!MANUAL_VERIFICATION_CATALOG.includes(requested)) {
  console.error(`Unknown verification script: ${requested}`);
  printCatalog();
  process.exit(2);
}

const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", requested), ...args], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
