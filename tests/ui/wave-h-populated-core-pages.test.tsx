import React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/", harness.navigate],
  useRoute: () => [false, {}],
  useSearch: () => "",
  useParams: () => ({}),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  Route: ({ component: Component }: any) => (Component ? <Component /> : null),
  Switch: ({ children }: any) => <>{children}</>,
  Redirect: () => null,
}));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => "erp",
  useModePrefix: () => "",
  AppModeProvider: ({ children }: any) => <>{children}</>,
  getModePrefix: () => "",
}));

vi.mock("@/contexts/CompanyContext", () => {
  const companyState = () => ({
    selectedCompany: { id: 1, name: "Test Co", code: "TC", active: true, companyType: "erp" as const, role: "Admin" },
    companies: [
      { id: 1, name: "Test Co", code: "TC", active: true, companyType: "erp" as const },
      { id: 2, name: "Second Co", code: "SC", active: true, companyType: "erp" as const },
    ],
    isLoading: false,
    selectCompany: vi.fn(),
  });
  return {
    useCompany: companyState,
    // Read by useExistingRecordChangeAccess for role-based control gating.
    useOptionalCompany: companyState,
    CompanyProvider: ({ children }: any) => <>{children}</>,
  };
});

vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({
    selectedCurrency: "USD",
    exchangeRate: 1,
    isLoadingRate: false,
    isLoadingCompany: false,
    baseCurrency: "USD",
    displayCurrency: "USD",
    isMultiCurrency: false,
    formatAmount: (value: any) => `$${Number(value ?? 0).toFixed(2)}`,
    formatAmountRaw: (value: any) => `$${Number(value ?? 0).toFixed(2)}`,
    formatCashAmount: (value: any) => `$${Number(value ?? 0).toFixed(2)}`,
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
    formatDisplayDate: (date: any) => String(date),
    formatShortDate: (date: any) => String(date),
    formatDisplayTime: (date: any) => String(date),
    formatDisplayDateTime: (date: any) => String(date),
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
vi.mock("@/hooks/use-date-jump", () => ({ useDateJump: vi.fn() }));
vi.mock("@/hooks/use-escape-back", () => ({ useEscapeBack: vi.fn() }));
vi.mock("react-to-print", () => ({ useReactToPrint: () => vi.fn() }));
vi.mock("@/lib/excelHelper", () => ({
  utils: {
    aoa_to_sheet: vi.fn(() => ({})),
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  },
  writeFile: harness.writeFile,
}));
vi.mock("@/components/vouchers/PrintTemplate", () => ({
  parseDateLocal: (value: string) => new Date(`${value}T00:00:00`),
}));

import Agents from "@/pages/Agents";
import CombinedInventory from "@/pages/CombinedInventory";
import Suppliers from "@/pages/Suppliers";
import { StockAdjustmentForm } from "@/pages/vouchers/StockAdjustmentForm";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

describe("Wave H populated core-page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([]))
    );
  });

  it("combines OTW and in-hand inventory, promotes legacy name matches, and drills into a stock group", async () => {
    renderWithProviders(<CombinedInventory />, {
      seedQueries: [
        [["/api/containers"], [{ id: 7, status: "OTW" }]],
        [
          ["/api/containers/7"],
          {
            pos: [
              {
                items: [
                  {
                    stockItemId: 11,
                    stockItemName: "Alpha Bale",
                    stockGroupId: 3,
                    stockGroupName: "Bales",
                    quantity: "4",
                    rate: "5",
                  },
                  {
                    stockItemId: null,
                    stockItemName: "Legacy Bale",
                    stockGroupId: 3,
                    stockGroupName: "Bales",
                    quantity: "2",
                    rate: "3",
                  },
                ],
              },
            ],
          },
        ],
        [
          ["/api/inventory", 1],
          {
            data: [
              {
                stockItemId: 11,
                stockItemName: "Alpha Bale",
                stockItemCode: "A11",
                quantity: "6",
                averageRate: "4",
                totalValue: "24",
                stockGroupId: 3,
                stockGroupName: "Bales",
              },
              {
                stockItemId: 12,
                stockItemName: "Legacy Bale",
                stockItemCode: "L12",
                quantity: "3",
                averageRate: "2",
                totalValue: "6",
                stockGroupId: 3,
                stockGroupName: "Bales",
              },
            ],
            total: 2,
            page: 1,
            pageSize: 100,
            totalPages: 1,
          },
        ],
      ],
    });

    expect(await screen.findByTestId("stat-items")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-otw")).toHaveTextContent("6");
    expect(screen.getByTestId("stat-inhand")).toHaveTextContent("9");
    expect(screen.getByTestId("stat-total")).toHaveTextContent("15");
    expect(screen.getByTestId("total-combined-value")).toHaveTextContent("$50.00");

    fireEvent.click(screen.getByTestId("row-group-3"));
    expect(await screen.findByTestId("button-back-to-groups")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha Bale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Legacy Bale").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("input-search-combined"), { target: { value: "Alpha" } });
    expect(screen.getAllByText("Alpha Bale").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Legacy Bale")).toHaveLength(0);
  });

  it("renders supplier portfolio totals and opens a populated ledger with purchase orders", async () => {
    renderWithProviders(<Suppliers />, {
      seedQueries: [
        [
          ["/api/suppliers/stats", 1],
          [
            {
              id: 1,
              code: "SUP-A",
              legalName: "Alpha Supplier",
              email: "alpha@example.test",
              phone: null,
              address: null,
              taxId: null,
              paymentTerms: "30 days",
              active: true,
              containerCount: 2,
              balance: 130,
            },
            {
              id: 2,
              code: "SUP-Z",
              legalName: "Zero Supplier",
              email: "zero@example.test",
              phone: null,
              address: null,
              taxId: null,
              paymentTerms: null,
              active: false,
              containerCount: 1,
              balance: 0,
            },
          ],
        ],
        [
          ["/api/companies"],
          [
            { id: 1, name: "Test Co" },
            { id: 2, name: "Second Co" },
          ],
        ],
        [
          ["/api/suppliers/1/unified-ledger", 1],
          [
            { type: "opening", date: "2026-08-01", balance: 100 },
            {
              type: "transaction",
              date: "2026-08-10",
              companyId: 1,
              companyName: "Test Co",
              docNumber: "PUR-1",
              voucherId: 81,
              voucherType: "Purchase",
              description: "Stock purchase",
              debit: "0",
              credit: "50",
              balance: 150,
            },
            {
              type: "transaction",
              date: "2026-08-11",
              companyId: 1,
              companyName: "Test Co",
              docNumber: "PAY-1",
              voucherId: 82,
              voucherType: "Payment",
              description: "Supplier payment",
              debit: "20",
              credit: "0",
              balance: 130,
            },
          ],
        ],
        [
          ["/api/suppliers/1/purchase-orders", 1],
          [
            {
              id: 501,
              companyId: 1,
              poNumber: "PO-501",
              orderDate: "2026-08-09",
              totalAmount: "50",
              containerId: 700,
              containerNumber: "CONT-700",
              status: "OPEN",
            },
          ],
        ],
      ],
    });

    expect(await screen.findByTestId("text-active-suppliers")).toHaveTextContent("1");
    expect(screen.getByTestId("text-total-containers")).toHaveTextContent("3");
    expect(screen.getByTestId("text-total-balance")).toHaveTextContent("$130.00");
    expect(screen.getByTestId("row-supplier-1")).toBeInTheDocument();
    expect(screen.queryByTestId("row-supplier-2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("row-supplier-1"));
    const supplierDialog = await screen.findByRole("dialog");
    expect(within(supplierDialog).getByRole("heading", { name: "Alpha Supplier" })).toBeInTheDocument();
    const purchasesKpi = screen.getByText("Total Purchases").parentElement;
    const paymentsKpi = screen.getByText("Total Payments").parentElement;
    expect(purchasesKpi && within(purchasesKpi).getByText("$50.00")).toBeTruthy();
    expect(paymentsKpi && within(paymentsKpi).getByText("$20.00")).toBeTruthy();
    expect(screen.getByTestId("tab-purchase-orders")).toHaveTextContent("(1)");
    expect(screen.getByTestId("button-export-excel")).toBeEnabled();

    fireEvent.click(screen.getByTestId("button-date-filter-today"));
    expect(await screen.findByText(/0 results/)).toBeInTheDocument();
  });

  it("loads an agent ledger, groups voucher entries, and enables statement export", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/accounts/customer/101/transactions")) {
        return jsonResponse([
          {
            entryId: 1,
            voucherId: 91,
            debitAmount: "30",
            creditAmount: "0",
            narration: "Sale line",
            voucherNumber: "JV-91",
            voucherType: "Journal",
            voucherDate: "2026-08-20",
            voucherDescription: "Agent sale",
          },
          {
            entryId: 2,
            voucherId: 91,
            debitAmount: "0",
            creditAmount: "5",
            narration: "Discount line",
            voucherNumber: "JV-91",
            voucherType: "Journal",
            voucherDate: "2026-08-20",
            voucherDescription: "Agent sale",
          },
        ]);
      }
      if (url.includes("/pre-period-balance")) return jsonResponse({ balance: 25 });
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<Agents />, {
      seedQueries: [
        [
          ["/api/accounts/all", 1],
          [
            {
              id: "agent-1",
              accountId: 101,
              type: "customer",
              code: "AG-1",
              name: "Alpha Agent",
              balance: 75,
              balanceSide: "Dr",
              openingBalance: 10,
              openingBalanceSide: "Dr",
              active: true,
            },
            {
              id: "available-2",
              accountId: 102,
              type: "customer",
              code: "AG-2",
              name: "Available Account",
              balance: 0,
              balanceSide: null,
              openingBalance: 0,
              active: true,
            },
          ],
        ],
        [
          ["/api/agent-accounts", 1],
          [{ id: 1, companyId: 1, accountId: "agent-1", accountType: "customer", accountName: "Alpha Agent" }],
        ],
        [
          ["/api/accounts/customer/101/transactions", { startDate: "2026-08-20", endDate: "2026-08-20" }],
          [
            {
              entryId: 1,
              voucherId: 91,
              debitAmount: "30",
              creditAmount: "0",
              narration: "Sale line",
              voucherNumber: "JV-91",
              voucherType: "Journal",
              voucherDate: "2026-08-20",
              voucherDescription: "Agent sale",
            },
            {
              entryId: 2,
              voucherId: 91,
              debitAmount: "0",
              creditAmount: "5",
              narration: "Discount line",
              voucherNumber: "JV-91",
              voucherType: "Journal",
              voucherDate: "2026-08-20",
              voucherDescription: "Agent sale",
            },
          ],
        ],
        [["/api/accounts/customer/101/pre-period-balance", { endDate: "2026-08-20" }], { balance: 25 }],
      ],
    });

    expect(await screen.findByTestId("button-select-agent-agent-1")).toHaveTextContent("Alpha Agent");
    fireEvent.click(screen.getByTestId("button-select-agent-agent-1"));

    expect(await screen.findByTestId("text-agent-account-name")).toHaveTextContent("Alpha Agent");
    expect(screen.getByTestId("text-agent-balance")).toHaveTextContent("$75.00");
    await waitFor(() => expect(screen.getByTestId("button-export-excel")).toBeEnabled());
    const voucherRow = screen.getByTestId("row-voucher-91");
    expect(voucherRow).toHaveTextContent("Journal");
    expect(voucherRow).toHaveTextContent("Agent sale");
    expect(voucherRow).toHaveTextContent("$30.00");
    expect(voucherRow).toHaveTextContent("$5.00");

    fireEvent.click(screen.getByTestId("button-add-agent"));
    expect(await screen.findByText("Available Account")).toBeInTheDocument();
  });

  it("hydrates a mixed stock adjustment from persisted signed quantities and location inventory", async () => {
    renderWithProviders(<StockAdjustmentForm voucherIdToEdit={900} isPOS={false} />, {
      seedQueries: [
        [
          ["/api/stock-items/light", 1],
          [
            { id: 11, code: "A11", name: "Alpha Bale", uom: "EA" },
            { id: 12, code: "B12", name: "Beta Bale", uom: "EA" },
          ],
        ],
        [
          ["/api/locations", 1],
          [
            { id: 2, code: "WH1", name: "Warehouse 1" },
            { id: 3, code: "WH2", name: "Warehouse 2" },
          ],
        ],
        [["/api/vouchers", 900], { id: 900, voucherDate: "2026-08-19", optional: true }],
        [
          ["/api/stock-adjustments", 900],
          {
            id: 77,
            voucherId: 900,
            locationId: 2,
            notes: "Repack",
            items: [
              { stockItemId: 11, quantity: "-3", rate: "10" },
              { stockItemId: 12, quantity: "2", rate: "14" },
            ],
          },
        ],
        [
          ["/api/adjustment-location-inventory", 2],
          [
            { stockItemId: 11, quantity: "20", averageRate: "10" },
            { stockItemId: 12, quantity: "8", averageRate: "14" },
          ],
        ],
      ],
    });

    const firstType = (await screen.findByTestId("input-adjustment-type-0")) as HTMLInputElement;
    const firstQty = screen.getByTestId("input-adjustment-qty-0") as HTMLInputElement;
    const firstRate = screen.getByTestId("input-adjustment-rate-0") as HTMLInputElement;
    const secondType = screen.getByTestId("input-adjustment-type-1") as HTMLInputElement;
    const secondQty = screen.getByTestId("input-adjustment-qty-1") as HTMLInputElement;

    await waitFor(() => expect(firstType.value).toBe("Consume"));
    expect(firstQty.value).toBe("3");
    expect(firstRate.value).toBe("10");
    expect(secondType.value).toBe("Produce");
    expect(secondQty.value).toBe("2");
    expect(screen.getByTestId("input-adjustment-item-0")).toHaveValue("Alpha Bale");
    expect(screen.getByTestId("input-adjustment-item-1")).toHaveValue("Beta Bale");

    fireEvent.focus(screen.getByTestId("input-adjustment-item-0"));
    fireEvent.change(screen.getByTestId("input-adjustment-item-0"), { target: { value: "Beta" } });
    fireEvent.keyDown(screen.getByTestId("input-adjustment-item-0"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("input-adjustment-qty-0")).toHaveFocus());
  });
});
