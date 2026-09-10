/**
 * Guard sweep over the sensitive write surface.
 *
 * The API smoke sweep proves the read surface still responds. It cannot do the
 * same for writes — calling a mutating endpoint in a sweep would post vouchers
 * and move stock — so `tests/api-smoke-sweep.test.ts` excludes them by design,
 * and `npm run audit:write-routes` exists to measure the hole that leaves.
 *
 * There is exactly one thing that can be asserted about every write route
 * without writing anything: an unauthenticated caller must be turned away.
 * That request is rejected by the guard chain before the handler runs, so the
 * sweep is safe on endpoints a read sweep could never touch, and the property
 * is worth holding — a route registered without `requireAuth` is a hole in the
 * ledger that nothing else in this repository would notice.
 *
 * What this sweep is NOT is behavioural coverage. It says nothing about whether
 * a route computes the right numbers. `audit-write-route-coverage.mjs` counts
 * routes covered only by this file separately, under
 * `guardOnlySensitiveCeiling`, so that "referenced by a test" cannot quietly
 * come to mean "swept". Phase F draws that second number down by giving these
 * routes real tests; a route leaves the guard-only set as soon as any other
 * test names it.
 *
 * Four worker-deduction routes briefly left this list when
 * server/routes/payroll/workerStatsAdvancesRoutes.ts was split. They write
 * factory_worker_deductions only, and the audit classifies by owner file, so
 * sharing a 936-line file with the voucher-posting advance routes had been
 * lending them a sensitivity they did not declare themselves.
 *
 * Rather than accept the narrower set, factory_worker_deductions was added to
 * SENSITIVE_TABLES. A payroll deduction reduces what a worker is paid, and
 * reaching the ledger through a payroll voucher rather than directly does not
 * make it less real. Both zero ceilings still hold at the wider set, so the
 * coverage was already there — only the classification was wrong.
 *
 * Two stock-transfer-revision routes left this list when the revision lifecycle
 * became immutable. DELETE /api/stock-transfer-revisions/:id and
 * PATCH /api/stock-transfer-revisions/:id/optional are now answered by the
 * tombstones in server/routes/vouchers/immutableStockTransferRevisionRoutes.ts,
 * which are registered first and reject every call with 409 before any write.
 * The approve handler that used to adjust inventory from
 * server/routes/fiscal-transfers/revisions-write.ts moved to
 * services/immutableStockTransferRevisionLifecycle, so the owner file no longer
 * writes a sensitive table. Unlike the worker deductions above, narrowing is
 * right here: these two routes can no longer write anything at all.
 *
 * The inventory below is written out rather than derived from the manifest at
 * runtime, for two reasons: the coverage audit looks for path literals in test
 * sources, and an explicit list is reviewable in a diff. The first test keeps
 * it honest by requiring it to equal the audit's sensitive set exactly, so a
 * new sensitive write route fails here until it is listed.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { auditWriteRouteCoverage } from "../scripts/audit-write-route-coverage.mjs";
import { setupTestApp, closeTestServer } from "./setup";
import type { Express } from "express";

/**
 * Every write route the coverage audit classifies as touching the ledger or the
 * stock ledger, as `METHOD /path`. Regenerate with:
 *
 *     node scripts/audit-write-route-coverage.mjs --json
 */
