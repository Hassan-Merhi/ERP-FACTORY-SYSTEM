import React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders, stubFetch } from "./helpers";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  stubFetch();
});

vi.mock("wouter", () => ({
  useLocation: () => ["/factory/sales/invoices/77", harness.navigate],
  useRoute: (pattern: string) => (pattern.includes(":id") ? [true, { id: "77" }] : [false, {}]),
  useSearch: () => "",
  useParams: () => ({ id: "77" }),
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

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));

describe("Wave H populated factory surfaces", () => {
  it("renders populated V5 allocation rows and exercises filters", async () => {
    const { default: FactoryStockAllocationV5 } = await import("@/pages/factory/FactoryStockAllocationV5");
    const data = {
      rows: [
        {
          articleCode: "BAL-101",
          productName: "Alpha Bale",
          categoryName: "Premium",
          stockAvailable: 20,
          totalLoaded: 4,
          expectedToLoad: 6,
          freeToPromise: 10,
          totalKg: 1200,
          proformaDetails: [
            {
              proformaId: 501,
              proformaName: "PRO-501",
              customerId: 10,
              customerName: "Alpha Customer",
              lineQty: 6,
              containerCount: 1,
              totalExpected: 6,
              containers: [
                {
                  orderId: 901,
                  containerName: "Container 1",
                  status: "DRAFT",
                  expectedQty: 6,
                  loadedQty: 0,
                  remainingQty: 6,
                },
              ],
            },
          ],
        },
        {
          articleCode: "BAL-NEG",
          productName: "Short Bale",
          categoryName: "Standard",
          stockAvailable: 2,
          totalLoaded: 4,
          expectedToLoad: 5,
          freeToPromise: -7,
          totalKg: 300,
          proformaDetails: [],
        },
        {
          articleCode: "WIP-1",
          productName: "Factory Wipers",
          categoryName: "Waste",
          stockAvailable: 9,
          totalLoaded: 0,
          expectedToLoad: 0,
          freeToPromise: 9,
          totalKg: 100,
          proformaDetails: [],
          isGarbageOrWipers: true,
        },
      ],
      totals: {
        stockAvailable: 31,
        totalLoaded: 8,
        expectedToLoad: 11,
        freeToPromise: 12,
        totalKg: 1600,
        shortageCount: 1,
      },
      productNames: {},
    };

    renderWithProviders(
      <TooltipProvider>
        <FactoryStockAllocationV5 />
      </TooltipProvider>,
      { seedQueries: [[["/api/factory/v5/stock-allocation", true, undefined], data]] }
    );

    expect(await screen.findAllByText("Alpha Bale")).not.toHaveLength(0);
    expect(screen.getAllByText("Short Bale")).not.toHaveLength(0);
    expect(screen.queryAllByText("Factory Wipers")).toHaveLength(0);
    expect(screen.getAllByText(/1 shortage/)).not.toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-v5-toggle-negative-only"));
    expect(screen.getAllByText("Short Bale")).not.toHaveLength(0);
    expect(screen.queryAllByText("Alpha Bale")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-v5-toggle-negative-only"));
    fireEvent.click(screen.getByTestId("button-v5-toggle-garbage-wipers"));
    expect(screen.getAllByText("Factory Wipers")).not.toHaveLength(0);

    fireEvent.change(screen.getByTestId("input-v5-search"), { target: { value: "BAL-101" } });
    expect(screen.getAllByText("Alpha Bale")).not.toHaveLength(0);
    expect(screen.queryAllByText("Short Bale")).toHaveLength(0);
  });

  it("renders populated OTW tracking metrics and filters a container list", async () => {
    const { default: FactoryOtwTrackingTab } = await import("@/pages/factory/FactoryOtwTrackingTab");
    const containers = [
      {
        id: 11,
        companyId: 1,
        containerNumber: "MSCU1234567",
        status: "IN_TRANSIT",
        supplierId: 2,
        supplierName: "Alpha Supplier",
        arrivalDate: "2026-08-18",
        currencyCode: "USD",
        finalPayableAmount: "1200",
        ratePerKg: "0",
        totalKg: "1000",
        freight: "200",
        freightCurrencyCode: "USD",
        commissionAmount: "50",
        commissionCurrencyCode: "USD",
        otwDocsReceived: true,
        otwNote: "Priority shipment",
        trackingEnabled: true,
        trackingLastCheckedAt: "2026-08-20T08:00:00.000Z",
      },
      {
        id: 12,
        companyId: 1,
        containerNumber: "OOLU7654321",
        status: "ARRIVED",
        supplierId: 3,
        supplierName: "Beta Supplier",
        arrivalDate: "2026-08-25",
        currencyCode: "EUR",
        finalPayableAmount: "0",
        ratePerKg: "2",
        totalKg: "500",
        freight: "0",
        freightCurrencyCode: "EUR",
        commissionAmount: "0",
        otwDocsReceived: false,
        trackingEnabled: false,
      },
    ];

    renderWithProviders(
      <TooltipProvider>
        <FactoryOtwTrackingTab />
      </TooltipProvider>,
      { seedQueries: [[["/api/factory/containers", "otw"], containers]] }
    );

    expect(await screen.findByText("MSCU1234567")).toBeInTheDocument();
    expect(screen.getByText("OOLU7654321")).toBeInTheDocument();
    expect(screen.getByText("Alpha Supplier")).toBeInTheDocument();
    expect(screen.getByText("Beta Supplier")).toBeInTheDocument();

    const search = screen.getByPlaceholderText(/Search/i);
    fireEvent.change(search, { target: { value: "MSCU" } });
    expect(screen.getByText("MSCU1234567")).toBeInTheDocument();
    expect(screen.queryByText("OOLU7654321")).not.toBeInTheDocument();
  });

  it("renders a populated factory invoice with lines, charges, totals and dispatch metadata", async () => {
    const { default: FactoryInvoiceDetail } = await import("@/pages/factory/FactoryInvoiceDetail");
    const order = {
      id: 77,
      companyId: 1,
      customerId: 10,
      orderDate: "2026-08-20",
      status: "FINALIZED",
      invoiceNumber: "INV-77",
      subtotalBales: "500",
      freightAmount: "40",
      otherChargesTotal: "10",
      grandTotal: "550",
      totalQtyBales: 3,
      customerName: "Alpha Customer",
      customerCode: "CUS-A",
      containerNumber: "CONT-77",
      shippingCompany: "Test Shipping",
      destination: "Lubumbashi",
      dispatchBatchId: 601,
      lines: [
        {
          articleCode: "BAL-101",
          baleName: "Alpha Bale",
          qty: 2,
          weightPerBale: 100,
          totalWeight: 200,
          pricePerBale: 150,
          totalPrice: 300,
          pricingMode: "PER_BALE",
        },
        {
          articleCode: "BAL-202",
          baleName: "Beta Bale",
          qty: 1,
          weightPerBale: 120,
          totalWeight: 120,
          pricePerBale: 200,
          totalPrice: 200,
          pricingMode: "PER_BALE",
        },
      ],
      bales: [
        {
          id: 1,
          baleId: 1001,
          baleReference: "REF-1001",
          locationId: 3,
          weight: 100,
          articleCode: "BAL-101",
          baleName: "Alpha Bale",
          priceUsed: 150,
        },
      ],
      charges: [
        { id: 1, name: "Freight", amount: "40", chargeType: "FREIGHT", ledgerAccountId: 21 },
        { id: 2, name: "Handling", amount: "10", chargeType: "OTHER", ledgerAccountId: 22 },
      ],
    };
    const dispatch = {
      batch: { id: 601, batchNumber: "DB-601", batchDate: "2026-08-20", status: "FINALIZED", currency: "USD" },
      customerName: "Alpha Customer",
      proforma: { id: 501, name: "PRO-501" },
      rides: [{ id: 1, rideNumber: 1, status: "LOADED", baleCount: 3, totalWeightKg: "320" }],
      totals: { totalBales: 3, totalWeightKg: "320", grandTotal: "550" },
    };

    renderWithProviders(<FactoryInvoiceDetail />, {
      seedQueries: [
        [["/api/factory/customer-orders", 77], order],
        [["/api/ledger-accounts?includeHidden=true"], [{ id: 21, name: "Freight Expense", code: "EXP-F" }]],
        [["/api/factory/my-access"], { hiddenCostFields: [], fullAccess: true }],
        [["/api/auth/me"], { id: "test-user", role: "Developer" }],
        [["/api/factory/customer-proformas", 10], [{ id: 501, name: "PRO-501", lines: [] }]],
        [["/api/factory/dispatch-batches", 601], dispatch],
      ],
    });

    expect(await screen.findByTestId("text-invoice-number")).toHaveTextContent("INV-77");
    expect(screen.getByTestId("text-customer-name")).toHaveTextContent("Alpha Customer");
    expect(screen.getByTestId("text-container-number")).toHaveTextContent("CONT-77");
    expect(screen.getByTestId("text-shipping-company")).toHaveTextContent("Test Shipping");
    expect(screen.getByTestId("text-destination")).toHaveTextContent("Lubumbashi");
    expect(screen.getByTestId("badge-status-finalized")).toBeInTheDocument();
    expect(screen.getByText("Alpha Bale")).toBeInTheDocument();
    expect(screen.getByText("Beta Bale")).toBeInTheDocument();
    expect(screen.getByText("DB-601")).toBeInTheDocument();
    expect(screen.getByTestId("button-scan-loading")).toBeInTheDocument();
  });
});
