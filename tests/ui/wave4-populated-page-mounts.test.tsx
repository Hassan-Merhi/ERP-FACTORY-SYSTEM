/**
 * Wave 4 — pages mounted with data, not just their empty state.
 *
 * The page-mount suites (renders-uncovered-pages, wave4-page-mounts) prove a
 * page's component graph mounts with empty API responses. Most row-rendering,
 * formatting and derived-total code only runs once there is data, so this
 * suite mounts the same pages again with every GET answered by three generic
 * records. The payload is an array that also carries the paginated envelope
 * fields (items, rows, data, total, page...) so both response shapes resolve.
 *
 * Every page must still show its landmark with data loaded (a page that
 * crashes on its first real row fails here). Pages marked showsRows must also
 * render the seeded rows, which is the positive path of a list page.
 */
import React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

function seededRecord(i: number) {
  return {
    id: i,
    name: `Name ${i}`,
    code: `C${i}`,
    companyId: 1,
    locationId: 1,
    stockItemId: i,
    customerId: i,
    supplierId: i,
    workerId: i,
    containerId: i,
    accountId: i,
    voucherId: i,
    quantity: 10 * i,
    qty: 10 * i,
    amount: 100 * i,
    total: 100 * i,
    balance: 50 * i,
    rate: 5,
    price: 5,
    status: "active",
    date: "2026-09-01",
    createdAt: "2026-09-01T10:00:00Z",
    voucherDate: "2026-09-01",
    description: `Desc ${i}`,
    notes: "",
    active: true,
    type: "Sales",
    voucherType: "Sales",
    accountType: "Asset",
    locationName: "Main",
    itemName: `Item ${i}`,
    stockItemName: `Item ${i}`,
    customerName: `Cust ${i}`,
    supplierName: `Supp ${i}`,
    containerNumber: `CONT${i}`,
    username: `user${i}`,
    role: "Admin",
    weight: 100,
    kg: 100,
  };
}

/** Three records as an array that also answers the paginated envelope fields. */
function seededPayload() {
  const records = [seededRecord(1), seededRecord(2), seededRecord(3)];
  return Object.assign(records, {
    items: records,
    rows: records,
    data: records,
    results: records,
    total: 3,
    totalCount: 3,
    page: 1,
    pageSize: 50,
    totalPages: 1,
    hasMore: false,
  });
}

function stubSeededFetch() {
  (global as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => seededPayload(),
    text: async () => "",
    headers: new Headers({ "content-type": "application/json" }),
    clone() {
      return this;
    },
  }));
}

interface PageCase {
  name: string;
  load: () => Promise<any>;
  landmark: string;
  factory?: boolean;
  showsRows?: boolean;
}

