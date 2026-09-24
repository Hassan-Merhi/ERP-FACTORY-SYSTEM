import type { NextFunction, Request, Response } from "express";
import {
  authorizeFactoryPageAccess,
  sendFactoryAccessDenied,
  type FactoryAccessDecision,
} from "../lib/factoryAccessControl";

export type FactoryApiAccessRequirement = {
  pageKey?: string;
  /** Every listed tab must be visible. */
  tabs?: string[];
  /** At least one complete alternative tab-set on the same page must be visible. */
  tabAlternatives?: string[][];
  /** Shared APIs may be legitimately owned by more than one Factory surface. */
  alternatives?: FactoryApiAccessRequirement[];
};

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function isWrite(req: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
}

function isFactoryAccessBoundaryExempt(req: Request, path: string): boolean {
  if (path === "/my-access") return true;
  if (req.method.toUpperCase() !== "GET") return false;

  // Shared read-only configuration/assets are consumed by multiple permitted
  // Factory pages. Their mutations are still explicitly protected by Settings.
  if (path === "/settings") return true;
  if (path === "/label-design-colors" || path === "/label-banners") return true;
  if (/^\/customer-logos\/\d+\/image$/.test(path)) return true;
  return false;
}

function requirement(pageKey: string, tabs?: string[]): FactoryApiAccessRequirement {
  return { pageKey, ...(tabs?.length ? { tabs } : {}) };
}

function anyOf(...alternatives: FactoryApiAccessRequirement[]): FactoryApiAccessRequirement {
  return { alternatives };
}

const PAYROLL_WORKERS = "hide_tab_payrollhub_workers";
const PAYROLL_EMPLOYEES = "hide_tab_payrollhub_employees";
const WORKERS_LIST = "hide_tab_workers_workers";
const WORKERS_PAYROLL = "hide_tab_workers_payroll";
const WORKERS_ATTENDANCE = "hide_tab_workers_attendance";
const WORKERS_REPORT = "hide_tab_workers_report";
const WORKERS_ADVANCES = "hide_tab_workers_advances";
const EMPLOYEES_LIST = "hide_tab_employees_employees";
const EMPLOYEES_PAYROLL = "hide_tab_employees_payroll";
const EMPLOYEES_ATTENDANCE = "hide_tab_employees_attendance";
const EMPLOYEES_ADVANCES = "hide_tab_employees_advances";
const EMPLOYEES_BONUSES = "hide_tab_employees_bonuses";
const EMPLOYEES_WITHDRAWALS = "hide_tab_employees_withdrawals";

function workerRequirement(req: Request, path: string): FactoryApiAccessRequirement {
  const base = [PAYROLL_WORKERS];

  if (req.method === "GET" && path === "/workers" && String(req.query.profile || "") === "picker") {
    return requirement("factory/payroll-hub", base);
  }
  if (/^\/workers\/\d+\/payrolls(?:\/|$)/.test(path) || path === "/workers/amount-due") {
    return requirement("factory/payroll-hub", [...base, WORKERS_PAYROLL]);
  }
  if (/^\/workers\/\d+\/(?:advances|deductions|advance-balance|bulk-repay-advances)(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_ADVANCES]);
  }
  if (/^\/workers\/\d+\/statement(?:-pdf)?(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_LIST, "hide_tab_workerdetail_statement"]);
  }
  if (/^\/workers\/\d+\/documents(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_LIST, "hide_tab_workerdetail_documents"]);
  }
  if (/^\/workers\/\d+\/bales(?:\/|$)/.test(path)) {
    return requirement("factory/payroll-hub", [...base, WORKERS_LIST, "hide_tab_workerdetail_bales"]);
  }
  if (/^\/workers\/\d+\/stats(?:\/|$)/.test(path) || path === "/workers/attendance-report") {
    return requirement("factory/payroll-hub", [...base, WORKERS_REPORT]);
  }
  return requirement("factory/payroll-hub", [...base, WORKERS_LIST]);
}

