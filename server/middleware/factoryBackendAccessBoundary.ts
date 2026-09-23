import type { NextFunction, Request, Response } from "express";
import {
  authorizeFactoryPageAccess,
  sendFactoryAccessDenied,
  type FactoryAccessDecision,
} from "../lib/factoryAccessControl";

export type FactoryApiAccessRequirement = {
  pageKey: string;
  /** Every listed tab must be visible. */
  tabs?: string[];
  /** At least one complete alternative tab-set must be visible. */
  tabAlternatives?: string[][];
};

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function isWrite(req: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
}

function requirement(pageKey: string, tabs?: string[]): FactoryApiAccessRequirement {
  return { pageKey, ...(tabs?.length ? { tabs } : {}) };
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
  return {
    pageKey: "factory/payroll-hub",
    tabAlternatives: [
      [PAYROLL_WORKERS, WORKERS_ATTENDANCE],
      [PAYROLL_EMPLOYEES, EMPLOYEES_ATTENDANCE],
    ],
  };
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

  // Access bootstrap must remain callable so the UI can learn what is denied.
  if (path === "/my-access") return null;

  // Attendance is an active-company exception in factoryRoutes.ts. Keep its
  // authorization tied to the Attendance tabs rather than the admin Settings page.
  if (
    hasPrefix(path, "/attendance") ||
    (path === "/staff-tracking" && String(req.query.page || req.body?.page || "") === "attendance") ||
    (hasPrefix(path, "/settings") && String(req.query.scope || "") === "attendance")
  ) {
    return attendanceRequirement();
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
    return requirement("factory/invoicing", ["hide_invoicing_invoices_tab"]);
  }
  if (path === "/repair-orphaned-vouchers") {
    return requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_PAYROLL, "hide_tab_payroll_records"]);
  }
  if (hasPrefix(path, "/suppliers/fx-diagnostic")) {
    return requirement("factory/parties", ["hide_tab_parties_suppliers"]);
  }

  // Admin/configuration mutation surfaces. Operational reads of label assets,
  // customer logos and common Factory settings remain available to the pages
  // that render/print them; changing configuration requires Settings access.
  if (
    hasPrefix(path, "/users") ||
    hasPrefix(path, "/admin") ||
    path === "/admin-verify" ||
    path === "/import-company-data" ||
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
  // pre-router SQL accelerator.
  if (
    hasPrefix(path, "/bale-ledger") ||
    hasPrefix(path, "/production-value-report") ||
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
    (path === "/staff-tracking" && String(req.query.page || req.body?.page || "") === "production")
  ) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]);
  }

  // Stock Entry operational child tabs.
  if (hasPrefix(path, "/daily-bale-scans")) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_daily_scan"]);
  }
  if (hasPrefix(path, "/ground-scan")) {
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

  // Worker/employee/payroll families.
  if (hasPrefix(path, "/employees")) return employeeRequirement(path);
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

  return null;
}

function tabDeniedDecision(message: string): Exclude<FactoryAccessDecision, { allowed: true }> {
  return {
    allowed: false,
    code: "FACTORY_TAB_ACCESS_DENIED",
    message,
  };
}

export async function enforceFactoryBackendAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) return next();

  try {
    const rule = resolveFactoryBackendAccessRequirement(req);
    if (!rule) return next();

    const pageDecision = await authorizeFactoryPageAccess(req, rule.pageKey);
    if (!pageDecision.allowed) return sendFactoryAccessDenied(res, pageDecision);
    if (pageDecision.state.privileged) return next();

    const hidden = new Set(pageDecision.state.hiddenTabs);

    if (rule.tabs?.some((tab) => hidden.has(tab))) {
      return sendFactoryAccessDenied(
        res,
        tabDeniedDecision("You do not have access to the Factory tab required for this action.")
      );
    }

    if (
      rule.tabAlternatives?.length &&
      !rule.tabAlternatives.some((alternative) => alternative.every((tab) => !hidden.has(tab)))
    ) {
      return sendFactoryAccessDenied(
        res,
        tabDeniedDecision("You do not have access to any Factory tab that permits this action.")
      );
    }

    return next();
  } catch (error) {
    return next(error);
  }
}
