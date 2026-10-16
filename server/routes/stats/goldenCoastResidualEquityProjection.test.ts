import { describe, expect, it } from "vitest";
import type { AccountBalance } from "../../netPositionHelper";
import { projectGoldenCoastResidualEquity } from "./goldenCoastResidualEquityProjection";

const EXCEL_STOCK = 305158.3;
const EXCEL_GC_SALES_CASH = 104328.5;
const EXCEL_HASSAN = 289242;
const EXCEL_TOTAL = 409486.8;
const EXCEL_FRESH_START = 120244.8;

function accounts(
  overrides: {
    hadi?: number;
    cash?: number;
    freshOpening?: number;
    freshDebit?: number;
    freshCredit?: number;
    hassanDebit?: number;
    hassanCredit?: number;
    gcSalesOpening?: number;
    gcSalesDebit?: number;
    gcSalesCredit?: number;
  } = {}
) {
  const hadi = overrides.hadi ?? 0;
  const cash = overrides.cash ?? 0;
  const freshOpening = overrides.freshOpening ?? 120245;
  const gcSalesOpening = overrides.gcSalesOpening ?? EXCEL_GC_SALES_CASH;
  const rows = [
    {
      id: 1,
      name: "Fresh Start FZ Equity",
      code: "GC-FSCAP",
      accountType: "Equity",
      subType: "gc_partner_capital",
      openingBalance: freshOpening.toFixed(2),
      openingBalanceSide: "Dr",
      active: true,
      deletedAt: null,
    },
    {
      id: 2,
      name: "Hassan Dakik Equity",
      code: "GC-HCAP",
      accountType: "Equity",
      subType: "gc_owner_capital",
      openingBalance: EXCEL_HASSAN.toFixed(2),
      openingBalanceSide: "Dr",
      active: true,
      deletedAt: null,
    },
    {
      id: 3,
      name: "GC Sales Cash",
      code: "SP-PAY",
      accountType: "Liability",
      subType: "sp_payable",
      openingBalance: gcSalesOpening.toFixed(2),
      openingBalanceSide: "Cr",
      active: true,
      deletedAt: null,
    },
    {
      id: 4,
      name: "HADI L'SHI — Intercompany",
      code: "SP-HADI-IC",
      accountType: "Intercompany",
      subType: "sp_hadi_intercompany",
      openingBalance: hadi.toFixed(2),
      openingBalanceSide: "Dr",
      active: true,
      deletedAt: null,
    },
  ];
  if (cash > 0) {
    rows.push({
      id: 5,
      name: "GC Cash",
      code: "GC-CASH",
      accountType: "Cash",
      subType: "Cash",
      openingBalance: cash.toFixed(2),
      openingBalanceSide: "Dr",
      active: true,
      deletedAt: null,
    });
  }

  const balances = new Map<number, AccountBalance>();
  const freshDebit = overrides.freshDebit ?? 0;
  const freshCredit = overrides.freshCredit ?? 0;
  const hassanDebit = overrides.hassanDebit ?? 0;
  const hassanCredit = overrides.hassanCredit ?? 0;
  const gcSalesDebit = overrides.gcSalesDebit ?? 0;
  const gcSalesCredit = overrides.gcSalesCredit ?? 0;
  if (freshDebit || freshCredit) balances.set(1, { debit: freshDebit, credit: freshCredit });
  if (hassanDebit || hassanCredit) balances.set(2, { debit: hassanDebit, credit: hassanCredit });
  if (gcSalesDebit || gcSalesCredit) balances.set(3, { debit: gcSalesDebit, credit: gcSalesCredit });
  return { rows, balances };
}

