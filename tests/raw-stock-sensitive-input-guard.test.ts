import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditValues, auditInsert } = vi.hoisted(() => {
  const values = vi.fn(async () => undefined);
  return {
    auditValues: values,
    auditInsert: vi.fn(() => ({ values })),
  };
});

vi.mock("../server/db", () => ({
  db: { insert: auditInsert },
}));

import { requireRawStockSensitiveInput } from "../server/services/security/rawStockSensitiveInputGuard";

async function run(path: string, body: unknown, options: { mountedPath?: string } = {}) {
  const originalUrl = options.mountedPath ?? path;
  const req: any = {
    method: "POST",
    path,
    url: path,
    originalUrl,
    body,
    ip: "127.0.0.1",
    session: {
      userId: "user-1",
      username: "admin",
      currentCompanyId: 1,
      currentRole: "Admin",
    },
    get: (header: string) => (header.toLowerCase() === "user-agent" ? "vitest" : undefined),
  };
  const response: any = {
    statusCode: 200,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  const next = vi.fn();
  await requireRawStockSensitiveInput(req, response, next);
  return { req, response, next };
}

describe("raw-stock sensitive input guard", () => {
  beforeEach(() => {
    auditInsert.mockClear();
    auditValues.mockClear();
    auditValues.mockResolvedValue(undefined);
  });

  it("accepts and freezes an exact recalc apply payload", async () => {
    const result = await run("/api/factory/raw-stock/recalc/apply", {
      containerIds: [3, 7],
      confirm: true,
      confirmationToken: "signed-token",
      includeCompletedBatches: false,
      includeHistoricalContainers: false,
      reason: "Correct audited landed cost",
      idempotencyKey: "recalc:company:1:batch:44",
    });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.response.statusCode).toBe(200);
    expect(Object.isFrozen(result.req.body)).toBe(true);
    expect(auditValues).toHaveBeenCalledOnce();
  });

  it("uses originalUrl when Express has rewritten the mounted req.path", async () => {
    const result = await run(
      "/",
      {
        containerIds: [4],
        reason: "Apply approved FX rate",
        idempotencyKey: "fx:company:1:container:4",
        unexpected: true,
      },
      { mountedPath: "/api/factory/raw-stock/recalc/auto-apply-fx?source=admin" }
    );

    expect(result.response.statusCode).toBe(400);
    expect(result.next).not.toHaveBeenCalled();
    expect(auditValues.mock.calls[0][0].changes.targetId).toBe("/api/factory/raw-stock/recalc/auto-apply-fx");
  });

  it("admits the browser's retry identity on every guarded route", async () => {
    const result = await run("/api/factory/raw-stock/recalc/fix-source-mismatches", {
      clientRequestId: "6f1c2b9e-0d4a-4c1e-9a57-3b8e2f0c7d11",
    });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.req.body).toEqual({ clientRequestId: "6f1c2b9e-0d4a-4c1e-9a57-3b8e2f0c7d11" });
  });

  it("rejects unknown fields before route logic", async () => {
    const result = await run("/api/factory/raw-stock/recalc/auto-apply-fx", {
      containerIds: [1],
      reason: "Apply approved FX rate",
      idempotencyKey: "fx:company:1:container:1",
      adminOverride: true,
    });

    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.statusCode).toBe(400);
    expect(result.response.payload).toEqual({ message: "Invalid request" });
  });

  it("rejects duplicate, non-integer, and non-positive identifiers", async () => {
    for (const ids of [[1, 1], [1.5], [0], [-1], ["1"]]) {
      const result = await run("/api/factory/raw-stock/recalc/auto-apply-fx", {
        containerIds: ids,
        reason: "Apply approved FX rate",
        idempotencyKey: "fx:company:1:batch:1",
      });
      expect(result.response.statusCode).toBe(400);
      expect(result.next).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized identifier arrays", async () => {
    const result = await run("/api/factory/raw-stock/recalc/apply", {
      containerIds: Array.from({ length: 501 }, (_, index) => index + 1),
      reason: "Correct audited landed cost",
      idempotencyKey: "recalc:company:1:batch:large",
    });

    expect(result.response.statusCode).toBe(400);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("rejects manual rates outside the selected source set", async () => {
    const result = await run("/api/factory/raw-stock/recalc/zero-cost-sources/apply", {
      sourceIds: [10],
      manualRates: { "11": 0.55 },
      reason: "Repair approved source rate",
      idempotencyKey: "source:company:1:repair:10",
    });

    expect(result.response.statusCode).toBe(400);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("rejects unsafe object structure", async () => {
    const polluted = Object.create(null);
    polluted.sourceIds = [10];
    polluted.manualRates = Object.create(null);
    polluted.manualRates.constructor = 1;
    polluted.reason = "Repair approved source rate";
    polluted.idempotencyKey = "source:company:1:repair:unsafe";

    const result = await run("/api/factory/raw-stock/recalc/zero-cost-sources/apply", polluted);
    expect(result.response.statusCode).toBe(400);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("requires strict positive integer identifiers for direct repairs", async () => {
    const supplier = await run("/api/factory/raw-stock/supplier-rate/recompute", {
      supplierId: "12",
      reason: "Recompute approved supplier rate",
      idempotencyKey: "supplier:company:1:rate:12",
    });
    const undo = await run("/api/factory/raw-stock/recalc/undo", {
      undoLogId: 0,
      reason: "Undo incorrect recalculation",
      idempotencyKey: "undo:company:1:log:0",
    });

    expect(supplier.response.statusCode).toBe(400);
    expect(undo.response.statusCode).toBe(400);
  });
});
