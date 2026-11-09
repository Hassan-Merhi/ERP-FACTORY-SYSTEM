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
  useLocation: () => ["/factory/sales/invoices/77", harness.navigate],
  useRoute: (pattern: string) => (pattern === "/factory/sales/invoices/:id" ? [true, { id: "77" }] : [false, {}]),
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
  useAppMode: () => "factory",
  useModePrefix: () => "/factory",
  AppModeProvider: ({ children }: ChildrenProps) => <>{children}</>,
  getModePrefix: () => "/factory",
}));

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: {
      id: 1,
      name: "Factory Co",
      code: "FC",
      active: true,
      companyType: "factory" as const,
    },
    companies: [
      {
        id: 1,
        name: "Factory Co",
        code: "FC",
        active: true,
        companyType: "factory" as const,
      },
    ],
    isLoading: false,
    selectCompany: vi.fn(),
  }),
  CompanyProvider: ({ children }: ChildrenProps) => <>{children}</>,
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
  useLocation: () => ({
    selectedLocation: null,
    setSelectedLocation: vi.fn(),
  }),
  LocationProvider: ({ children }: ChildrenProps) => <>{children}</>,
}));

vi.mock("@/contexts/CursorNavContext", () => ({
  useCursorNav: () => ({
    register: vi.fn(),
    unregister: vi.fn(),
    config: {},
  }),
  CursorNavProvider: ({ children }: ChildrenProps) => <>{children}</>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));
vi.mock("@/hooks/use-escape-to-parent", () => ({ useEscapeToParent: vi.fn() }));

import FactoryInvoiceDetail from "@/pages/factory/FactoryInvoiceDetail";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

const finalizedOrder = {
  id: 77,
  companyId: 1,
  customerId: 3,
  orderDate: "2026-08-20",
  status: "FINALIZED",
  invoiceNumber: "INV-77",
  subtotalBales: "250",
  freightAmount: "30",
  otherChargesTotal: "20",
  grandTotal: "300",
  totalQtyBales: 5,
  customerName: "Factory Customer",
  customerCode: "CUS-3",
  containerNumber: "MSCU-77",
  shippingCompany: "Test Shipping",
  destination: "Kolwezi",
  dispatchBatchId: null,
  lines: [
    {
      articleCode: "BAL-A",
      baleName: "Alpha Bale",
      qty: 2,
      weightPerBale: 50,
      totalWeight: 100,
      pricePerBale: 60,
      totalPrice: 120,
    },
    {
      articleCode: "BAL-B",
      baleName: "Beta Bale",
      qty: 3,
      weightPerBale: 45,
      totalWeight: 135,
      pricePerBale: 43.3333,
      totalPrice: 130,
    },
  ],
  bales: [],
  charges: [
    {
      id: 11,
      name: "Ocean Freight",
      amount: "30",
      chargeType: "FREIGHT",
      ledgerAccountId: 9,
      voucherId: 101,
    },
    {
      id: 12,
      name: "Clearance",
      amount: "20",
      chargeType: "CLEARANCE",
      ledgerAccountId: 10,
      voucherId: 102,
    },
  ],
};

describe("Wave H populated factory-invoice detail behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([]))
    );
  });

  it("renders finalized invoice lines, charges, logistics metadata, and computed totals", async () => {
    renderWithProviders(<FactoryInvoiceDetail />, {
      seedQueries: [
        [["/api/factory/customer-orders", 1, 77], finalizedOrder],
        [
          ["/api/ledger-accounts?includeHidden=true", 1],
          [
            { id: 9, name: "Freight Expense", code: "EXP-9" },
            { id: 10, name: "Clearance Expense", code: "EXP-10" },
          ],
        ],
        [
          ["/api/factory/my-access", 1],
          { hiddenCostFields: [], fullAccess: true, hasFactoryAccess: true, hideAllCosts: false, companyId: 1 },
        ],
        [["/api/factory/customer-proformas", 1, 3, "summary"], []],
      ],
    });

    expect(await screen.findByTestId("text-invoice-number")).toHaveTextContent("INV-77");
    expect(screen.getByTestId("badge-status-finalized")).toHaveTextContent("Finalized");
    expect(screen.getByTestId("text-customer-name")).toHaveTextContent("Factory Customer");
    expect(screen.getByTestId("text-container-number")).toHaveTextContent("MSCU-77");
    expect(screen.getByTestId("text-shipping-company")).toHaveTextContent("Test Shipping");
    expect(screen.getByTestId("text-destination")).toHaveTextContent("Kolwezi");
    expect(screen.getByTestId("button-scan-loading")).toBeInTheDocument();

    expect(screen.getByTestId("text-article-code-0")).toHaveTextContent("BAL-A");
    expect(screen.getByTestId("text-bale-name-0")).toHaveTextContent("Alpha Bale");
    expect(screen.getByTestId("text-qty-0")).toHaveTextContent("2");
    expect(screen.getByTestId("text-total-weight-0")).toHaveTextContent("100");
    expect(screen.getByTestId("text-total-price-0")).toHaveTextContent("120");
    expect(screen.getByTestId("text-article-code-1")).toHaveTextContent("BAL-B");
    expect(screen.getByTestId("text-bale-name-1")).toHaveTextContent("Beta Bale");

    expect(screen.getByTestId("text-charges-header")).toHaveTextContent("Freight & Charges");
    expect(screen.getByText("Ocean Freight")).toBeInTheDocument();
    expect(screen.getByText("Clearance")).toBeInTheDocument();
    expect(screen.getByTestId("button-add-charge")).toBeInTheDocument();

    expect(screen.getByTestId("text-subtotal")).toHaveTextContent("250");
    expect(screen.getByTestId("text-total-charges")).toHaveTextContent("50");
    expect(screen.getByTestId("text-grand-total")).toHaveTextContent("300");
    expect(screen.getByTestId("text-total-bales-qty")).toHaveTextContent("5");
    expect(screen.getByTestId("text-total-weight-kg")).toHaveTextContent("235 kg");
  });
});