function baseBody(input: { tracker: number; cash?: number; stock?: number; hadiDisplayed?: number }) {
  const stock = input.stock ?? EXCEL_STOCK;
  const cash = input.cash ?? 0;
  const hadiDisplayed = input.hadiDisplayed ?? 0;
  return {
    forUs: {
      total: stock + cash + hadiDisplayed,
      breakdown: [
        { name: "Inventory", value: stock },
        ...(cash ? [{ name: "Cash", value: cash }] : []),
        ...(hadiDisplayed ? [{ name: "HADI Intercompany", value: hadiDisplayed }] : []),
      ],
      accounts: [
        {
          name: "Stock In Hand / Stock on Floor",
          code: "COMPUTED",
          value: stock,
          category: "Inventory",
        },
        ...(cash
          ? [
              {
                id: 5,
                name: "GC Cash",
                code: "GC-CASH",
                value: cash,
                category: "Cash",
              },
            ]
          : []),
        ...(hadiDisplayed
          ? [
              {
                id: 4,
                name: "HADI L'SHI — Intercompany",
                code: "SP-HADI-IC",
                value: hadiDisplayed,
                category: "HADI Intercompany",
              },
            ]
          : []),
      ],
    },
    onUs: {
      total: input.tracker,
      breakdown: [{ name: "Liability", value: input.tracker }],
      accounts: [
        {
          id: 3,
          name: "GC Sales Cash",
          code: "SP-PAY",
          value: input.tracker,
          category: "Liability",
        },
      ],
    },
    equity: {
      total: 0,
      accounts: [],
      includedInNetPosition: true,
    },
    netPosition: stock + cash + hadiDisplayed - input.tracker,
    netWorth: stock + cash + hadiDisplayed - input.tracker,
    forUsTotal: stock + cash + hadiDisplayed,
    onUsTotal: input.tracker,
    netPositionBreakdown: {
      assets: { total: stock + cash + hadiDisplayed, breakdown: [] },
      liabilities: { total: input.tracker, breakdown: [] },
      equity: { total: 0, accounts: [] },
      netPosition: stock + cash + hadiDisplayed - input.tracker,
    },
  };
}

