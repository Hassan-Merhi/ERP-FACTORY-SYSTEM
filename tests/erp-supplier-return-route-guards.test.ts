/**
 * Behavioural guard tests for the ERP supplier-return write routes.
 *
 * POST /api/erp/supplier-returns/preview and POST /api/erp/supplier-returns/commit
 * can post vouchers and move stock. These tests pin that only Admin/Developer
 * reach the handlers and that malformed requests are refused before any
 * database read or write happens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
  assertActiveCompanyAccess: vi.fn(async () => ({ activeCompanyId: 5 })),
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole:
    (...roles: string[]) =>
    (
      req: { user?: { role?: string } },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) =>
      roles.includes(req.user?.role ?? "") ? next() : res.status(403).json({ message: "Forbidden" }),
}));
vi.mock("../server/db", () => ({ db: { execute: h.execute, transaction: h.transaction } }));
vi.mock("../server/security/companyAccessBoundary", () => ({
  assertActiveCompanyAccess: h.assertActiveCompanyAccess,
}));
vi.mock("../server/inventoryHelper", () => ({ adjustInventory: vi.fn() }));
vi.mock("../server/services/accounting/inventoryControlAccount", () => ({
  getOrCreateInventoryControlAccount: vi.fn(),
}));
vi.mock("../server/services/accounting/perpetualInventory/linkedJournal", () => ({
  ledgerAccountByCodeTx: vi.fn(),
}));
vi.mock("../server/services/factory/factoryVoucherPosting", () => ({ postFactoryVoucherTx: vi.fn() }));
vi.mock("../server/services/inventory/databaseStockMovementAdapter", () => ({
  createDatabaseStockMovementAdapter: vi.fn(),
}));
vi.mock("../server/services/inventory/stockMovementIntegrityService", () => ({ postStockMovementTx: vi.fn() }));

import { registerErpSupplierReturnRoutes } from "../server/routes/erpSupplierReturnRoutes";

type Handler = (req: unknown, res: unknown, next: () => void) => unknown;
const routes = new Map<string, Handler[]>();
const app = {
  get: (path: string, ...handlers: Handler[]) => routes.set("GET " + path, handlers),
  post: (path: string, ...handlers: Handler[]) => routes.set("POST " + path, handlers),
};
registerErpSupplierReturnRoutes(app as never);

async function post(path: string, body: unknown, role = "Admin") {
  const handlers = routes.get("POST " + path);
  if (!handlers) throw new Error("route not registered: " + path);
  const req = { body, user: { role }, session: {}, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  for (const handler of handlers) {
    let continued = false;
    await handler(req, res, () => {
      continued = true;
    });
    if (!continued) break;
  }
  return res;
}

const PREVIEW = "/api/erp/supplier-returns/preview";
const COMMIT = "/api/erp/supplier-returns/commit";

describe("ERP supplier return write routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses roles other than Admin and Developer before the handler runs", async () => {
    for (const role of ["User", "Owner", "Viewer"]) {
      expect((await post(PREVIEW, { rows: [{ code: "A", quantity: 1 }] }, role)).statusCode).toBe(403);
      expect((await post(COMMIT, { requestKey: "request-key-1" }, role)).statusCode).toBe(403);
    }
    expect(h.assertActiveCompanyAccess).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed previews without reading inventory", async () => {
    for (const body of [
      {},
      { rows: [] },
      { rows: Array(1001).fill({ code: "A", quantity: 1 }) },
      { rows: [{ code: "", quantity: 1 }] },
      { supplierId: -1, rows: [{ code: "A", quantity: 1 }] },
    ]) {
      expect((await post(PREVIEW, body)).statusCode).toBe(400);
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed commits before opening a posting transaction", async () => {
    const valid = {
      requestKey: "return-request-0001",
      returnDate: "2026-11-14",
      lines: [{ offloadItemId: 1, quantity: "1" }],
    };
    for (const body of [
      { ...valid, requestKey: "short" },
      { ...valid, returnDate: "2026-02-30" },
      { ...valid, returnDate: "14/11/2026" },
      { ...valid, lines: [] },
      { ...valid, supplierId: 0 },
    ]) {
      expect((await post(COMMIT, body, "Developer")).statusCode).toBe(400);
    }
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
