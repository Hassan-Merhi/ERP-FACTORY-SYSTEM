/**
 * Wave 4 — the remaining top-level pages.
 *
 * The other wave 4 suites cover pages that had zero coverage. This one covers
 * top-level pages that were only partly exercised (usually by a single mount
 * in an older suite), with the same three contracts:
 *
 *  1. empty: the page mounts with empty API data and shows its landmark
 *  2. populated: with seeded rows the landmark survives, and list pages marked
 *     showsRows render the seeded rows
 *  3. sweep (pages marked sweep): with seeded rows, pressing each of the first
 *     30 test-id'd buttons throws nothing and raises no uncaught error
 *
 * Landmarks are the first page-specific test id present in both the empty and
 * populated render.
 */
import React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubFetchRoutes, stubSeededFetch } from "./pageMocks";

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
  showsRows?: boolean;
  sweep?: boolean;
}

const PAGES: PageCase[] = [
  { name: "AccountTransfer", load: () => import("@/pages/AccountTransfer"), landmark: "combobox-from-account" },
  {
    name: "AccountingCreate",
    load: () => import("@/pages/AccountingCreate"),
    landmark: "select-entity-mobile",
    showsRows: true,
    sweep: true,
  },
  { name: "Accounts", load: () => import("@/pages/Accounts"), landmark: "button-account-groups", sweep: true },
  { name: "AnalyticsLegacy", load: () => import("@/pages/AnalyticsLegacy"), landmark: "select-analytics-section" },
  { name: "BalanceSheet", load: () => import("@/pages/BalanceSheet"), landmark: "text-total-assets", sweep: true },
  {
    name: "BarcodeLookup",
    load: () => import("@/pages/BarcodeLookup"),
    landmark: "button-toggle-search-mode",
    sweep: true,
  },
  {
    name: "ClosingStockSummary",
    load: () => import("@/pages/ClosingStockSummary"),
    landmark: "period-filter-closing-stock",
    sweep: true,
  },
  { name: "Containers", load: () => import("@/pages/Containers"), landmark: "button-export-dropdown", sweep: true },
  {
    name: "ContainersPage",
    load: () => import("@/pages/ContainersPage"),
    landmark: "button-export-dropdown",
    sweep: true,
  },
  {
    name: "ConvergenceReconciliation",
    load: () => import("@/pages/ConvergenceReconciliation"),
    landmark: "page-convergence-reconciliation",
    sweep: true,
  },
  { name: "GITMockup", load: () => import("@/pages/GITMockup"), landmark: "tab-git-detail" },
  {
    name: "InventoryHub",
    load: () => import("@/pages/InventoryHub"),
    landmark: "tab-by-location",
    showsRows: true,
    sweep: true,
  },
  {
    name: "LocationInventory",
    load: () => import("@/pages/LocationInventory"),
    landmark: "button-negative-stock",
    showsRows: true,
    sweep: true,
  },
  {
    name: "LocationSummary",
    load: () => import("@/pages/LocationSummary"),
    landmark: "location-summary-container",
    sweep: true,
  },
  { name: "OffloadItemSearch", load: () => import("@/pages/OffloadItemSearch"), landmark: "input-item-search" },
  {
    name: "PendingInvoices",
    load: () => import("@/pages/PendingInvoices"),
    landmark: "filter-tabs",
    showsRows: true,
    sweep: true,
  },
  {
    name: "PendingLoadings",
    load: () => import("@/pages/PendingLoadings"),
    landmark: "button-start-new",
    showsRows: true,
    sweep: true,
  },
  { name: "SalesReport", load: () => import("@/pages/SalesReport"), landmark: "button-compare-companies", sweep: true },
  {
    name: "SalesReportLegacy",
    load: () => import("@/pages/SalesReportLegacy"),
    landmark: "button-compare-companies",
    sweep: true,
  },
  { name: "SalesToolsHub", load: () => import("@/pages/SalesToolsHub"), landmark: "tab-transfers", sweep: true },
  { name: "Settings", load: () => import("@/pages/Settings"), landmark: "text-users-title", sweep: true },
  {
    name: "SmartStockTransferOrderPage",
    load: () => import("@/pages/SmartStockTransferOrderPage"),
    landmark: "select-destination",
    sweep: true,
  },
  {
    name: "SoldContainers",
    load: () => import("@/pages/SoldContainers"),
    landmark: "input-search-sold-containers",
    showsRows: true,
    sweep: true,
  },
  {
    name: "StockHub",
    load: () => import("@/pages/StockHub"),
    landmark: "tab-stock-items",
    showsRows: true,
    sweep: true,
  },
  {
    name: "StockInSalesReport",
    load: () => import("@/pages/StockInSalesReport"),
    landmark: "button-back-stock-in-sales",
    sweep: true,
  },
  { name: "StockItemHistory", load: () => import("@/pages/StockItemHistory"), landmark: "period-filter", sweep: true },
  { name: "StockQuery", load: () => import("@/pages/StockQuery"), landmark: "input-stock-search", showsRows: true },
  {
    name: "SupplierProfitCheck",
    load: () => import("@/pages/SupplierProfitCheck"),
    landmark: "button-import-excel",
    sweep: true,
  },
  {
    name: "TrackingHub",
    load: () => import("@/pages/TrackingHub"),
    landmark: "tab-tracking-containers-otw",
    sweep: true,
  },
  {
    name: "FactoryAccounts",
    load: () => import("@/pages/factory/FactoryAccounts"),
    landmark: "button-account-groups",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryAdvancesTab",
    load: () => import("@/pages/factory/FactoryAdvancesTab"),
    landmark: "subtab-advances",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryAlerts",
    load: () => import("@/pages/factory/FactoryAlerts"),
    landmark: "text-unread-count",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryBaleTracking",
    load: () => import("@/pages/factory/FactoryBaleTracking"),
    landmark: "factory-bale-tracking-page",
    factory: true,
  },
  {
    name: "FactoryCashflow",
    load: () => import("@/pages/factory/FactoryCashflow"),
    landmark: "period-selector",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryContainerTracking",
    load: () => import("@/pages/factory/FactoryContainerTracking"),
    landmark: "input-tracking-search",
    factory: true,
    showsRows: true,
  },
  {
    name: "FactoryContainersHub",
    load: () => import("@/pages/factory/FactoryContainersHub"),
    landmark: "button-view-list",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryCustomers",
    load: () => import("@/pages/factory/FactoryCustomers"),
    landmark: "button-add-customer",
    factory: true,
  },
  {
    name: "FactoryDashboard",
    load: () => import("@/pages/factory/FactoryDashboard"),
    landmark: "input-date",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryEmployeesHub",
    load: () => import("@/pages/factory/FactoryEmployeesHub"),
    landmark: "select-employees-section",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryImport",
    load: () => import("@/pages/factory/FactoryImport"),
    landmark: "factory-import-page",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryInvoiceDetail",
    load: () => import("@/pages/factory/FactoryInvoiceDetail"),
    landmark: "button-back-to-list",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryInvoiceDetailBilingual",
    load: () => import("@/pages/factory/FactoryInvoiceDetailBilingual"),
    landmark: "button-bilingual-document-actions",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryInvoicing",
    load: () => import("@/pages/factory/FactoryInvoicing"),
    landmark: "tab-proformas",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryKpis",
    load: () => import("@/pages/factory/FactoryKpis"),
    landmark: "input-date-from",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryLoadingsHub",
    load: () => import("@/pages/factory/FactoryLoadingsHub"),
    landmark: "tab-container-loadings",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryMixOptimizer",
    load: () => import("@/pages/factory/FactoryMixOptimizer"),
    landmark: "select-trigger-target-product",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryPartiesHub",
    load: () => import("@/pages/factory/FactoryPartiesHub"),
    landmark: "tab-parties-customers",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryPayroll",
    load: () => import("@/pages/factory/FactoryPayroll"),
    landmark: "button-generate-payroll",
    factory: true,
    showsRows: true,
    sweep: true,
  },
  {
    name: "FactoryPayrollTab",
    load: () => import("@/pages/factory/FactoryPayrollTab"),
    landmark: "stat-workers",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryProduction",
    load: () => import("@/pages/factory/FactoryProduction"),
    landmark: "tab-factory-factory-suppliers",
    factory: true,
    sweep: true,
  },
  {
    name: "FactoryRawMaterialsHub",
    load: () => import("@/pages/factory/FactoryRawMaterialsHub"),
    landmark: "production-raw-stock-page",
    factory: true,
    showsRows: true,
    sweep: true,
  },
  {
    name: "FactorySupplierHub",
    load: () => import("@/pages/factory/FactorySupplierHub"),
    landmark: "tab-supplier-hub-report",
    factory: true,
  },
  { name: "POSSettings", load: () => import("@/pages/pos/POSSettings"), landmark: "input-current-password" },
  {
    name: "PropertiesAccounts",
    load: () => import("@/pages/properties/PropertiesAccounts"),
    landmark: "button-account-groups",
    sweep: true,
  },
  {
    name: "PropertiesAnalytics",
    load: () => import("@/pages/properties/PropertiesAnalytics"),
    landmark: "select-analytics-section",
  },
  {
    name: "PropertiesCreate",
    load: () => import("@/pages/properties/PropertiesCreate"),
    landmark: "select-entity-mobile",
    showsRows: true,
    sweep: true,
  },
  {
    name: "PropertiesSettings",
    load: () => import("@/pages/properties/PropertiesSettings"),
    landmark: "text-users-title",
    sweep: true,
  },
  {
    name: "SpAliases",
    load: () => import("@/pages/sp/SpAliases"),
    landmark: "input-sp-alias-code",
    showsRows: true,
    sweep: true,
  },
  { name: "SpGoldenCoast", load: () => import("@/pages/sp/SpGoldenCoast"), landmark: "sp-golden-coast" },
  { name: "SpOverview", load: () => import("@/pages/sp/SpOverview"), landmark: "sp-overview", showsRows: true },
  { name: "SpSetup", load: () => import("@/pages/sp/SpSetup"), landmark: "sp-administration-hub", sweep: true },
];

