/**
 * Cash/bank statement reconciliation state (client/src/pages/useCashBankReconciliationState.tsx).
 *
 * Reconciliation never posts a voucher: it imports a bank statement, then
 * matches each statement line to an existing voucher entry of the same exact
 * amount and currency, or classifies it for investigation. These cases pin the
 * upload form, the matching rules the screen enforces before it lets anyone
 * match, and the requests behind match, review and unmatch.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  location: "/cash-bank-reconciliation",
  apiRequest: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  detail: undefined as unknown,
}));

const ACCOUNTS = [
  { accountKind: "bank", accountId: 3, name: "Zanaco USD" },
  { accountKind: "cash", accountId: 9, name: "Shop cash" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    if (enabled === false) return { data: undefined };
    if (queryKey[0] === "/api/accounting/cash-bank/accounts") return { data: ACCOUNTS };
    if (queryKey[0] === "cash-bank-statements") return { data: [{ id: 70 }], queryKey };
    if (queryKey[0] === "cash-bank-detail") return { data: harness.detail };
    return { data: undefined };
  },
  useMutation: (options: {
    mutationFn: (variables: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown) => unknown;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (variables?: unknown) =>
      Promise.resolve()
        .then(() => options.mutationFn(variables))
        .then(
          (data) => options.onSuccess?.(data),
          (error) => options.onError?.(error)
        ),
  }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));
vi.mock("wouter", () => ({ useLocation: () => [harness.location, vi.fn()] }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: harness.apiRequest }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/pages/CashBankReconciliationTypes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pages/CashBankReconciliationTypes")>();
  return { ...actual, json: vi.fn(), upload: harness.upload };
});

import { useCashBankReconciliationState } from "@/pages/useCashBankReconciliationState";

const STATEMENT_DETAIL = {
  statement: { id: 70, currency: "USD" },
  lines: [
    { id: 1, amount: "-150.00", status: "unmatched" },
    { id: 2, amount: "200.00", status: "matched" },
  ],
  bookEntries: [
    { entryId: 11, amount: "-150", currency: "USD", eligible: true },
    { entryId: 12, amount: "-150.00", currency: "ZMW", eligible: true },
    { entryId: 13, amount: "-149.99", currency: "USD", eligible: true },
    { entryId: 14, amount: "-150.000000", currency: "USD", eligible: false },
    { entryId: 15, amount: "-150.0000001", currency: "USD", eligible: true },
  ],
};

function render() {
  return renderHook(() => useCashBankReconciliationState());
}
const titles = () => harness.toast.mock.calls.map(([arg]) => arg.title);

beforeEach(() => {
  harness.location = "/cash-bank-reconciliation";
  harness.apiRequest.mockReset();
  harness.apiRequest.mockResolvedValue({ json: async () => ({}) });
  harness.upload.mockReset();
  harness.toast.mockReset();
  harness.invalidateQueries.mockReset();
  harness.detail = STATEMENT_DETAIL;
});

describe("links follow the workspace", () => {
  it.each([
    ["/cash-bank-reconciliation", "/create", "/voucher-detail/5"],
    ["/factory/cash-bank-reconciliation", "/factory/create", "/factory/voucher-detail/5"],
    ["/properties/cash-bank-reconciliation", "/properties/create", "/properties/voucher-detail/5"],
  ])("on %s", (location, createPath, voucherPath) => {
    harness.location = location;
    const { result } = render();
    expect(result.current.createPath).toBe(createPath);
    expect(result.current.voucherPath(5)).toBe(voucherPath);
  });
});

describe("importing a statement", () => {
  it("lists the chosen account's statements only once an account is chosen", () => {
    const { result } = render();
    expect(result.current.current).toBeUndefined();
    expect(result.current.statements.data).toBeUndefined();

    act(() => result.current.setAccount("cash:9"));
    expect(result.current.current).toEqual(ACCOUNTS[1]);
    expect(result.current.statements.data).toEqual([{ id: 70 }]);
  });

  it("refuses to preview without an account and a file", async () => {
    const { result } = render();
    await act(async () => {
      await result.current.previewMutation.mutate();
    });

    expect(harness.upload).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Statement preview failed",
        description: "Select an account and a CSV/XLSX statement first",
      })
    );
  });

  it("uploads the file with the account and statement figures, and shows the preview", async () => {
    harness.upload.mockResolvedValue({ rows: 3 });
    const { result } = render();
    const file = new File(["date,amount"], "zanaco.csv", { type: "text/csv" });
    act(() => {
      result.current.setAccount("bank:3");
      result.current.setFile(file);
      result.current.setForm({
        currency: "USD",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        openingBalance: "1000.00",
        closingBalance: "850.00",
      });
    });
    await act(async () => {
      await result.current.previewMutation.mutate();
    });

    const [path, body] = harness.upload.mock.calls[0];
    expect(path).toBe("/api/accounting/cash-bank/preview");
    expect(Object.fromEntries((body as FormData).entries())).toEqual({
      file: expect.any(File),
      accountKind: "bank",
      accountId: "3",
      currency: "USD",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      openingBalance: "1000.00",
      closingBalance: "850.00",
    });
    expect(result.current.preview).toEqual({ rows: 3 });
  });

  it("opens the imported statement and clears the upload, posting no vouchers", async () => {
    harness.upload.mockResolvedValue({ statementId: 70 });
    const { result } = render();
    act(() => {
      result.current.setAccount("bank:3");
      result.current.setFile(new File(["x"], "s.csv"));
      result.current.setPreview({ rows: 1 } as never);
    });
    await act(async () => {
      await result.current.importMutation.mutate();
    });

    expect(harness.upload.mock.calls[0][0]).toBe("/api/accounting/cash-bank/import");
    expect(result.current.statementId).toBe(70);
    expect(result.current.preview).toBeNull();
    expect(result.current.file).toBeNull();
    expect(titles()).toEqual(["Statement imported (no ledger vouchers created)"]);
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["cash-bank-statements"] });
  });

  it("reports an import the server refuses", async () => {
    harness.upload.mockRejectedValue(new Error("Statement overlaps an imported period"));
    const { result } = render();
    act(() => {
      result.current.setAccount("bank:3");
      result.current.setFile(new File(["x"], "s.csv"));
    });
    await act(async () => {
      await result.current.importMutation.mutate();
    });

    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Import refused", description: "Statement overlaps an imported period" })
    );
  });
});

describe("matching a statement line to a voucher entry", () => {
  function withStatement() {
    const view = render();
    act(() => view.result.current.setStatementId(70));
    return view;
  }

  it("suggests only eligible entries of the exact amount in the statement's currency, listed first", () => {
    const { result } = withStatement();
    act(() => result.current.setSelectedLine(1));

    expect(result.current.suggestions.map((entry) => entry.entryId)).toEqual([11, 15]);
    expect(result.current.bookEntriesShown.map((entry) => entry.entryId)).toEqual([11, 15, 12, 13, 14]);
  });

  it.each([
    ["an exact, eligible, same-currency entry", 1, 11, true],
    ["an entry a cent off", 1, 13, false],
    ["an entry in another currency", 1, 12, false],
    ["an ineligible entry", 1, 14, false],
    ["a line that is already matched", 2, 11, false],
  ])("allows matching %s: %s", (_label, line, entry, valid) => {
    const { result } = withStatement();
    act(() => {
      result.current.setSelectedLine(line);
      result.current.setSelectedEntry(entry);
    });
    expect(result.current.matchesValid).toBe(valid);
  });

  it("refuses a match until one line and one entry are selected", async () => {
    const { result } = withStatement();
    act(() => result.current.setSelectedLine(1));
    await act(async () => {
      await result.current.matchMutation.mutate();
    });

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Match refused",
        description: "Select one statement line and one voucher entry",
      })
    );
  });

  it("matches with the reason given, then clears the selection", async () => {
    const { result } = withStatement();
    act(() => {
      result.current.setSelectedLine(1);
      result.current.setSelectedEntry(11);
      result.current.setReason("Supplier transfer");
    });
    await act(async () => {
      await result.current.matchMutation.mutate();
    });

    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/accounting/cash-bank/matches", {
      statementLineId: 1,
      voucherEntryId: 11,
      reason: "Supplier transfer",
    });
    expect(result.current.selectedLine).toBeNull();
    expect(result.current.selectedEntry).toBeNull();
    expect(result.current.reason).toBe("");
    expect(titles()).toEqual(["Bank movement matched"]);
  });

  it("sends no reason rather than an empty one", async () => {
    const { result } = withStatement();
    act(() => {
      result.current.setSelectedLine(1);
      result.current.setSelectedEntry(11);
    });
    await act(async () => {
      await result.current.matchMutation.mutate();
    });
    expect(harness.apiRequest.mock.calls[0][2]).toMatchObject({ reason: null });
  });

  it("cancels a match with its reason, keeping the statement and voucher", async () => {
    const { result } = withStatement();
    act(() => result.current.setVoidReason("Matched to the wrong voucher"));
    await act(async () => {
      await result.current.unmatchMutation.mutate(301);
    });

    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/accounting/cash-bank/matches/301/void", {
      reason: "Matched to the wrong voucher",
    });
    expect(result.current.voidReason).toBe("");
    expect(titles()).toEqual(["Match cancelled"]);
  });

  it("reports an unmatch the server refuses", async () => {
    harness.apiRequest.mockRejectedValue(new Error("Reason required"));
    const { result } = withStatement();
    await act(async () => {
      await result.current.unmatchMutation.mutate(301);
    });
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unmatch refused", description: "Reason required" })
    );
  });
});

describe("classifying a statement line", () => {
  it("needs a selected line, then saves the category and note without posting", async () => {
    const { result } = render();
    await act(async () => {
      await result.current.reviewMutation.mutate();
    });
    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(titles()).toEqual(["Review not saved"]);

    act(() => {
      result.current.setSelectedLine(1);
      result.current.setReviewCategory("bank_fee");
      result.current.setReviewNote("Monthly charge");
    });
    await act(async () => {
      await result.current.reviewMutation.mutate();
    });

    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/accounting/cash-bank/lines/1/review", {
      category: "bank_fee",
      note: "Monthly charge",
    });
    expect(titles()).toContain("Bank transaction reviewed");
  });

  it("clears an empty category and note to null", async () => {
    const { result } = render();
    act(() => result.current.setSelectedLine(2));
    await act(async () => {
      await result.current.reviewMutation.mutate();
    });
    expect(harness.apiRequest.mock.calls[0][2]).toEqual({ category: null, note: null });
  });
});