function employeeRequirement(path: string): FactoryApiAccessRequirement {
  const base = [PAYROLL_EMPLOYEES];
  if (/^\/employees\/\d+\/(?:deposit|withdraw)(?:\/|$)/.test(path) || path === "/employees/bulk-withdraw") {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_WITHDRAWALS]);
  }
  if (path === "/employees/bulk-payroll") {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_PAYROLL]);
  }
  if (path.includes("/advances")) {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_ADVANCES]);
  }
  if (path.includes("/bonuses")) {
    return requirement("factory/payroll-hub", [...base, EMPLOYEES_BONUSES]);
  }
  return requirement("factory/payroll-hub", [...base, EMPLOYEES_LIST]);
}

function attendanceRequirement(): FactoryApiAccessRequirement {
  return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_ATTENDANCE]);
}

function importRequirement(path: string): FactoryApiAccessRequirement {
  if (hasPrefix(path, "/import/suppliers") || path === "/import/template/suppliers") {
    return requirement("factory/import", ["hide_tab_import_suppliers"]);
  }
  if (hasPrefix(path, "/import/raw-stock") || path === "/import/template/raw-stock") {
    return requirement("factory/import", ["hide_tab_import_raw_stock"]);
  }
  if (hasPrefix(path, "/import/bales") || path === "/import/template/bales") {
    return requirement("factory/import", ["hide_tab_import_bales"]);
  }
  if (hasPrefix(path, "/import/opening-raw-stock") || path === "/import/template/opening-raw-stock") {
    return requirement("factory/import", ["hide_tab_import_opening_stock"]);
  }
  return requirement("factory/import");
}

function invoicingRequirement(path: string): FactoryApiAccessRequirement {
  if (
    hasPrefix(path, "/invoice-loading-sessions") ||
    /^\/invoices\/\d+\/(?:loading-|loading-sessions)/.test(path) ||
    /\/create-remaining-proforma(?:\/|$)/.test(path)
  ) {
    return requirement("factory/invoicing", ["hide_invoicing_loadings_tab"]);
  }

  if (hasPrefix(path, "/invoices") || hasPrefix(path, "/sales/invoices")) {
    return requirement("factory/invoicing", ["hide_invoicing_invoices_tab"]);
  }

  if (hasPrefix(path, "/customer-proformas") || hasPrefix(path, "/customer-proforma-lines")) {
    return requirement("factory/invoicing", ["hide_invoicing_proformas_tab"]);
  }

  if (hasPrefix(path, "/customer-orders")) {
    const loadingSpecific =
      /\/(?:bales|loading-list|pending-export|verification-summary|loading-note|bale-removals)(?:\/|$)/.test(path) ||
      /\/create-loading(?:\/|$)/.test(path);
    if (loadingSpecific) {
      return requirement("factory/invoicing", ["hide_invoicing_loadings_tab"]);
    }
    return {
      pageKey: "factory/invoicing",
      tabAlternatives: [["hide_invoicing_invoices_tab"], ["hide_invoicing_loadings_tab"]],
    };
  }

  return requirement("factory/invoicing");
}

/**
 * Resolve Factory API calls to the page/tab that owns them.
 *
 * Order is deliberate: narrow action/detail rules appear before broad parents,
 * so a child API cannot escape the permission of the UI surface that owns it.
 */