describe("Golden Coast Excel-style Net Position projection", () => {
  it("matches the 1-Sep balance sheet by showing GC Sales Cash as Cash and Fresh Start as the residual", () => {
    const fixture = accounts({ hadi: EXCEL_GC_SALES_CASH });
    const result = projectGoldenCoastResidualEquity({
      body: baseBody({ tracker: EXCEL_GC_SALES_CASH }),
      companyAccounts: fixture.rows,
      accountBalances: fixture.balances,
    });

    expect(result.forUs.total).toBe(EXCEL_TOTAL);
    expect(result.onUs.total).toBe(0);
    expect(result.netPosition).toBe(EXCEL_TOTAL);
    expect(result.equity.total).toBe(EXCEL_TOTAL);
    expect(result.equity.residualFormula).toBe("net_position_minus_hassan");
    expect(result.equity.hassanClaim).toBe(EXCEL_HASSAN);
    expect(result.equity.freshStartResidual).toBe(EXCEL_FRESH_START);
    expect(result.equity.freshStartClaim).toBe(EXCEL_FRESH_START);
    expect(result.equity.unclosedEarnings).toBe(0);
    expect(result.equity.accounts).toHaveLength(2);
    expect(result.equity.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, value: EXCEL_FRESH_START, balanceSide: "Cr" }),
        expect.objectContaining({ id: 2, value: EXCEL_HASSAN, balanceSide: "Cr" }),
      ])
    );
    expect(result.forUs.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 3, value: EXCEL_GC_SALES_CASH, category: "Cash" })])
    );
    expect(result.onUs.accounts.some((account: { id?: number }) => account.id === 3)).toBe(false);
    expect(result.forUs.accounts.some((account: { id?: number }) => account.id === 4)).toBe(false);
  });

  it("removes a generic HADI Intercompany row so sales cash is never double-counted", () => {
    const fixture = accounts({ hadi: 5000 });
    const result = projectGoldenCoastResidualEquity({
      body: baseBody({ tracker: EXCEL_GC_SALES_CASH, hadiDisplayed: 5000 }),
      companyAccounts: fixture.rows,
      accountBalances: fixture.balances,
    });

    expect(result.forUs.total).toBe(EXCEL_TOTAL);
    expect(result.netPosition).toBe(EXCEL_TOTAL);
    expect(result.equity.freshStartResidual).toBe(EXCEL_FRESH_START);
    expect(result.forUs.accounts.some((account: { id?: number }) => account.id === 4)).toBe(false);
  });

  it("maps post-sale profit into Fresh Start without synthetic earnings", () => {
    const fixture = accounts({
      hadi: 1000,
      freshDebit: 1000,
      gcSalesCredit: 1000,
    });
    const result = projectGoldenCoastResidualEquity({
      body: baseBody({
        tracker: EXCEL_GC_SALES_CASH + 1000,
        stock: EXCEL_STOCK - 600,
      }),
      companyAccounts: fixture.rows,
      accountBalances: fixture.balances,
    });

    expect(result.forUs.total).toBe(EXCEL_TOTAL + 400);
    expect(result.onUs.total).toBe(0);
    expect(result.netPosition).toBe(EXCEL_TOTAL + 400);
    expect(result.equity.freshStartLedgerClaim).toBe(119245);
    expect(result.equity.freshStartResidual).toBe(EXCEL_FRESH_START + 400);
    expect(result.equity.partnerCapitalTotal).toBe(EXCEL_TOTAL + 400);
    expect(result.equity.accounts).toHaveLength(2);
    expect(
      result.equity.accounts.some((account: { name?: string }) => account.name === "Current Period Earnings (Unclosed)")
    ).toBe(false);
  });

  it("does not resurrect a historical cash balance when current translation resolves it to zero", () => {
    const fixture = accounts({ cash: 100 });
    const body = baseBody({ tracker: EXCEL_GC_SALES_CASH });
    Object.assign(body, {
      currencyRevaluation: {
        currentTranslatedLedgerAccountIds: [5],
        currentCashBankTranslationDifference: -100,
      },
    });

    const result = projectGoldenCoastResidualEquity({
      body,
      companyAccounts: fixture.rows,
      accountBalances: fixture.balances,
    });

    expect(result.forUs.total).toBe(EXCEL_TOTAL);
    expect(result.forUs.accounts.some((account: { id?: number }) => account.id === 5)).toBe(false);
    expect(result.onUs.accounts.some((account: { id?: number }) => account.id === 5)).toBe(false);
  });

  it("keeps a credit Inventory ledger balance out of What We Owe and nets it into stock", () => {
    const fixture = accounts();
    fixture.rows.push({
      id: 6,
      name: "Inventory",
      code: "INVENTORY",
      accountType: "Asset",
      subType: "Current Asset",
      openingBalance: "0",
      openingBalanceSide: "Dr",
      active: true,
      deletedAt: null,
    });
    fixture.balances.set(6, { debit: 1928.22, credit: 1968.58 });

    const result = projectGoldenCoastResidualEquity({
      body: baseBody({ tracker: EXCEL_GC_SALES_CASH, stock: 163847.58 }),
      companyAccounts: fixture.rows,
      accountBalances: fixture.balances,
    });

    expect(result.onUs.total).toBe(0);
    expect(result.onUs.accounts).toEqual([]);
    expect(result.forUs.total).toBe(163807.22 + EXCEL_GC_SALES_CASH);
    expect(result.netPosition).toBe(163807.22 + EXCEL_GC_SALES_CASH);
    expect(result.forUs.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPUTED", value: 163807.22 })])
    );
    expect(result.forUs.accounts.some((account: { id?: number }) => account.id === 6)).toBe(false);
  });

  it("does nothing to an ordinary Supplier Partner without Golden Coast equity roles", () => {
    const body = baseBody({ tracker: 100 });
    const result = projectGoldenCoastResidualEquity({
      body,
      companyAccounts: [
        {
          id: 3,
          name: "Supplier Cash Payable",
          code: "SP-PAY",
          accountType: "Liability",
          subType: "sp_payable",
          openingBalance: "100",
          openingBalanceSide: "Cr",
          active: true,
          deletedAt: null,
        },
      ],
      accountBalances: new Map(),
    });

    expect(result).toBe(body);
  });
});
