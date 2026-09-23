import React, { createContext, useContext } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  selectCompany: vi.fn(),
  setLocation: vi.fn(),
  apiRequest: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
  queryError: null as Error | null,
  hiddenJournalVoucherIds: [] as number[],
}));

const journalData = {
  vouchers: [
    {
      id: 101,
      voucherDate: "2026-08-12",
      companyId: 4,
      companyName: "GC Lshi",
      voucherType: "Payment",
      voucherNumber: "PAY-101",
      description: "Supplier payment",
      narration: "Supplier payment",
      currency: "USD",
      totalAmount: "250",
      optional: false,
      deletedAt: null,
    },
    {
      id: 102,
      voucherDate: "2026-08-12",
      companyId: 5,
      companyName: "GC #2",
      voucherType: "Receipt",
      voucherNumber: "REC-102",
      description: "Customer receipt",
      narration: "Customer receipt",
      currency: "CFA",
      totalAmount: "12000",
      optional: false,
      deletedAt: null,
    },
  ],
  companies: [
    { id: 4, name: "GC Lshi" },
    { id: 5, name: "GC #2" },
  ],
  summary: [
    { companyId: 4, companyName: "GC Lshi", voucherCount: 2, currency: "USD", totalDebits: "250", totalCredits: "250" },
    {
      companyId: 5,
      companyName: "GC #2",
      voucherCount: 1,
      currency: "CFA",
      totalDebits: "12000",
      totalCredits: "12000",
    },
  ],
  total: 150,
  totalPages: 3,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    if (queryKey?.[0] === "/api/my-erp-pages") return { data: { hiddenErpCostFields: [] } };
    if (queryKey?.[0] === "/api/user-preferences") {
      return { data: { hiddenTransactionJournalVoucherIds: harness.hiddenJournalVoucherIds } };
    }
    if (queryKey?.[0] === "/api/global/transactions" && queryKey.length === 2) {
      return {
        data: journalData,
        error: harness.queryError,
        isLoading: false,
        isFetching: false,
        refetch: harness.refetch,
      };
    }
    if (queryKey?.[0] === "/api/global/transactions/voucher-types") return { data: ["Payment", "Receipt"] };
    if (queryKey?.[0] === "/api/global/transactions" && queryKey?.[2] === "detail")
      return { data: null, isLoading: false };
    if (queryKey?.[0] === "/api/global/transactions" && queryKey?.[2] === "view-entries")
      return { data: [], isLoading: false };
    return { data: undefined, isLoading: false, isFetching: false, refetch: harness.refetch };
  },
}));
vi.mock("wouter", () => ({ useLocation: () => ["/transaction-journal", harness.setLocation] }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectCompany: harness.selectCompany,
    companies: [
      { id: 4, name: "GC Lshi" },
      { id: 5, name: "GC #2" },
    ],
  }),
}));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ formatCashAmount: (value: unknown) => String(value) }),
}));
vi.mock("@/lib/queryClient", () => ({ apiRequest: harness.apiRequest }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/hooks/use-escape-back", () => ({ hasAnyOpenDialog: () => false }));
vi.mock("@/pages/transactionjournal/utils", () => ({
  companyColor: () => "company-color",
  fmtDate: (value: string) => `D:${value}`,
  formatAmount: (value: unknown) => Number(value).toLocaleString("en-US"),
}));
vi.mock("@/pages/transactionjournal/components/VoucherTypeBadge", () => ({
  VoucherTypeBadge: ({ type }: any) => <span data-testid="voucher-type">{type}</span>,
}));
vi.mock("@/components/ui/period-filter", () => ({
  getDefaultPeriodValue: () => ({ fromDate: "2026-08-12", toDate: "2026-08-12", preset: "today" }),
  PeriodFilter: ({ value, onChange }: any) => (
    <button
      type="button"
      data-testid="period-filter"
      onClick={() => onChange({ fromDate: "2026-08-01", toDate: "2026-08-12", preset: "custom" })}
    >
      {value.fromDate}:{value.toDate}
    </button>
  ),
}));

const SelectContext = createContext<((value: string) => void) | null>(null);
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: any) => (
    <SelectContext.Provider value={onValueChange}>{children}</SelectContext.Provider>
  ),
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: () => <span>selected</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => {
    const onChange = useContext(SelectContext);
    return (
      <button type="button" onClick={() => onChange?.(value)}>
        {children}
      </button>
    );
  },
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: any) => <span>{children}</span>,
  DropdownMenuSeparator: () => null,
  DropdownMenuCheckboxItem: ({ children, onCheckedChange, ...props }: any) => (
    <button type="button" onClick={() => onCheckedChange?.(true)} {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
}));

import TransactionJournal from "@/pages/TransactionJournal";

