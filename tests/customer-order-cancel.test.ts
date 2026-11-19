import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  order: null as Record<string, unknown> | null,
  baleIds: [] as number[],
  txSelectCall: 0,
  txUpdate: vi.fn(),
  txDelete: vi.fn(),
  txExecute: vi.fn(),
  transaction: vi.fn(),
  writeDaybookEntry: vi.fn(),
  recalculateOrderTotals: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("../server/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = harness.session;
    next();
  },
}));

vi.mock("../server/routes/factory/_helpers", () => ({
  writeDaybookEntry: harness.writeDaybookEntry,
  recalculateOrderTotals: harness.recalculateOrderTotals,
}));

vi.mock("../server/routes/helpers/auditHelpers", () => ({
  logAudit: harness.logAudit,
}));

vi.mock("../server/db", () => {
  const selectChain = (rows: unknown[]) => ({
    from: () => ({
      where: async () => rows,
    }),
  });

  const terminal = (returningRows: unknown[] = []) => ({
    returning: async () => returningRows,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(undefined).then(resolve, reject),
  });

  const tx = {
    select: () => {
      const call = harness.txSelectCall++;
      if (call === 0) return selectChain(harness.baleIds.map((baleId) => ({ baleId })));
      return selectChain([{ legalName: "Test Customer" }]);
    },
    update: harness.txUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => terminal([{ id: 77, status: "CANCELLED" }]),
      }),
    })),
    delete: harness.txDelete.mockImplementation(() => ({
      where: async () => undefined,
    })),
    execute: harness.txExecute,
  };

  harness.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));

  return {
    db: {
      select: () => selectChain(harness.order ? [harness.order] : []),
      transaction: harness.transaction,
    },
  };
});

import { registerOrderCancelRoutes } from "../server/routes/factory/customer-orders/finalize-loading/cancel";

const app = express();
app.use(express.json());
registerOrderCancelRoutes(app as any);

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    companyId: 12,
    customerId: 9,
    status: "LOADING",
    proformaIdUsed: null,
    loadingStartedAt: new Date("2026-09-03T07:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.session = { factoryCompanyId: 12, userId: "42", username: "loader" };
  harness.order = order();
  harness.baleIds = Array.from({ length: 500 }, (_, index) => index + 1);
  harness.txSelectCall = 0;
  harness.txExecute.mockResolvedValue(undefined);
  harness.writeDaybookEntry.mockResolvedValue(undefined);
  harness.recalculateOrderTotals.mockResolvedValue(undefined);
  harness.logAudit.mockResolvedValue(undefined);
});

describe("customer order cancellation phase 2", () => {
  it("releases hundreds of bales with one bulk update instead of one update per bale", async () => {
    const response = await request(app).post("/api/factory/customer-orders/77/cancel");

    expect(response.status).toBe(200);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    // One bulk factory-bale update + one order-status update, regardless of bale count.
    expect(harness.txUpdate).toHaveBeenCalledTimes(2);
    expect(harness.writeDaybookEntry).toHaveBeenCalledTimes(1);
    expect(harness.recalculateOrderTotals).not.toHaveBeenCalled();
  });

  it("skips the bulk bale update when an order has no linked bales", async () => {
    harness.baleIds = [];

    const response = await request(app).post("/api/factory/customer-orders/77/cancel");

    expect(response.status).toBe(200);
    // Only the order-status update remains; no empty IN (...) statement is emitted.
    expect(harness.txUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps the V5 archive, release, link cleanup and total recalculation in the same transaction", async () => {
    harness.order = order({ proformaIdUsed: 55 });

    const response = await request(app).post("/api/factory/customer-orders/77/cancel").send({ txDate: "2026-09-03" });

    expect(response.status).toBe(200);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    // Two executes: the proforma capacity advisory lock this cancellation takes
    // before touching the order, then the V5 bale-history archive insert.
    expect(harness.txExecute).toHaveBeenCalledTimes(2);
    expect(harness.txUpdate).toHaveBeenCalledTimes(2);
    expect(harness.txDelete).toHaveBeenCalledTimes(2);
    expect(harness.recalculateOrderTotals).toHaveBeenCalledTimes(1);
    expect(harness.writeDaybookEntry).toHaveBeenCalledTimes(1);
  });

  it("fails the cancellation when a transactional write fails and does not emit a success audit", async () => {
    harness.writeDaybookEntry.mockRejectedValueOnce(new Error("daybook write failed"));

    const response = await request(app).post("/api/factory/customer-orders/77/cancel");

    expect(response.status).toBe(500);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.logAudit).not.toHaveBeenCalled();
  });
});
