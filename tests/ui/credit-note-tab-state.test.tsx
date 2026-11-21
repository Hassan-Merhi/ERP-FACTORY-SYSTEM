/**
 * The credit/debit note editor's state (client/src/components/vouchers/useCreditNoteTabState.ts).
 *
 * A credit note refunds stock to a location and pays the customer back, so
 * this pins what reaches the server: the cart's quantities, refund rates and
 * inventory costs; the USD/ZMW conversion of a kwacha refund at the note
 * date's approved rate; the refusals that keep a note from posting without a
 * location, a quantity, an item or a rate; and edit mode, which keeps the
 * original voucher's locked currency and rate.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  currency: { selectedCurrency: "USD", displayCurrency: "USD" },
  zmwRate: null as { rate: string } | null,
  editData: undefined as unknown,
}));

const LOCATIONS = [
  { id: 7, name: "Lusaka Shop" },
  { id: 8, name: "Kitwe Shop" },
];
const STOCK_ITEMS = [
  { id: 1, name: "Shirt", code: "SH-1", uom: "pc" },
  { id: 2, name: "Jeans", code: "JN-2", uom: "pc" },
];
const INVENTORY = [
  { stockItemId: 1, quantity: "10", averageRate: "4.5" },
  { stockItemId: 2, quantity: "3", averageRate: "12" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const [key, , part] = queryKey ?? [];
    if (key === "/api/locations" && queryKey.length === 1) return { data: LOCATIONS };
    if (key === "/api/locations" && part === "inventory") return { data: INVENTORY };
    if (key === "/api/stock-items/light") return { data: STOCK_ITEMS };
    if (key === "/api/credit-notes") return { data: harness.editData, isLoading: false };
    if (key === "/api/exchange-rates/latest") return { data: harness.zmwRate, isFetching: false };
    return { data: undefined, isLoading: false, isFetching: false };
  },
  // Runs the mutation the way React Query does: mutationFn, then onSuccess or onError.
  useMutation: (options: {
    mutationFn: (variables: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown) => void;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (variables: unknown) =>
      options.mutationFn(variables).then(
        (data) => options.onSuccess?.(data),
        (error) => options.onError?.(error)
      ),
  }),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/CurrencyContext", () => ({ useCurrencyContext: () => harness.currency }));
vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: 3 } }) }));

import { useCreditNoteTabState } from "@/components/vouchers/useCreditNoteTabState";

type Hook = ReturnType<typeof useCreditNoteTabState>;
const formValues = {
  noteType: "Credit Note" as const,
  voucherDate: "2026-11-05",
  cashAccountType: "cash",
  cashAccountId: 44,
  cashAccountName: "Shop Cash",
  description: "Customer returned goods",
};

function renderEditor(editVoucherId?: number) {
  return renderHook(() => useCreditNoteTabState({ allAccounts: [], editVoucherId } as never));
}

const stockItem = (hook: Hook, id: number) => hook.filteredItems.find((item) => item.id === id)!;

async function submit(hook: { current: Hook }, values: Partial<typeof formValues> = {}) {
  await act(async () => {
    await hook.current.onSubmit({ ...formValues, ...values });
  });
}

const sentBody = () => harness.apiRequest.mock.calls.at(-1)?.[2];
const toastTitles = () => harness.toast.mock.calls.map(([arg]) => arg.title);

beforeEach(() => {
  harness.apiRequest.mockReset();
  harness.apiRequest.mockResolvedValue({ json: async () => ({ message: "Saved" }) });
  harness.toast.mockReset();
  harness.invalidateQueries.mockReset();
  harness.currency = { selectedCurrency: "USD", displayCurrency: "USD" };
  harness.zmwRate = null;
  harness.editData = undefined;
});

describe("adding items to a credit note", () => {
  it("refuses to add an item before a location is chosen", () => {
    const { result } = renderEditor();
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));

    expect(result.current.items).toEqual([]);
    expect(toastTitles()).toEqual(["No location selected"]);
  });

  it("joins the location's stock to the catalogue and defaults the refund to its average cost", () => {
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));

    expect(stockItem(result.current, 1)).toMatchObject({ stockQty: 10, avgRate: 4.5 });
    act(() => result.current.setItemQuantity("3"));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));

    expect(result.current.items).toEqual([
      expect.objectContaining({
        stockItemId: 1,
        locationId: 7,
        locationName: "Lusaka Shop",
        quantity: "3",
        refundRate: "4.50",
        inventoryCost: "4.50",
      }),
    ]);
    expect(result.current.totalRefund).toBeCloseTo(13.5);
    expect(result.current.itemQuantity).toBe("1");
  });

  it("uses a typed refund rate over the average cost, then clears it for the next item", () => {
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.setRefundRate("6"));
    act(() => result.current.addItemToCart(stockItem(result.current, 2)));

    expect(result.current.items[0]).toMatchObject({ refundRate: "6.00", inventoryCost: "12.00" });
    expect(result.current.refundRate).toBe("");
    expect(result.current.totalInventoryValue).toBeCloseTo(12);
  });

  it.each(["0", "-2", "abc"])("refuses a quantity of %s", (quantity) => {
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.setItemQuantity(quantity));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));

    expect(result.current.items).toEqual([]);
    expect(toastTitles()).toEqual(["Invalid quantity"]);
  });

  it("searches by name or code, and edits or removes cart lines", () => {
    const { result } = renderEditor();
    act(() => result.current.setSearchTerm("jn-2"));
    expect(result.current.filteredItems.map((item) => item.id)).toEqual([2]);
    act(() => result.current.setSearchTerm(""));

    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));
    act(() => result.current.addItemToCart(stockItem(result.current, 2)));
    act(() => result.current.updateItemInventoryCost(0, "5.25"));
    expect(result.current.items[0].inventoryCost).toBe("5.25");

    act(() => result.current.removeItem(1));
    expect(result.current.items.map((item) => item.stockItemId)).toEqual([1]);
  });

  it("adds the highlighted item with Enter but leaves Ctrl+Enter to the Save shortcut", () => {
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(result.current.highlightedIndex).toBe(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    });
    expect(result.current.items).toEqual([]);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(result.current.items.map((item) => item.stockItemId)).toEqual([2]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    });
    expect(result.current.highlightedIndex).toBe(1);
  });
});

describe("saving a USD note", () => {
  it("posts the cart and note type, then clears the editor", async () => {
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.setItemQuantity("2"));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));
    await submit(result, { noteType: "Debit Note" });

    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/credit-notes", {
      noteType: "Debit Note",
      voucherDate: "2026-11-05",
      cashAccountId: 44,
      cashAccountType: "cash",
      description: "Customer returned goods",
      currency: "USD",
      exchangeRate: undefined,
      items: [
        {
          stockItemId: 1,
          locationId: 7,
          quantity: "2",
          refundRate: "4.50",
          originalCurrencyRate: undefined,
          inventoryCost: "4.50",
        },
      ],
    });
    expect(result.current.items).toEqual([]);
    expect(toastTitles()).toContain("Created");
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/vouchers"] });
  });

  it("refuses to save an empty note", async () => {
    const { result } = renderEditor();
    await submit(result);

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual(["No items"]);
  });

  it("keeps the cart and reports the server's refusal", async () => {
    harness.apiRequest.mockRejectedValue(new Error("Accounting period closed."));
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));
    await submit(result);

    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Save failed", description: "Accounting period closed." })
    );
    expect(result.current.items).toHaveLength(1);
  });

  it("stays quiet when a global handler already reported the failure", async () => {
    harness.apiRequest.mockRejectedValue(Object.assign(new Error("x"), { _handledGlobally: true }));
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));
    await submit(result);

    expect(harness.toast).not.toHaveBeenCalled();
  });
});

describe("kwacha notes", () => {
  beforeEach(() => {
    harness.currency = { selectedCurrency: "ZMW", displayCurrency: "ZMW" };
  });

  it("prices the default refund in kwacha and posts USD rates at the note date's approved rate", async () => {
    harness.zmwRate = { rate: "20" };
    const { result } = renderEditor();
    expect(result.current.noteCurrency).toBe("ZMW");
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.setItemQuantity("2"));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));

    // 4.50 USD average cost at 20 K per USD is 90.00 K; inventory cost stays in USD.
    expect(result.current.items[0]).toMatchObject({ refundRate: "90.00", inventoryCost: "4.50" });
    expect(result.current.totalRefund).toBeCloseTo(180);
    expect(result.current.totalRefundUsd).toBeCloseTo(9);

    await submit(result);
    expect(sentBody()).toMatchObject({
      currency: "ZMW",
      exchangeRate: "20",
      items: [{ refundRate: "4.500000", originalCurrencyRate: "90.00", inventoryCost: "4.50", quantity: "2" }],
    });
  });

  it("refuses to save without an approved rate for the refund date", async () => {
    harness.zmwRate = null;
    const { result } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.setRefundRate("100"));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));
    expect(result.current.totalRefundUsd).toBe(0);
    await submit(result);

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(toastTitles()).toContain("USD/ZMW rate required");
  });

  it("clears a new note's cart when the display currency changes, so prices are never reinterpreted", () => {
    harness.zmwRate = { rate: "20" };
    const { result, rerender } = renderEditor();
    act(() => result.current.setSelectedLocationId(7));
    act(() => result.current.setRefundRate("100"));
    act(() => result.current.addItemToCart(stockItem(result.current, 1)));
    expect(result.current.items).toHaveLength(1);

    harness.currency = { selectedCurrency: "USD", displayCurrency: "USD" };
    rerender();
    expect(result.current.noteCurrency).toBe("USD");
    expect(result.current.items).toEqual([]);
  });
});

describe("editing a saved note", () => {
  const savedZmwNote = {
    voucher: {
      voucherType: "Credit Note",
      voucherDate: "2026-10-30",
      description: "Return",
      currency: "ZMW",
      exchangeRate: "21",
    },
    cashAccountType: "bank",
    cashAccountId: 9,
    items: [
      {
        stockItemId: 1,
        stockItemName: "Shirt",
        locationId: 8,
        locationName: "Kitwe Shop",
        quantity: "2",
        refundRate: "5",
        inventoryCost: "4.5",
        uom: "pc",
      },
    ],
  };

  it("loads the voucher in its own currency and rate, whatever the display currency", () => {
    harness.editData = savedZmwNote;
    const { result } = renderEditor(55);

    expect(result.current.isEditMode).toBe(true);
    expect(result.current.noteCurrency).toBe("ZMW");
    expect(result.current.selectedLocationId).toBe(8);
    // Stored as 5 USD per unit; shown at the voucher's own 21 K rate.
    expect(result.current.items[0]).toMatchObject({ refundRate: "105.00", quantity: "2", inventoryCost: "4.5" });
    expect(result.current.form.getValues()).toMatchObject({ cashAccountId: 9, cashAccountType: "bank" });
  });

  it("patches the same voucher at its saved rate, without a note type", async () => {
    harness.editData = savedZmwNote;
    const { result } = renderEditor(55);
    await submit(result, { voucherDate: "2026-10-30", cashAccountId: 9, cashAccountType: "bank" });

    const [method, url, body] = harness.apiRequest.mock.calls.at(-1)!;
    expect([method, url]).toEqual(["PATCH", "/api/credit-notes/55"]);
    expect(body).not.toHaveProperty("noteType");
    expect(body).toMatchObject({
      exchangeRate: "21",
      items: [{ refundRate: "5.000000", originalCurrencyRate: "105.00" }],
    });
    expect(toastTitles()).toContain("Updated");
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/credit-notes", 55] });
    expect(window.location.search).toBe("?tab=credit-note");
  });

  it("refuses to patch a kwacha note whose saved rate is missing", async () => {
    harness.editData = { ...savedZmwNote, voucher: { ...savedZmwNote.voucher, exchangeRate: "0" } };
    const { result } = renderEditor(55);
    expect(result.current.items[0].refundRate).toBe("5");
    await submit(result);

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(toastTitles()).toContain("USD/ZMW rate required");
  });

  it("reports an update the server refuses", async () => {
    harness.editData = { ...savedZmwNote, voucher: { ...savedZmwNote.voucher, currency: "USD", exchangeRate: "1" } };
    harness.apiRequest.mockRejectedValue(new Error("Voucher is locked"));
    const { result } = renderEditor(55);
    expect(result.current.items[0].refundRate).toBe("5");
    await submit(result);

    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Update failed", description: "Voucher is locked" })
    );
  });
});
