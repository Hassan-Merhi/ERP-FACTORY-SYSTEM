/**
 * Wave 4 — every remaining zero-coverage page mounts and shows its own control.
 *
 * `renders-uncovered-pages.test.tsx` did this for the twenty biggest pages.
 * This suite extends the same contract to the rest of the pages and
 * page-level components that no test had ever imported: each one mounts
 * under the shared deterministic context mocks (`pageMocks.tsx`) and must show
 * a control only that page has — not a generic page title or the keyboard
 * cursor buttons every page carries. A page that mounted into its error state,
 * or whose landmark was renamed or dropped, fails here.
 *
 * Landmarks were read off the rendered DOM of each page and are the first
 * page-specific `data-testid` it shows with empty API data. Factory pages mount
 * with a factory company and factory app mode, as they do behind the factory
 * route guard.
 */
import React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

interface PageCase {
  name: string;
  load: () => Promise<any>;
  landmark: string;
  factory?: boolean;
}

const PAGES: PageCase[] = [
  // Shared components.
  {
    name: "AdvancedRestrictionsPanel",
    load: () => import("@/components/AdvancedRestrictionsPanel"),
    landmark: "input-permission-search",
  },
  {
    name: "GradesCategoriesManager",
    load: () => import("@/components/GradesCategoriesManager"),
    landmark: "button-export-grade-category",
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

  // ERP.
  { name: "AICommandCenter", load: () => import("@/pages/AICommandCenter"), landmark: "textarea-instruction" },
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
  },
  { name: "Bales", load: () => import("@/pages/Bales"), landmark: "button-add-bale" },
  { name: "BarcodeManager", load: () => import("@/pages/BarcodeManager"), landmark: "button-upload" },
  { name: "BatchDetail", load: () => import("@/pages/BatchDetail"), landmark: "button-edit-batch" },
  { name: "Chat", load: () => import("@/pages/Chat"), landmark: "chat-page" },
  { name: "ChatbotSettings", load: () => import("@/pages/ChatbotSettings"), landmark: "tab-users" },
  { name: "CompanyDataReset", load: () => import("@/pages/CompanyDataReset"), landmark: "select-company" },
  { name: "CompanyTransfer", load: () => import("@/pages/CompanyTransfer"), landmark: "rule-section-PROPERTIES" },
  { name: "ConflictCenter", load: () => import("@/pages/ConflictCenter"), landmark: "btn-refresh-conflicts" },
  { name: "CustomerInvoiceCreate", load: () => import("@/pages/CustomerInvoiceCreate"), landmark: "text-bales-header" },
  {
    name: "CustomerInvoiceDetail",
    load: () => import("@/pages/CustomerInvoiceDetail"),
    landmark: "button-back-to-list",
  },
  { name: "CustomerInvoices", load: () => import("@/pages/CustomerInvoices"), landmark: "select-status-filter" },
  { name: "Customers", load: () => import("@/pages/Customers"), landmark: "button-create-customer" },
  { name: "ImportCycleDiagnostics", load: () => import("@/pages/ImportCycleDiagnostics"), landmark: "button-refresh" },
  { name: "IntercompanyLinks", load: () => import("@/pages/IntercompanyLinks"), landmark: "button-create-link" },
  {
    name: "IntercompanyRequests",
    load: () => import("@/pages/IntercompanyRequests"),
    landmark: "select-trigger-status",
  },
  { name: "InventoryRepair", load: () => import("@/pages/InventoryRepair"), landmark: "button-preview-discrepancies" },
  { name: "LiveSheets", load: () => import("@/pages/LiveSheets"), landmark: "button-add-sheet" },
  { name: "MixBatches", load: () => import("@/pages/MixBatches"), landmark: "button-report" },
  { name: "MySettings", load: () => import("@/pages/MySettings"), landmark: "select-date-format" },
  { name: "NetProfitReport", load: () => import("@/pages/NetProfitReport"), landmark: "select-period" },
  {
    name: "NotificationSettings",
    load: () => import("@/pages/NotificationSettings"),
    landmark: "card-event-LOADING_STARTED",
  },
  { name: "OffloadDetail", load: () => import("@/pages/OffloadDetail"), landmark: "button-back-offload" },
  { name: "OptionalVouchers", load: () => import("@/pages/OptionalVouchers"), landmark: "select-voucher-type" },
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
  { name: "TestDataImport", load: () => import("@/pages/TestDataImport"), landmark: "input-test-date" },
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
  { name: "GroupsTab", load: () => import("@/pages/payroll/GroupsTab"), landmark: "button-create-worker-group" },

  // Factory.
  {
    name: "BaleProductImages",
    load: () => import("@/pages/factory/BaleProductImages"),
    landmark: "bale-product-images-page",
    factory: true,
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
    landmark: "button-start-new",
    factory: true,
  },
  {
    name: "FactoryPriceList",
    load: () => import("@/pages/factory/FactoryPriceList"),
    landmark: "input-price-upload-file",
    factory: true,
  },
  {
    name: "FactoryProfitability",
    load: () => import("@/pages/factory/FactoryProfitability"),
    landmark: "input-date-from",
    factory: true,
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
  },
  {
    name: "FactoryUsers",
    load: () => import("@/pages/factory/FactoryUsers"),
    landmark: "button-add-factory-user",
    factory: true,
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
  },
  {
    name: "ProductionSummary",
    load: () => import("@/pages/factory/ProductionSummary"),
    landmark: "text-total-bales",
    factory: true,
  },
  {
    name: "ProformaAddLine",
    load: () => import("@/pages/factory/ProformaAddLine"),
    landmark: "button-autosave-toggle",
    factory: true,
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
  },
  {
    name: "WorkerCategoriesTab",
    load: () => import("@/pages/factory/bale-stock-entry/WorkerCategoriesTab"),
    landmark: "button-new-category",
    factory: true,
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

  // POS and retail.
  {
    name: "POSContainerTracking",
    load: () => import("@/pages/pos/POSContainerTracking"),
    landmark: "pos-container-tracking-page",
  },
  { name: "POSCustomers", load: () => import("@/pages/pos/POSCustomers"), landmark: "button-create-customer" },
  { name: "POSDaybook", load: () => import("@/pages/pos/POSDaybook"), landmark: "pos-daybook-period-filter" },
  { name: "PosTransferOrders", load: () => import("@/pages/pos/PosTransferOrders"), landmark: "input-date-filter" },

  // Settings.
  {
    name: "ActiveSessionsTab",
    load: () => import("@/pages/settings/ActiveSessionsTab"),
    landmark: "button-refresh-sessions",
  },
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
  { name: "CompaniesTab", load: () => import("@/pages/settings/CompaniesTab"), landmark: "button-add-company" },
  {
    name: "ContainersWhatsAppSection",
    load: () => import("@/pages/settings/ContainersWhatsAppSection"),
    landmark: "button-toggle-containers-wa",
  },
  {
    name: "ExportAccountsSection",
    load: () => import("@/pages/settings/ExportAccountsSection"),
    landmark: "badge-selected-count",
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

  // Supplier Partner and properties.
  { name: "SpOpeningStock", load: () => import("@/pages/sp/SpOpeningStock"), landmark: "input-sp-opn-article" },
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
];

describe("wave 4 page mounts", () => {
  beforeEach(() => {
    resetPageState();
    stubFetchRoutes();
  });

  for (const { name, load, landmark, factory } of PAGES) {
    it(`${name} mounts and renders ${landmark}`, async () => {
      if (factory) {
        pageState.companyType = "factory";
        pageState.appMode = "factory";
      }
      const module = await load();
      const Component = (module.default ??
        module[name] ??
        Object.values(module).find((value) => typeof value === "function")) as React.ComponentType;
      expect(Component, `${name} must export a component`).toBeTypeOf("function");

      renderWithProviders(<Component />);
      expect(await screen.findByTestId(landmark)).toBeInTheDocument();
    });
  }
});
