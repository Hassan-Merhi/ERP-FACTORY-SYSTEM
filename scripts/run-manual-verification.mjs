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
  "audit-i18n.mjs",
  "audit-large-export-buffers.mjs",
  "audit-lint-warnings.mjs",
  "audit-platform-modernization.mjs",
  "audit-production-logs.mjs",
  "audit-program6c-inventory-payloads.mjs",
  "audit-program6c-stock-item-callers.mjs",
  "audit-program6d-database-query-risks.mjs",
  "audit-realtime-queries.mjs",
  "audit-script-inventory.mjs",
  "audit-source-text-assertions.mjs",
  "audit-toolchain-coherence.mjs",
  "audit-type-escapes.mjs",
  "audit-ux-module-consistency.mjs",
  "audit-write-evidence.mjs",
  "audit-write-route-coverage.mjs",
  "verify-bandwidth-sales-report.mjs",
  "verify-bandwidth-phases-1-2.mjs",
  "verify-database-backup.mjs",
  "verify-dependency-audit.mjs",
  "verify-env-documentation.mjs",
  "verify-final-production-readiness.mjs",
  "verify-group-a.mjs",
  "verify-i18n-audit-classifier.mjs",
  "verify-lockfile-registry.mjs",
  "verify-memory-stabilization.mjs",
  "verify-mobile-responsive-foundation-browser.mjs",
  "verify-mobile-responsive-critical-flows.mjs",
  "verify-mobile-responsive-performance.mjs",
  "verify-mobile-responsive-release-regression.mjs",
  "verify-mobile-responsive-tables.mjs",
  "verify-mobile-responsive-core-erp.mjs",
  "verify-mobile-responsive-factory.mjs",
  "verify-mobile-responsive-pos.mjs",
  "verify-mobile-responsive-reports.mjs",
  "verify-mobile-responsive-factory-browser.mjs",
  "verify-mobile-responsive-factory-floor.mjs",
  "verify-mobile-responsive-erp-browser.mjs",
  "verify-mobile-responsive-erp-operations.mjs",
  "verify-mobile-responsive-regression-browser.mjs",
  "verify-mobile-responsive-visual-regression.mjs",
  "verify-mobile-web-routing.mjs",
  "verify-multilingual-phases-4-7-current-main.mjs",
  "verify-performance-certification.mjs",
  "verify-dialog-form-consistency.mjs",
  "verify-scheduled-attachments.mjs",
  "verify-scheduled-export-lifecycle.mjs",
  "verify-ui-consistency.mjs",
  "verify-observability-disaster-recovery.mjs",
  "verify-api-pagination.mjs",
  "verify-daybook-frontend-pagination.mjs",
  "verify-frontend-pagination.mjs",
  "verify-native-pagination.mjs",
  "verify-operational-monitoring.mjs",
  "verify-v5-frontend-pagination.mjs",
  "verify-business-regression.mjs",
  "verify-costing-engine-consolidation.mjs",
  "verify-chat-report-domains.mjs",
  "verify-historical-accounting-fx-repair-center.mjs",
  "verify-debug-route-extraction.mjs",
  "verify-permission-company-isolation.mjs",
  "verify-current-main-reconciliation.mjs",
  "verify-frontend-data-architecture.mjs",
  "verify-current-main-release.mjs",
  "verify-export-bridge.mjs",
  "verify-final-i18n-baseline.mjs",
  "verify-pr-protection-policy.mjs",
  "verify-production-artifact.mjs",
  "verify-production-dependencies.mjs",
  "verify-program1-observability-foundation.mjs",
  "verify-program2-accounting-foundation.mjs",
  "verify-program2-manual-vouchers.mjs",
  "verify-program2-payments-receipts.mjs",
  "verify-program2-pos-stock-transfers.mjs",
  "verify-program2-containers-freight.mjs",
  "verify-program2-supplier-partner.mjs",
  "verify-program2-payroll.mjs",
  "verify-program2-rentals.mjs",
  "verify-program2-final-reconciliation.mjs",
  "verify-program6b-financial-pagination.mjs",
  "verify-program6d-query-safety.mjs",
  "verify-program6f-export-resource-controls.mjs",
  "verify-program7a-design-system.mjs",
  "verify-program7d-accessibility-responsive.mjs",
  "verify-program8a-incomplete-workflows.mjs",
  "verify-program8b-approval-exceptions.mjs",
  "verify-program8c-reporting-traceability.mjs",
  "verify-programs-6-8-completion.mjs",
  "verify-readable-logging.mjs",
  "verify-readable-logging-phases-1-7.mjs",
  "verify-readable-logging-phases-8-9.mjs",
  "verify-remote-control-action-registry.mjs",
  "verify-remote-support-invariants.mjs",
  "verify-remote-support-rollout-metrics.mjs",
  "verify-render-lazy-schedulers.mjs",
  "verify-render-lazy-routes.mjs",
  "verify-render-operational-routes.mjs",
  "verify-runtime-dependencies.mjs",
  "verify-server-bundle.mjs",
  "verify-sp-migration-rehearsal.mjs",
  "verify-stock-transfer-revision-lifecycle.mjs",
  "verify-api-payload-bandwidth.mjs",
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
