/**
 * /api/accounts/voucher-sidebar sums movements exactly:
 * - an employee credited 1.005 shows "1.01" (the float path printed "1.00");
 * - a supplier credited 0.1 and 0.2 shows -0.3 (the float path returned
 *   -0.30000000000000004).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/helpers/partyOpeningSide", () => ({ loadPartyOpeningSides: async () => new Map() }));
vi.mock("../server/routes/customers/customerBalanceQuery", () => ({ getCustomersWithBalances: async () => [] }));
vi.mock("../server/storage", () => ({
  storage: {
    getCompanyById: async () => ({ companyType: "erp", parentCompanyId: null }),
    getAllLedgerAccounts: async () => [],
    getAllBankAccounts: async () => [],
    getAllFixedAssets: async () => [],
    getAllEmployees: async () => [
      { id: 3, code: "E3", firstName: "A", lastName: "B", active: true, openingBalance: "0" },
    ],
    getAllSuppliers: async () => [{ id: 4, companyId: 7, legalName: "S", code: "S4", openingBalance: "0" }],
  },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const movement = (row: Record<string, unknown>) => ({
    bankAccountId: null,
    fixedAssetId: null,
    supplierId: null,
    employeeId: null,
    factorySupplierId: null,
    debits: "0",
    credits: "0",
    supplierNet: "0",
    factorySupplierVoucherPaidUsd: "0",
    ...row,
  });
  const rows = (table: never, fields?: Record<string, unknown>) => {
    if (getTableName(table) !== "voucher_entries" || (fields && "ledgerAccountId" in fields)) return [];
    return [
      movement({ employeeId: 3, credits: "1.005" }),
      movement({ supplierId: 4, supplierNet: "0.1" }),
      movement({ supplierId: 4, supplierNet: "0.2" }),
    ];
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "groupBy"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: { select: (fields?: Record<string, unknown>) => ({ from: (table: never) => chain(rows(table, fields)) }) },
  };
});

import { registerAccountVoucherSidebarRoutes } from "../server/routes/accounts/voucher-sidebar";

describe("voucher sidebar balances", () => {
  it("sums employee and supplier movements exactly", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerAccountVoucherSidebarRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: Array<{ type: string; balance: unknown; balanceSide?: string }> = [];
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler({ session: { currentCompanyId: 7 } }, res);

    expect(body.find((a) => a.type === "employee")).toMatchObject({ balance: "1.01", balanceSide: "Cr" });
    expect(body.find((a) => a.type === "supplier")?.balance).toBe(-0.3);
  });
});
