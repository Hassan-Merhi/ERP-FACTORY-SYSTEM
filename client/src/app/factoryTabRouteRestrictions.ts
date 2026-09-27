/**
 * Direct Factory routes that render content owned by a configurable tab.
 *
 * The canonical tab catalog lives in @shared/factoryPermissionCatalog.
 * This file only maps deep/legacy URLs to the tab permission(s) that own them,
 * preventing bookmarks from bypassing the same visibility rules enforced by hubs.
 */
export interface FactoryTabRouteRestriction {
  prefix: string;
  hiddenKeys: readonly string[];
  fallback: string;
  includeRoot?: boolean;
}

export const FACTORY_TAB_ROUTE_RESTRICTIONS: readonly FactoryTabRouteRestriction[] = [
  { prefix: "/factory/bale-relabeling/wipers-re-entry", hiddenKeys: ["hide_tab_relabeling_wipers"], fallback: "/factory/bale-relabeling" },

  { prefix: "/factory/customers", hiddenKeys: ["hide_tab_parties_customers"], fallback: "/factory/parties" },
  { prefix: "/factory/suppliers", hiddenKeys: ["hide_tab_parties_suppliers"], fallback: "/factory/parties" },

  { prefix: "/factory/workers", hiddenKeys: ["hide_tab_payrollhub_workers", "hide_tab_workers_workers"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/worker-payroll", hiddenKeys: ["hide_tab_payrollhub_workers", "hide_tab_workers_payroll"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/payroll", hiddenKeys: ["hide_tab_payrollhub_workers", "hide_tab_workers_payroll"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/employees", hiddenKeys: ["hide_tab_payrollhub_employees", "hide_tab_employees_employees"], fallback: "/factory/payroll-hub" },
  { prefix: "/factory/insurance", hiddenKeys: ["hide_tab_payrollhub_insurance"], fallback: "/factory/payroll-hub" },

  { prefix: "/factory/bales-history", hiddenKeys: ["hide_tab_bales_history"], fallback: "/factory/bales-hub" },
  { prefix: "/factory/bale-product-history", hiddenKeys: ["hide_tab_bales_history"], fallback: "/factory/bales-hub" },
  { prefix: "/factory/barcode-lookup", hiddenKeys: ["hide_tab_bales_barcode"], fallback: "/factory/bales-hub" },
  { prefix: "/factory/bale-products", hiddenKeys: ["hide_tab_bales_products"], fallback: "/factory/bales-hub" },

  { prefix: "/factory/sales/proformas", hiddenKeys: ["hide_invoicing_proformas_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/new", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/invoices", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/pending-invoices", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/invoices", hiddenKeys: ["hide_invoicing_invoices_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/loading/pending", hiddenKeys: ["hide_tab_loadings_pending"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/loading/new", hiddenKeys: ["hide_invoicing_loadings_tab"], fallback: "/factory/invoicing" },
  { prefix: "/factory/sales/loadings", hiddenKeys: ["hide_invoicing_loadings_tab"], fallback: "/factory/invoicing" },

  { prefix: "/factory/dispatch-batches", hiddenKeys: ["hide_tab_dispatch_batches"], fallback: "/factory/dispatch-batches", includeRoot: false },

  { prefix: "/factory/ledger-monthly", hiddenKeys: ["hide_tab_accounts_view"], fallback: "/factory/accounts" },
  { prefix: "/factory/ledger-vouchers", hiddenKeys: ["hide_tab_accounts_view"], fallback: "/factory/accounts" },
  { prefix: "/factory/create", hiddenKeys: ["hide_tab_accounts_view"], fallback: "/factory/accounts" },
] as const;

function cleanFactoryPath(path: string): string {
  const withoutHash = path.split("#", 1)[0];
  const withoutQuery = withoutHash.split("?", 1)[0];
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed || "/";
}

export function resolveFactoryTabRouteRestriction(path: string): FactoryTabRouteRestriction | null {
  const clean = cleanFactoryPath(path);
  return (
    FACTORY_TAB_ROUTE_RESTRICTIONS.find((rule) =>
      rule.includeRoot === false
        ? clean.startsWith(`${rule.prefix}/`)
        : clean === rule.prefix || clean.startsWith(`${rule.prefix}/`)
    ) ?? null
  );
}
