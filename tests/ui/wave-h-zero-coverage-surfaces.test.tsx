/**
 * Wave H coverage for large production surfaces that were still at 0% lines.
 *
 * These are executable mount contracts, not source-text assertions. Each test
 * renders the real component tree with the same deterministic providers used by
 * the rest of the UI suite and asserts a control or empty-state unique to that
 * production surface.
 */
import React from "react";
import { screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
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

describe("Wave H zero-coverage production surfaces", () => {
  it("mounts ContainerDetail and reaches its missing-container contract", async () => {
    const { default: ContainerDetail } = await import("@/pages/ContainerDetail");
    renderWithProviders(<ContainerDetail />);
    expect(await screen.findByText("Container not found")).toBeInTheDocument();
  });

  it("mounts FactoryInvoiceDetail and reaches its missing-invoice contract", async () => {
    const { default: FactoryInvoiceDetail } = await import("@/pages/factory/FactoryInvoiceDetail");
    renderWithProviders(<FactoryInvoiceDetail />);
    expect(await screen.findByTestId("text-not-found")).toHaveTextContent("Invoice not found");
  });

  it("mounts FactoryOtwTrackingTab and renders its empty OTW state", async () => {
    const { default: FactoryOtwTrackingTab } = await import("@/pages/factory/FactoryOtwTrackingTab");
    renderWithProviders(<FactoryOtwTrackingTab />);
    expect(await screen.findByText("No containers currently on the way.")).toBeInTheDocument();
  });

  it("mounts FactoryStockAllocationV5 and exposes the create-proforma action", async () => {
    const { default: FactoryStockAllocationV5 } = await import("@/pages/factory/FactoryStockAllocationV5");
    renderWithProviders(
      <TooltipProvider>
        <FactoryStockAllocationV5 />
      </TooltipProvider>
    );
    expect(await screen.findByTestId("button-v5-open-create-proforma")).toBeInTheDocument();
  });

  it("mounts the V5 create-proforma page with a real allocation row", async () => {
    const { default: CreateProformaV5Drawer } = await import("@/pages/factory/CreateProformaV5Drawer");
    const articleRows = [
      {
        articleCode: "BAL-101",
        productName: "Test Bale",
        stockAvailable: 12,
        expectedToLoad: 2,
        totalLoaded: 3,
        freeToPromise: 7,
      },
    ];

    const view = renderWithProviders(
      <CreateProformaV5Drawer open onClose={vi.fn()} onSuccess={vi.fn()} articleRows={articleRows} />
    );

    expect(await screen.findByTestId("page-create-proforma-v5")).toBeInTheDocument();
    expect(screen.getByTestId("select-v5-proforma-customer")).toBeInTheDocument();
    expect(screen.getByText("BAL-101")).toBeInTheDocument();

    // Radix FocusScope dispatches its unmount autofocus event from a zero-delay
    // timer. Flush it while this file's jsdom Event realm is still active; if
    // it leaks into the next serialized test file, jsdom correctly rejects the
    // prior realm's CustomEvent and Vitest reports an unhandled exception.
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