export function resolveFactoryBackendAccessRequirement(req: Request): FactoryApiAccessRequirement | null {
  // Normalize from originalUrl so ownership matching is stable whether Express
  // invokes this as mounted middleware or as a direct handler.
  const requestPath = (req.originalUrl.split("?", 1)[0] || req.path);
  const path =
    requestPath === "/api/factory"
      ? "/"
      : requestPath.startsWith("/api/factory/")
        ? requestPath.slice("/api/factory".length)
        : req.path;

  // Explicit shared/bootstrap exceptions are handled fail-open here; every
  // other Factory route must resolve to an owner or the middleware denies it.
  if (isFactoryAccessBoundaryExempt(req, path)) return null;

  // Attendance is an active-company exception in factoryRoutes.ts. Keep its
  // authorization tied to the Attendance tabs rather than the admin Settings page.
  if (
    hasPrefix(path, "/attendance") ||
    ((path === "/staff-tracking" || path === "/staff-tracking/bulk") &&
      String(req.query.page || req.body?.page || "") === "attendance") ||
    (hasPrefix(path, "/settings") && String(req.query.scope || "") === "attendance")
  ) {
    return attendanceRequirement();
  }

  if (path === "/send-weekly-report-whatsapp") {
    return requirement("factory/production-report");
  }

  if (path === "/send-mix-batch-image-whatsapp") {
    const destination = String(req.body?.destination || req.body?.recipient || "");
    if (destination === "attendance") return attendanceRequirement();
    if (destination === "production") {
      return requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]);
    }
    return requirement("factory/raw-materials");
  }

  // Additional high-risk operational utilities inherit the page that exposes them.
  if (hasPrefix(path, "/status-builder") || hasPrefix(path, "/weekly-report-wa-settings")) {
    return requirement("factory/production-report");
  }
  if (hasPrefix(path, "/production-summary")) {
    return requirement("factory/intelligence/production-hub", ["hide_tab_production_intel_summary"]);
  }
  if (hasPrefix(path, "/container-tracking")) {
    return requirement("factory/intelligence/production-hub", ["hide_tab_production_intel_container_tracking"]);
  }
  if (hasPrefix(path, "/ais")) {
    return anyOf(
      requirement("factory/containers-hub"),
      requirement("factory/intelligence/production-hub", ["hide_tab_production_intel_container_tracking"])
    );
  }
  if (
    hasPrefix(path, "/bale-products/arabic-import") ||
    hasPrefix(path, "/french-catalog/import") ||
    path === "/bale-products/import-excel"
  ) {
    return requirement("factory/bales-hub", ["hide_tab_bales_products"]);
  }
  if (hasPrefix(path, "/bale-import-batches")) {
    return requirement("factory/import", ["hide_tab_import_bales"]);
  }
  if (path === "/containers/import-excel" || path === "/containers/backfill-import-credits") {
    return requirement("factory/containers-hub");
  }
  if (path === "/sheets/import") {
    return requirement("factory/sheets-sacks", ["hide_tab_sheets_stock"]);
  }
  if (path === "/repair-perkg-prices") {
    return requirement("factory/settings");
  }
  if (path === "/repair-orphaned-vouchers") {
    return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_PAYROLL, "hide_tab_payroll_records"]);
  }
  if (hasPrefix(path, "/suppliers/fx-diagnostic")) {
    return requirement("factory/parties", ["hide_tab_parties_suppliers"]);
  }

  // Employee sub-tabs are separate API families rather than /employees children.
  if (hasPrefix(path, "/employee-payroll-preview")) {
    return requirement("factory/payroll-hub", [PAYROLL_EMPLOYEES, EMPLOYEES_PAYROLL]);
  }
  if (hasPrefix(path, "/employee-attendance")) {
    return requirement("factory/payroll-hub", [PAYROLL_EMPLOYEES, EMPLOYEES_ATTENDANCE]);
  }
  if (hasPrefix(path, "/employee-advances") || hasPrefix(path, "/employee-advance-repayments")) {
    return requirement("factory/payroll-hub", [PAYROLL_EMPLOYEES, EMPLOYEES_ADVANCES]);
  }
  if (hasPrefix(path, "/employee-bonuses")) {
    return requirement("factory/payroll-hub", [PAYROLL_EMPLOYEES, EMPLOYEES_BONUSES]);
  }
  if (hasPrefix(path, "/worker-bonuses")) {
    return requirement("factory/payroll-hub", [PAYROLL_WORKERS, "hide_tab_workers_bonuses"]);
  }

  // Worker categories/pickers are intentionally shared by Stock Entry,
  // Production Targets and Worker management. Requiring only one parent page
  // would incorrectly break the other two permitted surfaces.
  if (hasPrefix(path, "/worker-categories")) {
    if (isWrite(req)) {
      return anyOf(
        requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]),
        requirement("factory/payroll-hub", [PAYROLL_WORKERS, "hide_tab_workers_categories"])
      );
    }
    return anyOf(
      requirement("factory/stock-entry", ["hide_tab_stockentry_entry"]),
      requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]),
      requirement("factory/payroll-hub", [PAYROLL_WORKERS, "hide_tab_workers_categories"])
    );
  }

  if (hasPrefix(path, "/invoice-container-tracking") || hasPrefix(path, "/shipping-container-rows") || hasPrefix(path, "/shipping-invoice-docs")) {
    return requirement("factory/production-report", ["hide_tab_overview_shipping"]);
  }

  if (hasPrefix(path, "/net-position/payroll-breakdown")) {
    return requirement("factory/intelligence/financial-hub");
  }

  // Admin/configuration mutation surfaces. Operational reads of label assets,
  // customer logos and common Factory settings remain available to the pages
  // that render/print them; changing configuration requires Settings access.
  if (
    hasPrefix(path, "/users") ||
    hasPrefix(path, "/admin") ||
    path === "/admin-verify" ||
    path === "/import-company-data" ||
    path === "/export-company-data" ||
    path === "/migrate-voucher-descriptions" ||
    path === "/payroll/migrate-city-split" ||
    path === "/payroll/migrate-worker-names" ||
    path === "/payroll/migrate-salary-groups" ||
    path === "/bales/backfill-costs" ||
    path === "/bilingual-snapshots/backfill" ||
    path === "/bilingual-snapshots/diagnose" ||
    (hasPrefix(path, "/settings") && isWrite(req)) ||
    (hasPrefix(path, "/label-design-colors") && isWrite(req)) ||
    (hasPrefix(path, "/label-banners") && isWrite(req)) ||
    (hasPrefix(path, "/customer-logos") && isWrite(req)) ||
    (/^\/customers\/\d+\/logos(?:\/|$)/.test(path) && isWrite(req))
  ) {
    return requirement("factory/settings");
  }

  // Production report detail APIs, including the legacy fallback behind the
  // pre-router SQL accelerator. The shared production-value endpoint is used by
  // multiple Overview surfaces, so bind explicit view requests to their owning
  // tab/page instead of letting a hidden tab reuse another view's request.
  if (hasPrefix(path, "/production-value-report")) {
    const view = String(req.query.view || "");
    if (view === "production") {
      return requirement("factory/production-report", ["hide_tab_overview_production"]);
    }
    if (view === "production-comparison") {
      return anyOf(
        requirement("factory/production-report", ["hide_tab_overview_comparison"]),
        requirement("factory/production-comparison")
      );
    }
    return requirement("factory/production-report");
  }
  if (
    hasPrefix(path, "/bale-ledger") ||
    hasPrefix(path, "/daily-report") ||
    hasPrefix(path, "/weekly-report")
  ) {
    return requirement("factory/production-report");
  }

  // Accounting pages and their Factory-owned detail/actions.
  if (hasPrefix(path, "/accounts") || hasPrefix(path, "/ledger-monthly") || hasPrefix(path, "/ledger-vouchers")) {
    return requirement("factory/accounts");
  }
  if (hasPrefix(path, "/voucher-detail") || hasPrefix(path, "/factory-vouchers")) {
    return requirement("factory/vouchers");
  }
  if (hasPrefix(path, "/daybook")) {
    if (/\/edits(?:\/|$)/.test(path)) {
      return requirement("factory/daybook", ["hide_tab_daybook_activity"]);
    }
    return requirement("factory/daybook", ["hide_tab_daybook_transactions"]);
  }

  // Import page.
  if (hasPrefix(path, "/import")) return importRequirement(path);

  // Customer price lists inherit the Customers parent and the profile Price List tab.
  if (hasPrefix(path, "/customer-price-lists")) {
    return requirement("factory/parties", ["hide_tab_parties_customers", "hide_tab_customer_pricelist"]);
  }

  // Stock Allocation V2/V3/V5 actions and detail APIs all inherit the Stock Allocation page.
  if (
    hasPrefix(path, "/stock-allocation") ||
    hasPrefix(path, "/v2/stock-allocation") ||
    hasPrefix(path, "/v3") ||
    hasPrefix(path, "/v5")
  ) {
    return requirement("factory/stock-allocation-v5");
  }

  // Invoicing and loading families.
  if (
    hasPrefix(path, "/customer-proformas") ||
    hasPrefix(path, "/customer-proforma-lines") ||
    hasPrefix(path, "/customer-orders") ||
    hasPrefix(path, "/customer-orders-loading") ||
    hasPrefix(path, "/invoice-loading-sessions") ||
    hasPrefix(path, "/invoices") ||
    hasPrefix(path, "/sales")
  ) {
    return invoicingRequirement(path);
  }

  // Production target/default/link/planner controls.
  if (
    hasPrefix(path, "/production-planner") ||
    hasPrefix(path, "/production-position-planner") ||
    hasPrefix(path, "/production-positions") ||
    hasPrefix(path, "/staff-tracking/production-target-defaults") ||
    hasPrefix(path, "/staff-tracking/production-worker-links") ||
    ((path === "/staff-tracking" || path === "/staff-tracking/bulk") &&
      String(req.query.page || req.body?.page || "") === "production") ||
    path === "/stock-entry/production-session" ||
    path === "/stock-entry/end-production"
  ) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]);
  }

  // Stock Entry operational child tabs.
  if (hasPrefix(path, "/daily-bale-scans")) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_daily_scan"]);
  }
  if (hasPrefix(path, "/ground-scan") || hasPrefix(path, "/ground-scan-items")) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_ground_scan"]);
  }
  if (hasPrefix(path, "/bales/stock-entry-history")) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_history"]);
  }
  if (
    hasPrefix(path, "/stock-entry") ||
    hasPrefix(path, "/pressing") ||
    hasPrefix(path, "/pressing-batches") ||
    path === "/finalize" ||
    path === "/bales/create-batch" ||
    path === "/bales/import" ||
    path === "/bales/import-excel" ||
    path === "/bales/validate-import" ||
    path === "/bales/reimport"
  ) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_entry"]);
  }

  // Raw-material reads, adjustments, offload/recalc detail/actions inherit Raw Materials.
  if (hasPrefix(path, "/raw-stock")) {
    return requirement("factory/raw-materials");
  }

  // Generic staff-tracking requests still require one of the two owning tabs;
  // malformed requests then continue to the route's normal 400 validation.
  if (hasPrefix(path, "/staff-tracking")) {
    return anyOf(
      requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]),
      attendanceRequirement()
    );
  }

  // Worker/employee/payroll families.
  if (hasPrefix(path, "/employees")) return employeeRequirement(path);
  if (req.method === "GET" && path === "/workers" && String(req.query.profile || "") === "picker") {
    return anyOf(
      requirement("factory/stock-entry", ["hide_tab_stockentry_entry"]),
      requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]),
      requirement("factory/payroll-hub", [PAYROLL_WORKERS])
    );
  }
  if (hasPrefix(path, "/workers")) return workerRequirement(req, path);
  if (
    hasPrefix(path, "/payroll") ||
    hasPrefix(path, "/payrolls") ||
    hasPrefix(path, "/cash-accounts")
  ) {
    return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_PAYROLL, "hide_tab_payroll_records"]);
  }
  if (
    hasPrefix(path, "/advances") ||
    hasPrefix(path, "/advance-repayments") ||
    hasPrefix(path, "/worker-deductions") ||
    hasPrefix(path, "/cash-account-balance")
  ) {
    return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_ADVANCES]);
  }

  // ── Canonical page ownership fallback ────────────────────────────────────
  // The cases above handle sensitive child tabs first. These family mappings
  // close the remaining page-level bypasses so a hidden Factory page cannot be
  // reached by calling its API directly.

  if (hasPrefix(path, "/alerts")) {
    return requirement("factory/intelligence/alerts");
  }
  if (hasPrefix(path, "/analytics")) {
    return requirement("factory/analytics");
  }
  if (path === "/dashboard" || hasPrefix(path, "/dashboard-kpis")) {
    return requirement("factory/intelligence/dashboard");
  }
  if (hasPrefix(path, "/kpis")) {
    return requirement("factory/intelligence/kpis");
  }
  if (hasPrefix(path, "/profitability") || hasPrefix(path, "/cashflow") || hasPrefix(path, "/net-position")) {
    return requirement("factory/intelligence/financial-hub");
  }
  if (hasPrefix(path, "/reports/supplier-usage") || hasPrefix(path, "/suppliers/score")) {
    return requirement("factory/intelligence/supplier-hub");
  }
  if (hasPrefix(path, "/mix/optimize") || hasPrefix(path, "/waste")) {
    return requirement("factory/intelligence/production-hub");
  }
  if (hasPrefix(path, "/financial-snapshot")) {
    return requirement("factory/analytics");
  }

  if (hasPrefix(path, "/location-inventory")) {
    return requirement("factory/location-inventory");
  }
  if (hasPrefix(path, "/bale-stock-list")) {
    return requirement("factory/stock-bale-list");
  }
  // The compact stock-count read is shared by the Bale Stock List and the
  // Container Loading scan. Keep the full bale list protected by its own page,
  // while allowing loading users to read only the aggregate availability counts
  // needed by the Invoicing > Loadings workflow.
  if (hasPrefix(path, "/bale-stock-count")) {
    return anyOf(
      requirement("factory/stock-bale-list"),
      requirement("factory/invoicing", ["hide_invoicing_loadings_tab"])
    );
  }
  if (hasPrefix(path, "/bales/relabel")) {
    return requirement("factory/bale-relabeling", ["hide_tab_relabeling_main"]);
  }
  if (hasPrefix(path, "/customer-loading")) {
    return requirement("factory/bales-hub", ["hide_tab_bales_customer_loading"]);
  }
  if (hasPrefix(path, "/bales/lookup")) {
    return requirement("factory/bales-hub", ["hide_tab_bales_barcode"]);
  }
  if (hasPrefix(path, "/bale-product-history")) {
    return requirement("factory/bales-hub", ["hide_tab_bales_history"]);
  }
  if (hasPrefix(path, "/bale-product-detail")) {
    return requirement("factory/bales-hub", ["hide_tab_bales_products"]);
  }
  if (hasPrefix(path, "/bale-product-images")) {
    return requirement("factory/bale-product-images");
  }
  if (hasPrefix(path, "/bale-lookup")) {
    return anyOf(
      requirement("factory/bale-tracking"),
      requirement("factory/invoicing", ["hide_invoicing_loadings_tab"])
    );
  }
  if (hasPrefix(path, "/bale-photos")) {
    return requirement("factory/bales-hub", ["hide_tab_bales_history"]);
  }

  if (hasPrefix(path, "/bale-products") || hasPrefix(path, "/categories") || hasPrefix(path, "/french-catalog")) {
    if (path === "/bale-products/bulk-update-prices") {
      return requirement("factory/price-list");
    }
    if (path === "/bale-products/merge" || hasPrefix(path, "/bale-products/merge-stats")) {
      return requirement("factory/merge-bale-products");
    }
    if (isWrite(req)) {
      return requirement("factory/bales-hub", ["hide_tab_bales_products"]);
    }
    return anyOf(
      requirement("factory/bales-hub", ["hide_tab_bales_products"]),
      requirement("factory/price-list"),
      requirement("factory/invoicing", ["hide_invoicing_proformas_tab"]),
      requirement("factory/stock-entry", ["hide_tab_stockentry_entry"]),
      requirement("factory/production-comparison"),
      requirement("factory/intelligence/production-hub"),
      requirement("factory/stock-allocation-v5"),
      requirement("factory/location-inventory")
    );
  }

  if (hasPrefix(path, "/bales")) {
    return anyOf(
      requirement("factory/bales-hub"),
      requirement("factory/stock-entry"),
      requirement("factory/stock-bale-list"),
      requirement("factory/stock-allocation-v5"),
      requirement("factory/invoicing", ["hide_invoicing_loadings_tab"]),
      requirement("factory/production-report"),
      requirement("factory/intelligence/dashboard"),
      requirement("factory/intelligence/production-hub"),
      requirement("factory/production-comparison")
    );
  }

  if (
    /^\/containers\/\d+\/(?:reverse-offload|post-offload-charges|confirm-duty)(?:\/|$)/.test(path) ||
    hasPrefix(path, "/container-commissions")
  ) {
    return requirement("factory/raw-materials");
  }
  if (
    hasPrefix(path, "/containers") ||
    hasPrefix(path, "/container-doc-types") ||
    hasPrefix(path, "/freight")
  ) {
    if (isWrite(req)) return requirement("factory/containers-hub");
    return anyOf(
      requirement("factory/containers-hub"),
      requirement("factory/raw-materials"),
      requirement("factory/production-report"),
      requirement("factory/intelligence/dashboard"),
      requirement("factory/intelligence/financial-hub")
    );
  }

  if (
    hasPrefix(path, "/shipping-availability") ||
    hasPrefix(path, "/shipping-containers") ||
    hasPrefix(path, "/shipping-container-docs")
  ) {
    return requirement("factory/production-report", ["hide_tab_overview_shipping"]);
  }

  if (hasPrefix(path, "/suppliers")) {
    if (/\/broker-visual-statement(?:\/|$)/.test(path)) {
      return requirement("factory/broker-visual-statement");
    }
    if (isWrite(req)) {
      return requirement("factory/parties", ["hide_tab_parties_suppliers"]);
    }
    return anyOf(
      requirement("factory/parties", ["hide_tab_parties_suppliers"]),
      requirement("factory/raw-materials"),
      requirement("factory/containers-hub"),
      requirement("factory/intelligence/supplier-hub"),
      requirement("factory/intelligence/financial-hub"),
      requirement("factory/intelligence/dashboard"),
      requirement("factory/production-report")
    );
  }
  if (
    hasPrefix(path, "/supplier-categories") ||
    hasPrefix(path, "/supplier-payments") ||
    hasPrefix(path, "/supplier-fx-transfers")
  ) {
    return requirement("factory/parties", ["hide_tab_parties_suppliers"]);
  }

  if (hasPrefix(path, "/customers")) {
    if (isWrite(req)) {
      return requirement("factory/parties", ["hide_tab_parties_customers"]);
    }
    return anyOf(
      requirement("factory/parties", ["hide_tab_parties_customers"]),
      requirement("factory/invoicing"),
      requirement("factory/stock-entry")
    );
  }

  if (hasPrefix(path, "/contacts")) {
    return requirement("factory/contacts");
  }
  if (hasPrefix(path, "/transporters") || hasPrefix(path, "/transporter-accounts")) {
    return requirement("factory/transporters");
  }

  if (hasPrefix(path, "/dispatch-reports")) {
    return requirement("factory/dispatch-batches", ["hide_tab_dispatch_reports"]);
  }
  if (
    hasPrefix(path, "/dispatch-batches") ||
    hasPrefix(path, "/dispatch-truck-rides") ||
    hasPrefix(path, "/dispatch-bale-scans") ||
    hasPrefix(path, "/bale-search")
  ) {
    return requirement("factory/dispatch-batches", ["hide_tab_dispatch_batches"]);
  }

  if (hasPrefix(path, "/sheets-sacks")) {
    if (hasPrefix(path, "/sheets-sacks/log")) {
      return requirement("factory/sheets-sacks", ["hide_tab_sheets_movements"]);
    }
    return requirement("factory/sheets-sacks", ["hide_tab_sheets_stock"]);
  }
  if (hasPrefix(path, "/sheets")) {
    return anyOf(
      requirement("factory/sheets-sacks", ["hide_tab_sheets_stock"]),
      requirement("factory/production-report", ["hide_tab_overview_sheets"])
    );
  }

  if (hasPrefix(path, "/mix-batches") || hasPrefix(path, "/mix-batches-by-date") || hasPrefix(path, "/fx-rates")) {
    return anyOf(
      requirement("factory/raw-materials"),
      requirement("factory/production-report"),
      requirement("factory/intelligence/production-hub")
    );
  }

  if (hasPrefix(path, "/pos")) {
    return requirement("factory/production-report");
  }

  if (hasPrefix(path, "/monthly-salary-summary")) {
    return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_PAYROLL]);
  }

  if (hasPrefix(path, "/waste-dispatch")) {
    return requirement("factory/waste-dispatch");
  }

  if (hasPrefix(path, "/rental")) {
    if (
      hasPrefix(path, "/rental/payments") ||
      hasPrefix(path, "/rental/cash-accounts") ||
      hasPrefix(path, "/rental/auto-transfer-config") ||
      hasPrefix(path, "/rental/reconciliation")
    ) {
      return anyOf(
        requirement("factory/rental/shops"),
        requirement("factory/rental/payments")
      );
    }
    return anyOf(
      requirement("factory/rental/shops"),
      requirement("factory/rental/warehouses")
    );
  }

  if (hasPrefix(path, "/uploads/workers")) {
    return requirement("factory/payroll-hub");
  }
  if (hasPrefix(path, "/uploads/bale-photos")) {
    return requirement("factory/bales-hub");
  }
  if (hasPrefix(path, "/uploads")) {
    return anyOf(
      requirement("factory/containers-hub"),
      requirement("factory/bales-hub"),
      requirement("factory/payroll-hub")
    );
  }

  return null;
}