const SENSITIVE_WRITE_ROUTES = [
  "DELETE /api/bales/:id",
  "DELETE /api/deleted-items/:type/:id/permanent",
  "DELETE /api/factory/advances/:id",
  "DELETE /api/factory/bale-products/:id",
  "DELETE /api/factory/bales/:id",
  "DELETE /api/factory/containers/:id",
  "DELETE /api/factory/customer-orders/:id",
  "DELETE /api/factory/customer-orders/:id/bales/:baleId",
  "DELETE /api/factory/customer-orders/:id/charges/:chargeId",
  "DELETE /api/factory/daybook/entry/:id",
  "DELETE /api/factory/daybook/entry/:id/void",
  "DELETE /api/factory/dispatch-bale-scans/:id",
  "DELETE /api/factory/dispatch-batches/:id",
  "DELETE /api/factory/employee-advances/:id",
  "DELETE /api/factory/employee-bonuses/:id",
  "DELETE /api/factory/mix-batches/:id",
  "DELETE /api/factory/payroll/:id",
  "DELETE /api/factory/pos/sales/:id",
  "DELETE /api/factory/raw-stock/adjustments/:id",
  "DELETE /api/factory/raw-stock/batch-source",
  "DELETE /api/factory/raw-stock/opening-balance/:id",
  "DELETE /api/factory/raw-stock/receipts/:rawStockId",
  "DELETE /api/factory/shipping-container-rows/:id",
  "DELETE /api/factory/supplier-payments/:id",
  "DELETE /api/factory/suppliers/:id",
  "DELETE /api/factory/suppliers/:id/permanent",
  "DELETE /api/factory/transporters/:id/transactions/:txId",
  "DELETE /api/factory/v3/loads/:id/bales/:baleId",
  "DELETE /api/factory/waste-dispatch/:id",
  "DELETE /api/factory/worker-bonuses/:id",
  "DELETE /api/factory/workers/:workerId/deductions/:id",
  "DELETE /api/insurance/members/:id",
  "DELETE /api/intercompany-links/:id",
  "DELETE /api/ledger-accounts/:id",
  "DELETE /api/lookup/reference/:referenceNumber/delete-everywhere",
  "DELETE /api/orphaned-records/delete-all",
  "DELETE /api/payroll/runs/:id",
  "DELETE /api/payroll/workers/:workerId/deductions/:id",
  "DELETE /api/purchase-orders/:id",
  "DELETE /api/salary-advances/:id",
  "DELETE /api/sp/migration/cutover",
  "DELETE /api/vouchers/:id",
  "DELETE /api/waste-dispatches/:id",
  "PATCH /api/bales/:id",
  "PATCH /api/containers/:id/number",
  "PATCH /api/containers/:id/offload",
  "PATCH /api/credit-notes/:id",
  "PATCH /api/factory/advances/:id",
  "PATCH /api/factory/bale-products/:id",
  "PATCH /api/factory/bales/:id/assign-worker",
  "PATCH /api/factory/bales/:id/product-name",
  "PATCH /api/factory/bales/:id/status",
  "PATCH /api/factory/bales/:id/weight",
  "PATCH /api/factory/bales/bulk-assign-worker",
  "PATCH /api/factory/bales/bulk-date",
  "PATCH /api/factory/bales/bulk-status",
  "PATCH /api/factory/containers/:id",
  "PATCH /api/factory/customer-orders/:id/charges/:chargeId",
  "PATCH /api/factory/customer-orders/:id/date",
  "PATCH /api/factory/customer-orders/:id/hidden",
  "PATCH /api/factory/customer-orders/:id/link-proforma",
  "PATCH /api/factory/customer-orders/:id/loading-note",
  "PATCH /api/factory/daybook/:entryId/cost-edit",
  "PATCH /api/factory/dispatch-batches/:id",
  "PATCH /api/factory/mix-batches/:id",
  "PATCH /api/factory/payroll/:id",
  "PATCH /api/factory/payrolls/:id/fix-accounting",
  "PATCH /api/factory/payrolls/:id/mark-paid",
  "PATCH /api/factory/raw-stock/opening-balance/:id",
  "PATCH /api/factory/raw-stock/receipts/:rawStockId",
  "PATCH /api/factory/shipping-container-rows/:id",
  "PATCH /api/factory/shipping-container-rows/:id/sync-order",
  "PATCH /api/factory/suppliers/:id",
  "PATCH /api/factory/suppliers/:id/opening-balance",
  "PATCH /api/factory/suppliers/:id/reactivate",
  "PATCH /api/factory/suppliers/:id/set-broker",
  "PATCH /api/factory/transporters/:id",
  "PATCH /api/factory/v3/loads/:id/cancel",
  "PATCH /api/factory/v3/loads/:id/start",
  "PATCH /api/insurance/members/:id",
  "PATCH /api/insurance/members/:id/toggle",
  "PATCH /api/ledger-accounts/bulk-assign-parent",
  "PATCH /api/lookup/reference/:referenceNumber/change-product",
  "PATCH /api/payroll/runs/:id",
  "PATCH /api/purchase-orders/:id",
  "PATCH /api/sp/containers/:id",
  "PATCH /api/sp/migration/cutover",
  "PATCH /api/stock-transfers/:id",
  "PATCH /api/voucher-entries/:id",
  "PATCH /api/vouchers/:id",
  "PATCH /api/vouchers/:id/adjustment",
  "PATCH /api/vouchers/:id/journal",
  "PATCH /api/vouchers/:id/optional",
  "PATCH /api/vouchers/:id/payment-receipt",
  "PATCH /api/vouchers/:id/purchase",
  "PATCH /api/vouchers/:id/transfer",
  "POST /api/admin/account-migration/execute",
  "POST /api/admin/account-migration/preview",
  "POST /api/admin/account-migration/undo",
  "POST /api/admin/apply-missing-migrations",
  "POST /api/admin/backfill-payroll-vouchers",
  "POST /api/admin/backfill-postoffload-vouchers",
  "POST /api/admin/cleanup-legacy-employee-accounts",
  "POST /api/admin/company-data-reset",
  "POST /api/admin/delete-orphaned-pos-sales",
  "POST /api/admin/fix-orphaned-bales",
  "POST /api/admin/fix-orphaned-charge-vouchers",
  "POST /api/admin/fix-orphaned-pos-data",
  "POST /api/admin/fix-sales-inventory",
  "POST /api/admin/initialize-accounting-balances",
  "POST /api/admin/migrate-employee-account/:accountId",
  "POST /api/admin/rebuild-inventory",
  "POST /api/admin/repair-balances/apply",
  "POST /api/admin/repair-balances/undo",
  "POST /api/admin/repair-inventory-values",
  "POST /api/admin/reset-company-data",
  "POST /api/admin/undo-company-reset",
  "POST /api/bale-label-prints",
  "POST /api/bale-label-prints/allocate-pool",
  "POST /api/bale-label-prints/reprint",
  "POST /api/bales",
  "POST /api/bales/import",
  "POST /api/bales/price-import/apply",
  "POST /api/bales/price-import/preview",
  "POST /api/cleanup/orphaned-charges",
  "POST /api/company-settings",
  "POST /api/containers/:id/offload",
  "POST /api/containers/:id/reverse-offload",
  "POST /api/containers/:id/sync-voucher",
  "POST /api/containers/sync-all-vouchers",
  "POST /api/credit-notes",
  "POST /api/credit-sales-import/import",
  "POST /api/credit-sales-import/parse",
  "POST /api/credit-sales-import/validate",
  "POST /api/deleted-items/:type/:id/restore",
  "POST /api/dev/seed",
  "POST /api/exchange-rates",
  "POST /api/factory/admin/fix-other-charges-currency",
  "POST /api/factory/advances/:id/repayments",
  "POST /api/factory/advances/:id/reverse",
  "POST /api/factory/advances/bulk",
  "POST /api/factory/advances/bulk-update-cash-account",
  "POST /api/factory/advances/cash-adjustment",
  "POST /api/factory/advances/post-accounting",
  "POST /api/factory/advances/post-repayment-vouchers",
  "POST /api/factory/advances/reconcile",
  "POST /api/factory/advances/repay-by-month",
  "POST /api/factory/bale-products/:id/cascade-update",
  "POST /api/factory/bale-products/bulk-rename-apply",
  "POST /api/factory/bale-products/bulk-rename-preview",
  "POST /api/factory/bale-products/bulk-toggle-active",
  "POST /api/factory/bale-products/bulk-update-prices",
  "POST /api/factory/bale-products/import-excel",
  "POST /api/factory/bale-products/merge",
  "POST /api/factory/bales/:id/repack",
  "POST /api/factory/bales/:id/return-to-stock",
  "POST /api/factory/bales/backfill-costs",
  "POST /api/factory/bales/bulk-update-names",
  "POST /api/factory/bales/create-batch",
  "POST /api/factory/bales/import",
  "POST /api/factory/bales/import-excel",
  "POST /api/factory/bales/reimport",
  "POST /api/factory/bales/relabel/apply",
  "POST /api/factory/bales/relabel/validate",
  "POST /api/factory/bales/swap",
  "POST /api/factory/bales/validate-import",
  "POST /api/factory/containers",
  "POST /api/factory/containers/:id/other-charges/sync",
  "POST /api/factory/containers/:id/reverse-offload",
  "POST /api/factory/containers/backfill-import-credits",
  "POST /api/factory/containers/bulk-delete",
  "POST /api/factory/customer-orders",
  "POST /api/factory/customer-orders-loading",
  "POST /api/factory/customer-orders/:id/assign-container",
  "POST /api/factory/customer-orders/:id/auto-recover-bales",
  "POST /api/factory/customer-orders/:id/bales",
  "POST /api/factory/customer-orders/:id/bales/bulk-import",
  "POST /api/factory/customer-orders/:id/bales/exchange",
  "POST /api/factory/customer-orders/:id/cancel",
  "POST /api/factory/customer-orders/:id/charges",
  "POST /api/factory/customer-orders/:id/charges/relink-vouchers",
  "POST /api/factory/customer-orders/:id/finalize",
  "POST /api/factory/customer-orders/:id/finalize-loading",
  "POST /api/factory/customer-orders/:id/force-sync-bale-status",
  "POST /api/factory/customer-orders/:id/recover-bales",
  "POST /api/factory/customer-orders/:id/restore-loading",
  "POST /api/factory/customer-orders/:id/return-to-loading",
  "POST /api/factory/customer-orders/:id/unfinalize",
  "POST /api/factory/customer-orders/:id/verify",
  "POST /api/factory/customer-proformas/:id/create-loading",
  "POST /api/factory/dispatch-batches",
  "POST /api/factory/dispatch-batches/:id/generate-invoice",
  "POST /api/factory/dispatch-truck-rides/:id/scan-bale",
  "POST /api/factory/employee-advances",
  "POST /api/factory/employee-advances/:id/repay",
  "POST /api/factory/employee-bonuses",
  "POST /api/factory/employees/:id/deposit",
  "POST /api/factory/employees/:id/withdraw",
  "POST /api/factory/employees/bulk-payroll",
  "POST /api/factory/employees/bulk-withdraw",
  "POST /api/factory/finalize",
  "POST /api/factory/import-company-data",
  "POST /api/factory/import/bales",
  "POST /api/factory/import/opening-raw-stock",
  "POST /api/factory/import/raw-stock",
  "POST /api/factory/import/suppliers",
  "POST /api/factory/migrate-voucher-descriptions",
  "POST /api/factory/mix-batches",
  "POST /api/factory/mix-batches/:id/assign-bales",
  "POST /api/factory/mix-batches/:id/finalize",
  "POST /api/factory/mix-batches/:id/top-up",
  "POST /api/factory/payroll/:id/undo",
  "POST /api/factory/payroll/migrate-city-split",
  "POST /api/factory/payroll/migrate-salary-groups",
  "POST /api/factory/payroll/migrate-worker-names",
  "POST /api/factory/payrolls/generate-bulk",
  "POST /api/factory/payrolls/mark-paid-bulk",
  "POST /api/factory/pos/sale",
  "POST /api/factory/pressing/create-and-print",
  "POST /api/factory/pressing/create-multi",
  "POST /api/factory/raw-stock/:rawStockId/assign-to-bales",
  "POST /api/factory/raw-stock/adjustment",
  "POST /api/factory/raw-stock/deduct-received",
  "POST /api/factory/raw-stock/offload",
  "POST /api/factory/raw-stock/opening-balance",
  "POST /api/factory/raw-stock/recalc-opening",
  "POST /api/factory/raw-stock/recalc/historical-replay/apply",
  "POST /api/factory/raw-stock/recalc/undo",
  "POST /api/factory/raw-stock/recalculate-bale-costs",
  "POST /api/factory/raw-stock/recalculate-used",
  "POST /api/factory/raw-stock/update-cost",
  "POST /api/factory/repair-orphaned-vouchers",
  "POST /api/factory/shipping-container-rows",
  "POST /api/factory/shipping-container-rows/:id/done",
  "POST /api/factory/shipping-container-rows/:id/restore",
  "POST /api/factory/shipping-container-rows/sync",
  "POST /api/factory/stock-entry",
  "POST /api/factory/stock-entry/remove",
  "POST /api/factory/stock-entry/remove-by-product",
  "POST /api/factory/supplier-payments",
  "POST /api/factory/suppliers",
  "POST /api/factory/transporters",
  "POST /api/factory/transporters/:id/charges",
  "POST /api/factory/transporters/:id/payments",
  "POST /api/factory/v3/loads",
  "POST /api/factory/v3/loads/:id/bales",
  "POST /api/factory/v3/loads/:id/finalize",
  "POST /api/factory/waste-dispatch/submit",
  "POST /api/factory/worker-bonuses",
  "POST /api/factory/worker-bonuses/:id/pay",
  "POST /api/factory/workers/:id/advances",
  "POST /api/factory/workers/:id/bulk-repay-advances",
  "POST /api/factory/workers/:id/deductions",
  "POST /api/fix-old-po-credits",
  "POST /api/fix-parent-po-supplier-entries",
  "POST /api/golden-coast/accounting/phase1/post",
  "POST /api/golden-coast/accounting/phase1/preview",
  "POST /api/golden-coast/accounting/phase1/setup-accounts",
  "POST /api/insurance/admin/clear-all",
  "POST /api/insurance/admin/repair-reversed-journals",
  "POST /api/insurance/generate",
  "POST /api/insurance/import/apply",
  "POST /api/insurance/import/preview",
  "POST /api/insurance/members",
  "POST /api/intercompany-links",
  "POST /api/intercompany-requests/:id/approve",
  "POST /api/intercompany-requests/:id/dismiss",
  "POST /api/ledger-accounts",
  "POST /api/lookup/reference/:referenceNumber/scan",
  "POST /api/offloads/:id/toggle-optional",
  "POST /api/orphaned-records/reassign",
  "POST /api/payroll/auto-calculate-bonuses",
  "POST /api/payroll/bonus-employee",
  "POST /api/payroll/bulk-bonus-employees",
  "POST /api/payroll/bulk-deposit-employees",
  "POST /api/payroll/bulk-pay-workers",
  "POST /api/payroll/bulk-withdraw-employees",
  "POST /api/payroll/deposit-employee",
  "POST /api/payroll/pay-worker",
  "POST /api/payroll/runs",
  "POST /api/payroll/runs/:id/undo",
  "POST /api/payroll/runs/migrate-group-expenses",
  "POST /api/payroll/withdraw-employee",
  "POST /api/payroll/workers/:id/deductions",
  "POST /api/po-import/import",
  "POST /api/po-import/validate",
  "POST /api/pos-import/import",
  "POST /api/pos-import/parse",
  "POST /api/pos-import/validate",
  "POST /api/properties/repair/reallocate-payments/:contractId",
  "POST /api/purchase-orders/:id/sync-parent-voucher",
  "POST /api/reverse-po-credits",
  "POST /api/salary-advances",
  "POST /api/salary-advances/:id/deduction",
  "POST /api/salary-advances/reconcile",
  "POST /api/sales-import/backfill",
  "POST /api/sales-report/recalculate-costs",
  "POST /api/sp/containers",
  "POST /api/sp/containers/:id/cancel",
  "POST /api/sp/migration/create-sp-company",
  "POST /api/sp/migration/cutover",
  "POST /api/sp/migration/cutover/cancel",
  "POST /api/sp/migration/cutover/finalize",
  "POST /api/sp/migration/cutover/prepare",
  "POST /api/sp/migration/cutover/rollback",
  "POST /api/sp/migration/gc-container-charge-review/:chargeId/map",
  "POST /api/sp/migration/gc-containers",
  "POST /api/sp/migration/gc-create-accounts",
  "POST /api/sp/migration/gc-profit-opening",
  "POST /api/sp/migration/gc-rehearsal",
  "POST /api/sp/migration/gc-sales-readonly",
  "POST /api/sp/migration/gc-stock-master",
  "POST /api/sp/migration/gc-stock-opening",
  "POST /api/sp/migration/gc-suspense-review/:targetEntryId/map",
  "POST /api/sp/migration/opening-balance",
  "POST /api/sp/migration/rehearsal",
  "POST /api/sp/migration/rollback",
  "POST /api/sp/offload",
  "POST /api/sp/offloads/:id/reverse",
  "POST /api/sp/opening-stock",
  "POST /api/sp/prepaid",
  "POST /api/sp/sales",
  "POST /api/sp/sales/:id/reverse",
  "POST /api/sp/setup",
  "POST /api/sp/setup/golden-coast",
  "POST /api/stock-adjustments",
  "POST /api/stock-items/:id/merge",
  "POST /api/stock-items/bulk-merge",
  "POST /api/stock-items/merge-logs/:logId/unmerge",
  "POST /api/stock-items/merge-logs/historical-restore",
  "POST /api/stock-transfer-import/import",
  "POST /api/stock-transfer-import/import-multi-source",
  "POST /api/stock-transfer-import/parse",
  "POST /api/stock-transfer-import/parse-multi-source",
  "POST /api/stock-transfer-import/validate",
  "POST /api/stock-transfer-import/validate-multi-source",
  "POST /api/stock-transfers",
  "POST /api/system/parent-company",
  "POST /api/test-data/vouchers",
  "POST /api/voucher-entries/transfer-account",
  "POST /api/vouchers",
  "POST /api/vouchers/:id/finalize",
  "POST /api/vouchers/bulk-delete",
  "POST /api/vouchers/journal",
  "POST /api/vouchers/payment-receipt",
  "POST /api/vouchers/with-entries",
  "POST /api/waste-dispatches",
  "PUT /api/erp-user-hidden-costs/:userId",
  "PUT /api/erp-user-page-access/:userId",
  "PUT /api/factory/daybook/:entryId",
  "PUT /api/factory/pos/sales/:id",
  "PUT /api/intercompany-links/:id",
  "PUT /api/ledger-accounts/:id",
  "PUT /api/settings/role-permissions",
  "PUT /api/sp/migration/cutover",
  "PUT /api/stock-adjustments/:id",
  "PUT /api/stock-transfers/:id",
  "PUT /api/vouchers/:id/with-entries",
] as const;

