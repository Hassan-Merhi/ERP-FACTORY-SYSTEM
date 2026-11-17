import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const emptyData: unknown[] = [];
  const erpPages = { hiddenErpCostFields: [] as string[] };
  const vouchers = [
    {
      id: 1,
      voucherNumber: "S-1",
      voucherDate: "2026-08-11",
      voucherType: "Sales",
      description: "sale",
      totalAmount: "100",
      optional: false,
    },
    {
      id: 2,
      voucherNumber: "J-2",
      voucherDate: "2026-08-11",
      voucherType: "Journal",
      description: "journal",
      totalAmount: "50",
      optional: false,
    },
  ];
  const paginatedResponse = {
    data: [] as unknown[],
    page: 1,
    pageSize: 100,
    total: 2,
    totalPages: 1,
    hasMore: false,
    summary: { total: 2, active: 2, optional: 0, totalAmount: 150 },
  };
  const formValues = { entries: [] as unknown[] };
  const formApi = {
    control: {},
    reset: vi.fn(),
    setValue: vi.fn(),
    getValues: vi.fn(() => formValues),
    handleSubmit: (fn: any) => fn,
    watch: vi.fn(() => formValues.entries),
    formState: { errors: {} },
  };
  const fieldArrayApi = {
    fields: [] as unknown[],
    append: vi.fn(),
    remove: vi.fn(),
    replace: vi.fn(),
  };
  return {
    navigate: vi.fn(),
    toast: vi.fn(),
    saveDaybookState: vi.fn(),
    invalidateCompanyApiFamily: vi.fn(),
    apiRequest: vi.fn(),
    loadAllVouchers: vi.fn(),
    refetch: vi.fn(),
    emptyData,
    erpPages,
    vouchers,
    paginatedResponse,
    formApi,
    fieldArrayApi,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const root = Array.isArray(queryKey) ? queryKey[0] : queryKey;
    if (root === "/api/my-erp-pages") {
      return {
        data: harness.erpPages,
        isLoading: false,
        isError: false,
        error: null,
        refetch: harness.refetch,
      };
    }
    return {
      data: harness.emptyData,
      isLoading: false,
      isError: false,
      error: null,
      refetch: harness.refetch,
    };
  },
  useMutation: (config: any) => ({
    isPending: false,
    mutate: vi.fn(async (value: any) => {
      const result = await config.mutationFn(value);
      config.onSuccess?.(result);
      return result;
    }),
  }),
}));
vi.mock("react-hook-form", () => ({
  useForm: () => harness.formApi,
  useFieldArray: () => harness.fieldArrayApi,
}));
vi.mock("@hookform/resolvers/zod", () => ({ zodResolver: () => undefined }));
vi.mock("wouter", () => ({ useLocation: () => ["/daybook", harness.navigate] }));
vi.mock("@/contexts/CompanyContext", () => ({
  // No provider role: the shared change-access helper leaves controls as they are.
  useOptionalCompany: () => null,
  useCompany: () => ({
    selectedCompany: { id: 4, name: "GC Lshi", companyType: "standard" },
  }),
}));
vi.mock("@/contexts/CurrencyContext", () => ({
  // The Daybook formats totals with formatHistoricalBaseAmount (#2973) and
  // per-transaction amounts with formatTransactionAmount.
  useCurrencyContext: () => ({
    formatAmount: (value: unknown) => `$${value}`,
    formatHistoricalBaseAmount: (value: unknown) => `$${value}`,
    formatTransactionAmount: (value: unknown) => `$${value}`,
  }),
}));
vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({
    formatDisplayDate: (d: string) => `D:${d}`,
    formatDisplayTime: (d: string) => `T:${d}`,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/hooks/use-escape-back", () => ({ hasAnyOpenDialog: () => false }));
vi.mock("@/hooks/use-date-jump", () => ({ useDateJump: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/lib/frontendDataArchitecture", () => ({
  canonicalApiUrl: (url: string) => url,
  companyDataKey: (url: string, companyId: number) => [url, companyId],
  frontendQueryPolicies: { reference: {}, live: {}, operational: {} },
  invalidateCompanyApiFamily: harness.invalidateCompanyApiFamily,
}));
vi.mock("@/lib/migratedVoucherGuard", () => ({
  isReadonlyMigratedVoucher: () => false,
  isGoldenCoastProgrammeVoucher: () => false,
  isVoucherMutationBlocked: () => false,
}));
vi.mock("@/lib/abortError", () => ({ isBlockingQueryError: () => false }));
vi.mock("@/lib/excelHelper", () => ({
  utils: {
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
}));
vi.mock("@/components/ui/period-filter", () => ({
  getDefaultPeriodValue: () => ({
    fromDate: "2026-08-11",
    toDate: "2026-08-11",
    preset: "today",
  }),
}));
vi.mock("@/pages/daybook/state", () => ({
  loadDaybookState: () => ({ viewMode: "detailed" }),
  saveDaybookState: harness.saveDaybookState,
}));
vi.mock("@/pages/daybook/usePaginatedDaybookVouchers", () => ({
  usePaginatedDaybookVouchers: () => ({
    vouchers: harness.vouchers,
    response: harness.paginatedResponse,
    isLoading: false,
    isError: false,
    error: null,
    refetch: harness.refetch,
    loadAllVouchers: harness.loadAllVouchers,
  }),
}));

vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({ title, subtitle, children }: any) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </header>
  ),
}));
vi.mock("@/components/PaginationBar", () => ({
  PaginationBar: ({ total }: any) => <div data-testid="pagination-total">{total}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: any) => <div>{children}</div>,
  TabsList: ({ children }: any) => <div>{children}</div>,
  TabsTrigger: ({ children }: any) => <button>{children}</button>,
  TabsContent: ({ children }: any) => <section>{children}</section>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: any) => (open ? <div data-testid="delete-dialog">{children}</div> : null),
  AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: any) => <button>{children}</button>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/pages/settings/AuditLog", () => ({ AuditLog: () => <div>Audit activity</div> }));
