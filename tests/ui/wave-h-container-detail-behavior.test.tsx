import React from "react";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
}));

type ChildrenProps = { children: React.ReactNode };

vi.mock("wouter", () => ({
  useLocation: () => ["/containers/42", harness.navigate],
  useRoute: () => [false, {}],
  useSearch: () => "",
  useParams: () => ({}),
  Link: ({ children, ...props }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
  Route: ({ component: Component }: { component?: React.ComponentType }) => (Component ? <Component /> : null),
  Switch: ({ children }: ChildrenProps) => <>{children}</>,
  Redirect: () => null,
}));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => "erp",
  useModePrefix: () => "",
  AppModeProvider: ({ children }: ChildrenProps) => <>{children}</>,
  getModePrefix: () => "",
}));

vi.mock("@/contexts/CompanyContext", () => ({
  // No provider role: the shared change-access helper leaves controls as they are.
  useOptionalCompany: () => null,
  useCompany: () => ({
    selectedCompany: { id: 1, name: "Test Co", code: "TC", active: true, companyType: "erp" as const },
    companies: [{ id: 1, name: "Test Co", code: "TC", active: true, companyType: "erp" as const }],
    isLoading: false,
    selectCompany: vi.fn(),
  }),
  CompanyProvider: ({ children }: ChildrenProps) => <>{children}</>,
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
    formatAmount: (value: unknown) => `$${Number(value ?? 0).toFixed(2)}`,
    formatAmountRaw: (value: unknown) => `$${Number(value ?? 0).toFixed(2)}`,
    formatCashAmount: (value: unknown) => `$${Number(value ?? 0).toFixed(2)}`,
    convertToDisplay: (value: number) => value,
    convertToUSD: (value: number) => value,
    setCurrency: vi.fn(),
    toggleCurrency: vi.fn(),
  }),
}));

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({
    dateFormat: "MM/DD/YYYY",
    setDateFormat: vi.fn(),
    formatDisplayDate: (date: unknown) => String(date),
    formatShortDate: (date: unknown) => String(date),
    formatDisplayTime: (date: unknown) => String(date),
    formatDisplayDateTime: (date: unknown) => String(date),
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
  LocationProvider: ({ children }: ChildrenProps) => <>{children}</>,
}));

vi.mock("@/contexts/CursorNavContext", () => ({
  useCursorNav: () => ({ register: vi.fn(), unregister: vi.fn(), config: {} }),
  CursorNavProvider: ({ children }: ChildrenProps) => <>{children}</>,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/hooks/use-escape-to-parent", () => ({ useEscapeToParent: vi.fn() }));

import ContainerDetail from "@/pages/ContainerDetail";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

const populatedContainer = {
  container: {
    id: 42,
    containerNumber: "CONT-42",
    status: "OTW",
    importDate: "2026-08-01",
    supplierId: 7,
    grandTotal: "130",
  },
  pos: [
    {
      id: 9,
      poNumber: "PO-9",
      currency: "USD",
      itemsTotal: "100",
      items: [
        { id: 91, itemName: "Alpha Bale", quantity: "2.500", rate: "20", lineTotal: "50" },
        { id: 92, itemName: "Beta Bale", quantity: "1", rate: "50", lineTotal: "50" },
      ],
    },
  ],
  charges: [{ chargeType: "Freight", amount: "30" }],
  offloadId: null,
};

const supplier = { id: 7, code: "ACME", legalName: "Acme Supplier" };

function commonSeeds(containerData: unknown, sales: unknown[] = []) {
  return [
    [["/api/containers/42"], containerData],
    [["/api/suppliers"], [supplier]],
    [["/api/customers", 1], [{ id: 3, legalName: "Customer One" }]],
    [["/api/ledger-accounts", 1], [{ id: 8, name: "Commission Income", code: "INC-8", accountType: "Income" }]],
    [["/api/container-sales", 1], sales],
  ] as const;
}

describe("Wave H populated container-detail behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/documents")) {
          return jsonResponse({ documents: [], docTypes: [], completeness: { total: 0, uploaded: 0, complete: true } });
        }
        return jsonResponse([]);
      })
    );
  });

  it("renders a populated ERP container from live PO and charge data", async () => {
    renderWithProviders(<ContainerDetail id="42" />, { seedQueries: commonSeeds(populatedContainer) });

    expect(await screen.findByTestId("text-container-number")).toHaveTextContent("Container CONT-42");
    expect(screen.getByTestId("badge-status")).toHaveTextContent("OTW");
    expect(screen.getByTestId("text-supplier")).toHaveTextContent("Acme Supplier");
    expect(screen.getByTestId("text-items-total")).toHaveTextContent("$100.00");
    expect(screen.getByTestId("text-grand-total")).toHaveTextContent("$130.00");
    expect(screen.getByTestId("text-po-PO-9")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha Bale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta Bale").length).toBeGreaterThan(0);
    expect(screen.getByText("Extra Charges")).toBeInTheDocument();
    expect(screen.getByText("Freight")).toBeInTheDocument();
    expect(screen.getByText("3.5")).toBeInTheDocument();
  });

  it("renders sold and offloaded evidence without losing the underlying container totals", async () => {
    const offloaded = {
      ...populatedContainer,
      container: { ...populatedContainer.container, status: "OFFLOADED" },
      offloadId: 55,
    };
    const sale = {
      id: 5,
      containerId: 42,
      customerId: 3,
      saleDate: "2026-08-20",
      containerCost: "130",
      commission: "7.5",
      totalAmount: "137.5",
    };

    renderWithProviders(<ContainerDetail id="42" />, { seedQueries: commonSeeds(offloaded, [sale]) });

    expect(await screen.findByText("Container Sold")).toBeInTheDocument();
    expect(screen.getByTestId("text-sale-customer")).toHaveTextContent("Customer One");
    expect(screen.getByTestId("text-sale-date")).toHaveTextContent("2026-08-20");
    expect(screen.getByTestId("text-sale-price")).toHaveTextContent("$130.00");
    expect(screen.getByTestId("text-sale-commission")).toHaveTextContent("$7.50");
    expect(screen.getByTestId("text-sale-total")).toHaveTextContent("$137.50");
    expect(screen.getByTestId("button-view-offload")).toBeInTheDocument();
    expect(screen.getByTestId("text-grand-total")).toHaveTextContent("$130.00");
  });
});