/** Statuses that mean "turned away". */
const REJECTED = new Set([401, 403]);

let app: Express;

beforeAll(async () => {
  app = await setupTestApp();
}, 120000);

afterAll(() => {
  closeTestServer();
});

describe("sensitive write-route guard sweep", () => {
  it("lists exactly the routes the coverage audit calls sensitive", () => {
    const audited = auditWriteRouteCoverage()
      .routes.filter((route: { sensitiveTable: string | null }) => route.sensitiveTable)
      .map((route: { method: string; path: string }) => `${route.method} ${route.path}`)
      .sort();

    // Drift in either direction is a failure. A new sensitive write route that
    // is not listed here would otherwise be swept by nothing while still
    // counting as covered, and a route that stopped being sensitive should be
    // removed deliberately rather than left behind.
    expect([...new Set(audited)]).toEqual([...SENSITIVE_WRITE_ROUTES]);
  });

  it("refuses every one of them without a session", async () => {
    const reachable: string[] = [];
    const errored: string[] = [];

    for (const route of SENSITIVE_WRITE_ROUTES) {
      const [method, routePath] = route.split(" ");
      // Concrete values for path params. An unauthenticated request must be
      // rejected before any of them is read, so the values never matter.
      const url = routePath.replace(/:[A-Za-z0-9_]+/g, "1");
      const response = await request(app)
        [method.toLowerCase() as "post" | "put" | "patch" | "delete"](url)
        .send({})
        .timeout(15000);

      if (!REJECTED.has(response.status)) {
        // A 5xx here is its own bug: the guard chain threw instead of
        // rejecting, which means the route is reachable enough to crash.
        (response.status >= 500 ? errored : reachable).push(`${route} -> ${response.status}`);
      }
    }

    expect(errored, `Guard chain threw instead of rejecting:\n${errored.join("\n")}`).toEqual([]);
    expect(
      reachable,
      `Write routes touching money or stock answered an unauthenticated caller:\n${reachable.join("\n")}`
    ).toEqual([]);
  }, 300000);
});
