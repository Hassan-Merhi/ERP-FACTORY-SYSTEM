/**
 * The biggest untested pages mount and show the control they exist for.
 *
 * `renders.test.tsx` does this for thirteen pages and explains why it is worth
 * doing: there is no route manifest for React, so a page that mounts is the
 * only cheap proof that a split, a renamed export, or a moved provider did not
 * break the component graph. Every page below was at zero measured coverage —
 * not partially tested, never imported by anything — while carrying between
 * 200 and 800 lines each, including the two stock-document forms through which
 * inventory is actually adjusted and transferred.
 *
 * Each case asserts a landmark that is specific to the page's purpose rather
 * than a generic page title: the destination selector on a transfer form, the
 * scan input on a ground scan, the adjustment location on an adjustment form.
 * A page that mounted but rendered its error state would satisfy "something
 * rendered" and fails here.
 *
 * The mocks mirror renders.test.tsx exactly — the same deterministic contexts
 * and the same intercepted fetch — so no test in this file reaches a database.
 */
import React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders, stubFetch } from "./helpers";

beforeAll(() => stubFetch());

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
  useRoute: () => [false, {}],
  useSearch: () => "",
  useParams: () => ({}),
  Link: ({ children, ...p }: any) => <a {...p}>{children}</a>,
  Route: ({ component: C }: any) => (C ? <C /> : null),
  Switch: ({ children }: any) => <>{children}</>,
  Redirect: () => null,
}));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => "erp",
  useModePrefix: () => "",
  AppModeProvider: ({ children }: any) => <>{children}</>,
  getModePrefix: () => "",
}));

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: 1, name: "Test Co", code: "TC", active: true, companyType: "erp" as const },
    companies: [],
    isLoading: false,
    selectCompany: vi.fn(),
  }),
  CompanyProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({
    selectedCurrency: "USD",
    exchangeRate: 1,
    isLoadingRate: false,
    isLoadingCompany: false,
    baseCurrency: "USD",
    displayCurrency: "USD",
    isMultiCurrency: false,
    formatAmount: (v: any) => `$${Number(v ?? 0).toFixed(2)}`,
    formatAmountRaw: (v: any) => `$${Number(v ?? 0).toFixed(2)}`,
    formatCashAmount: (v: any) => `$${Number(v ?? 0).toFixed(2)}`,
    convertToDisplay: (v: number) => v,
    convertToUSD: (v: number) => v,
    setCurrency: vi.fn(),
    toggleCurrency: vi.fn(),
  }),
}));

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({
    dateFormat: "MM/DD/YYYY",
    setDateFormat: vi.fn(),
    formatDisplayDate: (d: any) => String(d),
    formatShortDate: (d: any) => String(d),
    formatDisplayTime: (d: any) => String(d),
    formatDisplayDateTime: (d: any) => String(d),
    isLoading: false,
    isPending: false,
  }),
}));

vi.mock("@/contexts/ConnectivityContext", () => ({
  useConnectivity: () => ({
    status: "online",
    isOnline: true,
    isSyncing: false,
    lastSyncedAt: null,
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    triggerSync: vi.fn(),
    refreshCounts: vi.fn(),
  }),
}));

vi.mock("@/contexts/LocationContext", () => ({
  useLocation: () => ({ selectedLocation: null, setSelectedLocation: vi.fn() }),
  LocationProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/contexts/CursorNavContext", () => ({
  useCursorNav: () => ({ register: vi.fn(), unregister: vi.fn(), config: {} }),
  CursorNavProvider: ({ children }: any) => <>{children}</>,
}));

/**
 * page → the control that only that page has.
 *
 * Deliberately not `text-page-title`: half these pages render one, and a
 * landmark shared by every page proves only that PageHeader still works.
 */
