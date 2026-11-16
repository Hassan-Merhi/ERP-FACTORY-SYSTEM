import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    calls: 0,
    // The first query is the selected-customer lookup; later queries return bale matches.
    customerRows: [{ id: 7, legalName: "Customer One" }] as Array<Record<string, unknown>>,
    rows: [] as Array<Record<string, unknown>>,
  };
  return {
    state,
    execute: vi.fn(async () => ({ rows: state.calls++ === 0 ? state.customerRows : state.rows })),
  };
});
vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: () => void) =>
      roles.includes(req.user?.role) ? next() : res.status(403).json({ message: "Forbidden" }),
}));
vi.mock("../server/db", () => ({ db: { execute: h.execute } }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { registerFinalizedReturnImportPreview } from "../server/routes/factory/customer-orders/bale-scanning/finalized-return-import-preview";

type Handler = (req: any, res: any, next: () => void) => unknown;
let handlers: Handler[] = [];
const app: any = {
  // Other finalized-return routes registered by the same module are not under test here.
  get: () => undefined,
  post: (path: string, ...next: Handler[]) => {
    if (path === "/api/factory/finalized-sale-returns/import-preview") handlers = next;
  },
};
registerFinalizedReturnImportPreview(app);

async function request(
  references: unknown,
  options?: { role?: string; companyId?: number | null; customerId?: unknown }
) {
  const req = {
    headers: {},
    body: { references, customerId: options && "customerId" in options ? options.customerId : 7 },
    session: { factoryCompanyId: options?.companyId === undefined ? 10 : options.companyId },
    user: { role: options?.role ?? "Admin" },
  };
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  for (const fn of handlers) {
    let continued = false;
    await fn(req, res, () => {
      continued = true;
    });
    if (!continued) break;
  }
  return { status: res.statusCode, body: res.body };
}

const match = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  baleId: 15,
  reference: key,
  articleCode: "ARTICLE",
  productName: "Cotton",
  orderId: 42,
  invoiceNumber: "INV-42",
  containerNumber: "ABCD-1",
  customerName: "Customer One",
  grandTotal: "500.00",
  dispatchBatchId: null,
  baleStatus: "SOLD",
  baleDeletedAt: null,
  currentLocationId: 2,
  soldLocationId: 2,
  balanceCount: 1,
  cleanBalanceCount: 1,
  ...extra,
});

describe("Finalized loading return Excel reference preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.calls = 0;
    h.state.customerRows = [{ id: 7, legalName: "Customer One" }];
    h.state.rows = [];
  });

  it("enforces Admin/Developer-only access to the invoice match endpoint", async () => {
    expect((await request(["HMD1"], { role: "User" })).status).toBe(403);
    expect((await request(["HMD1"], { role: "Owner" })).status).toBe(403);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects a missing Factory company or customer before reading data", async () => {
    expect((await request(["HMD1"], { companyId: null })).status).toBe(400);
    expect((await request(["HMD1"], { customerId: undefined })).status).toBe(400);
    expect((await request(["HMD1"], { customerId: "7" })).status).toBe(400);
    expect((await request(["HMD1"], { customerId: 0 })).status).toBe(400);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects a customer outside the Factory company", async () => {
    h.state.customerRows = [];
    expect((await request(["HMD1"])).status).toBe(404);
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("rejects malformed imports without matching bales", async () => {
    for (const references of [[], [""], Array(1001).fill("HMD1")]) {
      h.state.calls = 0;
      expect((await request(references)).status).toBe(400);
    }
    // Only the selected-customer lookup ran for each request; no bale query.
    expect(h.execute).toHaveBeenCalledTimes(3);
  });

  it("maps a unique bale to its exact invoice without writing changes", async () => {
    h.state.rows = [match("HMD0001")];
    const result = await request([" hmd0001 "]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      matched: 1,
      issues: 0,
      rows: [
        {
          status: "matched",
          reference: "hmd0001",
          orderId: 42,
          baleId: 15,
          invoiceNumber: "INV-42",
          containerNumber: "ABCD-1",
          articleCode: "ARTICLE",
        },
      ],
    });
    // Customer lookup plus one read-only bale match query.
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("flags repeated references even with case/spacing differences", async () => {
    h.state.rows = [match("HMD0001")];
    const result = await request(["HMD0001", " hmd0001 "]);
    expect(result.body.issues).toBe(2);
    expect(result.body.rows.map((row: any) => row.status)).toEqual(["duplicate", "duplicate"]);
  });

  it("never guesses when a reference belongs to multiple active invoices", async () => {
    h.state.rows = [match("HMD2"), match("HMD2", { orderId: 44, invoiceNumber: "INV-44", baleId: 24 })];
    const result = await request(["HMD2"]);
    expect(result.body.matched).toBe(0);
    expect(result.body.rows[0].status).toBe("ambiguous");
  });

  it("reports missing references and stops unsafe invoice/stock matches", async () => {
    h.state.rows = [
      match("HMD3", { balanceCount: 2, cleanBalanceCount: 1 }),
      match("HMD4", { currentLocationId: 3 }),
      match("HMD5", { dispatchBatchId: 123 }),
      match("HMD6", { baleStatus: "OFFLOADED" }),
    ];
    const result = await request(["HMD3", "HMD4", "HMD5", "HMD6", "UNKNOWN"]);
    expect(result.body.matched).toBe(0);
    expect(result.body.issues).toBe(5);
    expect(result.body.rows.map((row: any) => row.status)).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "missing",
    ]);
  });
});
