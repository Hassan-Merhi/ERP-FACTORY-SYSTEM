/**
 * Operational permissions (imports, bulk maintenance, exports, POS shifts),
 * declared per route.
 *
 * Every guarded route is listed below by method and Express path, under the
 * permission it needs. Nothing is inferred from words in the URL: a route that
 * is not listed is not guarded by this layer (its own requireAuth/requireRole
 * chain still applies). tests/operational-permission-route-policy.test.ts keeps
 * the table honest: every entry must be a registered route, and every
 * registered route whose path looks like an import, export, print or repair
 * must be listed here or explicitly exempted there.
 */
export type OperationalPermissionType = "action" | "export" | "pos";

export interface OperationalPermissionRouteMatch {
  operation:
    | "import"
    | "bulk-maintenance"
    | "excel-export"
    | "pdf-export"
    | "stock-export"
    | "print"
    | "whatsapp-export"
    | "global-export-center"
    | "pos-shift-control"
    | "pos-shift-summary";
  permissionType: OperationalPermissionType;
  permissionKey: string;
  developerOnly?: boolean;
  deniedRoles?: readonly string[];
  permissionBypassRoles?: readonly string[];
}

export const OPERATIONAL_PERMISSIONS = {
  posShiftControl: { operation: "pos-shift-control", permissionType: "pos", permissionKey: "pos_perm_open_shift" },
  posShiftSummary: {
    operation: "pos-shift-summary",
    permissionType: "pos",
    permissionKey: "pos_perm_view_shift_summary",
  },
  // POS Excel imports are intentional sales workflows. POS users must be able
  // to import both normal/cash sales and customer/credit sales even when the
  // broad "Import Data" restriction is disabled for their role. Other roles
  // still use the normal act_import_data permission, and View Only stays blocked.
  posSalesImport: {
    operation: "import",
    permissionType: "action",
    permissionKey: "act_import_data",
    deniedRoles: ["View Only"],
    permissionBypassRoles: ["POS"],
  },
  import: {
    operation: "import",
    permissionType: "action",
    permissionKey: "act_import_data",
    deniedRoles: ["POS", "View Only"],
  },
  bulkMaintenance: {
    operation: "bulk-maintenance",
    permissionType: "action",
    permissionKey: "act_bulk_operations",
    deniedRoles: ["POS", "View Only"],
  },
  globalExportCenter: {
    operation: "global-export-center",
    permissionType: "export",
    permissionKey: "exp_backup_download",
    developerOnly: true,
  },
  whatsappExport: { operation: "whatsapp-export", permissionType: "export", permissionKey: "exp_whatsapp_send" },
  stockExport: { operation: "stock-export", permissionType: "export", permissionKey: "exp_stock_report" },
  pdfExport: { operation: "pdf-export", permissionType: "export", permissionKey: "exp_pdf" },
  print: { operation: "print", permissionType: "export", permissionKey: "exp_print_invoice" },
  excelExport: { operation: "excel-export", permissionType: "export", permissionKey: "exp_excel" },
} as const satisfies Record<string, OperationalPermissionRouteMatch>;

export type OperationalPermissionName = keyof typeof OPERATIONAL_PERMISSIONS;

/**
 * "METHOD /express/path" entries per permission. Paths use only literal
 * segments and ":param" segments. When a request matches entries under two
 * permissions, the one listed first here wins.
 */
