/**
 * Wave 4 — press every button on every populated page.
 *
 * The mount suites prove pages render; most dialogs, tab panels, menus and
 * handlers only run when a control is used. This sweep mounts each page with
 * seeded rows (same payload as wave4-populated-page-mounts) and presses each
 * of its first 30 test-id'd buttons in turn, closing whatever opened with
 * Escape. A handler that throws, a dialog that crashes on real data, or an
 * async failure surfaced as an uncaught error fails the page's case.
 *
 * Downloads, printing and new windows are stubbed so export buttons run their
 * workbook/PDF code without leaving the test. Pages whose buttons need data
 * shapes the generic seed cannot provide are covered by their own behaviour
 * suites instead of being listed here.
 */
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubSeededFetch } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

const MAX_BUTTONS = 30;

const PAGES: Array<{
  name: string;
  load: () => Promise<any>;
  factory?: boolean;
  /** Payloads for endpoints whose rows nest the record (see stubSeededFetch). */
  seedRoutes?: Record<string, () => unknown>;
}> = [
  { name: "AdvancedRestrictionsPanel", load: () => import("@/components/AdvancedRestrictionsPanel") },
  { name: "GradesCategoriesManager", load: () => import("@/components/GradesCategoriesManager") },
  { name: "NotificationsCenter", load: () => import("@/components/NotificationsCenter") },
  { name: "StockNameUpdateImport", load: () => import("@/components/StockNameUpdateImport") },
  { name: "AccountGroups", load: () => import("@/pages/AccountGroups") },
  { name: "AccountMigration", load: () => import("@/pages/AccountMigration") },
  { name: "AiValidationPage", load: () => import("@/pages/AiValidationPage") },
  { name: "BaleProductsBilingual", load: () => import("@/pages/BaleProductsBilingual") },
  { name: "Bales", load: () => import("@/pages/Bales") },
  { name: "BarcodeManager", load: () => import("@/pages/BarcodeManager") },
  { name: "Chat", load: () => import("@/pages/Chat") },
  { name: "CompanyDataReset", load: () => import("@/pages/CompanyDataReset") },
  { name: "CompanyTransfer", load: () => import("@/pages/CompanyTransfer") },
  { name: "ConflictCenter", load: () => import("@/pages/ConflictCenter") },
  { name: "CustomerInvoiceCreate", load: () => import("@/pages/CustomerInvoiceCreate") },
  { name: "CustomerInvoiceDetail", load: () => import("@/pages/CustomerInvoiceDetail") },
  { name: "CustomerInvoices", load: () => import("@/pages/CustomerInvoices") },
  { name: "Customers", load: () => import("@/pages/Customers") },
  { name: "ImportCycleDiagnostics", load: () => import("@/pages/ImportCycleDiagnostics") },
  { name: "IntercompanyLinks", load: () => import("@/pages/IntercompanyLinks") },
  { name: "IntercompanyRequests", load: () => import("@/pages/IntercompanyRequests") },
  { name: "LiveSheets", load: () => import("@/pages/LiveSheets") },
  { name: "MixBatches", load: () => import("@/pages/MixBatches") },
  { name: "MySettings", load: () => import("@/pages/MySettings") },
  { name: "NetProfitReport", load: () => import("@/pages/NetProfitReport") },
  { name: "OffloadDetail", load: () => import("@/pages/OffloadDetail") },
  { name: "OptionalVouchers", load: () => import("@/pages/OptionalVouchers") },
  { name: "OrphanedRecords", load: () => import("@/pages/OrphanedRecords") },
  { name: "POImport", load: () => import("@/pages/POImport") },
  { name: "POSItemReplacement", load: () => import("@/pages/POSItemReplacement") },
  { name: "SalesReportComparison", load: () => import("@/pages/SalesReportComparison") },
  { name: "StockInSalesReportComparison", load: () => import("@/pages/StockInSalesReportComparison") },
  { name: "StockItemVouchers", load: () => import("@/pages/StockItemVouchers") },
  { name: "StockTransferImport", load: () => import("@/pages/StockTransferImport") },
  { name: "StockTransfers", load: () => import("@/pages/StockTransfers") },
  { name: "TransporterStatement", load: () => import("@/pages/TransporterStatement") },
  { name: "TabSummary", load: () => import("@/pages/git-mockup/TabSummary") },
  { name: "TabTruckLocation", load: () => import("@/pages/git-mockup/TabTruckLocation") },
  { name: "UpdateCategoriesTab", load: () => import("@/pages/import-stock-items/UpdateCategoriesTab") },
  { name: "AdvancesTab", load: () => import("@/pages/payroll/AdvancesTab") },
  { name: "BaleProductImages", load: () => import("@/pages/factory/BaleProductImages"), factory: true },
  { name: "CustomerLoading", load: () => import("@/pages/factory/CustomerLoading"), factory: true },
  { name: "CustomerLogosSettings", load: () => import("@/pages/factory/CustomerLogosSettings"), factory: true },
  { name: "FactoryBaleRelabeling", load: () => import("@/pages/factory/FactoryBaleRelabeling"), factory: true },
  { name: "FactoryContainerCreate", load: () => import("@/pages/factory/FactoryContainerCreate"), factory: true },
  { name: "FactoryContainers", load: () => import("@/pages/factory/FactoryContainers"), factory: true },
  { name: "FactoryDispatchBatches", load: () => import("@/pages/factory/FactoryDispatchBatches"), factory: true },
  {
    name: "FactoryEmployeeAdvancesTab",
    load: () => import("@/pages/factory/FactoryEmployeeAdvancesTab"),
    factory: true,
  },
  { name: "FactoryEmployeeBonusesTab", load: () => import("@/pages/factory/FactoryEmployeeBonusesTab"), factory: true },
  { name: "FactoryEmployeePayrollTab", load: () => import("@/pages/factory/FactoryEmployeePayrollTab"), factory: true },
  {
    name: "FactoryEmployeeWithdrawalsTab",
    load: () => import("@/pages/factory/FactoryEmployeeWithdrawalsTab"),
    factory: true,
  },
  { name: "FactoryEmployees", load: () => import("@/pages/factory/FactoryEmployees"), factory: true },
  {
    name: "FactoryLocationInventoryMockup",
    load: () => import("@/pages/factory/FactoryLocationInventoryMockup"),
    factory: true,
  },
  { name: "FactoryNetProfitAnalytics", load: () => import("@/pages/factory/FactoryNetProfitAnalytics"), factory: true },
  { name: "FactoryPendingInvoices", load: () => import("@/pages/factory/FactoryPendingInvoices"), factory: true },
  { name: "FactoryPendingLoadings", load: () => import("@/pages/factory/FactoryPendingLoadings"), factory: true },
  { name: "FactoryPriceList", load: () => import("@/pages/factory/FactoryPriceList"), factory: true },
  { name: "FactoryStockAllocationV3", load: () => import("@/pages/factory/FactoryStockAllocationV3"), factory: true },
  { name: "FactoryStockOTW", load: () => import("@/pages/factory/FactoryStockOTW"), factory: true },
  { name: "FactorySupplierReport", load: () => import("@/pages/factory/FactorySupplierReport"), factory: true },
  { name: "FactorySupplierStatement", load: () => import("@/pages/factory/FactorySupplierStatement"), factory: true },
  { name: "FactoryTransporters", load: () => import("@/pages/factory/FactoryTransporters"), factory: true },
  { name: "FactoryWaste", load: () => import("@/pages/factory/FactoryWaste"), factory: true },
  { name: "FactoryWorkerBonusesTab", load: () => import("@/pages/factory/FactoryWorkerBonusesTab"), factory: true },
  { name: "LabelBannersSettings", load: () => import("@/pages/factory/LabelBannersSettings"), factory: true },
  { name: "MergeBaleProducts", load: () => import("@/pages/factory/MergeBaleProducts"), factory: true },
  { name: "ProductionRawStock", load: () => import("@/pages/factory/ProductionRawStock"), factory: true },
  { name: "ProformaAddLine", load: () => import("@/pages/factory/ProformaAddLine"), factory: true },
  {
    name: "FactoryBaleProductAllMonths",
    load: () => import("@/pages/factory/bale-product-history/FactoryBaleProductAllMonths"),
    factory: true,
  },
  {
    name: "FactoryBaleProductMonthDetail",
    load: () => import("@/pages/factory/bale-product-history/FactoryBaleProductMonthDetail"),
    factory: true,
  },
  {
    name: "ProductionPositionsTab",
    load: () => import("@/pages/factory/bale-stock-entry/ProductionPositionsTab"),
    factory: true,
  },
  {
    name: "WorkerCategoriesTab",
    load: () => import("@/pages/factory/bale-stock-entry/WorkerCategoriesTab"),
    factory: true,
  },
  {
    name: "ContainerListView",
    load: () => import("@/pages/factory/factory-containers/ContainerListView"),
    factory: true,
  },
  {
    name: "DeductionsView",
    load: () => import("@/pages/factory/factoryadvancestab/components/DeductionsView"),
    factory: true,
  },
  {
    name: "PerWorkerView",
    load: () => import("@/pages/factory/factoryattendance/components/PerWorkerView"),
    factory: true,
  },
  { name: "BaleImport", load: () => import("@/pages/factory/factoryimport/components/BaleImport"), factory: true },
  {
    name: "OpeningStockImport",
    load: () => import("@/pages/factory/factoryimport/components/OpeningStockImport"),
    factory: true,
  },
  {
    name: "RawStockImport",
    load: () => import("@/pages/factory/factoryimport/components/RawStockImport"),
    factory: true,
  },
  {
    name: "SupplierImport",
    load: () => import("@/pages/factory/factoryimport/components/SupplierImport"),
    factory: true,
  },
  {
    name: "ContainerPlannerSavedPlans",
    load: () => import("@/pages/factory/factorystockallocationv5/components/ContainerPlannerSavedPlans"),
    factory: true,
  },
  {
    name: "ProductComparisonCharts",
    load: () => import("@/pages/factory/productcomparison/ProductComparisonCharts"),
    factory: true,
  },
  { name: "POSContainerTracking", load: () => import("@/pages/pos/POSContainerTracking") },
  { name: "POSCustomers", load: () => import("@/pages/pos/POSCustomers") },
  { name: "PosTransferOrders", load: () => import("@/pages/pos/PosTransferOrders") },
  { name: "AgentDutyWhatsAppSection", load: () => import("@/pages/settings/AgentDutyWhatsAppSection") },
  { name: "ApprovalsPage", load: () => import("@/pages/settings/ApprovalsPage") },
  { name: "BusinessAlertsPage", load: () => import("@/pages/settings/BusinessAlertsPage") },
  { name: "CompaniesTab", load: () => import("@/pages/settings/CompaniesTab") },
  { name: "ContainersWhatsAppSection", load: () => import("@/pages/settings/ContainersWhatsAppSection") },
  { name: "ExportAccountsSection", load: () => import("@/pages/settings/ExportAccountsSection") },
  { name: "NetPositionExportSection", load: () => import("@/pages/settings/NetPositionExportSection") },
  { name: "PosWhatsAppSection", load: () => import("@/pages/settings/PosWhatsAppSection") },
  { name: "PriceGroupsTab", load: () => import("@/pages/settings/PriceGroupsTab") },
  { name: "WhatsAppExportSection", load: () => import("@/pages/settings/WhatsAppExportSection") },
  {
    name: "BulkMergeStockItemsCard",
    load: () => import("@/pages/settings/datatoolstab/components/BulkMergeStockItemsCard"),
  },
  { name: "SpReports", load: () => import("@/pages/sp/SpReports") },
  { name: "SpSetupPanel", load: () => import("@/pages/sp/SpSetupPanel") },
  { name: "StockAdjustmentForm", load: () => import("@/pages/vouchers/StockAdjustmentForm") },
  { name: "StockTransferForm", load: () => import("@/pages/vouchers/StockTransferForm") },
  { name: "StockTransferOrder", load: () => import("@/pages/StockTransferOrder") },
  { name: "StockItems", load: () => import("@/pages/StockItems") },
  { name: "StockOTW", load: () => import("@/pages/StockOTW") },
  { name: "ImportStockItems", load: () => import("@/pages/ImportStockItems") },
  { name: "AccountsLegacy", load: () => import("@/pages/AccountsLegacy") },
  { name: "SalesReportDetail", load: () => import("@/pages/SalesReportDetail") },
  { name: "PendingInvoiceVerify", load: () => import("@/pages/PendingInvoiceVerify") },
  { name: "SpreadsheetEditor", load: () => import("@/pages/SpreadsheetEditor") },
  { name: "FactorySuppliers", load: () => import("@/pages/factory/FactorySuppliers"), factory: true },
  {
    name: "FactoryPendingInvoiceVerify",
    load: () => import("@/pages/factory/FactoryPendingInvoiceVerify"),
    factory: true,
  },
  { name: "FactoryLocationInventory", load: () => import("@/pages/factory/FactoryLocationInventory"), factory: true },
  { name: "GroundScan", load: () => import("@/pages/factory/GroundScan"), factory: true },
  { name: "FactoryPOS", load: () => import("@/pages/factory/FactoryPOS"), factory: true },
  { name: "FactoryStatusBuilder", load: () => import("@/pages/factory/FactoryStatusBuilder"), factory: true },
  { name: "FactoryProformas", load: () => import("@/pages/factory/FactoryProformas"), factory: true },
  { name: "FactorySettings", load: () => import("@/pages/factory/FactorySettings"), factory: true },
  { name: "WipersReEntry", load: () => import("@/pages/factory/WipersReEntry"), factory: true },
  { name: "ContainerLoadingScan", load: () => import("@/pages/ContainerLoadingScan") },
  { name: "BaleProducts", load: () => import("@/pages/BaleProducts") },
  { name: "FactoryInvoiceCreate", load: () => import("@/pages/factory/FactoryInvoiceCreate"), factory: true },
  {
    name: "FactoryContainerLoadingScan",
    load: () => import("@/pages/factory/FactoryContainerLoadingScan"),
    factory: true,
  },
  {
    name: "FactoryShippingContainers",
    load: () => import("@/pages/factory/FactoryShippingContainers"),
    factory: true,
    seedRoutes: { "/whatsapp-preview": () => ({ files: [], defaultMessage: "" }) },
  },
  { name: "FactoryInvoices", load: () => import("@/pages/factory/FactoryInvoices"), factory: true },
  { name: "WasteDispatch", load: () => import("@/pages/factory/WasteDispatch"), factory: true },
  { name: "StockEntryTab", load: () => import("@/pages/factory/bale-stock-entry/StockEntryTab"), factory: true },
  {
    name: "RemoveFromStockTab",
    load: () => import("@/pages/factory/bale-stock-entry/RemoveFromStockTab"),
    factory: true,
  },
  { name: "POSPriceList", load: () => import("@/pages/pos/POSPriceList") },
  { name: "POSImport", load: () => import("@/pages/pos/POSImport") },
  { name: "ContainerVerification", load: () => import("@/pages/ContainerVerification") },
  { name: "SupplierProformas", load: () => import("@/pages/SupplierProformas") },
  { name: "DataToolsTab", load: () => import("@/pages/settings/DataToolsTab") },
  { name: "CustomerProformas", load: () => import("@/pages/CustomerProformas") },
  { name: "CombinedInventory", load: () => import("@/pages/CombinedInventory") },
  { name: "Agents", load: () => import("@/pages/Agents") },
  { name: "FactoryInsurance", load: () => import("@/pages/factory/FactoryInsurance"), factory: true },
  { name: "FactoryReprintLabels", load: () => import("@/pages/factory/FactoryReprintLabels"), factory: true },
];