vi.mock("@/pages/daybook/DaybookFilters", () => ({
  DaybookFilters: ({ periodFilter, onPrevDay, onNextDay }: any) => (
    <div>
      <span data-testid="period">
        {periodFilter.fromDate}:{periodFilter.toDate}
      </span>
      <button onClick={onPrevDay}>Previous day</button>
      <button onClick={onNextDay}>Next day</button>
    </div>
  ),
}));
vi.mock("@/pages/daybook/DaybookTable", () => ({
  DaybookTable: ({ displayedRows, viewMode, handleView, handleEdit, handleDelete }: any) => (
    <div data-testid="daybook-table">
      <span>
        {viewMode}:{displayedRows.length}
      </span>
      {displayedRows
        .filter((r: any) => r._type === "voucher")
        .map((r: any) => (
          <div key={r.data.id}>
            <button onClick={() => handleView(r.data)}>View {r.data.id}</button>
            <button onClick={() => handleEdit(r.data)}>Edit {r.data.id}</button>
            <button onClick={() => handleDelete(r.data)}>Delete {r.data.id}</button>
          </div>
        ))}
    </div>
  ),
}));
vi.mock("@/pages/daybook/VoucherDetailsDialog", () => ({
  VoucherDetailsDialog: ({ open, selectedVoucher }: any) =>
    open ? <div data-testid="details-dialog">{selectedVoucher?.voucherNumber}</div> : null,
}));
vi.mock("@/pages/daybook/VoucherEditDialog", () => ({
  VoucherEditDialog: ({ open }: any) => (open ? <div data-testid="edit-dialog">edit voucher</div> : null),
}));

import Daybook from "@/pages/Daybook";

describe("Daybook page behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    harness.apiRequest.mockResolvedValue({ ok: true, json: async () => ({}) });
    harness.loadAllVouchers.mockResolvedValue([
      {
        id: 1,
        voucherNumber: "S-1",
        voucherDate: "2026-08-11",
        voucherType: "Sales",
        totalAmount: "100",
        optional: false,
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" }))
    );
  });

  it("renders chronological voucher rows and opens voucher details", () => {
    render(<Daybook user={{ role: "Admin" }} />);
    expect(screen.getByRole("heading", { name: "Daybook" })).toBeInTheDocument();
    expect(screen.getByTestId("daybook-table")).toHaveTextContent("detailed:2");
    expect(screen.getByTestId("pagination-total")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: "View 2" }));
    expect(screen.getByTestId("details-dialog")).toHaveTextContent("J-2");
  });

  it("navigates sales edits to POS and journal edits to the correct voucher tab", () => {
    render(<Daybook user={{ role: "Admin" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit 1" }));
    expect(harness.navigate).toHaveBeenCalledWith("/pos/edit/1");
    fireEvent.click(screen.getByRole("button", { name: "Edit 2" }));
    expect(harness.navigate).toHaveBeenCalledWith("/vouchers?edit=2&tab=journal&from=daybook");
  });

  it("moves the selected day with controls and keyboard shortcuts", () => {
    render(<Daybook user={{ role: "Admin" }} />);
    expect(screen.getByTestId("period")).toHaveTextContent("2026-08-11:2026-08-11");
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByTestId("period")).toHaveTextContent("2026-08-10:2026-08-10");
    fireEvent.keyDown(window, { key: "=", code: "Equal" });
    expect(screen.getByTestId("period")).toHaveTextContent("2026-08-11:2026-08-11");
  });

  it("persists condensed/detailed view choice and executes delete mutation", async () => {
    render(<Daybook user={{ role: "Admin" }} />);
    fireEvent.click(screen.getByTestId("button-view-condensed"));
    expect(harness.saveDaybookState).toHaveBeenCalledWith({ viewMode: "condensed" });
    fireEvent.click(screen.getByTestId("button-view-detailed"));
    expect(harness.saveDaybookState).toHaveBeenCalledWith({ viewMode: "detailed" });

    // The delete first asks the server whether the voucher is part of a linked
    // intercompany trade; an unlinked voucher falls through to the normal delete.
    const linkLookup = vi.fn(async () => ({ ok: true, json: async () => ({ linked: {} }) }));
    vi.stubGlobal("fetch", linkLookup);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
      expect(screen.getByTestId("delete-dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(harness.apiRequest).toHaveBeenCalledWith("DELETE", "/api/vouchers/2"));
      expect(linkLookup).toHaveBeenCalledWith(
        "/api/intercompany-container-trading/daybook-linked-vouchers?ids=2",
        expect.objectContaining({ credentials: "include" })
      );
      expect(harness.invalidateCompanyApiFamily).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
