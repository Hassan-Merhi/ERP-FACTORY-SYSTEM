#!/usr/bin/env node
/**
 * Phase 11: dependency-free static safety gate.
 * Run in a real checkout: node scripts/verify-properties-unification-phase11.mjs
 * This does NOT replace TypeScript, Vitest, browser, authorization or ledger tests.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(new URL(path, "file://" + root), "utf8");
const files = {
  centralDelete: "server/routes/rental/centralRentalPaymentDeletionRoute.ts",
  accrual: "server/routes/rental/rentalPaymentsAccrualRoutes.ts",
  routeFactory: "server/routes/rentalRouteFactory.ts",
  permissions: "server/routes/rental/rentalRoutePermissions.ts",
  paymentPage: "client/src/pages/properties/RentalPaymentsLog.tsx",
  rentalsPage: "client/src/pages/properties/PropertyRentalPage.tsx",
  receiptMath: "client/src/pages/properties/property-rental/paymentsReceiptMath.ts",
  snapshot: "client/src/pages/properties/property-rental/historicalRentSnapshot.ts",
  reporting: "client/src/properties/config/rentalReportingPresentation.ts",
  paymentUi: "client/src/properties/config/rentalPaymentPresentation.ts",
  identity: "client/src/properties/config/historicalRentReportingPolicy.ts",
  navigation: "client/src/properties/config/propertiesNavigation.ts",
  routes: "client/src/app/PropertiesRoutes.tsx",
  sidebar: "client/src/components/PropertiesSidebar.tsx",
  filters: "client/src/properties/hooks/useRentalPaymentsFilters.ts",
  premium: "client/src/pages/properties/property-rental/components/PropertiesPaymentsPremium.tsx",
};
const content = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, read(path)]));
const checks = [
  ["posted payment deletion uses canonical authorization", () => content.centralDelete.includes("requireAuth, requireRentalDeletePermission")],
  ["scheduled cancellation uses canonical authorization", () => content.accrual.includes("requireAuth, requireRentalDeletePermission")],
  ["reconciliation uses canonical authorization", () => content.routeFactory.includes("requireAuth, requireRentalReconciliationPermission")],
  ["permission policy reads active company from database", () => content.permissions.includes("getActiveCompanyPermissionContext")],
  ["no legacy reconciliation role fallback", () => !content.routeFactory.includes("session?.role")],
  ["reconciliation restricted to Admin/Developer", () => content.permissions.includes('context.role !== "Admin" && context.role !== "Developer"')],
  ["posted deletion retains company/module scope", () => content.centralDelete.includes("companyId") && content.centralDelete.includes("module")],
  ["scheduled cancellation retains company/module/status predicates", () => ["eq(propertyPayments.companyId, companyId)", "eq(propertyPayments.module, module)", "postingStatus"].every((value) => content.accrual.includes(value))],
  ["posted voucher and cash account required for cash receipt", () => content.receiptMath.includes('row.postingStatus === "POSTED" && row.voucherId != null && row.cashAccountId != null')],
  ["TSV exports fail closed for non-USD currencies", () => content.receiptMath.includes("assertUsdHistoryExport(rows)")],
  ["historical cutoff remains 2026-10-26", () => content.snapshot.includes('HISTORICAL_RENT_CUTOFF = "2026-10-26"')],
  ["historical company identity remains stable", () => ["company.id === HASSAN_PROPERTIES_REPORTING_COMPANY_ID", "company.code === HASSAN_PROPERTIES_REPORTING_COMPANY_CODE"].every((value) => content.identity.includes(value))],
  ["unreachable reconciliation tabs removed", () => !content.paymentPage.includes("RECONCILIATION_VIEWS") && !content.filters.includes("effectiveView")],
  ["company business day used in payment filters", () => content.filters.includes("rentalPeriodBounds(effectivePeriod)") && content.reporting.includes("getAppDate()")],
  ["currency checks present in both financial UIs", () => content.paymentPage.includes("hasSingleUsdBasis(filtered)") && content.rentalsPage.includes("contractTotalsAreUsd")],
  ["full-history button restricted to verified historical view", () => content.paymentPage.includes("const copyIsFull = isFullHistory;")],
  ["never show false full-history button on other Properties companies", () => !content.paymentPage.includes("const copyIsFull = noFilters;")],
  ["single payment deletion confirmation used", () => content.paymentPage.includes("<RentalPaymentDeleteDialog") && !content.paymentPage.includes("<ConfirmDialog")],
  ["Properties deletion message does not assume auto transfer", () => content.paymentUi.includes("do not automatically transfer")],
  ["cross-module Properties payment deletion UI blocked", () => content.premium.includes("mayOfferRentalPaymentDelete")],
  ["payment day display is timezone neutral", () => content.paymentUi.includes('timeZone: "UTC"')],
  ["six pinned Properties pages", () => (content.navigation.match(/navigation: "pinned"/g) ?? []).length === 6],
  ["operational legacy dashboard retained", () => content.routes.includes('path="/properties/dashboard" component={PropertiesDashboard}')],
  ["compatibility dashboard hidden from pinned navigation", () => content.navigation.includes('path: "/properties/dashboard", label: "Compatibility Dashboard", parent: null, capability: "workspace", navigation: "hidden"')],
  ["legacy rental redirects registered from manifest", () => content.routes.includes("Object.entries(PROPERTIES_LEGACY_RENTAL_REDIRECTS).map")],
  ["unknown routes safely redirect with replace", () => content.routes.includes('<Redirect replace to="/properties/daybook" />')],
  ["sidebar pinned icons keyed by pathname", () => content.sidebar.includes("pinnedIconsByPath")],
];
for (const [label, fn] of checks) {
  assert.ok(fn(), "FAIL: " + label);
  process.stdout.write("PASS " + label + "\n");
}
process.stdout.write(`Passed ${checks.length} static Properties regression checks.\n`);