describe("wave 4 page interaction sweep", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalPrint = window.print;
  const originalOpen = window.open;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const uncaught: string[] = [];
  const onWindowError = (event: ErrorEvent) => {
    uncaught.push(String(event.error?.message ?? event.message));
    event.preventDefault();
  };

  beforeAll(() => {
    (URL as any).createObjectURL = () => "blob:sweep";
    (URL as any).revokeObjectURL = () => {};
    window.print = () => {};
    window.open = (() => null) as typeof window.open;
    HTMLAnchorElement.prototype.click = function () {};
    window.addEventListener("error", onWindowError);
  });

  afterAll(() => {
    (URL as any).createObjectURL = originalCreateObjectURL;
    (URL as any).revokeObjectURL = originalRevokeObjectURL;
    window.print = originalPrint;
    window.open = originalOpen;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
    window.removeEventListener("error", onWindowError);
  });

  beforeEach(() => {
    resetPageState();
    stubSeededFetch();
    uncaught.length = 0;
  });

  for (const { name, load, factory, seedRoutes } of PAGES) {
    it(`${name} survives pressing each of its buttons`, async () => {
      if (seedRoutes) stubSeededFetch(seedRoutes);
      if (factory) {
        pageState.companyType = "factory";
        pageState.appMode = "factory";
      }
      const module = await load();
      const Component = (module.default ??
        module[name] ??
        Object.values(module).find((value) => typeof value === "function")) as React.ComponentType;

      const view = renderWithProviders(<Component />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      const buttonIds = Array.from(document.querySelectorAll("button[data-testid]"))
        .map((button) => button.getAttribute("data-testid")!)
        .slice(0, MAX_BUTTONS);
      let pressed = 0;
      for (const id of buttonIds) {
        const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
        if (!button || button.disabled) continue;
        await act(async () => {
          fireEvent.click(button);
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        pressed += 1;
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      }

      expect(pressed).toBeGreaterThan(0);
      expect(uncaught).toEqual([]);
      view.unmount();
    });
  }
});
