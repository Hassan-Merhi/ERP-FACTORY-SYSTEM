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
vi.mock("../server/db", () => ({ db: {} }));

// Wave 18 C: the balances are the balance engine's rows (its SQL sums the
// lines exactly); a bank line that also names the ledger is the ledger's.
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/accounting/balances/ledgerBalanceEngine")>();
  const { MoneyDecimal } = await import("../server/lib/money");
  const row = (kind: string, id: number, opening: string, debit: string, credit: string) => ({
    kind,
    id,
    code: null,
    name: kind,
    accountType: null,
    deleted: false,
    linkedLedgerAccountId: null,
    masterOpening: new MoneyDecimal(opening),
    openingSideAssumed: false,
    carriedForward: new MoneyDecimal(0),
    periodDebit: new MoneyDecimal(debit),
    periodCredit: new MoneyDecimal(credit),
    baseMovement: new MoneyDecimal(0),
  });
  return {
    ...actual,
    // Customer-owned ledgers come from the balance engine (none here).
    getPartyBalances: async () => ({ parties: [] }),
    loadBalanceRows: async () => [
      row("ledger", 1, "0", "1.015", "0"),
      row("bank", 2, "0.1", "0.205", "0"),
      row("employee", 3, "0", "0", "1.005"),
    ],
  };
});

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
