import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const executeResults: { rows: unknown[] }[] = [];
  const makeRead = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      for: vi.fn(() => Promise.resolve(result)),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const makeWrite = () => {
    const builder: any = {
      values: vi.fn(async () => []),
      set: vi.fn(() => builder),
      where: vi.fn(async () => []),
    };
    return builder;
  };
  const db: any = {
    execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
    select: vi.fn(() => makeRead(selectResults.shift() ?? [])),
    insert: vi.fn(() => makeWrite()),
    delete: vi.fn(() => makeWrite()),
    update: vi.fn(() => makeWrite()),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  return {
    db,
    selectResults,
    executeResults,
    order: {
      id: 91,
      companyId: 10,
      customerId: 8,
      invoiceNumber: "INV-000091",
      status: "FINALIZED",
      previousStatus: "LOADING",
      loadingStartedAt: new Date(),
      deletedAt: null,
      dispatchBatchId: null,
      proformaIdUsed: null,
      grandTotal: "100.00",
      totalQtyBales: 2,
      containerNumber: "CONT-01",
    },
    lockOrder: vi.fn(),
    physicalDispatch: vi.fn(),
    postedTrip: vi.fn(),
    recalc: vi.fn(),
    syncTotals: vi.fn(),
    priorityUndo: vi.fn(),
    freeze: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../server/auth", () => ({
  requireAuth: (_req: any, _res: any, next: () => void) => next(),
  requireRole:
    (...allowed: string[]) =>
    (req: any, res: any, next: () => void) =>
      allowed.includes(req.user?.role) ? next() : res.status(403).json({ message: "Forbidden" }),
}));
vi.mock("../server/db", () => ({ db: h.db }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../server/routes/factory/_helpers", () => ({ recalculateOrderTotals: h.recalc }));
vi.mock("../server/routes/factory/customer-orders/orderChargeLedger", () => ({
  lockCustomerOrderTx: h.lockOrder,
  syncOrderTotalsTx: h.syncTotals,
}));
vi.mock("../server/services/factory/dispatchTripFinancialGuards", () => ({
  hasAnyPhysicalDispatchTx: h.physicalDispatch,
  hasLiveFinancialTripTx: h.postedTrip,
}));
vi.mock("../server/routes/factory/customer-orders/priorityAutoAllocation", () => ({
  reversePriorityAllocationForDeletedBaleTx: h.priorityUndo,
}));
vi.mock("../server/routes/factory/customer-orders/priorityScanQueue", () => ({
  PRIORITY_SCAN_LOCK_NAMESPACE: 7712345,
}));
vi.mock("../server/services/factoryInvoiceDocumentService", () => ({
  freezeCanonicalInvoiceDocument: h.freeze,
}));
vi.mock("../server/services/audit/auditService", () => ({ writeAuditEvent: h.audit }));

import { registerFinalizedLoadingReturnRoutes } from "../server/routes/factory/customer-orders/bale-scanning/finalized-returns";

type Handler = (req: any, res: any, next: () => void) => unknown;
const routes = new Map<string, Handler[]>();
const app: any = {
  get: (path: string, ...handlers: Handler[]) => {
    routes.set("GET " + path, handlers);
  },
  post: (path: string, ...handlers: Handler[]) => {
    routes.set("POST " + path, handlers);
  },
};
registerFinalizedLoadingReturnRoutes(app);

async function apply(
  options: {
    role?: string;
    baleIds?: number[];
    reason?: string;
    confirmReturn?: boolean;
    expectedTotal?: string;
  } = {}
) {
  const req: any = {
    params: {},
    query: {},
    headers: { "accept-language": "en" },
    user: { role: options.role || "Admin" },
    session: { factoryCompanyId: 10, userId: 17, username: "tester" },
    body: {
      orderId: 91,
      baleIds: options.baleIds ?? [5],
      reason: options.reason ?? "Returned by customer",
      confirmReturn: options.confirmReturn ?? true,
      expectedTotal: options.expectedTotal ?? "100.00",
    },
  };
  const res: any = {
    statusCode: 200,
    body: null,
    status(status: number) {
      res.statusCode = status;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  for (const handler of routes.get("POST /api/factory/finalized-sale-returns/apply") ?? []) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return { status: res.statusCode, body: res.body };
}

describe("Admin-only finalized loading sale returns (not Factory POS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.selectResults.length = 0;
    h.executeResults.length = 0;
    h.order.grandTotal = "100.00";
    h.lockOrder.mockResolvedValue({ ...h.order });
    h.physicalDispatch.mockResolvedValue(false);
    h.postedTrip.mockResolvedValue(false);
    h.recalc.mockResolvedValue(undefined);
    h.syncTotals.mockResolvedValue(undefined);
    h.priorityUndo.mockResolvedValue(undefined);
    h.freeze.mockResolvedValue({ invoiceNumber: "INV-000091" });
    h.audit.mockResolvedValue(undefined);
  });

  it("rejects users without Admin/Developer role before accessing financial data", async () => {
    expect((await apply({ role: "Manager" })).status).toBe(403);
    expect((await apply({ role: "Owner" })).status).toBe(403);
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("rejects duplicate bale ids, unconfirmed returns and invalid quantities", async () => {
    expect((await apply({ baleIds: [5, 5] })).status).toBe(400);
    expect((await apply({ baleIds: [] })).status).toBe(400);
    expect((await apply({ confirmReturn: false })).status).toBe(400);
    expect(h.db.transaction).not.toHaveBeenCalled();
  });

  it("blocks posted/physical dispatch orders without altering stock or accounting", async () => {
    h.physicalDispatch.mockResolvedValue(true);
    const response = await apply();
    expect(response.status).toBe(409);
    expect(h.db.delete).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.syncTotals).not.toHaveBeenCalled();
  });

  it("blocks if the displayed amount no longer matches the finalized invoice", async () => {
    const response = await apply({ expectedTotal: "95.00" });
    expect(response.status).toBe(409);
    expect(h.db.delete).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("refuses already settled customer receivables instead of overwriting a payment", async () => {
    h.selectResults.push([{ transactionType: "SALE", debitAmount: "100.00", balance: "80.00", creditAmount: "20.00" }]);
    const response = await apply();
    expect(response.status).toBe(409);
    expect(h.db.delete).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it("returns a sold physical bale, recalculates receivable, records batch history and refreshes export", async () => {
    const saleRow = {
      id: 140,
      orderId: 91,
      baleId: 5,
      baleReference: "B-05",
      locationId: 4,
      articleCode: "WIP-01",
      baleName: "Wipers",
      weight: "50.000",
      priceUsed: "20.00",
      scannedBy: "tester",
    };
    const physical = {
      id: 5,
      companyId: 10,
      status: "SOLD",
      erpLocationId: 4,
      deletedAt: null,
      totalCost: "11.0000000",
    };
    h.selectResults.push(
      [{ transactionType: "SALE", debitAmount: "100.00", balance: "100.00", creditAmount: "0" }],
      [saleRow],
      [physical],
      [{ ...h.order, grandTotal: "80.00", totalQtyBales: 1 }]
    );
    h.executeResults.push(
      { rows: [] }, // advisory lock
      { rows: [] }, // duplicate return history
      { rows: [] }, // bale linked to another order
      { rows: [] } // audit insert
    );
    const response = await apply();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      invoiceNumber: "INV-000091",
      quantity: 1,
      originalTotal: "100.00",
      revisedTotal: "80.00",
      customerCredit: "20.00",
      snapshotUpdated: true,
    });
    expect(h.db.delete).toHaveBeenCalled();
    expect(h.db.update).toHaveBeenCalled();
    expect(h.db.insert).toHaveBeenCalledTimes(2);
    expect(h.recalc).toHaveBeenCalledOnce();
    expect(h.syncTotals).toHaveBeenCalledOnce();
    expect(h.priorityUndo).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.freeze).toHaveBeenCalledWith(91, 10, true);
  });
});