export const OPERATIONAL_ROUTE_PERMISSIONS: Readonly<Record<OperationalPermissionName, readonly string[]>> = {
  posShiftControl: [
    "POST /api/pos/shifts/open",
    "POST /api/pos/shifts/:id/close",
    "POST /api/pos/retail/shifts/:id/cash-movements",
  ],
  posShiftSummary: ["GET /api/pos/shifts/history", "GET /api/pos/shifts/:id", "GET /api/pos/retail/shifts/:id/summary"],
  posSalesImport: [
    "POST /api/pos-import/parse",
    "POST /api/pos-import/validate",
    "POST /api/pos-import/import",
    "GET /api/pos-import/template",
    "POST /api/credit-sales-import/parse",
    "POST /api/credit-sales-import/validate",
    "POST /api/credit-sales-import/import",
    "GET /api/credit-sales-import/template",
  ],
  import: [
    "POST /api/stock-items/import-opening-balances",
    "POST /api/bales/import",
    "POST /api/factory/workers/import-excel",
    "POST /api/containers/tracking/import",
    "POST /api/factory/bales/import",
    "POST /api/factory/bale-products/arabic-import/preview",
    "POST /api/factory/bale-products/arabic-import/errors",
    "POST /api/factory/bale-products/arabic-import/apply",
    "POST /api/factory/french-catalog/import/preview",
    "POST /api/factory/french-catalog/import/apply",
    "POST /api/factory/bale-products/import-excel",
    "POST /api/factory/bales/validate-import",
    "POST /api/factory/bales/import-excel",
    "POST /api/factory/containers/backfill-import-credits",
    "POST /api/factory/containers/import-excel",
    "POST /api/factory/import/suppliers",
    "POST /api/factory/import/raw-stock",
    "POST /api/factory/import/bales",
    "POST /api/factory/import/opening-raw-stock",
    "POST /api/factory/customer-orders/:id/bales/bulk-import",
    "POST /api/factory/import-company-data",
    "POST /api/suppliers/:supplierId/proformas/:proformaId/import-lines",
    "POST /api/containers/:containerId/import-loaded-items",
    "POST /api/supplier-profit-check/import-by-codes",
    "POST /api/factory/sheets/import",
    "POST /api/factory/status-builder/sheets/import",
    "GET /api/insurance/import/template",
    "POST /api/insurance/import/preview",
    "POST /api/insurance/import/apply",
    "POST /api/locations/:locationId/import-cost-prices",
    "POST /api/locations/:locationId/import-inventory",
    "POST /api/stock-items/import",
    "POST /api/stock-items/import-barcodes",
    "POST /api/stock-items/import-grade-category-template",
    "POST /api/retail/import",
    "POST /api/po-import/parse",
    "POST /api/po-import/backfill",
    "POST /api/sales-import/backfill",
    "POST /api/containers/:id/price-import/preview",
    "POST /api/containers/:id/price-import/apply",
    "POST /api/po-import/validate",
    "POST /api/po-import/import",
    "GET /api/po-import/template",
    "POST /api/stock-transfer-import/parse",
    "POST /api/stock-transfer-import/validate",
    "POST /api/stock-transfer-import/import",
    "GET /api/stock-transfer-import/template",
    "GET /api/stock-transfer-import/template-multi-source",
    "POST /api/stock-transfer-import/parse-multi-source",
    "POST /api/stock-transfer-import/validate-multi-source",
    "POST /api/stock-transfer-import/import-multi-source",
    "POST /api/stock-transfers/smart-feedback/import",
    "POST /api/bales/price-import/preview",
    "POST /api/bales/price-import/apply",
    "POST /api/pending-barcodes/import",
    "POST /api/bale-products/import-excel",
    "POST /api/production-bales/import-excel",
    "POST /api/chatbot/confirm-po-import",
    "POST /api/git/containers/import-excel",
    "POST /api/git/containers/import-excel/undo",
    "POST /api/ai-import/upload",
    "GET /api/ai-import/jobs/:id",
    "GET /api/ai-import/jobs/:id/rows",
    "POST /api/ai-import/jobs/:id/validate",
    "POST /api/ai-import/jobs/:id/confirm",
    "PATCH /api/ai-import/rows/:rowId",
    "GET /api/ai-import/corrections",
    "DELETE /api/ai-import/corrections/:id",
    "POST /api/ai-import/jobs/:id/post",
    // Import templates the old URL rules missed (.xlsx suffix, or a :type segment after /template).
    "GET /api/factory/import/template/:type",
    "GET /api/factory/workers/template.xlsx",
    "GET /api/git/containers/eta-template.xlsx",
    "GET /api/git/containers/import-template.xlsx",
  ],
  bulkMaintenance: [
    "POST /api/factory/suppliers/fx-diagnostic/repair",
    "POST /api/factory/bilingual-snapshots/backfill",
    "POST /api/factory/admin/fix-other-charges-currency",
    "POST /api/factory/raw-stock/post-offload/repair",
    "PATCH /api/factory/containers/:id/post-offload-charges/:chargeId/legacy-rebuild",
    "POST /api/factory/raw-stock/recalculate-used",
    "POST /api/factory/raw-stock/recalculate-bale-costs",
    "POST /api/factory/raw-stock/recalc/fix-source-mismatches",
    "POST /api/factory/bales/backfill-costs",
    "POST /api/factory/repair-perkg-prices",
    "POST /api/factory/employees/recalculate-balances",
    "POST /api/factory/employees/:id/recalculate-balance",
    "POST /api/factory/v5/container-plans/:planId/reconcile",
    "POST /api/factory/shipping-container-docs/cleanup-ghosts",
    "PATCH /api/factory/payrolls/:id/fix-accounting",
    "POST /api/factory/advances/reconcile",
    "POST /api/admin/backfill-payroll-vouchers",
    "POST /api/factory/repair-orphaned-vouchers",
    "POST /api/factory/admin/repair-truncated-user-attribution",
    "POST /api/accounts/multi-currency/repair-center/plan",
    "POST /api/accounts/multi-currency/repair-center/apply",
    "POST /api/accounting/factory-fx-repair/apply",
    "POST /api/intercompany-pos-config/rebuild",
    "POST /api/salary-advances/reconcile",
    "POST /api/stock-items/reconcile-otw-names",
    "POST /api/tracking-defaults/backfill",
    "POST /api/admin/fix-sales-inventory",
    "POST /api/sales-report/recalculate-costs",
    "POST /api/admin/fix-orphaned-charge-vouchers",
    "POST /api/admin/backfill-postoffload-vouchers",
    "POST /api/admin/offload-charge-voucher-repair",
    "POST /api/admin/recalculate-factory-order-totals",
    "POST /api/admin/cleanup-legacy-employee-accounts",
    "POST /api/fix-old-po-credits",
    "POST /api/fix-parent-po-supplier-entries",
    "POST /api/admin/recalculate-equity-adjustment",
    "POST /api/admin/recalculate-equity-adjustment-all",
    "POST /api/admin/fix-orphaned-pos-data",
    "POST /api/admin/rebuild-inventory",
    "POST /api/admin/repair-inventory-values",
    "POST /api/admin/fix-orphaned-bales",
    "POST /api/admin/repair/historical-sales-cost/dry-run",
    "POST /api/admin/repair/historical-sales-cost/:runId/apply",
    "POST /api/admin/repair/historical-sales-cost/:runId/partial-apply",
    "POST /api/admin/repair/historical-sales-cost/:runId/partial-apply/rollback",
    "POST /api/cleanup/orphaned-charges",
    "POST /api/admin/schema-fix",
    "POST /api/admin/repair-balances/apply",
    "POST /api/admin/repair-balances/undo",
    "POST /api/properties/repair/reallocate-payments/:contractId",
    "POST /api/export/cleanup-stuck-runs",
    // Raw-stock recalculation writes the old URL rules missed ("recalc" is not "recalculate").
    "POST /api/factory/raw-stock/recalc-opening",
    "POST /api/factory/raw-stock/recalc/apply",
    "POST /api/factory/raw-stock/recalc/apply-all-safe",
    "POST /api/factory/raw-stock/recalc/auto-apply-fx",
    "POST /api/factory/raw-stock/recalc/undo",
    "POST /api/factory/raw-stock/recalc/zero-cost-sources/apply",
    "POST /api/factory/raw-stock/recalc/partial-offload-scan/apply",
    "POST /api/factory/raw-stock/recalc/historical-replay/apply",
    "PATCH /api/factory/raw-stock/recalc/historical-replay/adjustments/:id/valuation-basis",
  ],
  globalExportCenter: [
    "GET /api/export/recipients",
    "POST /api/export/recipients",
    "DELETE /api/export/recipients/:id",
    "GET /api/export/settings",
    "PUT /api/export/settings",
    "POST /api/export/start",
    "GET /api/export/job/:jobId",
    "GET /api/export/download/:jobId",
    "GET /api/export/companies",
    "GET /api/export/backup-status",
  ],
  whatsappExport: [
    "POST /api/pos/send-whatsapp-pdf-upload",
    "POST /api/factory/bales/send-worker-pdf-whatsapp",
    "POST /api/daily-export/trigger-whatsapp",
  ],
  stockExport: [
    "POST /api/pos/send-stock-pdf-backend",
    "POST /api/pos/send-stock-pdf",
    "GET /api/factory/bales/stock-entry-history/export-pdf",
    "GET /api/locations/:locationId/inventory/pdf/stock-group/:groupId",
    "GET /api/stock-items/last-sales-export",
    "GET /api/stock-items/export-grade-category-template",
    // Missed by the old URL rules (.xlsx suffix).
    "GET /api/factory/bales/stock-register.xlsx",
  ],
  pdfExport: [
    "POST /api/pos/send-invoice-pdf-backend",
    "GET /api/factory/customer-orders/:id/export-pdf",
    "GET /api/factory/customers/:id/statement/export-pdf",
    "GET /api/factory/customer-proformas/:id/export/pdf",
    "POST /api/factory/payrolls/payment-summary-pdf",
    "GET /api/factory/workers/:id/statement-pdf",
    "POST /api/factory/payroll/export-pdf",
    "GET /api/factory/attendance/pdf",
    "GET /api/factory/invoices/:invoiceId/loading-report/export/pdf",
    "GET /api/factory/invoice-loading-sessions/:sessionId/export/pdf",
    "GET /api/locations/:locationId/inventory/pdf",
    "GET /api/accounts/:type/:id/statement-pdf",
    "GET /api/pos/temp-pdf/:id",
    "GET /api/pos/invoice/:voucherId/pdf",
  ],
  print: ["POST /api/factory/pressing/create-and-print"],
  excelExport: [
    "POST /api/reports/item-market-analysis/export-sale-prices",
    "GET /api/factory/location-inventory/:locationId/export/excel",
    "GET /api/factory/location-inventory/export/all",
    "GET /api/factory/suppliers/:id/broker-statement/export",
    "GET /api/factory/customer-orders/:id/export/excel",
    "GET /api/factory/customer-orders/:id/export-excel",
    "GET /api/factory/customer-orders/:id/pending-export",
    "GET /api/factory/bale-products/arabic-import/capabilities/export",
    "GET /api/factory/bale-products/arabic-template",
    "GET /api/factory/daily-report/export",
    "GET /api/factory/weekly-report/export",
    "GET /api/factory/bales/export-full.xlsx",
    "GET /api/factory/bales/export-names.xlsx",
    "GET /api/factory/customers/:id/statement/export-excel",
    "GET /api/factory/customer-proformas/:id/export/excel",
    "GET /api/factory/customer-orders/:id/loading-status-export",
    "GET /api/factory/export-company-data",
    "POST /api/factory/payrolls/preview-excel",
    "POST /api/factory/payroll/export-excel",
    "GET /api/suppliers/:supplierId/proformas/:proformaId/export-excel",
    "GET /api/supplier-profit-check/proforma/:proformaId/export-supplier",
    "POST /api/supplier-profit-check/export-internal",
    "GET /api/properties/rental/units/:id/statement/export",
    "GET /api/erp/rental/units/:id/statement/export",
    "GET /api/factory/rental/units/:id/statement/export",
    "GET /api/factory/sheets/export",
    "GET /api/factory/invoices/:invoiceId/loading-report/export/excel",
    "GET /api/factory/invoice-loading-sessions/:sessionId/export/excel",
    "GET /api/factory/status-builder/sheets/export",
    "GET /api/locations/:locationId/inventory/export",
    "GET /api/containers/:id/export",
    "GET /api/containers/export-all",
    "GET /api/accounts/statement/export-excel",
    "GET /api/stats/net-position-excel",
    "GET /api/stats/group-net-position-excel",
    "GET /api/reports/net-profit-excel",
    "GET /api/reports/net-position-monthly-excel",
    "GET /api/sp/sales-form/export",
    "GET /api/sp/sales-form/export-v2",
    // Missed by the old URL rules (.xlsx / .csv suffix).
    "GET /api/suppliers/:supplierId/containers/:containerId/verification-export.xlsx",
    "GET /api/suppliers/:supplierId/containers/:containerId/verification-summary-export.xlsx",
    "GET /api/sp/reconciliation/full/export.csv",
  ],
};

