/**
 * Permissions Control Center V2 — frontend page catalog.
 *
 * One typed list of the business pages in ERP, Factory, POS/Retail, Properties
 * and Supplier Partner, the permission-controlled actions each page offers,
 * and how the page is gated for the two roles that can never change existing
 * records (View Only and Create Only).
 *
 * The catalog is presentation policy only. The server's global View Only and
 * Create Only guards, the per-route Create Only guards and every other backend
 * boundary stay authoritative; nothing here grants access.
 *
 * Route modes for read-only roles:
 * - "browse": the page reads data; it stays open. In-page controls are gated
 *   per `inPage` below.
 * - "change": the page exists to change existing records (edit, import,
 *   approve, finalize, repair, settings). View Only and Create Only see an
 *   explanation instead, or are sent to the read-only view in `readView`.
 * - "create": the page exists to create a new record. Create Only sees an
 *   explanation unless `createOnlyCreate` names a handler-verified create.
 *   View Only keeps its existing (legacy) behaviour: the page opens and the
 *   server refuses the write.
 *
 * Human-readable page names and review notes for the audit report live in
 * config/permissions-v2-page-catalog-notes.json; the browser never shows them.
 *
 * In-page gating status (`inPage`):
 * - "component": the listed files read the shared role helpers and hide or
 *   disable controls that change existing records (checked by tests).
 * - "route": the whole page is unavailable to read-only roles.
 * - "role_restricted": the route only renders for Admin/Owner/Developer.
 * - "server_enforced": the page still shows some change controls to
 *   read-only roles; the server refuses them and the client request guard
 *   explains the refusal before sending. Listed as remaining UI work.
 */
import type { AccessControlAction, AccessControlResource } from "./accessControlV2";
import {
  isCreateOnlyRole,
  isExistingRecordReadOnlyRole,
  isCreateOnlyVerifiedCreateName,
  type CreateOnlyVerifiedCreateName,
} from "./createOnlyRolePolicy";

export type PermissionPageArea = "erp" | "factory" | "pos_retail" | "properties" | "supplier_partner";
export type ReadOnlyRouteMode = "browse" | "change" | "create";
export type InPageGating = "component" | "route" | "role_restricted" | "server_enforced";

export interface PermissionPageEntry {
  id: string;
  area: PermissionPageArea;
  /** wouter-style patterns; `:name` matches one path segment. */
  paths: readonly string[];
  resource: AccessControlResource;
  /** Permission-controlled actions the page offers to some role. */
  actions: readonly AccessControlAction[];
  mode: ReadOnlyRouteMode;
  inPage: InPageGating;
  /** Files whose controls are gated; required when inPage is "component". */
  files?: readonly string[];
  /** Handler-verified create this page submits to (Create Only may open it). */
  createOnlyCreate?: CreateOnlyVerifiedCreateName;
  /** Read-only view for "change" pages: `:param` values are copied across. */
  readView?: string;
}

const READ = ["view", "export"] as const satisfies readonly AccessControlAction[];
const CRUD = ["view", "create", "edit", "delete", "export"] as const satisfies readonly AccessControlAction[];
const DOC = [
  "view",
  "create",
  "edit",
  "delete",
  "approve",
  "finalize",
  "reverse",
  "void",
  "export",
] as const satisfies readonly AccessControlAction[];
const SETTINGS = ["view", "manage_settings"] as const satisfies readonly AccessControlAction[];
const REPAIR = ["view", "repair"] as const satisfies readonly AccessControlAction[];
const IMPORT = ["view", "import"] as const satisfies readonly AccessControlAction[];

