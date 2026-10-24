/**
 * factoryApi.ts wraps every Factory-mode request. Three of its jobs move money
 * or stock and were untested: a post-offload charge must be previewed and
 * confirmed before it is saved, the reports it changes must refetch, and a
 * compact single-bale scan response must be rebuilt into the full order the
 * loading screens expect. It also refuses ERP-only endpoints in Factory mode.
 */
import { confirmAction } from "@/components/ConfirmHost";
import { factoryApiRequest, getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { installFakeApi, respond } from "./fakeApi";

vi.mock("@/components/ConfirmHost", () => ({ confirmAction: vi.fn() }));

const CHARGES = "/api/factory/containers/12/post-offload-charges";
const confirm = vi.mocked(confirmAction);

function preview(overrides: Record<string, unknown> = {}, scope: Record<string, number> = {}) {
  return {
    confirmationToken: "impact-token-1",
    preview: {
      containerNumber: "MSKU1234567",
      currentContainerCostPerKgUsd: "1.2",
      projectedContainerCostPerKgUsd: "1.35",
      fullContainerValueDeltaUsd: "3000",
      containerRemainingKg: "12500.5",
      remainingFraction: "0.625",
      supplierLockedRateBefore: null,
      supplierLockedRateProjected: null,
      supplierInventoryValueDeltaUsd: "1875",
      historicalReplaySafe: true,
      historicalReplayBlockedReasons: [],
      scope: {
        supplierOwnedSources: 2,
        affectedSourceRows: 4,
        affectedBatches: 3,
        openBatches: 3,
        completedBatches: 0,
        availableBales: 40,
        finalizedBalesExcluded: 0,
        ...scope,
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  confirm.mockReset();
  queryClient.clear();
});

describe("post-offload charges", () => {
  it("previews the cost impact, asks for confirmation and saves with the preview token", async () => {
    const api = installFakeApi();
    api.post(`${CHARGES}/preview`, preview());
    api.post(CHARGES, ({ body }) => respond(201, { saved: body }));
    confirm.mockResolvedValue(true);

    const response = await factoryApiRequest("POST", CHARGES, { amountUsd: "3000", kind: "duty" });

    expect(api.callsTo("POST", `${CHARGES}/preview`)[0].body).toMatchObject({ amountUsd: "3000", kind: "duty" });
    const description = confirm.mock.calls[0][0].description as string;
    expect(description).toContain("Container: MSKU1234567");
    expect(description).toContain("Container cost/kg: $1.20 → $1.35");
    expect(description).toContain("Full container value change: $3,000.00");
    expect(description).toContain("Remaining inventory: 12,500.50 kg (62.50%)");
    expect(description).toContain("Historical scope: 2 supplier source(s), 3 batch(es), 40 available bale(s).");
    expect(description).not.toContain("WARNING");
    expect(api.callsTo("POST", CHARGES)[0].body).toMatchObject({
      amountUsd: "3000",
      impactPreviewVersion: 1,
      impactPreviewToken: "impact-token-1",
    });
    expect(response.status).toBe(201);
  });

  it("does not save when the user cancels the review", async () => {
    const api = installFakeApi();
    api.post(`${CHARGES}/preview`, preview());
    confirm.mockResolvedValue(false);

    await expect(factoryApiRequest("POST", CHARGES, { amountUsd: "10" })).rejects.toMatchObject({
      name: "UserCancelled",
      _handledGlobally: true,
    });
    expect(api.callsTo("POST", CHARGES)).toHaveLength(0);
  });

  it("surfaces a rejected preview with the server's message and status, without saving", async () => {
    const api = installFakeApi();
    api.post(`${CHARGES}/preview`, respond(409, { message: "Container is locked for costing" }));

    await expect(factoryApiRequest("POST", CHARGES, { amountUsd: "10" })).rejects.toMatchObject({
      message: "Container is locked for costing",
      status: 409,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(api.callsTo("POST", CHARGES)).toHaveLength(0);
  });

  it("refuses to save on an incomplete preview", async () => {
    const api = installFakeApi();
    api.post(`${CHARGES}/preview`, { preview: preview().preview });

    await expect(factoryApiRequest("POST", CHARGES, { amountUsd: "10" })).rejects.toThrow(/incomplete response/);
    expect(api.callsTo("POST", CHARGES)).toHaveLength(0);
  });

  it("does not preview again for a body that already carries a preview token", async () => {
    const api = installFakeApi();
    api.post(CHARGES, respond(201, {}));

    await factoryApiRequest("POST", CHARGES, { amountUsd: "10", impactPreviewVersion: 1, impactPreviewToken: "t" });

    expect(api.callsTo("POST", `${CHARGES}/preview`)).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("spells out locked supplier rates, completed batches and every replay warning", async () => {
    const api = installFakeApi();
    api.post(
      `${CHARGES}/preview`,
      preview(
        {
          supplierLockedRateBefore: "0.9",
          supplierLockedRateProjected: "0.95",
          remainingFraction: "1.4",
          historicalReplaySafe: false,
          historicalReplayBlockedReasons: ["open stock count", "pending transfer"],
        },
        { completedBatches: 2, finalizedBalesExcluded: 5 }
      )
    );
    api.post(CHARGES, respond(201, {}));
    confirm.mockResolvedValue(true);

    await factoryApiRequest("POST", CHARGES, { amountUsd: "10" });

    const description = confirm.mock.calls[0][0].description as string;
    expect(description).toContain("Supplier locked rate: $0.90 → $0.95");
    expect(description).toContain("(100.00%)");
    expect(description).toContain("2 completed batch(es) are included in the protected replay.");
    expect(description).toContain("WARNING: 5 sold/finalized bale(s) are excluded");
    expect(description).toContain("Historical replay is currently blocked (open stock count, pending transfer)");
  });

  it("names a generic reason when replay is blocked without one", async () => {
    const api = installFakeApi();
    api.post(`${CHARGES}/preview`, preview({ historicalReplaySafe: false, historicalReplayBlockedReasons: [] }));
    api.post(CHARGES, respond(201, {}));
    confirm.mockResolvedValue(true);

    await factoryApiRequest("POST", CHARGES, { amountUsd: "10" });

    expect(confirm.mock.calls[0][0].description).toContain("(historical replay safety checks failed)");
  });

  it("refetches the reports a saved charge reconciled, once each", async () => {
    const api = installFakeApi();
    api.patch(`${CHARGES}/:id`, {
      postOffloadReconciliation: {
        reports: { queryKeys: ["/api/factory/raw-stock", "/api/factory/net-position", "/api/factory/raw-stock", 7] },
      },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await factoryApiRequest("PATCH", `${CHARGES}/4`, { amountUsd: "12" });

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["/api/factory/raw-stock"],
      ["/api/factory/net-position"],
    ]);
    invalidate.mockRestore();
  });

  it("refetches nothing after a failed charge update", async () => {
    const api = installFakeApi();
    api.delete(`${CHARGES}/:id`, respond(422, { message: "Charge already reversed" }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await expect(factoryApiRequest("DELETE", `${CHARGES}/4`)).rejects.toThrow(/already reversed/);

    expect(invalidate).not.toHaveBeenCalled();
    invalidate.mockRestore();
  });
});

describe("compact bale scans", () => {
  const ORDER_KEY = ["/api/factory/customer-orders", 55] as const;
  const patch = {
    compactBaleScan: true,
    orderId: 55,
    order: { id: 55, status: "LOADING" },
    bale: { id: 902, barcode: "B-902" },
    line: { articleCode: "ART-1", qty: 3 },
    totals: {
      subtotalBales: "300.00",
      freightAmount: "0",
      otherChargesTotal: "0",
      grandTotal: "300.00",
      totalQtyBales: 3,
      updatedAt: null,
    },
  };

  it("rebuilds the full order from the cached one and updates the cache", async () => {
    const api = installFakeApi();
    api.post("/api/factory/customer-orders/:id/bales", patch);
    queryClient.setQueryData(ORDER_KEY, {
      id: 55,
      customerName: "Atlas",
      bales: [{ id: 901, barcode: "B-901" }],
      lines: [{ articleCode: "ART-1", qty: 2 }],
      charges: [{ id: 1 }],
    });

    const response = await factoryApiRequest("POST", "/api/factory/customer-orders/55/bales", { barcode: "B-902" });
    const order = await response.json();

    expect(order).toMatchObject({ id: 55, customerName: "Atlas", grandTotal: "300.00", charges: [{ id: 1 }] });
    expect(order.bales.map((bale: { id: number }) => bale.id)).toEqual([901, 902]);
    expect(order.lines).toEqual([{ articleCode: "ART-1", qty: 3 }]);
    expect(queryClient.getQueryData(ORDER_KEY)).toEqual(order);
    expect(api.callsTo("GET", "/api/factory/customer-orders/:id")).toHaveLength(0);
  });

  it("loads the full order once when it is not cached", async () => {
    const api = installFakeApi();
    api.post("/api/factory/customer-orders/:id/bales", patch);
    api.get("/api/factory/customer-orders/:id", { id: 55, customerName: "Atlas", bales: [], lines: [] });

    const order = await (await factoryApiRequest("POST", "/api/factory/customer-orders/55/bales", {})).json();

    expect(api.callsTo("GET", "/api/factory/customer-orders/:id")).toHaveLength(1);
    expect(order).toMatchObject({ customerName: "Atlas", bales: [{ id: 902, barcode: "B-902" }] });
  });

  it("still reports a committed scan as success when the full order cannot be loaded", async () => {
    const api = installFakeApi();
    api.post("/api/factory/customer-orders/:id/bales", patch);
    api.get("/api/factory/customer-orders/:id", respond(500, { message: "down" }));

    const response = await factoryApiRequest("POST", "/api/factory/customer-orders/55/bales", {});

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ id: 55, status: "LOADING", grandTotal: "300.00" });
  });

  it("passes a full-order response through untouched", async () => {
    const api = installFakeApi();
    api.post("/api/factory/customer-orders/:id/bales", { id: 55, bales: [{ id: 1 }] });

    const response = await factoryApiRequest("POST", "/api/factory/customer-orders/55/bales", {});

    await expect(response.json()).resolves.toEqual({ id: 55, bales: [{ id: 1 }] });
    expect(queryClient.getQueryData(ORDER_KEY)).toBeUndefined();
  });
});

describe("Factory endpoint guard", () => {
  it("refuses an ERP-only endpoint in Factory mode during development", async () => {
    const api = installFakeApi();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(factoryApiRequest("GET", "/api/retail/products")).rejects.toThrow(/BLOCKED/);
    expect(api.calls.filter((call) => call.path === "/api/retail/products")).toHaveLength(0);
    error.mockRestore();
  });

  it("allows Factory and shared endpoints", async () => {
    const api = installFakeApi();
    api.get("/api/factory/customers", []);
    api.get("/api/ledger-accounts", []);

    await factoryApiRequest("GET", "/api/factory/customers");
    await factoryApiRequest("GET", "/api/ledger-accounts");

    expect(api.calls.map((call) => call.path)).toEqual(["/api/factory/customers", "/api/ledger-accounts"]);
  });

  it("does not apply the Factory guard to ERP mode", async () => {
    const api = installFakeApi();
    api.get("/api/retail/products", []);

    await getApiRequest("erp")("GET", "/api/retail/products");

    expect(api.callsTo("GET", "/api/retail/products")).toHaveLength(1);
  });
});
