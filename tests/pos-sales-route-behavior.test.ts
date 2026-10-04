import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  companyRows: [] as unknown[],
  createPosSale: vi.fn(),
  logAudit: vi.fn(),
  getClientDate: vi.fn(() => "2026-08-11"),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  canModifyDate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: harness.getClientDate }));
vi.mock("../server/lib/logger", () => ({
  logger: { info: harness.loggerInfo, error: harness.loggerError },
}));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  errorStatus: (_error: unknown, fallback = 500) => fallback,
}));
vi.mock("../server/services/pos/createSaleService", () => ({
  createPosSale: harness.createPosSale,
}));
vi.mock("../server/routes/helpers/auditHelpers", () => ({ logAudit: harness.logAudit }));
vi.mock("@shared/schema", () => ({
  companies: { id: "companies.id", companyType: "companies.companyType" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));
vi.mock("../server/db", () => ({
  db: {
    select: vi.fn(() => {
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => harness.companyRows),
      };
      return builder;
    }),
  },
}));

import { registerPosSalesRoutes } from "../server/routes/pos/posSalesRoutes";

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("POS sales route behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.companyRows.splice(0);
    registerPosSalesRoutes({
      post: (path: string, ...callbacks: Array<(...args: any[]) => unknown>) =>
        harness.handlers.set(path, callbacks.at(-1)!),
    } as never);
  });

  it("creates a normal-company POS sale using authenticated company/user/location policy inputs and writes audit evidence", async () => {
    harness.companyRows.push({ companyType: "standard" });
    harness.createPosSale.mockResolvedValue({
      status: 200,
      body: { voucher: { id: 501, voucherNumber: "POS-501" } },
    });
    const req = {
      session: {
        currentCompanyId: 4,
        cashAccountId: 31,
        userId: "session-user",
        username: "cashier",
      },
      user: { id: "user-7", role: "POS", canSellNegativeStock: true },
      body: {
        locationId: 11,
        items: [{ stockItemId: 8, quantity: 2 }],
        voucherDate: "2026-08-10",
      },
    };
    const res = makeRes();

    await harness.handlers.get("/api/pos/sales")!(req, res);

    expect(harness.createPosSale).toHaveBeenCalledWith(
      {
        currentCompanyId: 4,
        userId: "user-7",
        username: "cashier",
        userRole: "POS",
        canSellNegativeStock: true,
        sessionCashAccountId: 31,
        voucherDateFallback: "2026-08-11",
        body: req.body,
      },
      { isSpCompany: false }
    );
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "session-user",
        username: "cashier",
        companyId: 4,
        action: "create",
        tableName: "vouchers",
        recordId: 501,
        recordIdentifier: "POS-501",
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      voucher: { id: 501, voucherNumber: "POS-501" },
    });
  });

  it("selects supplier-partner accounting mode from the session company rather than request body", async () => {
    harness.companyRows.push({ companyType: "supplier_partner" });
    harness.createPosSale.mockResolvedValue({ status: 201, body: { voucher: { id: 601 } } });
    const req = {
      session: { currentCompanyId: 9, cashAccountId: 44, userId: "u9", username: "sp-pos" },
      user: { id: "u9", role: "POS", canSellNegativeStock: false },
      body: { companyId: 999, locationId: 12, items: [] },
    };
    const res = makeRes();

    await harness.handlers.get("/api/pos/sales")!(req, res);

    expect(harness.createPosSale).toHaveBeenCalledWith(
      expect.objectContaining({ currentCompanyId: 9, canSellNegativeStock: false }),
      { isSpCompany: true }
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(harness.logAudit).not.toHaveBeenCalled();
  });

  it("treats audit failure as non-fatal after a successful sale", async () => {
    harness.companyRows.push({ companyType: "standard" });
    harness.createPosSale.mockResolvedValue({
      status: 200,
      body: { voucher: { id: 700, voucherNumber: "POS-700" } },
    });
    harness.logAudit.mockRejectedValue(new Error("audit unavailable"));
    const res = makeRes();

    await harness.handlers.get("/api/pos/sales")!(
      {
        session: { currentCompanyId: 4, userId: "u1" },
        user: { id: "u1" },
        body: {},
      },
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(harness.loggerError).toHaveBeenCalledWith(
      "[POS create audit] non-fatal:",
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it.each([
    ["Inventory not found at location", 404],
    ["Insufficient stock for A7", 400],
    ["Not enough stock for A7", 400],
    ["database unavailable", 500],
  ])("maps service failure %s to status %s", async (message, expectedStatus) => {
    harness.companyRows.push({ companyType: "standard" });
    harness.createPosSale.mockRejectedValue(new Error(message));
    const res = makeRes();

    await harness.handlers.get("/api/pos/sales")!(
      {
        session: { currentCompanyId: 4, userId: "u1" },
        user: { id: "u1" },
        body: {},
      },
      res
    );

    expect(res.status).toHaveBeenCalledWith(expectedStatus);
    expect(res.json).toHaveBeenCalledWith({ message });
  });

  it("rejects a sale when no company is selected before calling the sale service", async () => {
    const res = makeRes();
    await harness.handlers.get("/api/pos/sales")!({ session: {}, user: { id: "u1" }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "No company selected" });
    expect(harness.createPosSale).not.toHaveBeenCalled();
  });
});
