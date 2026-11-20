/**
 * Golden Coast Net Position projection (goldenCoastResidualEquityProjection.ts):
 * the pure presentation rules for every account family it rebases (HADI
 * intercompany, profit-correction suspense, Goods OTW credit and debit,
 * liability deposits and overdrafts, inventory contra-assets, customers and
 * unknown types), the bodies it leaves alone, and the HTTP middleware that
 * installs it only for configured Golden Coast Supplier Partner companies.
 */
import { describe, expect, it } from "vitest";

import type { AccountBalance } from "../server/netPositionHelper";
import { projectGoldenCoastResidualEquity } from "../server/routes/stats/goldenCoastResidualEquityProjection";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

type Row = {
  id: number;
  name: string;
  code?: string;
  accountType: string;
  subType?: string | null;
  openingBalance?: string;
  openingBalanceSide?: string | null;
  active?: boolean;
  deletedAt?: unknown;
};

const base: Row[] = [
  { id: 1, name: "Fresh Start FZ Equity", accountType: "Equity", subType: "gc_partner_capital", openingBalance: "100" },
  {
    id: 2,
    name: "Hassan Dakik Equity",
    accountType: "Equity",
    subType: "gc_owner_capital",
    openingBalance: "40",
    openingBalanceSide: "Cr",
  },
];

function project(extra: Row[], balances: Array<[number, number, number]> = [], body: Record<string, unknown> = {}) {
  return projectGoldenCoastResidualEquity({
    body: { forUs: { accounts: [], total: 0 }, onUs: { accounts: [], total: 0 }, ...body },
    companyAccounts: [...base, ...extra] as never,
    accountBalances: new Map<number, AccountBalance>(balances.map(([id, debit, credit]) => [id, { debit, credit }])),
  });
}

const lines = (side: { accounts?: unknown } | undefined) =>
  (side?.accounts as Array<{ id?: number; name: string; value: number; category?: string }>).map((a) => [
    a.name,
    a.value,
    a.category,
  ]);

