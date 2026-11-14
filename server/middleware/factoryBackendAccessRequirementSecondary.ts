/** Factory API requirement rules: ordered second half, preserving first-match order. */
import type { Request } from "express";
import { anyOf, hasPrefix, isWrite, requirement, type FactoryApiAccessRequirement } from "./factoryBackendAccessBoundaryRules";
import { PAYROLL_WORKERS, WORKERS_PAYROLL, WORKERS_ADVANCES, workerRequirement, employeeRequirement, attendanceRequirement, importRequirement, invoicingRequirement } from "./factoryBackendAccessRequirementHelpers";

export function resolveSecondaryRequirement(req: Request, path: string): FactoryApiAccessRequirement | null {
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

  // Automatic Priority Printing & Loading. The company switch is a Factory
  // Settings control; the print preflight is shared by every page that prints
  // or reprints physical factory bale labels.
  if (path === "/automatic-priority-mode" || path === "/non-bale-priority-items") {
    return requirement("factory/settings");
  }
  if (
    path === "/customer-orders/loading-list/automatic-print-preflight-batch" ||
    path === "/customer-orders/loading-list/automatic-print-preflight"
  ) {
    return anyOf(
      requirement("factory/bales-hub"),
      requirement("factory/bale-relabeling"),
      requirement("factory/location-inventory"),
      requirement("factory/stock-entry"),
      requirement("factory/invoicing", ["hide_invoicing_loadings_tab"])
    );
  }

  // Admin/Developer finalized customer-loading returns belong to the Others hub.
  // The route itself additionally gates both reads and writes to Admin/Developer.
  if (hasPrefix(path, "/finalized-sale-returns")) {
    return requirement("factory/production-report");
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
    hasPrefix(path, "/production-target-bonuses") ||
    hasPrefix(path, "/production-position-planner") ||
    hasPrefix(path, "/production-positions") ||
    hasPrefix(path, "/staff-tracking/production-target-defaults") ||
    hasPrefix(path, "/staff-tracking/production-worker-links") ||
    hasPrefix(path, "/staff-tracking/production-bonuses") ||
    ((path === "/staff-tracking" || path === "/staff-tracking/bulk") &&
      String(req.query.page || req.body?.page || "") === "production") ||
    path === "/stock-entry/production-session" ||
    path === "/stock-entry/end-production"
  ) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_production_targets"]);
  }

  // Stock Entry operational child tabs.
  // Physical pressing tracking is a separate tab from stock entry pressing/finalization.
  if (hasPrefix(path, "/pressing-machines")) {
    return requirement("factory/stock-entry", ["hide_tab_stockentry_pressing_machines"]);
  }
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
      requirement("factory/stock-entry", ["hide_tab_stockentry_history"]),
      requirement("factory/payroll-hub", [PAYROLL_WORKERS])
    );
  }
  if (hasPrefix(path, "/workers")) return workerRequirement(req, path);
  if (hasPrefix(path, "/payroll") || hasPrefix(path, "/payrolls") || hasPrefix(path, "/cash-accounts")) {
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
  if (hasPrefix(path, "/profitability") || hasPrefix(path, "/cashflow")) {
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

  if (hasPrefix(path, "/stock-query-report")) {
    return requirement("factory/stock-query");
  }
  if (hasPrefix(path, "/location-inventory")) {
    if (isWrite(req)) return requirement("factory/location-inventory");
    // Factory POS reads the selling location's stock to build its product picker.
    return anyOf(requirement("factory/location-inventory"), requirement("factory/pos"));
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
    return anyOf(requirement("factory/bales-hub", ["hide_tab_bales_products"]), requirement("factory/stock-query"));
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
  if (hasPrefix(path, "/containers") || hasPrefix(path, "/container-doc-types") || hasPrefix(path, "/freight")) {
    if (isWrite(req)) return requirement("factory/containers-hub");
    return anyOf(
      requirement("factory/containers-hub"),
      requirement("factory/raw-materials"),
      requirement("factory/production-report"),
      requirement("factory/intelligence/dashboard"),
      requirement("factory/intelligence/financial-hub")
    );
  }

  // Scheduled Containers is shown in both Invoicing > Invoices and the
  // Production Report shipping section. Own its CRUD API under either visible
  // page/tab, rather than rejecting it as an unmapped Factory action.
  // Keep this narrower than the general shipping routes below.
  if (hasPrefix(path, "/scheduled-containers")) {
    return anyOf(
      requirement("factory/invoicing", ["hide_invoicing_invoices_tab"]),
      requirement("factory/production-report", ["hide_tab_overview_shipping"])
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
      requirement("factory/stock-entry"),
      requirement("factory/pos")
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
    // Factory POS owns its API. Overview keeps the access it had while POS was its alias.
    return anyOf(requirement("factory/pos"), requirement("factory/production-report"));
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
      return anyOf(requirement("factory/rental/shops"), requirement("factory/rental/payments"));
    }
    return anyOf(requirement("factory/rental/shops"), requirement("factory/rental/warehouses"));
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