export const PERMISSION_PAGE_CATALOG: readonly PermissionPageEntry[] = [
  // ── ERP ────────────────────────────────────────────────────────────────
  {
    id: "erp.accounts",
    area: "erp",
    paths: ["/accounts"],
    resource: "erp.accounts",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/AccountsLegacy.tsx", "client/src/pages/accounts/AccountStatementView.tsx"],
  },
  {
    id: "erp.accounts.historical-openings",
    area: "erp",
    paths: ["/accounts/historical-openings"],
    resource: "erp.accounts",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.accounts.ledger",
    area: "erp",
    paths: ["/ledger-monthly/:accountId", "/ledger-vouchers/:accountId/:year/:month"],
    resource: "erp.accounts",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.vouchers.create",
    area: "erp",
    paths: ["/vouchers"],
    resource: "erp.vouchers",
    actions: DOC,
    mode: "create",
    inPage: "route",
  },
  {
    id: "erp.vouchers.edit",
    area: "erp",
    paths: ["/vouchers/:id/edit"],
    resource: "erp.vouchers",
    actions: ["view", "edit", "delete", "reverse"],
    mode: "change",
    inPage: "route",
    readView: "/voucher-detail/:id",
  },
  {
    id: "erp.vouchers.detail",
    area: "erp",
    paths: ["/voucher-detail/:voucherId"],
    resource: "erp.vouchers",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.vouchers.optional",
    area: "erp",
    paths: ["/optional-vouchers"],
    resource: "erp.vouchers",
    actions: ["view", "approve", "finalize", "delete"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.accounting.create",
    area: "erp",
    paths: ["/create"],
    resource: "erp.accounts",
    actions: ["view", "create"],
    mode: "create",
    inPage: "component",
    files: ["client/src/pages/AccountingCreate.tsx"],
    createOnlyCreate: "suppliers",
  },
  {
    id: "erp.parties",
    area: "erp",
    paths: ["/parties"],
    resource: "erp.customers",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/Customers.tsx", "client/src/pages/Suppliers.tsx"],
    createOnlyCreate: "customers",
  },
  {
    id: "erp.suppliers.edit",
    area: "erp",
    paths: ["/suppliers/:id/edit"],
    resource: "erp.suppliers",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.suppliers.proformas",
    area: "erp",
    paths: ["/suppliers/:supplierId/proformas"],
    resource: "erp.suppliers",
    actions: CRUD,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.purchase-orders.import",
    area: "erp",
    paths: ["/po-import"],
    resource: "erp.purchase_orders",
    actions: IMPORT,
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.purchase-orders.edit",
    area: "erp",
    paths: ["/purchase-orders/:id/edit"],
    resource: "erp.purchase_orders",
    actions: ["view", "edit", "delete"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.sales.pos",
    area: "erp",
    paths: ["/pos"],
    resource: "erp.sales",
    actions: ["view", "create"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "erp.sales.pos-edit",
    area: "erp",
    paths: ["/pos/edit/:id"],
    resource: "erp.sales",
    actions: ["view", "edit", "void"],
    mode: "change",
    inPage: "route",
    readView: "/voucher-detail/:id",
  },
  {
    id: "erp.sales.item-replacement",
    area: "erp",
    paths: ["/pos-item-replacement"],
    resource: "erp.sales",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.sales.pos-import",
    area: "erp",
    paths: ["/pos-import"],
    resource: "erp.sales",
    actions: IMPORT,
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.sales.reports",
    area: "erp",
    paths: [
      "/sales-report",
      "/sales-report/detail",
      "/sales-report/comparison",
      "/stock-in-sales-report",
      "/item-market-analysis",
      "/supplier-profit-reconciliation",
      "/supplier-profit-check",
    ],
    resource: "erp.sales",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.sales.tools",
    area: "erp",
    paths: ["/sales-tools"],
    resource: "erp.sales",
    actions: ["view", "create", "edit", "approve", "export"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.inventory",
    area: "erp",
    paths: ["/inventory"],
    resource: "erp.inventory",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.stock",
    area: "erp",
    paths: ["/stock"],
    resource: "erp.stock_items",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/stockitems/StockItemsView.tsx"],
    createOnlyCreate: "stockItems",
  },
  {
    id: "erp.stock.detail",
    area: "erp",
    paths: [
      "/stock-query/:id",
      "/stock-items/:id/history",
      "/stock-items/:id/history/:year/:month",
      "/stock-items/:stockItemId/monthly-summary",
      "/locations/:locationId/stock-items/:stockItemId/history",
      "/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month",
    ],
    resource: "erp.stock_items",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.stock.import",
    area: "erp",
    paths: ["/import-stock-items"],
    resource: "erp.stock_items",
    actions: IMPORT,
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.stock.opening-closing",
    area: "erp",
    paths: [
      "/opening-stock",
      "/opening-stock/:groupId",
      "/closing-stock-summary",
      "/closing-stock/:groupId",
      "/bale-ledger",
    ],
    resource: "erp.inventory",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.stock.barcodes",
    area: "erp",
    paths: ["/barcode-manager"],
    resource: "erp.stock_items",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.stock-transfers.create",
    area: "erp",
    paths: ["/stock-transfer-order"],
    resource: "erp.stock_transfers",
    actions: ["view", "create", "approve"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "erp.containers",
    area: "erp",
    paths: ["/containers"],
    resource: "erp.containers",
    actions: DOC,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/Containers.tsx"],
  },
  {
    id: "erp.containers.detail",
    area: "erp",
    paths: ["/containers/:id", "/offloads/:id"],
    resource: "erp.containers",
    actions: DOC,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.containers.verification",
    area: "erp",
    paths: ["/containers/:containerId/verification"],
    resource: "erp.containers",
    actions: ["view", "approve"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.containers.git",
    area: "erp",
    paths: ["/git", "/mock-git", "/containers-otw", "/mock-containers-otw"],
    resource: "erp.containers",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: [
      "client/src/pages/GITContainers.tsx",
      "client/src/pages/git-mockup/TabDetail.tsx",
      "client/src/pages/git-mockup/TabTruckLocation.tsx",
      "client/src/pages/git-mockup/TabAgentDuty.tsx",
    ],
  },
  {
    id: "erp.daybook",
    area: "erp",
    paths: ["/daybook"],
    resource: "erp.vouchers",
    actions: DOC,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/daybook/DaybookTable.tsx"],
  },
  {
    id: "erp.transaction-journal",
    area: "erp",
    paths: ["/transaction-journal"],
    resource: "erp.vouchers",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.reports.analytics",
    area: "erp",
    paths: ["/analytics"],
    resource: "erp.analytics",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.reports.financial-overview",
    area: "erp",
    paths: ["/financial-overview"],
    resource: "erp.analytics",
    actions: READ,
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.transporter-statement",
    area: "erp",
    paths: ["/tracking"],
    resource: "erp.accounts",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/TransporterStatement.tsx"],
  },
  {
    id: "erp.payroll",
    area: "erp",
    paths: ["/payroll"],
    resource: "erp.payroll",
    actions: ["view", "create", "approve", "export"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.rentals",
    area: "erp",
    paths: ["/erp/rental/warehouses", "/erp/rental/shops"],
    resource: "properties.units",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: [
      "client/src/pages/properties/property-rental/components/RentalUnitCards.tsx",
      "client/src/pages/properties/property-rental/components/UnitActionDialog.tsx",
      "client/src/pages/properties/property-rental/components/StartContractForm.tsx",
      "client/src/pages/properties/property-rental/components/NoteCell.tsx",
    ],
    createOnlyCreate: "rentalUnits",
  },
  {
    id: "erp.rentals.payments",
    area: "erp",
    paths: ["/erp/rental/payments"],
    resource: "properties.payments",
    actions: ["view", "create", "reverse"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "erp.conflicts",
    area: "erp",
    paths: ["/conflicts"],
    resource: "system.maintenance",
    actions: REPAIR,
    mode: "change",
    inPage: "route",
  },
  {
    id: "erp.settings",
    area: "erp",
    paths: ["/settings", "/intercompany-links", "/chatbot-settings", "/notification-settings", "/account-groups"],
    resource: "system.settings",
    actions: SETTINGS,
    mode: "change",
    inPage: "role_restricted",
  },
  {
    id: "erp.repair",
    area: "erp",
    paths: [
      "/orphaned-records",
      "/deleted-items",
      "/import-cycle-diagnostics",
      "/inventory-repair",
      "/balance-repair",
      "/convergence-reconciliation",
      "/company-data-reset",
      "/account-migration",
      "/account-transfer",
      "/company-transfer",
    ],
    resource: "system.maintenance",
    actions: REPAIR,
    mode: "change",
    inPage: "role_restricted",
  },

  // ── Factory ────────────────────────────────────────────────────────────
  {
    id: "factory.inventory",
    area: "factory",
    paths: [
      "/factory/raw-stock",
      "/factory/raw-materials",
      "/factory/location-inventory",
      "/factory/stock-query",
      "/factory/stock-query/:id",
      "/factory/stock-otw",
    ],
    resource: "factory.raw_stock",
    actions: CRUD,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.inventory.opening-edit",
    area: "factory",
    paths: ["/factory/raw-stock/opening-balance/:id/edit"],
    resource: "factory.raw_stock",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.inventory.recalculate",
    area: "factory",
    paths: ["/factory/raw-stock/recalculate"],
    resource: "factory.raw_stock",
    actions: REPAIR,
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.stock-allocation",
    area: "factory",
    paths: ["/factory/stock-allocation", "/factory/stock-allocation-v3", "/factory/stock-allocation-v5"],
    resource: "factory.customer_orders",
    actions: ["view", "create", "edit", "delete"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.stock-allocation.proforma-new",
    area: "factory",
    paths: ["/factory/stock-allocation-v5/proformas/new"],
    resource: "factory.customer_orders",
    actions: ["view", "create"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "factory.stock-allocation.proforma-edit",
    area: "factory",
    paths: [
      "/factory/stock-allocation-v5/proformas/:id/edit",
      "/factory/invoicing/proformas/:id/edit",
      "/factory/sales/proformas/:proformaId/add-line",
    ],
    resource: "factory.customer_orders",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.invoicing",
    area: "factory",
    paths: ["/factory/invoicing", "/factory/sales/invoices/:id", "/factory/price-list"],
    resource: "factory.customer_orders",
    actions: DOC,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.sales.new",
    area: "factory",
    paths: ["/factory/sales/new"],
    resource: "factory.customer_orders",
    actions: ["view", "create"],
    mode: "create",
    inPage: "route",
    createOnlyCreate: "factoryCustomerOrders",
  },
  {
    id: "factory.sales.verify",
    area: "factory",
    paths: ["/factory/sales/pending-invoices/:id/verify"],
    resource: "factory.customer_orders",
    actions: ["view", "approve", "finalize"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.bales",
    area: "factory",
    paths: [
      "/factory/bales-hub",
      "/factory/stock-bale-list",
      "/factory/bale-tracking",
      "/factory/bales-history",
      "/factory/bale-product-history/:productId/:locationId",
      "/factory/bale-product-history/:productId/:locationId/:year/:month",
      "/factory/bale-product-history/:productId/:locationId/:year/all",
      "/factory/bale-ledger",
      "/factory/reprint-labels",
      "/factory/bale-products",
    ],
    resource: "factory.bales",
    actions: CRUD,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.bales.relabel",
    area: "factory",
    paths: ["/factory/bale-relabeling", "/factory/bale-relabeling/wipers-re-entry", "/factory/merge-bale-products"],
    resource: "factory.bales",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.production.entry",
    area: "factory",
    paths: ["/factory/stock-entry"],
    resource: "factory.production",
    actions: ["view", "create"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "factory.production.pressing",
    area: "factory",
    paths: ["/factory/pressing"],
    resource: "factory.production",
    actions: ["view", "create", "edit"],
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/factory/PressingMachineManagement.tsx"],
  },
  {
    id: "factory.production.finalize",
    area: "factory",
    paths: ["/factory/finalize"],
    resource: "factory.production",
    actions: ["view", "finalize"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.production.reports",
    area: "factory",
    paths: [
      "/factory/production-report",
      "/factory/production-summary",
      "/factory/production-comparison",
      "/factory/monthly-production-matrix",
      "/factory/monthly-production-matrix/:productId/workers",
      "/factory/monthly-production-matrix/:productId/bales/:workerId",
    ],
    resource: "factory.production",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.mixing",
    area: "factory",
    paths: ["/factory/intelligence/mix-optimizer"],
    resource: "factory.mix_batches",
    actions: ["view", "create", "edit"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.containers",
    area: "factory",
    paths: ["/factory/containers", "/factory/containers-hub"],
    resource: "factory.containers",
    actions: DOC,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/factory/FactoryShippingContainers.tsx"],
  },
  {
    id: "factory.containers.new",
    area: "factory",
    paths: ["/factory/containers/new"],
    resource: "factory.containers",
    actions: ["view", "create"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "factory.loading",
    area: "factory",
    paths: [
      "/factory/sales/loadings",
      "/factory/sales/loading/pending",
      "/factory/dispatch-batches",
      "/factory/dispatch-batches/:id",
    ],
    resource: "factory.containers",
    actions: ["view", "create", "edit", "finalize"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.loading.scan",
    area: "factory",
    paths: [
      "/factory/sales/loading/new",
      "/factory/invoices/:id/loading-scan",
      "/factory/dispatch-batches/:batchId/rides/:rideId/scan",
    ],
    resource: "factory.containers",
    actions: ["view", "create", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.workers",
    area: "factory",
    paths: [
      "/factory/employees",
      "/factory/employees/:id",
      "/factory/workers",
      "/factory/workers/:id",
      "/factory/insurance",
    ],
    resource: "factory.employees",
    actions: CRUD,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.payroll",
    area: "factory",
    paths: ["/factory/payroll-hub", "/factory/worker-payroll", "/factory/payroll", "/factory/production-bonuses"],
    resource: "factory.payroll",
    actions: ["view", "create", "edit", "approve", "export"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.scanning",
    area: "factory",
    paths: ["/factory/barcode-lookup"],
    resource: "factory.bales",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.accounting",
    area: "factory",
    paths: [
      "/factory/accounts",
      "/factory/ledger-monthly/:accountId",
      "/factory/ledger-vouchers/:accountId/:year/:month",
      "/factory/contacts",
      "/factory/parties",
      "/factory/customers/:id",
      "/factory/transporters",
    ],
    resource: "factory.accounting",
    actions: CRUD,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.vouchers.create",
    area: "factory",
    paths: ["/factory/vouchers"],
    resource: "factory.accounting",
    actions: DOC,
    mode: "create",
    inPage: "route",
  },
  {
    id: "factory.vouchers.edit",
    area: "factory",
    paths: ["/factory/vouchers/:id/edit"],
    resource: "factory.accounting",
    actions: ["view", "edit", "delete", "reverse"],
    mode: "change",
    inPage: "route",
    readView: "/factory/voucher-detail/:id",
  },
  {
    id: "factory.vouchers.detail",
    area: "factory",
    paths: ["/factory/voucher-detail/:voucherId"],
    resource: "factory.accounting",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.accounting.create",
    area: "factory",
    paths: ["/factory/create"],
    resource: "factory.accounting",
    actions: ["view", "create"],
    mode: "create",
    inPage: "component",
    files: ["client/src/pages/AccountingCreate.tsx"],
    createOnlyCreate: "suppliers",
  },
  {
    id: "factory.daybook",
    area: "factory",
    paths: ["/factory/daybook"],
    resource: "factory.accounting",
    actions: DOC,
    mode: "browse",
    inPage: "component",
    files: ["client/src/pages/factory/daybook/useFactoryDaybookModel.ts"],
  },
  {
    id: "factory.reports",
    area: "factory",
    paths: [
      "/factory/analytics",
      "/factory/intelligence/dashboard",
      "/factory/intelligence/kpis",
      "/factory/intelligence/alerts",
      "/factory/intelligence/supplier-hub",
      "/factory/intelligence/financial-hub",
      "/factory/intelligence/production-hub",
      "/factory/net-position-details",
      "/factory/financial-snapshot",
      "/factory/broker-visual-statement",
    ],
    resource: "factory.analytics",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.pos",
    area: "factory",
    paths: ["/factory/pos"],
    resource: "retail.pos",
    actions: ["view", "create"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "factory.import",
    area: "factory",
    paths: ["/factory/import"],
    resource: "factory.raw_stock",
    actions: IMPORT,
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.rentals",
    area: "factory",
    paths: ["/factory/rental/warehouses", "/factory/rental/shops"],
    resource: "properties.units",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: [
      "client/src/pages/properties/property-rental/components/RentalUnitCards.tsx",
      "client/src/pages/properties/property-rental/components/UnitActionDialog.tsx",
      "client/src/pages/properties/property-rental/components/StartContractForm.tsx",
    ],
    createOnlyCreate: "rentalUnits",
  },
  {
    id: "factory.rentals.payments",
    area: "factory",
    paths: ["/factory/rental/payments"],
    resource: "properties.payments",
    actions: ["view", "create", "reverse"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "factory.settings",
    area: "factory",
    paths: [
      "/factory/settings",
      "/factory/catalog-translations",
      "/factory/bale-product-images",
      "/factory/customer-logos",
      "/factory/label-banners",
      "/factory/intelligence/settings",
      "/factory/users",
      "/factory/account-groups",
      "/factory/chatbot-settings",
    ],
    resource: "system.settings",
    actions: SETTINGS,
    mode: "change",
    inPage: "route",
  },
  {
    id: "factory.repair",
    area: "factory",
    paths: [
      "/factory/deleted-items",
      "/factory/orphaned-records",
      "/factory/inventory-repair",
      "/factory/company-data-reset",
      "/factory/import-cycle-diagnostics",
      "/factory/balance-repair",
      "/factory/conflicts",
    ],
    resource: "system.maintenance",
    actions: REPAIR,
    mode: "change",
    inPage: "route",
  },

  // ── POS and Retail ─────────────────────────────────────────────────────
  {
    id: "retail.pos",
    area: "pos_retail",
    paths: ["/retail/pos"],
    resource: "retail.pos",
    actions: ["view", "create", "void"],
    mode: "create",
    inPage: "route",
  },
  {
    id: "retail.products",
    area: "pos_retail",
    paths: ["/retail", "/retail/inventory", "/retail/products/:id"],
    resource: "retail.stock_items",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: [
      "client/src/pages/retail/RetailInventory.tsx",
      "client/src/pages/retail/RetailProductEditor.tsx",
      "client/src/pages/retail/RetailCatalogList.tsx",
    ],
    createOnlyCreate: "retailProducts",
  },
  {
    id: "retail.stock-count",
    area: "pos_retail",
    paths: ["/retail/stock-count"],
    resource: "retail.stock_items",
    actions: ["view", "edit"],
    mode: "change",
    inPage: "route",
  },
  {
    id: "retail.history",
    area: "pos_retail",
    paths: ["/retail/history", "/retail/reports"],
    resource: "retail.pos",
    actions: ["view", "void", "export"],
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "pos.role-workspace",
    area: "pos_retail",
    paths: [
      "/pos-daybook",
      "/pos-dashboard",
      "/pos-customers",
      "/pos-price-list",
      "/pos-transfer-orders",
      "/pos-settings",
      "/pos-containers",
      "/pos-containers/:id",
    ],
    resource: "retail.pos",
    actions: ["view", "create", "edit", "void", "approve", "export"],
    mode: "browse",
    inPage: "server_enforced",
  },

  // ── Properties ─────────────────────────────────────────────────────────
  {
    id: "properties.dashboard",
    area: "properties",
    paths: ["/properties/dashboard", "/properties/analytics"],
    resource: "properties.analytics",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "properties.rentals",
    area: "properties",
    paths: ["/properties/rentals"],
    resource: "properties.contracts",
    actions: CRUD,
    mode: "browse",
    inPage: "component",
    files: [
      "client/src/pages/properties/property-rental/components/RentalUnitCards.tsx",
      "client/src/pages/properties/property-rental/components/UnitActionDialog.tsx",
      "client/src/pages/properties/property-rental/components/StartContractForm.tsx",
      "client/src/pages/properties/property-rental/components/NoteCell.tsx",
    ],
    createOnlyCreate: "rentalContracts",
  },
  {
    id: "properties.accounts",
    area: "properties",
    paths: [
      "/properties/accounts",
      "/properties/ledger-monthly/:accountId",
      "/properties/ledger-vouchers/:accountId/:year/:month",
    ],
    resource: "properties.payments",
    actions: CRUD,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "properties.daybook",
    area: "properties",
    paths: ["/properties/daybook"],
    resource: "properties.payments",
    actions: DOC,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "properties.vouchers.create",
    area: "properties",
    paths: ["/properties/vouchers", "/properties/create"],
    resource: "properties.payments",
    actions: DOC,
    mode: "create",
    inPage: "route",
  },
  {
    id: "properties.vouchers.edit",
    area: "properties",
    paths: ["/properties/vouchers/:id/edit"],
    resource: "properties.payments",
    actions: ["view", "edit", "delete", "reverse"],
    mode: "change",
    inPage: "route",
    readView: "/properties/voucher-detail/:id",
  },
  {
    id: "properties.vouchers.detail",
    area: "properties",
    paths: ["/properties/voucher-detail/:voucherId"],
    resource: "properties.payments",
    actions: READ,
    mode: "browse",
    inPage: "server_enforced",
  },
  {
    id: "properties.settings",
    area: "properties",
    paths: ["/properties/settings", "/properties/transfer", "/properties/balance-repair"],
    resource: "system.settings",
    actions: SETTINGS,
    mode: "change",
    inPage: "role_restricted",
  },

  // ── Supplier Partner ───────────────────────────────────────────────────
  {
    id: "sp.overview",
    area: "supplier_partner",
    paths: ["/sp", "/sp/golden-coast", "/sp/reports"],
    resource: "retail.pos",
    actions: ["view", "create", "export"],
    mode: "browse",
    inPage: "server_enforced",
    createOnlyCreate: "spSales",
  },
  {
    id: "sp.setup",
    area: "supplier_partner",
    paths: ["/sp/opening-stock", "/sp/aliases", "/sp/setup"],
    resource: "system.settings",
    actions: SETTINGS,
    mode: "change",
    inPage: "route",
  },
];

function splitPath(path: string): string[] {
  const clean = (path.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "");
  return clean === "" ? [] : clean.split("/").slice(1);
}

/** Match a location against a pattern; returns captured params or null. */
export function matchPagePattern(pattern: string, location: string): Record<string, string> | null {
  const want = splitPath(pattern);
  const have = splitPath(location);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index]!;
    const actual = have[index]!;
    if (segment.startsWith(":")) {
      if (!actual) return null;
      params[segment.slice(1)] = actual;
    } else if (segment !== actual) {
      return null;
    }
  }
  return params;
}

export function findPermissionPage(
  location: string
): { entry: PermissionPageEntry; params: Record<string, string>; pattern: string } | null {
  // Literal segments beat parameters: "/vouchers/:id/edit" must not shadow a
  // literal sibling, so prefer the pattern with the fewest parameters.
  let best: { entry: PermissionPageEntry; params: Record<string, string>; pattern: string } | null = null;
  let bestParams = Number.POSITIVE_INFINITY;
  for (const entry of PERMISSION_PAGE_CATALOG) {
    for (const pattern of entry.paths) {
      const params = matchPagePattern(pattern, location);
      if (!params) continue;
      const count = Object.keys(params).length;
      if (count < bestParams) {
        best = { entry, params, pattern };
        bestParams = count;
      }
    }
  }
  return best;
}

export type ReadOnlyRouteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string; pageId: string }
  | { kind: "explain"; reason: "existing_record_change" | "unverified_create"; pageId: string };

/**
 * Route decision for the active company role. Only View Only and Create Only
 * are affected; every other role, and every page not in the catalog, is left
 * to the existing route guards.
 */
export function decideReadOnlyRoleRoute(role: string | null | undefined, location: string): ReadOnlyRouteDecision {
  if (!isExistingRecordReadOnlyRole(role)) return { kind: "allow" };
  const match = findPermissionPage(location);
  if (!match) return { kind: "allow" };
  const { entry, params } = match;
  if (entry.mode === "browse") return { kind: "allow" };
  if (entry.mode === "create") {
    // View Only keeps its legacy create pages (the server refuses the write).
    if (!isCreateOnlyRole(role)) return { kind: "allow" };
    if (isCreateOnlyVerifiedCreateName(entry.createOnlyCreate)) return { kind: "allow" };
    return { kind: "explain", reason: "unverified_create", pageId: entry.id };
  }
  if (entry.readView) {
    const to = entry.readView.replace(/:([A-Za-z]+)/g, (_, name: string) =>
      encodeURIComponent(params[name] ?? Object.values(params)[0] ?? "")
    );
    return { kind: "redirect", to, pageId: entry.id };
  }
  return { kind: "explain", reason: "existing_record_change", pageId: entry.id };
}

export function permissionPageCatalogSummary() {
  const byArea: Record<PermissionPageArea, number> = {
    erp: 0,
    factory: 0,
    pos_retail: 0,
    properties: 0,
    supplier_partner: 0,
  };
  const byInPage: Record<InPageGating, number> = { component: 0, route: 0, role_restricted: 0, server_enforced: 0 };
  let routes = 0;
  for (const entry of PERMISSION_PAGE_CATALOG) {
    byArea[entry.area] += 1;
    byInPage[entry.inPage] += 1;
    routes += entry.paths.length;
  }
  return { pages: PERMISSION_PAGE_CATALOG.length, routes, byArea, byInPage };
}