const PAGES: Array<{ name: string; load: () => Promise<any>; landmark: string }> = [
  // Stock documents. These two forms are how inventory is adjusted and moved
  // between locations, and neither had been imported by any test.
  {
    name: "StockAdjustmentForm",
    load: () => import("@/pages/vouchers/StockAdjustmentForm"),
    landmark: "select-adjustment-location",
  },
  {
    name: "StockTransferForm",
    load: () => import("@/pages/vouchers/StockTransferForm"),
    landmark: "select-destination-location",
  },
  { name: "StockTransferOrder", load: () => import("@/pages/StockTransferOrder"), landmark: "select-destination" },
  { name: "StockEntryHistory", load: () => import("@/pages/StockEntryHistory"), landmark: "button-view-condensed" },
  { name: "StockItems", load: () => import("@/pages/StockItems"), landmark: "button-add-item" },
  { name: "StockOTW", load: () => import("@/pages/StockOTW"), landmark: "button-export-excel" },
  { name: "ImportStockItems", load: () => import("@/pages/ImportStockItems"), landmark: "button-back" },

  // Accounting and reporting.
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
  { name: "SpreadsheetEditor", load: () => import("@/pages/SpreadsheetEditor"), landmark: "input-upload-xlsx" },

  // Factory.
  {
    name: "FactorySuppliers",
    load: () => import("@/pages/factory/FactorySuppliers"),
    landmark: "select-supplier-filter",
  },
  {
    name: "FactoryPendingInvoiceVerify",
    load: () => import("@/pages/factory/FactoryPendingInvoiceVerify"),
    landmark: "text-total-loaded-bales",
  },
  {
    name: "FactoryLocationInventory",
    load: () => import("@/pages/factory/FactoryLocationInventory"),
    landmark: "button-export-all-locations",
  },
  { name: "GroundScan", load: () => import("@/pages/factory/GroundScan"), landmark: "input-ground-scan" },
  { name: "FactoryPOS", load: () => import("@/pages/factory/FactoryPOS"), landmark: "button-complete-sale" },
  {
    name: "BalesHistory",
    load: () => import("@/pages/factory/BalesHistory"),
    landmark: "button-export-stock-register",
  },
  {
    name: "FactoryStatusBuilder",
    load: () => import("@/pages/factory/FactoryStatusBuilder"),
    landmark: "sb-button-export-excel",
  },
  { name: "FactoryProformas", load: () => import("@/pages/factory/FactoryProformas"), landmark: "select-customer" },
  { name: "FactorySettings", load: () => import("@/pages/factory/FactorySettings"), landmark: "button-enable-all" },
  { name: "WipersReEntry", load: () => import("@/pages/factory/WipersReEntry"), landmark: "tab-wipers-re-entry" },
  { name: "ContainerLoadingScan", load: () => import("@/pages/ContainerLoadingScan"), landmark: "text-bales-header" },
  { name: "BaleProducts", load: () => import("@/pages/BaleProducts"), landmark: "button-create-product" },
  {
    name: "FactoryInvoiceCreate",
    load: () => import("@/pages/factory/FactoryInvoiceCreate"),
    landmark: "badge-bale-count",
  },
  {
    name: "FactoryContainerLoadingScan",
    load: () => import("@/pages/factory/FactoryContainerLoadingScan"),
    landmark: "button-start-loading",
  },
  {
    name: "FactoryShippingContainers",
    load: () => import("@/pages/factory/FactoryShippingContainers"),
    landmark: "button-track-all-eta",
  },
  { name: "FactoryInvoices", load: () => import("@/pages/factory/FactoryInvoices"), landmark: "filter-tabs" },
  { name: "WasteDispatch", load: () => import("@/pages/factory/WasteDispatch"), landmark: "input-scan-ref" },
  {
    name: "StockEntryTab",
    load: () => import("@/pages/factory/bale-stock-entry/StockEntryTab"),
    landmark: "input-scan-product",
  },
  {
    name: "RemoveFromStockTab",
    load: () => import("@/pages/factory/bale-stock-entry/RemoveFromStockTab"),
    landmark: "button-remove-selected",
  },

  // POS and containers.
  { name: "POSPriceList", load: () => import("@/pages/pos/POSPriceList"), landmark: "button-mobile-location-all" },
  { name: "POSImport", load: () => import("@/pages/pos/POSImport"), landmark: "button-validate" },
  {
    name: "ContainerVerification",
    load: () => import("@/pages/ContainerVerification"),
    landmark: "button-import-loaded",
  },
  { name: "SupplierProformas", load: () => import("@/pages/SupplierProformas"), landmark: "button-create-proforma" },

  // Settings tabs. DataToolsTab in particular exposes stock import, cost-price
  // repair and silent transfer — three controls that write.
  {
    name: "DataToolsTab",
    load: () => import("@/pages/settings/DataToolsTab"),
    landmark: "button-open-stock-import",
  },
  { name: "FileStorageTab", load: () => import("@/pages/settings/FileStorageTab"), landmark: "button-upload-file" },

  // ERP listings and dashboards.
  { name: "ProductionBales", load: () => import("@/pages/ProductionBales"), landmark: "badge-finalize-mode" },
  { name: "CustomerProformas", load: () => import("@/pages/CustomerProformas"), landmark: "select-customer" },
  { name: "CombinedInventory", load: () => import("@/pages/CombinedInventory"), landmark: "button-refresh-inventory" },
  { name: "Agents", load: () => import("@/pages/Agents"), landmark: "button-add-agent" },
  { name: "Suppliers", load: () => import("@/pages/Suppliers"), landmark: "text-active-suppliers" },
  {
    name: "PropertiesDashboard",
    load: () => import("@/pages/properties/PropertiesDashboard"),
    landmark: "kpi-total-income",
  },
  { name: "FactoryInsurance", load: () => import("@/pages/factory/FactoryInsurance"), landmark: "button-add-member" },
  {
    name: "FactoryReprintLabels",
    load: () => import("@/pages/factory/FactoryReprintLabels"),
    landmark: "button-label-print-settings",
  },
];

describe("previously unmounted pages", () => {
  for (const { name, load, landmark } of PAGES) {
    it(`${name} mounts and renders ${landmark}`, async () => {
      const module = await load();
      const Component = (module.default ?? module[name]) as React.ComponentType;
      expect(Component, `${name} must export a component`).toBeTypeOf("function");

      renderWithProviders(<Component />);
      expect(await screen.findByTestId(landmark)).toBeInTheDocument();
    });
  }
});