describe("transaction journal page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.queryError = null;
    harness.hiddenJournalVoucherIds = [];
    sessionStorage.clear();
  });

  it("aggregates company summaries and renders cross-company vouchers", () => {
    render(<TransactionJournal />);

    expect(screen.getByRole("heading", { name: /All Daybook/ })).toBeInTheDocument();
    expect(screen.getByTestId("card-company-summary-4")).toHaveTextContent("GC Lshi");
    expect(screen.getByTestId("card-company-summary-4")).toHaveTextContent("2");
    expect(screen.getByTestId("card-company-summary-4")).toHaveTextContent("USD Dr: 250");
    expect(screen.getByTestId("card-company-summary-5")).toHaveTextContent("CFA Dr: 12,000");
    expect(screen.getByTestId("row-voucher-101")).toHaveTextContent("Supplier payment");
    expect(screen.getByTestId("row-voucher-102")).toHaveTextContent("Customer receipt");
  });

  it("supports search, quick type filters, and factory inclusion", () => {
    render(<TransactionJournal />);
    expect(screen.getByTestId("button-toggle-factory")).toHaveTextContent("Excluded");

    fireEvent.change(screen.getByTestId("input-search"), { target: { value: "PAY-101" } });
    fireEvent.click(screen.getByTestId("button-search"));
    expect(screen.getByTestId("button-clear-search")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chip-type-payment"));
    fireEvent.click(screen.getByTestId("button-toggle-factory"));
    expect(screen.getByTestId("button-toggle-factory")).toHaveTextContent("Included");
  });

  it("resets pagination for every filter path and can clear the complete filter set", () => {
    render(<TransactionJournal />);

    fireEvent.click(screen.getByTestId("button-next-page"));
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chip-type-payment"));
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-next-page"));
    fireEvent.click(screen.getByTestId("checkbox-company-4"));
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-next-page"));
    fireEvent.change(screen.getByTestId("input-search"), { target: { value: "PAY-101" } });
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();

    expect(screen.getByTestId("button-reset-filters")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-reset-filters"));
    expect(screen.getByTestId("input-search")).toHaveValue("");
    expect(screen.getByTestId("button-toggle-factory")).toHaveTextContent("Excluded");
    expect(screen.queryByTestId("button-reset-filters")).not.toBeInTheDocument();
  });

  it("hides individual rows and persists the per-user preference until unhidden", async () => {
    render(<TransactionJournal />);
    fireEvent.click(screen.getByTestId("button-hide-voucher-101"));
    expect(screen.queryByTestId("row-voucher-101")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-toggle-show-hidden")).toHaveTextContent("1");
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("PUT", "/api/user-preferences", {
        hiddenTransactionJournalVoucherIds: [101],
      })
    );

    fireEvent.click(screen.getByTestId("button-toggle-show-hidden"));
    expect(screen.getByTestId("row-voucher-101")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-clear-hidden-rows"));
    expect(screen.getByTestId("row-voucher-101")).toBeInTheDocument();
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("PUT", "/api/user-preferences", {
        hiddenTransactionJournalVoucherIds: [],
      })
    );
  });

  it("restores hidden rows from the signed-in user's saved preference", async () => {
    harness.hiddenJournalVoucherIds = [101];
    render(<TransactionJournal />);

    await waitFor(() => expect(screen.queryByTestId("row-voucher-101")).not.toBeInTheDocument());
    expect(screen.getByTestId("row-voucher-102")).toBeInTheDocument();
    expect(screen.getByTestId("button-toggle-show-hidden")).toHaveTextContent("1");
  });

  it("switches to a voucher company before navigating to its Daybook", async () => {
    render(<TransactionJournal />);
    fireEvent.click(screen.getByTestId("button-edit-voucher-102"));

    await waitFor(() => expect(harness.selectCompany).toHaveBeenCalledWith(expect.objectContaining({ id: 5 })));
    await waitFor(() => expect(harness.setLocation).toHaveBeenCalledWith("/daybook?voucherId=102"), { timeout: 1000 });
  });

  it("navigates the journal date with keyboard shortcuts and refreshes explicitly", () => {
    render(<TransactionJournal />);
    const period = screen.getByTestId("period-filter");
    expect(period).toHaveTextContent("2026-08-12:2026-08-12");
    fireEvent.keyDown(window, { key: "-", code: "Minus" });
    expect(period).toHaveTextContent("2026-08-11:2026-08-11");
    fireEvent.keyDown(window, { key: "=", code: "Equal" });
    expect(period).toHaveTextContent("2026-08-12:2026-08-12");

    fireEvent.click(screen.getByTestId("button-refresh-journal"));
    expect(harness.refetch).toHaveBeenCalled();
  });

  it("shows a retryable error instead of presenting a failed request as an empty list", () => {
    harness.queryError = new Error("No access to the selected company");
    render(<TransactionJournal />);

    expect(screen.getByTestId("journal-error")).toHaveTextContent("No access to the selected company");
    expect(screen.getByTestId("button-journal-retry")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-journal-retry"));
    expect(harness.refetch).toHaveBeenCalled();
    expect(screen.queryByText("No transactions found for the selected filters.")).not.toBeInTheDocument();
  });
});