/**
 * Registered routes that Express matches before a listed ":param" route with
 * the same shape, and that need no operational permission. They are checked
 * first, so the parameter route's permission does not leak onto them.
 */
export const OPERATIONAL_PERMISSION_FREE_ROUTES: readonly string[] = [
  // Registered before GET /api/pos/shifts/:id; any POS user reads their open shift.
  "GET /api/pos/shifts/current",
];

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  permission: OperationalPermissionRouteMatch | null;
}

const ROUTE_ENTRY =
  /^(GET|POST|PUT|PATCH|DELETE) (\/(?:[A-Za-z0-9._-]+|:[A-Za-z0-9_]+)(?:\/(?:[A-Za-z0-9._-]+|:[A-Za-z0-9_]+))*)$/;

function compileRoutePath(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  // Matches the way the app routes: case-sensitive (createHttpApp), one
  // optional trailing slash, whole path.
  // The source is built from the static table above, validated by ROUTE_ENTRY
  // and escaped segment by segment; no request data reaches it.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${source}/?$`);
}

/** A table entry that is not "METHOD /express/path"; thrown at module load. */
export class OperationalPermissionRouteEntryError extends Error {
  constructor(readonly entry: string) {
    super(entry);
    this.name = "OperationalPermissionRouteEntryError";
  }
}