describe("Golden Coast residual equity projection rules", () => {
  it("leaves bodies without both sides or without Golden Coast roles unchanged", () => {
    const bare = { forUs: { accounts: [] } };
    expect(
      projectGoldenCoastResidualEquity({ body: bare, companyAccounts: base as never, accountBalances: new Map() })
    ).toBe(bare);
    const body = { forUs: { accounts: [] }, onUs: { accounts: [] } };
    const onlyFresh = [base[0], { ...base[1], active: false }];
    expect(
      projectGoldenCoastResidualEquity({ body, companyAccounts: onlyFresh as never, accountBalances: new Map() })
    ).toBe(body);
  });

  it("drops HADI intercompany and profit-correction suspense lines from both sides and totals", () => {
    const res = project(
      [
        {
          id: 10,
          name: "HADI",
          accountType: "Asset",
          subType: "sp_hadi_intercompany",
          openingBalance: "5",
          openingBalanceSide: "Dr",
        },
        {
          id: 11,
          name: "SP Profit Correction Suspense",
          accountType: "Asset",
          subType: "sp_profit_correction_suspense",
        },
      ],
      [],
      {
        forUs: {
          accounts: [
            { id: 10, name: "HADI", value: 5, category: "HADI Intercompany" },
            { id: 11, name: "SP Profit Correction Suspense", value: 3 },
            { name: "sp profit correction suspense", code: "x", value: 0 },
          ],
          total: 8,
        },
        onUs: { accounts: [{ id: 10, name: "HADI", value: 2 }], total: 2 },
        forUsTotal: 8,
      }
    );
    expect(res.forUs?.total).toBe(0);
    expect(res.onUs?.total).toBe(0);
    expect(lines(res.forUs)).toEqual([]);
  });

  it("rebases Goods OTW from its ledger: a debit is an asset, a credit an adjustment owed", () => {
    const debit = project(
      [{ id: 20, name: "Goods OTW", code: "OTW", accountType: "Asset", subType: "sp_goods_otw" }],
      [[20, 70, 0]],
      { forUs: { accounts: [{ id: 20, name: "OTW old", value: 1 }], total: 1 } }
    );
    expect(lines(debit.forUs)).toEqual([["Goods OTW", 70, "Goods OTW"]]);
    const credit = project(
      [{ id: 20, name: "Goods OTW", accountType: "Asset", subType: "sp_goods_otw" }],
      [[20, 0, 30]]
    );
    expect(lines(credit.onUs)).toEqual([["Goods OTW", 30, "Goods OTW Adjustment"]]);
    expect(credit.netPosition).toBe(-30);
  });

  it("adds remaining balance-sheet accounts by side and skips internal, customer and unknown types", () => {
    const res = project(
      [
        { id: 30, name: "Loan Owed", accountType: "Loans", openingBalance: "50", openingBalanceSide: "Cr" },
        { id: 31, name: "Agent Deposit", accountType: "Duty Agent", openingBalance: "12", openingBalanceSide: "Dr" },
        {
          id: 32,
          name: "Prepaid Rent",
          accountType: "Asset",
          subType: "sp_prepaid",
          openingBalance: "9",
          openingBalanceSide: "Dr",
        },
        { id: 33, name: "Overdrawn Bank", accountType: "Bank", openingBalance: "4", openingBalanceSide: "Cr" },
        {
          id: 34,
          name: "Inventory",
          code: "INVENTORY",
          accountType: "Asset",
          openingBalance: "6",
          openingBalanceSide: "Cr",
        },
        {
          id: 35,
          name: "Stock clearing",
          accountType: "Asset",
          subType: "sp_stock",
          openingBalance: "99",
          openingBalanceSide: "Dr",
        },
        { id: 36, name: "Customer Account A", accountType: "Asset", openingBalance: "8", openingBalanceSide: "Dr" },
        { id: 37, name: "Revenue", accountType: "Income", openingBalance: "8", openingBalanceSide: "Cr" },
        { id: 38, name: "Zero Asset", accountType: "Asset" },
        {
          id: 39,
          name: "HADI",
          accountType: "Asset",
          subType: "sp_hadi_intercompany",
          openingBalance: "3",
          openingBalanceSide: "Dr",
        },
        { id: 40, name: "Translated", accountType: "Asset", openingBalance: "3", openingBalanceSide: "Dr" },
      ],
      [],
      { currencyRevaluation: { currentTranslatedLedgerAccountIds: [40, "x"] } }
    );
    expect(lines(res.forUs)).toEqual([
      ["Agent Deposit", 12, "Duty Agent Deposit"],
      ["Prepaid Rent", 9, "Prepaid"],
      ["Inventory", -6, "Inventory"],
    ]);
    expect(lines(res.onUs)).toEqual([
      ["Loan Owed", 50, "Loans"],
      ["Overdrawn Bank", 4, "Bank Overdraft"],
    ]);
    expect(res.netPosition).toBe(-39);
    expect(res.netPositionLabel).toBe("Net Liabilities");
    expect(res.equity).toMatchObject({ hassanClaim: 40, freshStartResidual: -79 });
    expect((res.equity as { accounts: Array<{ balanceSide: string }> }).accounts[0].balanceSide).toBe("Dr");
  });

  it("offsets the computed stock line with an inventory contra balance and shows GC Sales Cash as cash", () => {
    const res = project(
      [
        { id: 50, name: "inventory", accountType: "Asset", openingBalance: "10", openingBalanceSide: "Cr" },
        {
          id: 51,
          name: "Supplier Payable",
          accountType: "Liability",
          subType: "sp_payable",
          openingBalance: "25",
          openingBalanceSide: "Cr",
        },
      ],
      [],
      {
        forUs: { accounts: [{ name: "Stock", code: "COMPUTED", category: "Inventory", value: 100 }], total: 100 },
        onUs: { accounts: [{ id: 51, name: "Supplier Payable", value: 25 }], total: 25 },
      }
    );
    expect(lines(res.forUs)).toEqual([
      ["Stock", 90, "Inventory"],
      ["Supplier Payable", 25, "Cash"],
    ]);
    expect(res.equity).toMatchObject({ gcSalesCashPayable: 25, gcSalesCashNetPositionValue: 25 });
  });
});

describe("Golden Coast projection middleware", () => {
  async function account(w: FactoryWorld, subType: string, type: string, opening = "0") {
    await w.q(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, $3, $4, $5, $6, 'Cr')`,
      [w.companyId, `${w.tag}-${subType}`, subType, type, subType, opening]
    );
  }

  it("projects only configured Golden Coast Supplier Partner companies", () =>
    withFactoryWorld(async (w) => {
      const plain = await w.agent.get("/api/stats/net-profit");
      expect(plain.status).toBe(200);
      expect(plain.body.equity?.residualFormula).toBeUndefined();
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      expect((await w.agent.get("/api/stats/net-profit")).body.equity?.residualFormula).toBeUndefined();
      await account(w, "gc_partner_capital", "Equity", "100");
      await account(w, "gc_owner_capital", "Equity", "40");
      await account(w, "sp_payable", "Liability", "25");
      const projected = await w.agent.get("/api/stats/net-profit?toDate=2026-12-31");
      expect(projected.status).toBe(200);
      expect(projected.body.equity).toMatchObject({
        residualFormula: "net_position_minus_hassan",
        hassanClaim: 40,
        gcSalesCashPayable: 25,
      });
    }));
});
