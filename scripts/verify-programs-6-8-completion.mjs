#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const bulkRename = read("client/src/pages/settings/BulkRenameTab.tsx");
const ledgerRoutes = read("server/routes/ledgerRoutes.ts");
const accounts = read("client/src/pages/accountslegacy/useAccountsLegacyModel.ts");
const proforma = read("client/src/pages/factory/ProformaAddLine.tsx");
const locationQueries = read("client/src/pages/location-inventory/useLocationInventoryQueries.ts");
const locationRoutes = read("server/routes/location/locationInventoryRoutes.ts");
const loginHistory = read("client/src/pages/settings/LoginHistoryTab.tsx");

assert(bulkRename.includes("/api/stock-items/light"), "Bulk Rename must use the light stock-item endpoint.");
assert(ledgerRoutes.includes('app.get("/api/ledger-accounts/parent-groups"'), "Parent-group selector endpoint is missing.");
assert(accounts.includes("/api/ledger-accounts/parent-groups"), "Accounts parent-group selector migration is missing.");
assert(proforma.includes('["/api/stock-items/light", selectedCompany?.id]'), "Proforma stock-item query is not company-scoped.");
assert(proforma.includes("enabled: !!selectedCompany"), "Proforma stock-item query must wait for a selected company.");
assert(locationQueries.match(/refetchOnWindowFocus: false/g)?.length >= 2, "Historical inventory queries must disable window-focus refetches.");
assert(locationQueries.match(/refetchOnReconnect: false/g)?.length >= 2, "Historical inventory queries must disable reconnect refetches.");
assert(locationRoutes.includes("MAX_INVENTORY_RATE_STOCK_ITEM_IDS = 250"), "Inventory-rate request bound is missing.");
assert(locationRoutes.includes("new Set("), "Inventory-rate stock-item IDs must be deduplicated.");
assert(!loginHistory.includes("@/lib/excelHelper"), "Login History must not eagerly import the Excel helper.");

for (const file of [
  "scripts/audit-program6c-stock-item-callers.mjs",
  "scripts/audit-program6c-inventory-payloads.mjs",
  "scripts/run-program6c-inventory-review.mjs",
  "scripts/validate-program6c-inventory-classifications.mjs",
  "scripts/verify-program6b-financial-pagination.mjs",
  "scripts/verify-program6d-query-safety.mjs",
  "scripts/verify-program6f-export-resource-controls.mjs",
]) {
  assert(exists(file), `Missing Program 6 safeguard: ${file}`);
}

const program6d = read("docs/archive/program-6d-database-query-optimization.md");
assert(program6d.includes("## Status: COMPLETE"), "Program 6D completion status is missing.");
assert(program6d.includes("995/995"), "Program 6D reconciliation evidence is missing.");
assert(program6d.includes("Stock movement summary is year-bounded and drill-down is month-bounded"), "Stock movement/history bound evidence is missing.");
assert(program6d.includes("No index was added"), "Evidence-based index decision is missing.");

const emptyState = read("client/src/components/ui/empty-state.tsx");
const appLoading = read("client/src/components/ui/page-state.tsx");
const skeleton = read("client/src/components/ui/skeleton.tsx");
const companyRow = read("client/src/pages/settings/CompanyRow.tsx");
const alert = read("client/src/components/ui/alert.tsx");
const progress = read("client/src/components/ui/progress.tsx");
const card = read("client/src/components/ui/card.tsx");
const badge = read("client/src/components/ui/badge.tsx");

assert(emptyState.includes('role="status"'), "Shared EmptyState status semantics are missing.");
assert(emptyState.includes("<h3"), "Shared EmptyState heading semantics are missing.");
assert(emptyState.includes("<p"), "Shared EmptyState description semantics are missing.");
assert(appLoading.includes('aria-live="polite"') && appLoading.includes('aria-busy="true"'), "Shared LoadingState live/busy semantics are missing.");
assert(skeleton.includes('aria-hidden="true"'), "Shared Skeleton decorative semantics are missing.");
assert(companyRow.includes("aria-busy={chatsLoading}") && companyRow.includes("aria-busy={isSaving}"), "CompanyRow busy states are missing.");
assert(alert.includes("React.forwardRef<HTMLHeadingElement") && alert.includes("React.forwardRef<HTMLDivElement"), "Alert element typings are not aligned.");
assert(progress.includes('aria-hidden="true"'), "Progress indicator decorative semantics are missing.");
assert(card.includes("<h3"), "CardTitle heading semantics are missing.");
assert(badge.includes("React.HTMLAttributes<HTMLSpanElement>") && badge.includes("return <span"), "Badge inline semantics are missing.");

const exportGuard = read("scripts/verify-program6f-export-resource-controls.mjs");
for (const marker of [
  "HEAVY_EXPORT_MAX_CONCURRENT",
  "HEAVY_EXPORT_MAX_QUEUE",
  "createWriteStream(filePath",
  "createReadStream(payload.path)",
  "waitForDrain",
  "MEMORY_SOFT_RSS_MB",
  "MEMORY_HARD_RSS_MB",
  "PUPPETEER_MAX_CONCURRENT",
  "PUPPETEER_MAX_QUEUE_DEPTH",
]) {
  assert(exportGuard.includes(marker), `Program 6F safeguard marker is missing: ${marker}`);
}

for (const file of [
  "scripts/program8a-incomplete-workflow-baseline.json",
  "scripts/verify-program8a-incomplete-workflows.mjs",
  "scripts/program8b-approval-exception-baseline.json",
  "scripts/verify-program8b-approval-exceptions.mjs",
  "docs/program-8b-approval-exception-workflows.md",
  "scripts/program8c-reporting-traceability-baseline.json",
  "scripts/verify-program8c-reporting-traceability.mjs",
  "docs/archive/program-8c-reporting-traceability.md",
  "docs/archive/programs-6-8-completion.md",
]) {
  assert(exists(file), `Missing Program 8 or completion safeguard: ${file}`);
}

const program8b = read("scripts/verify-program8b-approval-exceptions.mjs");
for (const marker of [
  "authorization",
  "validation",
  "preview-or-dry-run",
  "explicit-confirmation",
  "transactional-write",
  "audit-trail",
  "idempotency-or-replay-protection",
]) {
  assert(program8b.includes(marker), `Program 8B control class is missing: ${marker}`);
}

const program8c = read("scripts/verify-program8c-reporting-traceability.mjs");
for (const marker of [
  "stable-record-identity",
  "company-scope",
  "source-workflow",
  "deterministic-ordering",
  "company-isolation",
  "export-parity-with-visible-filters",
]) {
  assert(program8c.includes(marker), `Program 8C traceability requirement is missing: ${marker}`);
}

if (failures.length > 0) {
  console.error("Programs 6–8 completion verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Programs 6–8 repository completion invariants verified.");
