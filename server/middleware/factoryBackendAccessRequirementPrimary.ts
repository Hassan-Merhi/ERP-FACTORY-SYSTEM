/** Factory API requirement rules: ordered first half, preserving first-match order. */
import type { Request } from "express";
import {
  anyOf,
  hasPrefix,
  isWrite,
  requirement,
  type FactoryApiAccessRequirement,
} from "./factoryBackendAccessBoundaryRules";
import {
  PAYROLL_WORKERS,
  PAYROLL_EMPLOYEES,
  WORKERS_PAYROLL,
  WORKERS_REPORT,
  EMPLOYEES_PAYROLL,
  EMPLOYEES_ATTENDANCE,
  EMPLOYEES_ADVANCES,
  EMPLOYEES_BONUSES,
  attendanceRequirement,
} from "./factoryBackendAccessRequirementHelpers";

export function resolvePrimaryRequirement(req: Request, path: string): FactoryApiAccessRequirement | null {
  // Attendance is an active-company exception in factoryRoutes.ts. Keep its
  // authorization tied to the Attendance tabs rather than the admin Settings page.
  if (
    hasPrefix(path, "/attendance") ||
    ((path === "/staff-tracking" || path === "/staff-tracking/bulk") &&
      String(req.query.page || req.body?.page || "") === "attendance") ||
    (hasPrefix(path, "/settings") && String(req.query.scope || "") === "attendance")
  ) {
    // The monthly Workers Report offers an attendance editor. Permit its
    // existing report-tab permission as an alternative for the same bulk save.
    // Existing-record and historical-date Admin approval rules still apply.
    if (req.method === "POST" && path === "/attendance/bulk") {
      return anyOf(attendanceRequirement(), requirement("factory/payroll-hub", [PAYROLL_WORKERS, WORKERS_REPORT]));
    }
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

  // Agent Ledger reads and pins accounts in the pinned Factory company.
  if (hasPrefix(path, "/agents")) {
    return requirement("factory/agents");
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
  if (
    path === "/containers/import-excel" ||
    path === "/containers/backfill-import-credits" ||
    path === "/container-import-credit-preview"
  ) {
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

  if (
    hasPrefix(path, "/invoice-container-tracking") ||
    hasPrefix(path, "/shipping-container-rows") ||
    hasPrefix(path, "/shipping-invoice-docs")
  ) {
    return requirement("factory/production-report", ["hide_tab_overview_shipping"]);
  }

  // FX activation, conversion and reversal belong to Accounts. Reading the
  // wallet for Pay From and posting a USD-beneficiary settlement are also
  // available to users permitted on Vouchers > Payment, not every FX write.
  if (hasPrefix(path, "/fx-agent-wallets")) {
    if (
      (req.method === "GET" && path === "/fx-agent-wallets") ||
      (req.method === "POST" && /^\/fx-agent-wallets\/\d+\/settle$/.test(path))
    ) {
      return anyOf(requirement("factory/accounts"), requirement("factory/vouchers", ["hide_tab_vouchers_payment"]));
    }
    return requirement("factory/accounts");
  }
  if (hasPrefix(path, "/net-position")) {
    return requirement("factory/net-position-details");
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
    // The reviewed bale/mix re-cost (preview and Owner apply, wave 11) is a cost
    // repair like /repair-perkg-prices; the retired /bales/backfill-costs (410)
    // now falls to the Bales parent below.
    hasPrefix(path, "/bale-cost") ||
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

  // MHD product aliases are display-only; reads are available only to Factory
  // users authorized on at least one product-bearing page. Writes require Settings.
  if (path === "/mhd-view") {
    if (isWrite(req)) return requirement("factory/intelligence/mhd-view");
    return anyOf(
      requirement("factory/stock-allocation-v5"),
      requirement("factory/bales-hub"),
      requirement("factory/location-inventory"),
      requirement("factory/stock-query"),
      requirement("factory/price-list"),
      requirement("factory/monthly-production-matrix"),
      requirement("factory/stock-bale-list"),
      requirement("factory/bale-tracking"),
      requirement("factory/invoicing"),
      requirement("factory/settings"),
      requirement("factory/intelligence/mhd-view")
    );
  }

  // Monthly Production Matrix reads and shared company row-order updates are
  // owned by the dedicated Inventory page, never by general Settings.
  if (hasPrefix(path, "/monthly-production-matrix")) {
    return requirement("factory/monthly-production-matrix");
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
  if (hasPrefix(path, "/bale-ledger") || hasPrefix(path, "/daily-report") || hasPrefix(path, "/weekly-report")) {
    return requirement("factory/production-report");
  }

  // Cost Centers has three distinct data owners. A Voucher-only user may
  // inspect voucher-backed allocations but NOT independent Factory Daybook
  // expenses; Daybook-only access cannot inspect arbitrary voucher sources.
  // The Finance workspace (Cost Centers or Accounts) can inspect both.
  const costCenterPath = path.toLowerCase();
  if (hasPrefix(costCenterPath, "/cost-centers")) {
    const finance = anyOf(requirement("factory/cost-centers"), requirement("factory/accounts"));
    // hasPrefix() appends the separator itself; these prefixes must not end in "/".
    const isVoucherSource =
      hasPrefix(costCenterPath, "/cost-centers/voucher") ||
      hasPrefix(costCenterPath, "/cost-centers/allocations/voucher_entry");
    if (isVoucherSource) {
      return anyOf(
        requirement("factory/cost-centers"),
        requirement("factory/accounts"),
        requirement("factory/vouchers")
      );
    }
    if (hasPrefix(costCenterPath, "/cost-centers/allocations/factory_daybook")) {
      return anyOf(
        requirement("factory/cost-centers"),
        requirement("factory/accounts"),
        requirement("factory/daybook")
      );
    }
    // Cost-center names are used by the authorized Voucher and Daybook
    // pickers. A catalog GET contains no per-source expense amounts.
    if (req.method.toUpperCase() === "GET" && costCenterPath === "/cost-centers") {
      return anyOf(
        requirement("factory/cost-centers"),
        requirement("factory/accounts"),
        requirement("factory/vouchers"),
        requirement("factory/daybook")
      );
    }
    // Historical previews/applications, expense reports, automation and
    // center management require Finance page access, not a voucher/daybook
    // page alone.
    return finance;
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
  return null;
}