function compileEntry(entry: string, permission: OperationalPermissionRouteMatch | null): CompiledRoute {
  const parsed = ROUTE_ENTRY.exec(entry);
  if (!parsed) throw new OperationalPermissionRouteEntryError(entry);
  return { method: parsed[1], pattern: compileRoutePath(parsed[2]), permission };
}

const COMPILED_ROUTES: readonly CompiledRoute[] = [
  ...OPERATIONAL_PERMISSION_FREE_ROUTES.map((entry) => compileEntry(entry, null)),
  ...(Object.entries(OPERATIONAL_ROUTE_PERMISSIONS) as Array<[OperationalPermissionName, readonly string[]]>).flatMap(
    ([name, entries]) => entries.map((entry) => compileEntry(entry, OPERATIONAL_PERMISSIONS[name]))
  ),
];

/** The permission a request needs, or null when no listed route matches. */
export function classifyOperationalPermissionRoute(
  method: string,
  rawPath: string
): OperationalPermissionRouteMatch | null {
  const upperMethod = method.toUpperCase();
  // Express answers HEAD with the GET handler.
  const routeMethod = upperMethod === "HEAD" ? "GET" : upperMethod;
  const path = rawPath.split("?", 1)[0] || "/";
  for (const route of COMPILED_ROUTES) {
    if (route.method === routeMethod && route.pattern.test(path)) return route.permission;
  }
  return null;
}
