import { FACTORY_ACCESS_REGISTRY, normalizeFactoryAccessPath } from "@shared/factoryAccessRegistry";

export function getParentRoute(pathname: string): string | null {
  const cleanPath = pathname.split("?")[0].split("#")[0];

  if (cleanPath.startsWith("/factory/")) {
    // People and parties details → exact hub section.
    if (/^\/factory\/employees\/\d+/.test(cleanPath)) return "/factory/payroll-hub?section=employees";
    if (/^\/factory\/workers\/\d+/.test(cleanPath)) return "/factory/payroll-hub?section=workers";
    if (/^\/factory\/customers\/\d+/.test(cleanPath)) return "/factory/parties?section=customers";

    // Containers, loading, and invoicing details → owning workflow.
    if (cleanPath === "/factory/containers/new") return "/factory/containers-hub?section=containers";
    if (cleanPath === "/factory/sales/loading/new") return "/factory/sales/loadings";
    if (cleanPath === "/factory/sales/loading/pending") return "/factory/sales/loadings";
    if (/^\/factory\/sales\/invoices\/\d+/.test(cleanPath)) return "/factory/invoicing?tab=invoices";
    if (/^\/factory\/sales\/pending-invoices\/\d+\/verify/.test(cleanPath)) return "/factory/invoicing?tab=invoices";
    if (/^\/factory\/sales\/proformas\/\d+\/add-line/.test(cleanPath)) return "/factory/invoicing?tab=proformas";
    {
      const match = cleanPath.match(/^\/factory\/invoices\/(\d+)\/loading-scan/);
      if (match) return `/factory/sales/invoices/${match[1]}`;
    }

    // Raw-material and bale child pages → owning inventory page.
    if (/^\/factory\/raw-stock\/opening-balance\/\d+\/edit/.test(cleanPath)) return "/factory/raw-materials";
    if (cleanPath === "/factory/raw-stock/recalculate") return "/factory/raw-materials";
    if (/^\/factory\/stock-query\/\d+/.test(cleanPath)) return "/factory/stock-query";
    if (cleanPath === "/factory/bale-relabeling/wipers-re-entry") return "/factory/bale-relabeling";
    {
      const match = cleanPath.match(/^\/factory\/bale-product-history\/(\d+)\/(\d+)\/\d+(?:\/(?:all|\d+))?/);
      if (match) return `/factory/bale-product-history/${match[1]}/${match[2]}`;
    }
    if (/^\/factory\/bale-product-history\/\d+\/\d+/.test(cleanPath)) return "/factory/location-inventory";

    // Accounting detail hierarchy.
    {
      const match = cleanPath.match(/^\/factory\/ledger-vouchers\/([^/]+)\//);
      if (match) return `/factory/ledger-monthly/${match[1]}`;
    }
    if (/^\/factory\/ledger-monthly\//.test(cleanPath)) return "/factory/accounts";
    if (/^\/factory\/voucher-detail\//.test(cleanPath)) return "/factory/vouchers";
    if (/^\/factory\/vouchers\/\d+\/edit/.test(cleanPath)) return "/factory/vouchers";

    // Dispatch ride scan → batch detail → batch list.
    {
      const match = cleanPath.match(/^\/factory\/dispatch-batches\/(\d+)\/rides\/\d+\/scan/);
      if (match) return `/factory/dispatch-batches/${match[1]}`;
    }
    if (/^\/factory\/dispatch-batches\/\d+/.test(cleanPath)) return "/factory/dispatch-batches";

    // Intelligence and administration children.
    if (/^\/factory\/net-position-details/.test(cleanPath)) {
      return "/factory/intelligence/financial-hub?section=net-position";
    }
    if (/^\/factory\/financial-snapshot/.test(cleanPath)) return "/factory/analytics";
    if (/^\/factory\/import-cycle-diagnostics/.test(cleanPath)) return "/factory/settings";
    if (/^\/factory\/inventory-repair/.test(cleanPath)) return "/factory/settings";
    if (/^\/factory\/company-data-reset/.test(cleanPath)) return "/factory/settings";
    if (/^\/factory\/orphaned-records/.test(cleanPath)) return "/factory/settings";
    if (/^\/factory\/deleted-items/.test(cleanPath)) return "/factory/settings";

    return null;
  }

  if (cleanPath.startsWith("/properties/")) {
    // Rentals children and compatibility pages → shared Rentals hub.
    if (cleanPath === "/properties/create") return "/properties/rentals?tab=warehouses";
    if (cleanPath === "/properties/transfer") return "/properties/rentals";
    if (cleanPath === "/properties/rental/warehouses") return "/properties/rentals?tab=warehouses";
    if (cleanPath === "/properties/rental/shops") return "/properties/rentals?tab=shops";
    if (cleanPath === "/properties/rental/payments") return "/properties/rentals?tab=payments";

    // Accounting detail hierarchy.
    if (/^\/properties\/voucher-detail\//.test(cleanPath)) return "/properties/vouchers";
    if (/^\/properties\/vouchers\/\d+\/edit/.test(cleanPath)) return "/properties/vouchers";
    {
      const match = cleanPath.match(/^\/properties\/ledger-vouchers\/([^/]+)\//);
      if (match) return `/properties/ledger-monthly/${match[1]}`;
    }
    if (/^\/properties\/ledger-monthly\//.test(cleanPath)) return "/properties/accounts";
    if (cleanPath === "/properties/account-groups") return "/properties/accounts";

    // Administration children.
    if (/^\/properties\/net-position-details/.test(cleanPath)) return "/properties/settings";
    if (/^\/properties\/import-cycle-diagnostics/.test(cleanPath)) return "/properties/settings";
    if (/^\/properties\/inventory-repair/.test(cleanPath)) return "/properties/settings";
    if (/^\/properties\/company-data-reset/.test(cleanPath)) return "/properties/settings";
    if (/^\/properties\/orphaned-records/.test(cleanPath)) return "/properties/settings";
    if (/^\/properties\/deleted-items/.test(cleanPath)) return "/properties/settings";
    if (/^\/properties\/chatbot-settings/.test(cleanPath)) return "/properties/settings";
    if (cleanPath === "/properties/balance-repair") return "/properties/settings";

    return null;
  }

  // ERP — parties and supplier workflows.
  if (/^\/suppliers\/\d+\/edit/.test(cleanPath)) return "/parties?tab=suppliers";
  if (/^\/suppliers\/\d+\/proformas/.test(cleanPath)) return "/parties?tab=suppliers";
  if (cleanPath === "/supplier-profit-check") return "/parties?tab=suppliers";

  // ERP — POS and sales workflows.
  if (/^\/pos\/edit\/\d+/.test(cleanPath)) return "/pos";
  if (cleanPath === "/pos-import") return "/pos";
  if (cleanPath === "/stock-transfer-order") return "/sales-tools?tab=transfers";

  // ERP — containers / purchase orders.
  if (/^\/purchase-orders\/\d+\/edit/.test(cleanPath)) return "/containers";
  if (cleanPath === "/po-import") return "/containers";
  if (/^\/containers\/\d+\/verification/.test(cleanPath)) {
    const match = cleanPath.match(/^\/containers\/(\d+)\//);
    return match ? `/containers/${match[1]}` : "/containers";
  }
  if (/^\/containers\/\d+/.test(cleanPath)) return "/containers";
  if (/^\/offloads\/\d+/.test(cleanPath)) return "/containers";

  // ERP — sales report details.
  if (cleanPath.startsWith("/sales-report/")) return "/sales-report";

  // ERP — accounting / ledger.
  {
    const match = cleanPath.match(/^\/ledger-vouchers\/([^/]+)\//);
    if (match) return `/ledger-monthly/${match[1]}`;
  }
  if (/^\/ledger-monthly\//.test(cleanPath)) return "/accounts";
  if (/^\/voucher-detail\//.test(cleanPath)) return "/vouchers";
  if (/^\/vouchers\/\d+\/edit/.test(cleanPath)) return "/vouchers";
  if (cleanPath === "/account-groups") return "/accounts";
  if (cleanPath === "/account-transfer") return "/accounts";

  // ERP — stock / inventory.
  if (/^\/stock-query\/\d+/.test(cleanPath)) return "/stock?tab=query";
  if (/^\/stock-items\/\d+\/history\/\d+\/\d+/.test(cleanPath)) {
    const match = cleanPath.match(/^\/stock-items\/(\d+)\/history/);
    return match ? `/stock-items/${match[1]}/history` : "/stock?tab=items";
  }
  if (/^\/stock-items\/\d+\/history/.test(cleanPath)) return "/stock?tab=items";
  if (/^\/stock-items\/\d+\/monthly-summary/.test(cleanPath)) return "/inventory?tab=by-location";
  if (/^\/locations\/\d+\/stock-items\/\d+\/vouchers\/\d+\/\d+/.test(cleanPath)) {
    const match = cleanPath.match(/^\/locations\/(\d+)\/stock-items\/(\d+)\//);
    return match ? `/locations/${match[1]}/stock-items/${match[2]}/history` : "/inventory?tab=by-location";
  }
  if (/^\/locations\/\d+\/stock-items\/\d+\/history/.test(cleanPath)) return "/inventory?tab=by-location";
  if (cleanPath === "/import-stock-items") return "/stock?tab=items";
  if (cleanPath === "/barcode-manager") return "/stock?tab=items";
  if (/^\/opening-stock\/[^/]+/.test(cleanPath)) return "/opening-stock";
  if (/^\/closing-stock\/[^/]+/.test(cleanPath)) return "/closing-stock-summary";

  // ERP — rentals.
  if (cleanPath === "/erp/rental/warehouses") return "/erp/rental/shops";
  if (cleanPath === "/erp/rental/payments") return "/erp/rental/shops";

  // ERP — AI and administrative children.
  if (cleanPath === "/ai-validation") return "/ai-command-center";
  if (/^\/net-position-details/.test(cleanPath)) return "/settings";
  if (/^\/import-cycle-diagnostics/.test(cleanPath)) return "/settings";
  if (/^\/inventory-repair/.test(cleanPath)) return "/settings";
  if (/^\/balance-repair/.test(cleanPath)) return "/settings";
  if (/^\/company-data-reset/.test(cleanPath)) return "/settings";
  if (/^\/orphaned-records/.test(cleanPath)) return "/settings";
  if (/^\/deleted-items/.test(cleanPath)) return "/settings";
  if (/^\/account-migration/.test(cleanPath)) return "/settings";
  if (/^\/test-data-import/.test(cleanPath)) return "/settings";
  if (/^\/notification-settings/.test(cleanPath)) return "/settings";
  if (/^\/chatbot-settings/.test(cleanPath)) return "/settings";
  if (/^\/intercompany-links/.test(cleanPath)) return "/settings";

  // ERP — Supplier Partner children → Overview hub or Setup tab.
  if (cleanPath === "/sp/reports") return "/sp";
  if (cleanPath === "/sp/opening-stock") return "/sp";
  if (cleanPath === "/sp/aliases") return "/sp";
  if (cleanPath === "/sp/setup") return "/sp";
  if (cleanPath === "/sp/migration" || cleanPath === "/sp/gc-migration") {
    return "/sp/setup";
  }

  return null;
}

const FACTORY_TOP_LEVEL_ROUTES: ReadonlySet<string> = new Set(FACTORY_ACCESS_REGISTRY.map((page) => page.route));

/**
 * True for a top-level Factory destination (a registry page, any hub section or query state).
 * These pages have no parent: Escape/Back performs no navigation there (navigation registry
 * contract), rather than falling back to browser history, which could leave Factory Mode.
 */
export function isFactoryTopLevelPath(pathname: string): boolean {
  return FACTORY_TOP_LEVEL_ROUTES.has(normalizeFactoryAccessPath(pathname));
}