const SEEDED_ROW_TEXT = /Name 1|Item 1|Cust 1|Supp 1|CONT1|Desc 1/;
const MAX_BUTTONS = 30;

async function mount({ name, load, factory }: PageCase) {
  if (factory) {
    pageState.companyType = "factory";
    pageState.appMode = "factory";
  }
  const module = await load();
  const Component = (module.default ?? module[name]) as React.ComponentType;
  return renderWithProviders(<Component />);
}

beforeEach(() => resetPageState());

describe("remaining pages — empty data", () => {
  for (const page of PAGES) {
    it(`${page.name} renders ${page.landmark}`, async () => {
      stubFetchRoutes();
      await mount(page);
      expect(await screen.findByTestId(page.landmark)).toBeInTheDocument();
    });
  }
});

describe("remaining pages — seeded data", () => {
  for (const page of PAGES) {
    it(`${page.name} keeps ${page.landmark}${page.showsRows ? " and renders rows" : ""}`, async () => {
      stubSeededFetch();
      await mount(page);
      expect(await screen.findByTestId(page.landmark)).toBeInTheDocument();
      if (page.showsRows) {
        await vi.waitFor(() => expect(document.body.textContent).toMatch(SEEDED_ROW_TEXT));
      }
    });
  }
});

describe("remaining pages — button sweep", () => {
  const originals = {
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
    print: window.print,
    open: window.open,
    anchorClick: HTMLAnchorElement.prototype.click,
  };
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
    (URL as any).createObjectURL = originals.createObjectURL;
    (URL as any).revokeObjectURL = originals.revokeObjectURL;
    window.print = originals.print;
    window.open = originals.open;
    HTMLAnchorElement.prototype.click = originals.anchorClick;
    window.removeEventListener("error", onWindowError);
  });

  for (const page of PAGES.filter((p) => p.sweep)) {
    it(`${page.name} survives pressing each of its buttons`, async () => {
      uncaught.length = 0;
      stubSeededFetch();
      const view = await mount(page);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      const ids = Array.from(document.querySelectorAll("button[data-testid]"))
        .map((button) => button.getAttribute("data-testid")!)
        .slice(0, MAX_BUTTONS);
      let pressed = 0;
      for (const id of ids) {
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
