/**
 * /api/accounts/all sums movements exactly:
 * - a ledger debited 1.015 shows "1.02" (the float path printed "1.01");
 * - a bank with opening 0.1 Dr plus 0.2 and 0.005 debits shows "0.31";
 * - an employee credited 1.005 shows "1.01" (the float path printed "1.00").
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/helpers/partyOpeningSide", () => ({ loadPartyOpeningSides: async () => new Map() }));
vi.mock("../server/storage", () => ({
  storage: {
    getCompanyById: async () => ({ id: 7, companyType: "erp" }),
    getAllLedgerAccounts: async () => [
      { id: 1, code: "L1", name: "Cash", accountType: "asset", subType: null, openingBalance: "0", active: true },
    ],
    getAllBankAccounts: async () => [
      { id: 2, code: "B2", name: "Main", bankName: "Bank", openingBalance: "0.1", openingBalanceSide: "Dr" },
    ],
    getAllFixedAssets: async () => [],
    getAllEmployees: async () => [
      { id: 3, code: "E3", firstName: "A", lastName: "B", active: true, openingBalance: "0" },
    ],
    getAllSuppliers: async () => [],
    getAllCustomers: async () => [],
  },
}));
vi.mock("../server/db", () => {
  const movement = (row: Record<string, unknown>) => ({
    ledgerAccountId: null,
    bankAccountId: null,
    fixedAssetId: null,
    employeeId: null,
    debits: "0",
    credits: "0",
    ...row,
  });
  const rows = [
    movement({ ledgerAccountId: 1, debits: "1.015" }),
    movement({ bankAccountId: 2, debits: "0.2" }),
    movement({ bankAccountId: 2, debits: "0.005" }),
    movement({ employeeId: 3, credits: "1.005" }),
  ];
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "groupBy"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => ({ from: () => chain(rows) }) } };
});

// Customer-owned ledgers come from the balance engine (none here).
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({
  getPartyBalances: async () => ({ parties: [] }),
}));

import { serveAccountListForCompany } from "../server/routes/accounts/all";

describe("account list balances", () => {
  it("sums ledger, bank and employee movements exactly", async () => {
    let body: { accounts: Array<{ type: string; balance: unknown; balanceSide?: string }> } = { accounts: [] };
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await serveAccountListForCompany({ query: {}, headers: {} } as never, res as never, 7);

    expect(body.accounts.find((a) => a.type === "ledger")).toMatchObject({ balance: "1.02", balanceSide: "Dr" });
    expect(body.accounts.find((a) => a.type === "bank")).toMatchObject({ balance: "0.31", balanceSide: "Dr" });
    expect(body.accounts.find((a) => a.type === "employee")).toMatchObject({ balance: "1.01", balanceSide: "Cr" });
  });
});
