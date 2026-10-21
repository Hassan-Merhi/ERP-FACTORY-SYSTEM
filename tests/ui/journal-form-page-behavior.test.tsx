import React, { createContext, useContext } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  modeApiRequest: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueriesData: vi.fn(),
  setLocation: vi.fn(),
  discardDraft: vi.fn(),
  scheduleSave: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = queryKey?.[0];
    if (root === "/api/bank-accounts") return { data: [], isFetched: true };
    if (root === "/api/ledger-accounts?profile=voucher-picker") {
      return {
        data: [
          { id: 1, name: "Cash", code: "CASH" },
          { id: 2, name: "Sales Revenue", code: "SALES" },
        ],
        isFetched: true,
      };
    }
    if (root === "/api/suppliers") return { data: [], isFetched: true };
    if (root === "/api/customers") return { data: [], isFetched: true };
    if (root === "/api/employees") return { data: [] };
    if (root === "/api/fixed-assets") return { data: [] };
    if (root === "/api/accounts/voucher-sidebar") {
      return {
        data: [
          { type: "ledger", id: 1, name: "Cash", balance: 500 },
          { type: "ledger", id: 2, name: "Sales Revenue", balance: -200 },
        ],
      };
    }
    if (root === "/api/factory/suppliers") return { data: [] };
    return { data: undefined, isFetched: true };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value?: any) => {
      try {
        const result = await config.mutationFn(value);
        await config.onSuccess?.(result, value);
        return result;
      } catch (error) {
        config.onError?.(error, value);
        return undefined;
      }
    }),
  }),
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 4, name: "GC Lshi", companyType: "erp" } }),
}));
vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => "erp",
  useModePrefix: () => "",
}));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({
    formatAmount: (value: unknown) => `$${Number(value).toFixed(2)}`,
    selectedCurrency: "USD",
    convertToUSD: (value: number) => value,
  }),
}));
vi.mock("@/lib/factoryApi", () => ({ getApiRequest: () => harness.modeApiRequest }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: {
    invalidateQueries: harness.invalidateQueries,
    setQueriesData: harness.setQueriesData,
  },
  keyStartsWith: (prefix: string) => () => prefix,
}));
vi.mock("wouter", () => ({ useLocation: () => ["/vouchers", harness.setLocation] }));
vi.mock("@/hooks/useFormDraft", () => ({
  useFormDraft: () => ({
    hasDraft: false,
    draftAge: null,
    draft: null,
    scheduleSave: harness.scheduleSave,
    discardDraft: harness.discardDraft,
  }),
}));
vi.mock("@/lib/whatsapp-prompt", () => ({ resolveWhatsAppPrompt: () => null }));
vi.mock("@/components/ExchangeRateInput", () => ({ ExchangeRateInput: () => null }));
vi.mock("@/components/vouchers/CreateAccountModal", () => ({ CreateAccountModal: () => null }));
vi.mock("@/components/DraftRestorePrompt", () => ({ DraftRestorePrompt: () => null }));
vi.mock("@/components/vouchers/PrintTemplate", () => ({
  parseDateLocal: (value: string) => new Date(`${value}T00:00:00`),
}));
vi.mock("@/lib/excelHelper", () => ({
  utils: { json_to_sheet: vi.fn(() => ({})), book_new: vi.fn(() => ({})), book_append_sheet: vi.fn() },
  writeFile: vi.fn(),
}));

const SelectContext = createContext<((value: string) => void) | null>(null);
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange }: any) => (
    <SelectContext.Provider value={onValueChange}>{children}</SelectContext.Provider>
  ),
  SelectTrigger: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder ?? "selected"}</span>,
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
  DropdownMenuItem: ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: any) => <div>{children}</div>,
  AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

import { JournalForm } from "@/pages/vouchers/JournalForm";

function chooseAccount(row: number, name: string) {
  const input = screen.getByTestId(`input-journal-account-${row}`);
  fireEvent.focus(input);
  const option = screen.getAllByRole("button").find((button) => button.textContent?.includes(name));
  expect(option).toBeDefined();
  fireEvent.mouseDown(option!);
}

describe("journal voucher form behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.modeApiRequest.mockResolvedValue({ ok: true, json: async () => ({ id: 90, voucherNumber: "JRN-90" }) });
  });

  it("starts balanced at zero and adds journal rows from the spreadsheet footer", () => {
    render(<JournalForm />);
    expect(screen.getByText("Balanced")).toBeInTheDocument();
    expect(screen.getByTestId("input-journal-amount-0")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-journal-add-row"));
    expect(screen.getByTestId("input-journal-amount-1")).toBeInTheDocument();
  });

  it("auto-fills a newly switched credit row with the remaining debit balance", () => {
    render(<JournalForm />);
    chooseAccount(0, "Cash");
    fireEvent.change(screen.getByTestId("input-journal-amount-0"), { target: { value: "125" } });
    fireEvent.click(screen.getByTestId("button-journal-add-row"));
    chooseAccount(1, "Sales Revenue");

    fireEvent.click(screen.getByTestId("input-journal-type-1"));
    const creditOption = screen.getAllByRole("button", { name: "CR" }).at(-1)!;
    fireEvent.click(creditOption);

    expect(screen.getByTestId("input-journal-amount-1")).toHaveValue(125);
    expect(screen.getByText("Balanced")).toBeInTheDocument();
  });

  it("posts a balanced journal with exact account, currency, notes, and effective-date metadata", async () => {
    render(<JournalForm />);
    chooseAccount(0, "Cash");
    fireEvent.change(screen.getByTestId("input-journal-amount-0"), { target: { value: "100" } });
    fireEvent.change(screen.getByTestId("input-journal-effective-date"), { target: { value: "2026-08-10" } });
    fireEvent.change(screen.getByTestId("input-journal-notes"), { target: { value: "Balance correction" } });
    fireEvent.click(screen.getByTestId("button-journal-add-row"));
    chooseAccount(1, "Sales Revenue");
    fireEvent.click(screen.getByTestId("input-journal-type-1"));
    fireEvent.click(screen.getAllByRole("button", { name: "CR" }).at(-1)!);

    await waitFor(() => expect(screen.getByTestId("input-journal-amount-1")).toHaveValue(100));
    expect(screen.getByText("Balanced")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-save-journal-voucher"));

    await waitFor(() =>
      expect(harness.modeApiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/vouchers/journal",
        expect.objectContaining({
          entries: [
            expect.objectContaining({
              type: "DR",
              accountType: "ledger",
              accountId: 1,
              accountName: "Cash",
              amount: "100",
            }),
            expect.objectContaining({
              type: "CR",
              accountType: "ledger",
              accountId: 2,
              accountName: "Sales Revenue",
              amount: "100",
            }),
          ],
          notes: "Balance correction",
          optional: false,
          currency: "USD",
          effectiveDate: "2026-08-10",
        })
      )
    );
    expect(harness.discardDraft).toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Success" }));
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/vouchers"] });
  });

  it("does not render the journal form for POS-only users", () => {
    const { container } = render(<JournalForm isPOS />);
    expect(container).toBeEmptyDOMElement();
  });
});
