/**
 * How the POS screen saves sales and drafts (client/src/pages/pos/hooks/usePosMutations.ts).
 *
 * The hook picks the posting route from the company: an edit goes to the
 * voucher sales editor; an ordinary company posts to /api/pos/sales; a
 * Supplier Partner first asks the server whether it is Golden Coast, then
 * either posts the atomic HADI sale or falls back to the generic SP sale - and
 * fails closed on any other readiness answer, so Golden Coast never drifts
 * back to legacy accounting. These cases pin each route's request and what the
 * screen is told afterwards.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  invalidateCustomerBalances: vi.fn(),
  invalidateLocationInventoryQueries: vi.fn(),
  upsertPosDraftSummary: vi.fn(),
  removePosDraftSummary: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: (variables: unknown) => Promise<unknown>;
    onSuccess?: (data: unknown, variables: unknown) => unknown;
    onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (variables?: unknown) =>
      options.mutationFn(variables).then(
        (data) => options.onSuccess?.(data, variables),
        (error) => options.onError?.(error)
      ),
  }),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { invalidateQueries: harness.invalidateQueries },
  invalidateCustomerBalances: harness.invalidateCustomerBalances,
  keyStartsWith: (prefix: string) => `startsWith:${prefix}`,
}));
vi.mock("@/api/inventoryApi", () => ({
  invalidateLocationInventoryQueries: harness.invalidateLocationInventoryQueries,
}));
vi.mock("@/api/posApi", () => ({
  upsertPosDraftSummary: harness.upsertPosDraftSummary,
  removePosDraftSummary: harness.removePosDraftSummary,
}));

import { usePosMutations } from "@/pages/pos/hooks/usePosMutations";

const LOCATION = { id: 12, name: "Lusaka Shop", whatsappGroupChatId: null } as never;
const ROWS = [
  { stockItemId: 5, itemName: "Shirt", stockItemCode: "SH5", configuredPrice: 9, quantity: 2, rate: 10, amount: 20 },
  { stockItemId: 6, itemName: "Jeans", stockItemCode: "JN6", configuredPrice: 20, quantity: 1, rate: 25, amount: 25 },
  { stockItemId: 0, itemName: "", quantity: 1, rate: 1, amount: 1 },
  { stockItemId: 7, itemName: "Free sample", quantity: 1, rate: 0, amount: 0 },
] as never[];

const SALE = {
  locationId: 12,
  voucherDate: "2026-11-06",
  paymentAccountType: "cash",
  paymentAccountId: 3,
  isCreditSale: false,
  currency: "USD",
  notes: "  Mary Banda  ",
  clientSaleId: "sale-uuid-1",
  items: [
    { stockItemId: 5, quantity: 2, rate: 10, salesItemId: 501 },
    { stockItemId: 6, quantity: 1, rate: 25, salesItemId: 502, originalCurrencyRate: "525" },
  ],
};

function setters() {
  return {
    setSavedSale: vi.fn(),
    setSaleJustCompleted: vi.fn(),
    setShowPrintDialog: vi.fn(),
    setCurrentDraftId: vi.fn(),
    setLastAutosaved: vi.fn(),
    setPendingAutoSend: vi.fn(),
    setPendingStockSend: vi.fn(),
    setStockWaStatus: vi.fn(),
    toast: vi.fn(),
  };
}

type Options = Partial<Parameters<typeof usePosMutations>[0]>;

function renderPos(options: Options = {}) {
  const spies = setters();
  const clientSaleIdRef = { current: "sale-uuid-1" };
  const lastSavedFingerprintRef = { current: "" };
  const { result } = renderHook(() =>
    usePosMutations({
      activeLocation: LOCATION,
      clientSaleIdRef,
      rows: ROWS,
      isCreditSale: false,
      paymentAccountType: "cash",
      paymentAccountId: "3",
      selectedCustomerId: "",
      currentDraftId: null,
      notes: "Mary Banda",
      lastSavedFingerprintRef,
      ...spies,
      ...options,
    } as Parameters<typeof usePosMutations>[0])
  );
  return { result, spies, clientSaleIdRef, lastSavedFingerprintRef };
}

const json = (body: unknown) => ({ json: async () => body });
const lastRequest = () => harness.apiRequest.mock.calls.at(-1);
const titles = (toast: ReturnType<typeof vi.fn>) => toast.mock.calls.map(([arg]) => arg.title);

function readiness(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as never;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  for (const spy of Object.values(harness)) spy.mockReset();
  harness.apiRequest.mockResolvedValue(json({ voucher: { id: 900, voucherNumber: "SALE-900", customerId: 44 } }));
  vi.spyOn(crypto, "randomUUID").mockReturnValue("fresh-uuid" as never);
});

describe("saving a sale", () => {
  it("refuses every write from a view-only POS account", async () => {
    const { result, spies } = renderPos({ writesDisabled: true });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
      await result.current.saveDraftMutation.mutate(undefined as never);
      await result.current.deleteDraftMutation.mutate(3 as never);
    });

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(spies.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "This POS account is view-only." })
    );
  });

  it("posts an ordinary company's sale and tells the screen it saved", async () => {
    const { result, spies, clientSaleIdRef } = renderPos();
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(lastRequest()).toEqual(["POST", "/api/pos/sales", SALE]);
    expect(clientSaleIdRef.current).toBe("fresh-uuid");
    expect(spies.setSaleJustCompleted).toHaveBeenCalledWith(true);
    expect(spies.setShowPrintDialog).toHaveBeenCalledWith(true);
    expect(spies.setStockWaStatus).toHaveBeenCalledWith("not_configured");
    expect(harness.invalidateLocationInventoryQueries).toHaveBeenCalledWith(12);
    expect(harness.invalidateCustomerBalances).toHaveBeenCalledWith(44);
    expect(spies.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sale Saved", description: "Sale SALE-900 has been saved successfully." })
    );
  });

  it("queues the WhatsApp receipt and stock message when the location has a group", async () => {
    vi.useFakeTimers();
    try {
      const { result, spies } = renderPos({ activeLocation: { ...LOCATION, whatsappGroupChatId: "group-1" } as never });
      await act(async () => {
        await result.current.saveMutation.mutate(SALE as never);
      });

      expect(spies.setPendingAutoSend).toHaveBeenCalledWith({ voucherId: 900, locationId: 12 });
      expect(spies.setStockWaStatus).toHaveBeenCalledWith("sending");
      expect(spies.setPendingStockSend).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(3000));
      expect(spies.setPendingStockSend).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("edits through the voucher sales editor, keeping the original payment for a POS user", async () => {
    const { result, spies } = renderPos({ editVoucherId: "77", posUser: { id: "u" } as never });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    const [method, url, body] = lastRequest()!;
    expect([method, url]).toEqual(["PUT", "/api/vouchers/77/sales"]);
    expect(body).not.toHaveProperty("paymentAccountType");
    expect(body.items).toEqual([
      { id: 501, stockItemId: 5, quantity: "2", sellingPrice: "10" },
      { id: 502, stockItemId: 6, quantity: "1", sellingPrice: "25", originalCurrencyRate: "525" },
    ]);
    expect(spies.setSaleJustCompleted).not.toHaveBeenCalled();
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/vouchers/77"] });
    expect(titles(spies.toast)).toContain("Sale Updated");
  });

  it("lets an ERP edit change the payment account and names the target company", async () => {
    const { result } = renderPos({ editVoucherId: "77", goldenCoastParentCompanyId: 4 });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(lastRequest()![2]).toMatchObject({ paymentAccountType: "cash", paymentAccountId: 3, targetCompanyId: 4 });
  });

  it("reports a failed save, worded for a save or an update", async () => {
    harness.apiRequest.mockRejectedValue(new Error(""));
    const { result, spies } = renderPos({ editVoucherId: "77" });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(spies.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Save failed", description: "Failed to update sale", variant: "destructive" })
    );
  });
});

describe("Supplier Partner and Golden Coast sales", () => {
  it("posts a known Golden Coast company's sale to its parent", async () => {
    const { result } = renderPos({ isSpCompany: true, isGoldenCoastPhase6: true, goldenCoastParentCompanyId: 4 });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(lastRequest()).toEqual(["POST", "/api/pos/sales", { ...SALE, targetCompanyId: 4 }]);
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/sp/stock"] });
    expect(harness.invalidateLocationInventoryQueries).not.toHaveBeenCalled();
  });

  it("asks a Supplier Partner whether it is Golden Coast, then posts the HADI sale with its revenue voucher", async () => {
    readiness(200, { automaticHadiPair: { hadiCompanyId: 9 } });
    harness.apiRequest.mockResolvedValue(
      json({
        revenueUsd: "45",
        postings: [{ role: "cash" }, { role: "revenue", voucher: { voucherNumber: "GC-REV-1" } }],
        automaticHadiCollection: { id: 1 },
      })
    );
    const { result, spies } = renderPos({ isSpCompany: true });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    const [method, url, body] = lastRequest()!;
    expect([method, url]).toEqual(["POST", "/api/sp/golden-coast/phase6/pos-sale?targetCompanyId=9"]);
    expect(body).toEqual({
      locationId: 12,
      saleDate: "2026-11-06",
      customerName: "Mary Banda",
      clientRequestId: "sale-uuid-1",
      notes: "  Mary Banda  ",
      lines: [
        { stockItemId: 5, qty: "2", unitPriceUsd: "10.00" },
        { stockItemId: 6, qty: "1", unitPriceUsd: "25.00" },
      ],
    });
    expect(spies.setSavedSale).toHaveBeenCalledWith(
      expect.objectContaining({
        voucherNumber: "GC-REV-1",
        grandTotal: "45.00",
        customer: { id: null, code: null, name: "Mary Banda" },
        automaticHadiCollection: { id: 1 },
        items: [
          expect.objectContaining({ stockItemName: "Shirt", quantity: "2", rate: "10.00", amount: "20.00" }),
          expect.objectContaining({ stockItemName: "Jeans", quantity: "1", rate: "25.00", amount: "25.00" }),
        ],
      })
    );
  });

  it("refuses a Golden Coast sale without a HADI pair or a stable client sale id", async () => {
    readiness(200, { automaticHadiPair: null });
    const first = renderPos({ isSpCompany: true });
    await act(async () => {
      await first.result.current.saveMutation.mutate(SALE as never);
    });
    expect(first.spies.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Golden Coast POS is not ready for automatic HADI cash routing." })
    );

    readiness(200, { automaticHadiPair: { hadiCompanyId: 9 } });
    const second = renderPos({ isSpCompany: true });
    await act(async () => {
      await second.result.current.saveMutation.mutate({ ...SALE, clientSaleId: "" } as never);
    });
    expect(second.spies.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Golden Coast POS requires a stable client sale id." })
    );
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("uses the generic SP sale only when the server says the company is not Golden Coast", async () => {
    readiness(409, { code: "GC_PHASE6_NOT_CONFIGURED" });
    harness.apiRequest.mockResolvedValue(
      json({
        id: 31,
        voucherId: 310,
        totalSalePriceUsd: "45",
        saleDate: "2026-11-06",
        customerName: "Mary Banda",
        lines: [{ stockItemId: 5, articleCode: "SH5", qtySold: "2", salePricePerUnit: "10", saleTotal: "20" }],
      })
    );
    const { result, spies } = renderPos({ isSpCompany: true });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(lastRequest()).toEqual([
      "POST",
      "/api/sp/sales",
      {
        saleDate: "2026-11-06",
        customerName: "Mary Banda",
        paymentAccountType: "cash",
        paymentAccountId: 3,
        notes: "  Mary Banda  ",
        saleLines: [
          { stockItemId: 5, qtySold: "2", salePricePerUnit: "10" },
          { stockItemId: 6, qtySold: "1", salePricePerUnit: "25" },
        ],
      },
    ]);
    expect(spies.setSavedSale).toHaveBeenCalledWith(
      expect.objectContaining({
        voucher: { id: 310, voucherNumber: "SP-SALE-31", customerId: undefined },
        grandTotal: "45.00",
        items: [expect.objectContaining({ stockItemName: "SH5", amount: "20" })],
      })
    );
  });

  it.each([
    ["an unhealthy HADI setup", 500, { message: "HADI pair is inactive" }, "HADI pair is inactive"],
    ["a different 409", 409, { code: "SOMETHING_ELSE" }, "Unable to verify Golden Coast POS accounting readiness."],
    ["an unreadable answer", 503, undefined, "Unable to verify Golden Coast POS accounting readiness."],
  ])("fails closed on %s instead of falling back to legacy accounting", async (_label, status, body, message) => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError("not json");
        return body;
      },
    })) as never;
    const { result, spies } = renderPos({ isSpCompany: true });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(spies.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Save failed", description: message }));
  });

  it("renews the sale request when Golden Coast reports a changed request, and asks to save again", async () => {
    harness.apiRequest.mockRejectedValue(
      Object.assign(new Error("conflict"), { code: "POSTING_IDEMPOTENCY_CONFLICT" })
    );
    const { result, spies, clientSaleIdRef } = renderPos({ isSpCompany: true, isGoldenCoastPhase6: true });
    await act(async () => {
      await result.current.saveMutation.mutate(SALE as never);
    });

    expect(clientSaleIdRef.current).toBe("fresh-uuid");
    expect(titles(spies.toast)).toEqual(["Sale request refreshed"]);
  });
});

describe("drafts", () => {
  it("saves only priced lines with a stock item, and records what was saved", async () => {
    harness.apiRequest.mockResolvedValue(json({ id: 61 }));
    const { result, spies, lastSavedFingerprintRef } = renderPos();
    await act(async () => {
      await result.current.saveDraftMutation.mutate(undefined as never);
    });

    expect(lastRequest()).toEqual([
      "POST",
      "/api/pos/drafts",
      {
        locationId: 12,
        paymentAccountType: "cash",
        paymentAccountId: 3,
        isCreditSale: false,
        notes: "Mary Banda",
        items: [
          { stockItemId: 5, quantity: "2", rate: "10", amount: "20" },
          { stockItemId: 6, quantity: "1", rate: "25", amount: "25" },
        ],
      },
    ]);
    expect(spies.setCurrentDraftId).toHaveBeenCalledWith(61);
    expect(harness.upsertPosDraftSummary).toHaveBeenCalledWith(12, { id: 61 }, [ROWS[0], ROWS[1]]);
    expect(JSON.parse(lastSavedFingerprintRef.current).items).toEqual([
      { id: 5, qty: 2, rate: 10 },
      { id: 6, qty: 1, rate: 25 },
    ]);
    expect(titles(spies.toast)).toEqual(["Draft Saved"]);
  });

  it("updates the open draft, recording a credit sale against its customer", async () => {
    harness.apiRequest.mockResolvedValue(json({ id: 61 }));
    const { result } = renderPos({ currentDraftId: 61, isCreditSale: true, selectedCustomerId: "88" });
    await act(async () => {
      await result.current.saveDraftMutation.mutate(undefined as never);
    });

    const [method, url, body] = lastRequest()!;
    expect([method, url]).toEqual(["PATCH", "/api/pos/drafts/61"]);
    expect(body).toMatchObject({ paymentAccountType: "credit", paymentAccountId: 88, isCreditSale: true });
  });

  it("refuses a draft with no location or no saleable line", async () => {
    const noLocation = renderPos({ activeLocation: null });
    await act(async () => {
      await noLocation.result.current.saveDraftMutation.mutate(undefined as never);
    });
    expect(noLocation.spies.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "No location selected" })
    );

    const noItems = renderPos({ rows: [ROWS[2], ROWS[3]] });
    await act(async () => {
      await noItems.result.current.saveDraftMutation.mutate(undefined as never);
    });
    expect(noItems.spies.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "No items to save" }));
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("deletes a draft and drops it from the location's draft list", async () => {
    const { result, spies } = renderPos();
    await act(async () => {
      await result.current.deleteDraftMutation.mutate(61 as never);
    });

    expect(lastRequest()).toEqual(["DELETE", "/api/pos/drafts/61"]);
    expect(harness.removePosDraftSummary).toHaveBeenCalledWith(12, 61);
    expect(titles(spies.toast)).toEqual(["Draft Deleted"]);
  });
});