const PAGES: PageCase[] = [
  {
    name: "AdvancedRestrictionsPanel",
    load: () => import("@/components/AdvancedRestrictionsPanel"),
    landmark: "input-permission-search",
  },
  {
    name: "GradesCategoriesManager",
    load: () => import("@/components/GradesCategoriesManager"),
    landmark: "button-export-grade-category",
    showsRows: true,
  },
  {
    name: "NotificationsCenter",
    load: () => import("@/components/NotificationsCenter"),
    landmark: "button-notifications-bell",
  },
  {
    name: "StockNameUpdateImport",
    load: () => import("@/components/StockNameUpdateImport"),
    landmark: "input-update-stock-names-file",
  },
  { name: "AccountGroups", load: () => import("@/pages/AccountGroups"), landmark: "button-create-group" },
  { name: "AccountMigration", load: () => import("@/pages/AccountMigration"), landmark: "select-source-company" },
  {
    name: "AiValidationPage",
    load: () => import("@/pages/AiValidationPage"),
    landmark: "select-validation-type-trigger",
  },
  { name: "Analytics", load: () => import("@/pages/Analytics"), landmark: "select-analytics-section" },
  { name: "BalanceRepair", load: () => import("@/pages/BalanceRepair"), landmark: "button-scan-balances" },
  {
    name: "BaleProductsBilingual",
    load: () => import("@/pages/BaleProductsBilingual"),
    landmark: "select-translation-status",
    showsRows: true,
  },
  { name: "Bales", load: () => import("@/pages/Bales"), landmark: "button-add-bale" },
  { name: "BarcodeManager", load: () => import("@/pages/BarcodeManager"), landmark: "button-upload" },
  { name: "Chat", load: () => import("@/pages/Chat"), landmark: "chat-page" },
  { name: "ChatbotSettings", load: () => import("@/pages/ChatbotSettings"), landmark: "tab-users" },
  { name: "CompanyDataReset", load: () => import("@/pages/CompanyDataReset"), landmark: "select-company" },
  {
    name: "CompanyTransfer",
    load: () => import("@/pages/CompanyTransfer"),
    landmark: "rule-section-PROPERTIES",
    showsRows: true,
  },
  { name: "ConflictCenter", load: () => import("@/pages/ConflictCenter"), landmark: "btn-refresh-conflicts" },
  { name: "CustomerInvoiceCreate", load: () => import("@/pages/CustomerInvoiceCreate"), landmark: "text-bales-header" },
  {
    name: "CustomerInvoiceDetail",
    load: () => import("@/pages/CustomerInvoiceDetail"),
    landmark: "button-back-to-list",
  },
  {
    name: "CustomerInvoices",
    load: () => import("@/pages/CustomerInvoices"),
    landmark: "select-status-filter",
    showsRows: true,
  },
  { name: "Customers", load: () => import("@/pages/Customers"), landmark: "button-create-customer" },
  { name: "ImportCycleDiagnostics", load: () => import("@/pages/ImportCycleDiagnostics"), landmark: "button-refresh" },
  { name: "IntercompanyLinks", load: () => import("@/pages/IntercompanyLinks"), landmark: "button-create-link" },
  {
    name: "IntercompanyRequests",
    load: () => import("@/pages/IntercompanyRequests"),
    landmark: "select-trigger-status",
    showsRows: true,
  },
  { name: "InventoryRepair", load: () => import("@/pages/InventoryRepair"), landmark: "button-preview-discrepancies" },
  { name: "LiveSheets", load: () => import("@/pages/LiveSheets"), landmark: "button-add-sheet", showsRows: true },
  { name: "MixBatches", load: () => import("@/pages/MixBatches"), landmark: "button-report" },
  { name: "MySettings", load: () => import("@/pages/MySettings"), landmark: "select-date-format" },
  { name: "NetProfitReport", load: () => import("@/pages/NetProfitReport"), landmark: "select-period" },
  {
    name: "NotificationSettings",
    load: () => import("@/pages/NotificationSettings"),
    landmark: "card-event-LOADING_STARTED",
  },
  { name: "OffloadDetail", load: () => import("@/pages/OffloadDetail"), landmark: "button-back-offload" },
  {
    name: "OptionalVouchers",
    load: () => import("@/pages/OptionalVouchers"),
    landmark: "select-voucher-type",
    showsRows: true,
  },
  { name: "OrphanedRecords", load: () => import("@/pages/OrphanedRecords"), landmark: "heading-unbalanced-vouchers" },
  { name: "POImport", load: () => import("@/pages/POImport"), landmark: "button-download-template" },
  {
    name: "POSItemReplacement",
    load: () => import("@/pages/POSItemReplacement"),
    landmark: "select-pos-replacement-location",
  },
  { name: "PressingBales", load: () => import("@/pages/PressingBales"), landmark: "text-pressing-badge" },
  { name: "SalesReportComparison", load: () => import("@/pages/SalesReportComparison"), landmark: "input-start-date" },
  {
    name: "StockInSalesReportComparison",
    load: () => import("@/pages/StockInSalesReportComparison"),
    landmark: "period-filter-stock-in-sales-comparison",
  },
  { name: "StockItemVouchers", load: () => import("@/pages/StockItemVouchers"), landmark: "period-filter" },
  {
    name: "StockTransferImport",
    load: () => import("@/pages/StockTransferImport"),
    landmark: "button-download-template",
  },
  { name: "StockTransfers", load: () => import("@/pages/StockTransfers"), landmark: "period-filter-dropdown" },
  { name: "TransporterStatement", load: () => import("@/pages/TransporterStatement"), landmark: "trigger-transporter" },
  { name: "TabSummary", load: () => import("@/pages/git-mockup/TabSummary"), landmark: "summary-mode-selector" },
  {
    name: "TabTruckLocation",
    load: () => import("@/pages/git-mockup/TabTruckLocation"),
    landmark: "btn-truck-mode-session",
  },
  { name: "TabWhatsApp", load: () => import("@/pages/git-mockup/TabWhatsApp"), landmark: "btn-wa-mode-session" },
  {
    name: "UpdateCategoriesTab",
    load: () => import("@/pages/import-stock-items/UpdateCategoriesTab"),
    landmark: "button-download-categories-template",
  },
  { name: "AdvancesTab", load: () => import("@/pages/payroll/AdvancesTab"), landmark: "select-worker-filter" },
  {
    name: "BaleProductImages",
    load: () => import("@/pages/factory/BaleProductImages"),
    landmark: "bale-product-images-page",
    factory: true,
    showsRows: true,
  },
  {
    name: "BaleStockEntry",
    load: () => import("@/pages/factory/BaleStockEntry"),
    landmark: "button-label-print-settings",
    factory: true,
  },
  {
    name: "CustomerLoading",
    load: () => import("@/pages/factory/CustomerLoading"),
    landmark: "customer-loading-page",
    factory: true,
  },
  {
    name: "CustomerLogosSettings",
    load: () => import("@/pages/factory/CustomerLogosSettings"),
    landmark: "select-logo-customer",
    factory: true,
  },
  {
    name: "DailyScan",
    load: () => import("@/pages/factory/DailyScan"),
    landmark: "button-daily-scan-prev-day",
    factory: true,
  },
  {
    name: "FactoryBaleRelabeling",
    load: () => import("@/pages/factory/FactoryBaleRelabeling"),
    landmark: "factory-bale-relabeling-page",
    factory: true,
  },
  {
    name: "FactoryBrokerVisualStatement",
    load: () => import("@/pages/factory/FactoryBrokerVisualStatement"),
    landmark: "select-broker",
    factory: true,
  },
  {
    name: "FactoryContainerCreate",
    load: () => import("@/pages/factory/FactoryContainerCreate"),
    landmark: "input-container-number",
    factory: true,
  },
  {
    name: "FactoryContainers",
    load: () => import("@/pages/factory/FactoryContainers"),
    landmark: "button-view-list",
    factory: true,
  },
  {
    name: "FactoryDispatchBatches",
    load: () => import("@/pages/factory/FactoryDispatchBatches"),
    landmark: "button-tab-list",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryEmployeeAdvancesTab",
    load: () => import("@/pages/factory/FactoryEmployeeAdvancesTab"),
    landmark: "select-emp-filter",
    factory: true,
  },
  {
    name: "FactoryEmployeeBonusesTab",
    load: () => import("@/pages/factory/FactoryEmployeeBonusesTab"),
    landmark: "select-bonus-emp-filter",
    factory: true,
  },
  {
    name: "FactoryEmployeePayrollTab",
    load: () => import("@/pages/factory/FactoryEmployeePayrollTab"),
    landmark: "button-run-payroll",
    factory: true,
  },
  {
    name: "FactoryEmployeeWithdrawalsTab",
    load: () => import("@/pages/factory/FactoryEmployeeWithdrawalsTab"),
    landmark: "button-withdraw-single",
    factory: true,
  },
  {
    name: "FactoryEmployees",
    load: () => import("@/pages/factory/FactoryEmployees"),
    landmark: "input-employee-search",
    factory: true,
  },
  {
    name: "FactoryLocationInventoryMockup",
    load: () => import("@/pages/factory/FactoryLocationInventoryMockup"),
    landmark: "mockup-button-back",
    factory: true,
  },
  {
    name: "FactoryNetProfitAnalytics",
    load: () => import("@/pages/factory/FactoryNetProfitAnalytics"),
    landmark: "select-period",
    factory: true,
  },
  {
    name: "FactoryPendingInvoices",
    load: () => import("@/pages/factory/FactoryPendingInvoices"),
    landmark: "filter-tabs",
    factory: true,
  },
  {
    name: "FactoryPendingLoadings",
    load: () => import("@/pages/factory/FactoryPendingLoadings"),
    landmark: "card-load-1",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryPriceList",
    load: () => import("@/pages/factory/FactoryPriceList"),
    landmark: "input-price-upload-file",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryStockAllocationV3",
    load: () => import("@/pages/factory/FactoryStockAllocationV3"),
    landmark: "button-v3-tab-overview",
    factory: true,
  },
  {
    name: "FactoryStockOTW",
    load: () => import("@/pages/factory/FactoryStockOTW"),
    landmark: "badge-total-count",
    factory: true,
  },
  {
    name: "FactorySupplierReport",
    load: () => import("@/pages/factory/FactorySupplierReport"),
    landmark: "input-start-date",
    factory: true,
  },
  {
    name: "FactorySupplierStatement",
    load: () => import("@/pages/factory/FactorySupplierStatement"),
    landmark: "select-supplier",
    factory: true,
  },
  {
    name: "FactoryTransporters",
    load: () => import("@/pages/factory/FactoryTransporters"),
    landmark: "button-add-transporter",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryWaste",
    load: () => import("@/pages/factory/FactoryWaste"),
    landmark: "input-date-from",
    factory: true,
  },
  {
    name: "FactoryWorkerBonusesTab",
    load: () => import("@/pages/factory/FactoryWorkerBonusesTab"),
    landmark: "select-worker-filter",
    factory: true,
  },
  {
    name: "LabelBannersSettings",
    load: () => import("@/pages/factory/LabelBannersSettings"),
    landmark: "card-add-color",
    factory: true,
  },
  {
    name: "MergeBaleProducts",
    load: () => import("@/pages/factory/MergeBaleProducts"),
    landmark: "input-merge-search",
    factory: true,
    showsRows: true,
  },
  {
    name: "ProductionPlannerDialog",
    load: () => import("@/pages/factory/ProductionPlannerDialog"),
    landmark: "button-production-planner",
    factory: true,
  },
  {
    name: "ProductionRawStock",
    load: () => import("@/pages/factory/ProductionRawStock"),
    landmark: "production-raw-stock-page",
    factory: true,
    showsRows: true,
  },
  {
    name: "ProformaAddLine",
    load: () => import("@/pages/factory/ProformaAddLine"),
    landmark: "button-autosave-toggle",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryBaleProductAllMonths",
    load: () => import("@/pages/factory/bale-product-history/FactoryBaleProductAllMonths"),
    landmark: "text-bale-count",
    factory: true,
  },
  {
    name: "FactoryBaleProductMonthDetail",
    load: () => import("@/pages/factory/bale-product-history/FactoryBaleProductMonthDetail"),
    landmark: "text-bale-count",
    factory: true,
  },
  {
    name: "ProductionPositionsTab",
    load: () => import("@/pages/factory/bale-stock-entry/ProductionPositionsTab"),
    landmark: "button-new-production-position",
    factory: true,
    showsRows: true,
  },
  {
    name: "WorkerCategoriesTab",
    load: () => import("@/pages/factory/bale-stock-entry/WorkerCategoriesTab"),
    landmark: "button-new-category",
    factory: true,
    showsRows: true,
  },
  {
    name: "ContainerListView",
    load: () => import("@/pages/factory/factory-containers/ContainerListView"),
    landmark: "input-search-containers",
    factory: true,
  },
  {
    name: "DeductionsView",
    load: () => import("@/pages/factory/factoryadvancestab/components/DeductionsView"),
    landmark: "button-add-deduction",
    factory: true,
  },
  {
    name: "PerWorkerView",
    load: () => import("@/pages/factory/factoryattendance/components/PerWorkerView"),
    landmark: "select-worker",
    factory: true,
  },
  {
    name: "BaleImport",
    load: () => import("@/pages/factory/factoryimport/components/BaleImport"),
    landmark: "card-upload-bales",
    factory: true,
  },
  {
    name: "OpeningStockImport",
    load: () => import("@/pages/factory/factoryimport/components/OpeningStockImport"),
    landmark: "card-upload-opening-raw-stock",
    factory: true,
  },
  {
    name: "RawStockImport",
    load: () => import("@/pages/factory/factoryimport/components/RawStockImport"),
    landmark: "card-upload-raw-stock",
    factory: true,
  },
  {
    name: "SupplierImport",
    load: () => import("@/pages/factory/factoryimport/components/SupplierImport"),
    landmark: "card-upload-suppliers",
    factory: true,
  },
  {
    name: "ContainerPlannerCustomerAllocation",
    load: () => import("@/pages/factory/factorystockallocationv5/components/ContainerPlannerCustomerAllocation"),
    landmark: "container-plan-allocations-error",
    factory: true,
  },
  {
    name: "ContainerPlannerSavedPlans",
    load: () => import("@/pages/factory/factorystockallocationv5/components/ContainerPlannerSavedPlans"),
    landmark: "container-planner-phase-2",
    factory: true,
  },
  {
    name: "ContainerPlannerShipments",
    load: () => import("@/pages/factory/factorystockallocationv5/components/ContainerPlannerShipments"),
    landmark: "container-plan-shipments-error",
    factory: true,
  },
  {
    name: "ProductComparisonCharts",
    load: () => import("@/pages/factory/productcomparison/ProductComparisonCharts"),
    landmark: "factory-product-comparison",
    factory: true,
  },
  {
    name: "RawStockTable",
    load: () => import("@/pages/factory/production-raw-stock/RawStockTable"),
    landmark: "raw-stock-mobile-list",
    factory: true,
  },
  {
    name: "POSContainerTracking",
    load: () => import("@/pages/pos/POSContainerTracking"),
    landmark: "pos-container-tracking-page",
  },
  { name: "POSCustomers", load: () => import("@/pages/pos/POSCustomers"), landmark: "button-create-customer" },
  { name: "PosTransferOrders", load: () => import("@/pages/pos/PosTransferOrders"), landmark: "input-date-filter" },
  {
    name: "AgentDutyWhatsAppSection",
    load: () => import("@/pages/settings/AgentDutyWhatsAppSection"),
    landmark: "button-toggle-agent-duty-wa",
  },
  { name: "ApprovalsPage", load: () => import("@/pages/settings/ApprovalsPage"), landmark: "tab-approvals-mine" },
  {
    name: "BusinessAlertsPage",
    load: () => import("@/pages/settings/BusinessAlertsPage"),
    landmark: "select-alert-status-filter",
  },
  {
    name: "CompaniesTab",
    load: () => import("@/pages/settings/CompaniesTab"),
    landmark: "button-add-company",
    showsRows: true,
  },
  {
    name: "ContainersWhatsAppSection",
    load: () => import("@/pages/settings/ContainersWhatsAppSection"),
    landmark: "button-toggle-containers-wa",
  },
  {
    name: "ExportAccountsSection",
    load: () => import("@/pages/settings/ExportAccountsSection"),
    landmark: "badge-selected-count",
    showsRows: true,
  },
  {
    name: "NetPositionExportSection",
    load: () => import("@/pages/settings/NetPositionExportSection"),
    landmark: "section-np-export",
  },
  {
    name: "PosWhatsAppSection",
    load: () => import("@/pages/settings/PosWhatsAppSection"),
    landmark: "badge-pos-api-status",
    showsRows: true,
  },
  { name: "PriceGroupsTab", load: () => import("@/pages/settings/PriceGroupsTab"), landmark: "button-add-price-group" },
  {
    name: "RemoteSupportWatchDialog",
    load: () => import("@/pages/settings/RemoteSupportWatchDialog"),
    landmark: "dialog-watch-user",
  },
  {
    name: "SettingsHubPage",
    load: () => import("@/pages/settings/SettingsHubPage"),
    landmark: "input-settings-search",
  },
  {
    name: "TransferWhatsAppSection",
    load: () => import("@/pages/settings/TransferWhatsAppSection"),
    landmark: "button-toggle-transfer-wa",
  },
  { name: "WatchUserDialog", load: () => import("@/pages/settings/WatchUserDialog"), landmark: "dialog-watch-user" },
  {
    name: "WhatsAppExportSection",
    load: () => import("@/pages/settings/WhatsAppExportSection"),
    landmark: "button-whatsapp-section-toggle",
  },
  {
    name: "BulkMergeStockItemsCard",
    load: () => import("@/pages/settings/datatoolstab/components/BulkMergeStockItemsCard"),
    landmark: "button-bulk-merge-template",
  },
  {
    name: "MergeStockItemsCard",
    load: () => import("@/pages/settings/datatoolstab/components/MergeStockItemsCard"),
    landmark: "merge-keep-item",
  },
  {
    name: "SpOpeningStock",
    load: () => import("@/pages/sp/SpOpeningStock"),
    landmark: "input-sp-opn-article",
    showsRows: true,
  },
  { name: "SpReports", load: () => import("@/pages/sp/SpReports"), landmark: "tabs-sp-reports" },
  { name: "SpSetupPanel", load: () => import("@/pages/sp/SpSetupPanel"), landmark: "button-sp-setup" },
  {
    name: "FreshStartHadiPaymentPanel",
    load: () => import("@/pages/sp/golden-coast/FreshStartHadiPaymentPanel"),
    landmark: "input-gc-fs-hadi-amount",
  },
  {
    name: "HadiProceedsRemittancePanel",
    load: () => import("@/pages/sp/golden-coast/HadiProceedsRemittancePanel"),
    landmark: "input-gc-p16-remit-amount",
  },
  {
    name: "StockAdjustmentForm",
    load: () => import("@/pages/vouchers/StockAdjustmentForm"),
    landmark: "select-adjustment-location",
    showsRows: true,
  },
  {
    name: "StockTransferForm",
    load: () => import("@/pages/vouchers/StockTransferForm"),
    landmark: "select-destination-location",
    showsRows: true,
  },
  { name: "StockTransferOrder", load: () => import("@/pages/StockTransferOrder"), landmark: "select-destination" },
  { name: "StockEntryHistory", load: () => import("@/pages/StockEntryHistory"), landmark: "button-view-condensed" },
  { name: "StockItems", load: () => import("@/pages/StockItems"), landmark: "button-add-item", showsRows: true },
  { name: "StockOTW", load: () => import("@/pages/StockOTW"), landmark: "button-export-excel", showsRows: true },
  { name: "ImportStockItems", load: () => import("@/pages/ImportStockItems"), landmark: "button-back" },
  { name: "AccountsLegacy", load: () => import("@/pages/AccountsLegacy"), landmark: "button-create-account" },
  {
    name: "SalesReportDetail",
    load: () => import("@/pages/SalesReportDetail"),
    landmark: "button-back-to-sales-report",
  },
  {
    name: "PendingInvoiceVerify",
    load: () => import("@/pages/PendingInvoiceVerify"),
    landmark: "text-total-loaded-bales",
  },
  {
    name: "SpreadsheetEditor",
    load: () => import("@/pages/SpreadsheetEditor"),
    landmark: "input-upload-xlsx",
    showsRows: true,
  },
  {
    name: "FactorySuppliers",
    load: () => import("@/pages/factory/FactorySuppliers"),
    landmark: "select-supplier-filter",
    factory: true,
  },
  {
    name: "FactoryPendingInvoiceVerify",
    load: () => import("@/pages/factory/FactoryPendingInvoiceVerify"),
    landmark: "text-total-loaded-bales",
    factory: true,
  },
  {
    name: "FactoryLocationInventory",
    load: () => import("@/pages/factory/FactoryLocationInventory"),
    landmark: "button-export-all-locations",
    factory: true,
    showsRows: true,
  },
  {
    name: "GroundScan",
    load: () => import("@/pages/factory/GroundScan"),
    landmark: "input-ground-scan",
    factory: true,
  },
  {
    name: "FactoryPOS",
    load: () => import("@/pages/factory/FactoryPOS"),
    landmark: "button-complete-sale",
    factory: true,
  },
  {
    name: "FactoryStatusBuilder",
    load: () => import("@/pages/factory/FactoryStatusBuilder"),
    landmark: "sb-button-export-excel",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryProformas",
    load: () => import("@/pages/factory/FactoryProformas"),
    landmark: "select-customer",
    factory: true,
  },
  {
    name: "FactorySettings",
    load: () => import("@/pages/factory/FactorySettings"),
    landmark: "button-enable-all",
    factory: true,
  },
  {
    name: "WipersReEntry",
    load: () => import("@/pages/factory/WipersReEntry"),
    landmark: "tab-wipers-re-entry",
    factory: true,
  },
  { name: "ContainerLoadingScan", load: () => import("@/pages/ContainerLoadingScan"), landmark: "text-bales-header" },
  {
    name: "BaleProducts",
    load: () => import("@/pages/BaleProducts"),
    landmark: "button-create-product",
    showsRows: true,
  },
  {
    name: "FactoryInvoiceCreate",
    load: () => import("@/pages/factory/FactoryInvoiceCreate"),
    landmark: "badge-bale-count",
    factory: true,
  },
  {
    name: "FactoryContainerLoadingScan",
    load: () => import("@/pages/factory/FactoryContainerLoadingScan"),
    landmark: "button-start-loading",
    factory: true,
  },
  {
    name: "FactoryShippingContainers",
    load: () => import("@/pages/factory/FactoryShippingContainers"),
    landmark: "button-track-all-eta",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryInvoices",
    load: () => import("@/pages/factory/FactoryInvoices"),
    landmark: "filter-tabs",
    factory: true,
  },
  {
    name: "WasteDispatch",
    load: () => import("@/pages/factory/WasteDispatch"),
    landmark: "input-scan-ref",
    factory: true,
  },
  {
    name: "StockEntryTab",
    load: () => import("@/pages/factory/bale-stock-entry/StockEntryTab"),
    landmark: "input-scan-product",
    factory: true,
  },
  {
    name: "RemoveFromStockTab",
    load: () => import("@/pages/factory/bale-stock-entry/RemoveFromStockTab"),
    landmark: "button-remove-selected",
    factory: true,
  },
  {
    name: "POSPriceList",
    load: () => import("@/pages/pos/POSPriceList"),
    landmark: "button-mobile-location-all",
    showsRows: true,
  },
  { name: "POSImport", load: () => import("@/pages/pos/POSImport"), landmark: "button-validate" },
  {
    name: "ContainerVerification",
    load: () => import("@/pages/ContainerVerification"),
    landmark: "button-import-loaded",
  },
  { name: "SupplierProformas", load: () => import("@/pages/SupplierProformas"), landmark: "button-create-proforma" },
  { name: "DataToolsTab", load: () => import("@/pages/settings/DataToolsTab"), landmark: "button-open-stock-import" },
  { name: "ProductionBales", load: () => import("@/pages/ProductionBales"), landmark: "badge-finalize-mode" },
  { name: "CustomerProformas", load: () => import("@/pages/CustomerProformas"), landmark: "select-customer" },
  { name: "CombinedInventory", load: () => import("@/pages/CombinedInventory"), landmark: "button-refresh-inventory" },
  { name: "Agents", load: () => import("@/pages/Agents"), landmark: "button-add-agent", showsRows: true },
  {
    name: "FactoryInsurance",
    load: () => import("@/pages/factory/FactoryInsurance"),
    landmark: "button-add-member",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryReprintLabels",
    load: () => import("@/pages/factory/FactoryReprintLabels"),
    landmark: "button-label-print-settings",
    factory: true,
  },
];

const SEEDED_ROW_TEXT = /Name 1|Item 1|Cust 1|Supp 1|CONT1|Desc 1/;

describe("wave 4 populated page mounts", () => {
  beforeEach(() => {
    resetPageState();
    stubSeededFetch();
  });

  for (const { name, load, landmark, factory, showsRows } of PAGES) {
    it(`${name} renders ${landmark}${showsRows ? " and its rows" : ""} with data loaded`, async () => {
      if (factory) {
        pageState.companyType = "factory";
        pageState.appMode = "factory";
      }
      const module = await load();
      const Component = (module.default ??
        module[name] ??
        Object.values(module).find((value) => typeof value === "function")) as React.ComponentType;

      renderWithProviders(<Component />);
      expect(await screen.findByTestId(landmark)).toBeInTheDocument();
      if (showsRows) {
        await vi.waitFor(() => expect(document.body.textContent).toMatch(SEEDED_ROW_TEXT));
      }
    });
  }
});