function tabDeniedDecision(message: string): Exclude<FactoryAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    code: "FACTORY_TAB_ACCESS_DENIED",
    message,
  };
}

async function evaluateFactoryRequirement(
  req: Request,
  rule: FactoryApiAccessRequirement
): Promise<FactoryAccessDecision> {
  if (rule.alternatives?.length) {
    let firstDenied: Exclude<FactoryAccessDecision, { allowed: true }> | null = null;
    for (const alternative of rule.alternatives) {
      const decision = await evaluateFactoryRequirement(req, alternative);
      if (decision.allowed) return decision;
      firstDenied ??= decision;
      if (decision.code === "FACTORY_ACCESS_DISABLED") return decision;
    }
    return firstDenied ?? tabDeniedDecision("You do not have access to a Factory page that permits this action.");
  }

  if (!rule.pageKey) {
    return {
      allowed: false,
      code: "FACTORY_PAGE_ACCESS_DENIED",
      message: "No Factory page owns this protected action.",
    };
  }

  const pageDecision = await authorizeFactoryPageAccess(req, rule.pageKey);
  if (!pageDecision.allowed) return pageDecision;
  if (pageDecision.state.privileged) return pageDecision;

  const hidden = new Set(pageDecision.state.hiddenTabs);
  if (rule.tabs?.some((tab) => hidden.has(tab))) {
    return tabDeniedDecision("You do not have access to the Factory tab required for this action.");
  }

  if (
    rule.tabAlternatives?.length &&
    !rule.tabAlternatives.some((alternative) => alternative.every((tab) => !hidden.has(tab)))
  ) {
    return tabDeniedDecision("You do not have access to any Factory tab that permits this action.");
  }

  return pageDecision;
}

export async function enforceFactoryBackendAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return next();

  try {
    const rule = resolveFactoryBackendAccessRequirement(req);
    if (!rule) {
      const requestPath = (req.originalUrl.split("?", 1)[0] || req.path);
      const path =
        requestPath === "/api/factory"
          ? "/"
          : requestPath.startsWith("/api/factory/")
            ? requestPath.slice("/api/factory".length)
            : req.path;
      if (isFactoryAccessBoundaryExempt(req, path)) return next();
      return res.status(403).json({
        message: "This Factory API has no declared page permission owner.",
        code: "FACTORY_PAGE_ACCESS_DENIED",
      });
    }

    const decision = await evaluateFactoryRequirement(req, rule);
    if (!decision.allowed) return sendFactoryAccessDenied(res, decision);
    return next();
  } catch (error) {
    return next(error);
  }
}
