/**
 * Shell render tests — each component mounts in jsdom without crashing and
 * exposes a stable UI landmark (heading, testid, or role).
 *
 * All network calls are intercepted; real DB is never hit.
 */
import React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders, stubFetch } from "./helpers";

// ── Global stubs ─────────────────────────────────────────────────────────────

beforeAll(() => stubFetch());

// wouter — minimal navigation mock (covers every export the pages use)
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

// Context mocks — return deterministic values, no API calls
vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => "erp",
  useModePrefix: () => "",
  AppModeProvider: ({ children }: any) => <>{children}</>,
  getModePrefix: () => "",
}));

const mockCompany = {
  selectedCompany: {
    id: 1,
    name: "Test Co",
    code: "TC",
    active: true,
    companyType: "erp" as const,
  },
  companies: [],
  isLoading: false,
  selectCompany: vi.fn(),
};
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => mockCompany,
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
  useLocation: () => ({
    selectedLocation: null,
    setSelectedLocation: vi.fn(),
  }),
  LocationProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/contexts/CursorNavContext", () => ({
  useCursorNav: () => ({ register: vi.fn(), unregister: vi.fn() }),
  CursorNavProvider: ({ children }: any) => <>{children}</>,
}));

// ── 1. Dashboard ──────────────────────────────────────────────────────────────
describe("Dashboard", () => {
  it("renders page title heading", async () => {
    const { default: Dashboard } = await import("@/pages/Dashboard");
    renderWithProviders(<Dashboard />);
    // PageHeader always renders data-testid="text-page-title"
    expect(await screen.findByTestId("text-page-title")).toBeInTheDocument();
  });
});

// ── 2. Accounts ───────────────────────────────────────────────────────────────
describe("Accounts page", () => {
  it("renders 'Accounts Overview' heading", async () => {
    const { default: Accounts } = await import("@/pages/Accounts");
    renderWithProviders(<Accounts />);
    const heading = await screen.findByTestId("text-page-title");
    expect(heading).toHaveTextContent("Accounts Overview");
  });
});

// ── 3. JournalForm (Vouchers shell) ──────────────────────────────────────────
describe("JournalForm", () => {
  it("renders the journal date input", async () => {
    const { JournalForm } = await import("@/pages/vouchers/JournalForm");
    renderWithProviders(<JournalForm />);
    expect(await screen.findByTestId("input-journal-date")).toBeInTheDocument();
  });
});

// ── 4. POS page ───────────────────────────────────────────────────────────────
describe("POS page", () => {
  it("renders 'Point of Sale' heading", async () => {
    const { default: POS } = await import("@/pages/pos/POS");
    renderWithProviders(<POS />);
    expect(await screen.findByText("Point of Sale")).toBeInTheDocument();
  });
});

// ── 5. StockHub ───────────────────────────────────────────────────────────────
describe("StockHub", () => {
  it("renders the Items tab button", async () => {
    const { default: StockHub } = await import("@/pages/StockHub");
    renderWithProviders(<StockHub />);
    // First tab is { value: "items" } → data-testid="tab-stock-items"
    expect(await screen.findByTestId("tab-stock-items")).toBeInTheDocument();
  });
});

// ── 6. InventoryHub ───────────────────────────────────────────────────────────
describe("InventoryHub", () => {
  it("renders the By Location tab button", async () => {
    const { default: InventoryHub } = await import("@/pages/InventoryHub");
    renderWithProviders(<InventoryHub />);
    // First tab is { value: "by-location" } → data-testid="tab-by-location"
    expect(await screen.findByTestId("tab-by-location")).toBeInTheDocument();
  });
});

// ── 7. SalesReport ────────────────────────────────────────────────────────────
describe("SalesReport", () => {
  it("renders 'Sales Report' heading", async () => {
    const { default: SalesReport } = await import("@/pages/SalesReport");
    renderWithProviders(<SalesReport />);
    const heading = await screen.findByTestId("text-page-title");
    expect(heading).toHaveTextContent("Sales Report");
  });
});

// ── 8. Settings ───────────────────────────────────────────────────────────────
describe("Settings", () => {
  it("renders settings shell with non-empty content", async () => {
    const { default: Settings } = await import("@/pages/Settings");
    const { container } = renderWithProviders(<Settings />);
    // Settings delegates to sub-hubs; assert the root container mounted content
    await vi.waitFor(() => expect(container.firstChild).not.toBeNull());
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });
});

// ── 9. FactoryWorkersHub ──────────────────────────────────────────────────────
describe("FactoryWorkersHub", () => {
  it("renders the section tabs", async () => {
    const { default: FactoryWorkersHub } = await import("@/pages/factory/FactoryWorkersHub");
    renderWithProviders(<FactoryWorkersHub />);
    const tabs = await screen.findByTestId("tabs-workers-section");
    expect(tabs).toHaveAttribute("role", "tablist");
    expect(tabs).toHaveAccessibleName("Worker sections");
  });
});

// ── 10. FactoryCustomers ──────────────────────────────────────────────────────
describe("FactoryCustomers page", () => {
  it("renders the page title heading", async () => {
    const { default: FactoryCustomers } = await import("@/pages/factory/FactoryCustomers");
    renderWithProviders(<FactoryCustomers />);
    expect(await screen.findByTestId("text-page-title")).toBeInTheDocument();
  });
});

// ── 12. FactoryDaybook ────────────────────────────────────────────────────────
// Added before the Phase 4 split of FactoryDaybook.tsx: there is no route
// manifest for React, so a page that mounts is the only cheap proof that an
// extraction did not break the component graph.
describe("FactoryDaybook page", () => {
  it("renders the page title heading", async () => {
    const { default: FactoryDaybook } = await import("@/pages/factory/FactoryDaybook");
    renderWithProviders(<FactoryDaybook />);
    const heading = await screen.findByTestId("text-page-title");
    expect(heading).toHaveTextContent("Factory Daybook");
  });
});

// ── 13. PropertiesRentalShops (PropertyRentalPage shell) ─────────────────────
// Added before the Phase 4 split of PropertyRentalPage.tsx. The page itself
// takes props, so it is exercised through the real prop-less entry point.
describe("PropertiesRentalShops page", () => {
  it("renders the page title heading", async () => {
    const { default: PropertiesRentalShops } = await import("@/pages/properties/PropertiesRentalShops");
    renderWithProviders(<PropertiesRentalShops />);
    const heading = await screen.findByTestId("text-page-title");
    expect(heading).toHaveTextContent("Shop Rentals");
  });
});

// ── 14. StockTransferOrder ───────────────────────────────────────────────────
// Added before decomposing StockTransferOrder.tsx in Phase 4.
describe("StockTransferOrder page", () => {
  it("renders the page title heading", async () => {
    const { default: StockTransferOrder } = await import("@/pages/StockTransferOrder");
    renderWithProviders(<StockTransferOrder />);
    expect(await screen.findByTestId("text-page-title")).toBeInTheDocument();
  });
});
