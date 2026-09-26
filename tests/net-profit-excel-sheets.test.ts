/**
 * The Profit & Loss workbook's arithmetic and classification rules.
 *
 * These functions decide which ledger account counts as income, as a purchase,
 * as a direct or indirect expense, and then produce the gross and net profit a
 * company reads off its P&L. They had no coverage at all, which means the
 * classification rules — several of them written as string tests on account
 * codes and names — could be changed by anyone without a single failing test.
 *
 * The sheet writers are exercised against a real ExcelJS worksheet and the
 * numbers are read back out of the cells, because a report that computes the
 * right figure and writes it into the wrong row is still a wrong report.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  computeBalancesFromEntries,
  computeStats,
  fmt,
  fmtMonthLabel,
  writeSheet,
  writeSummarySheet,
  type NetProfitSheetContext,
} from "../server/routes/netProfitExcelSheets";

function account(overrides: Record<string, unknown>) {
  return { id: 1, code: "MISC", name: "Misc", accountType: "Expense", subType: null, ...overrides };
}

function context(accounts: ReturnType<typeof account>[], importChargesIds: number[] = []): NetProfitSheetContext {
  return {
    companyAccounts: accounts,
    importChargesIds: new Set(importChargesIds),
    companyName: "Test Company",
  };
}

function balances(entries: Array<[number, number, number]>) {
  return new Map(entries.map(([id, debit, credit]) => [id, { debit, credit }]));
}

/** Every cell value in the sheet, flattened, for locating a written figure. */
function sheetValues(ws: ExcelJS.Worksheet): unknown[] {
  const values: unknown[] = [];
  ws.eachRow((row) => {
    row.eachCell({ includeEmpty: false }, (cell) => values.push(cell.value));
  });
  return values;
}

describe("net profit balances", () => {
  it("sums debits and credits per ledger account", () => {
    const result = computeBalancesFromEntries([
      { ledgerAccountId: 7, debitAmount: "100.50", creditAmount: "0" },
      { ledgerAccountId: 7, debitAmount: "0", creditAmount: "40.25" },
      { ledgerAccountId: 8, debitAmount: "10", creditAmount: "5" },
    ]);

    expect(result.get(7)).toEqual({ debit: 100.5, credit: 40.25 });
    expect(result.get(8)).toEqual({ debit: 10, credit: 5 });
  });

  it("ignores entries with no ledger account and treats missing amounts as zero", () => {
    const result = computeBalancesFromEntries([
      { ledgerAccountId: null, debitAmount: "999", creditAmount: "999" },
      { customerId: 3, debitAmount: "500" },
      { ledgerAccountId: 9 },
    ]);

    // An entry posted against a customer or supplier is not a ledger balance;
    // counting it here would inflate the P&L with subledger movement.
    expect(result.has(9)).toBe(true);
    expect(result.get(9)).toEqual({ debit: 0, credit: 0 });
    expect(result.size).toBe(1);
  });
});

describe("net profit statistics", () => {
  it("counts non-sales direct income and excludes sales accounts by code and by name", () => {
    const ctx = context([
      account({ id: 1, code: "OTHER-INC", name: "Scrap Income", accountType: "Income", subType: "Direct Income" }),
      account({ id: 2, code: "SALES-LOCAL", name: "Local Revenue", accountType: "Income", subType: "Direct Income" }),
      account({ id: 3, code: "REV", name: "Retail Sales", accountType: "Income", subType: "Direct Income" }),
    ]);

    const stats = computeStats(
      ctx,
      balances([
        [1, 0, 300],
        [2, 0, 1000],
        [3, 0, 500],
      ]),
      5000,
      0,
      0
    );

    // Sales are supplied separately as salesTotal; an account that is a sales
    // account by code or by name must not be added a second time.
    expect(stats.directIncTotal).toBe(300);
    expect(stats.totalIncome).toBe(5300);
    expect(stats.directIncDetails.map((row) => row.id)).toEqual([1]);
  });

  it("treats PURCHASES and its prefixed variants as purchases", () => {
    const ctx = context([
      account({ id: 1, code: "PURCHASES", name: "Purchases" }),
      account({ id: 2, code: "PURCHASES-IMPORT", name: "Import Purchases" }),
      account({ id: 3, code: "PURCHASING", name: "Not A Purchase Account" }),
    ]);

    const stats = computeStats(
      ctx,
      balances([
        [1, 400, 0],
        [2, 250, 50],
        [3, 900, 0],
      ]),
      0,
      0,
      0
    );

    expect(stats.purchaseTotal).toBe(600);
    expect(stats.purchaseDetails.map((row) => row.id)).toEqual([1, 2]);
  });

  it("recognises a direct expense by account type, by sub type, or by being an import charge", () => {
    const ctx = context(
      [
        account({ id: 1, code: "FREIGHT", name: "Freight", accountType: "Direct Expense" }),
        account({ id: 2, code: "LABOUR", name: "Labour", accountType: "Expense", subType: "Direct Expense" }),
        account({ id: 3, code: "CUSTOMS", name: "Customs", accountType: "Expense", subType: "Indirect Expense" }),
      ],
      [3]
    );

    const stats = computeStats(
      ctx,
      balances([
        [1, 100, 0],
        [2, 200, 0],
        [3, 300, 0],
      ]),
      0,
      0,
      0
    );

    expect(stats.directExpTotal).toBe(600);
    expect(stats.directExpDetails.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("keeps inventory valuation and return accounts out of indirect expenses", () => {
    const ctx = context([
      account({ id: 1, code: "RENT", name: "Rent", accountType: "Indirect Expense" }),
      account({ id: 2, code: "PRODUCTION_ADJUSTMENT", name: "Production", accountType: "Indirect Expense" }),
      account({ id: 3, code: "CONSUMPTION_EXPENSE", name: "Consumption", accountType: "Indirect Expense" }),
      account({
        id: 4,
        code: "STOCK_ADJUSTMENT",
        name: "Stock Adjustment (Production/Consumption)",
        accountType: "Indirect Expense",
      }),
      account({
        id: 5,
        code: "INVENTORY",
        name: "Credit Note - Customer Return",
        accountType: "Indirect Expense",
      }),
    ]);

    const stats = computeStats(
      ctx,
      balances([
        [1, 120, 0],
        [2, 5000, 0],
        [3, 4000, 0],
        [4, 57.16, 212.16],
        [5, 112.09, 0],
      ]),
      0,
      0,
      0
    );

    // These movements are already represented by stock/COGS. Counting them as
    // operating expenses would double-count inventory valuation changes.
    expect(stats.indirectExpTotal).toBe(120);
    expect(stats.indirectExpDetails.map((row) => row.id)).toEqual([1]);
  });

  it("drops accounts with no movement from the detail lists", () => {
    const ctx = context([account({ id: 1, code: "RENT", name: "Rent", accountType: "Indirect Expense" })]);

    const stats = computeStats(ctx, balances([]), 0, 0, 0);

    expect(stats.indirectExpDetails).toEqual([]);
    expect(stats.indirectExpTotal).toBe(0);
  });

  it("includes opening and closing stock in the annual cost of goods sold", () => {
    const ctx = context([account({ id: 1, code: "PURCHASES", name: "Purchases" })]);

    const stats = computeStats(ctx, balances([[1, 1000, 0]]), 3000, 500, 200);

    // Opening + purchases − closing.
    expect(stats.totalCOGS).toBe(1300);
    expect(stats.grossProfit).toBe(1700);
    expect(stats.netProfit).toBe(1700);
  });

  it("leaves opening and closing stock out of a single month", () => {
    const ctx = context([account({ id: 1, code: "PURCHASES", name: "Purchases" })]);

    const stats = computeStats(ctx, balances([[1, 1000, 0]]), 3000, 500, 200, true);

    // A month cannot claim the year's opening stock as its own cost.
    expect(stats.monthlyMode).toBe(true);
    expect(stats.totalCOGS).toBe(1000);
    expect(stats.grossProfit).toBe(2000);
  });

  it("reports zero margins rather than dividing by zero income", () => {
    const ctx = context([account({ id: 1, code: "PURCHASES", name: "Purchases" })]);

    const stats = computeStats(ctx, balances([[1, 400, 0]]), 0, 0, 0);

    expect(stats.totalIncome).toBe(0);
    expect(stats.grossMarginPct).toBe(0);
    expect(stats.netMarginPct).toBe(0);
    expect(Number.isFinite(stats.grossProfit)).toBe(true);
  });

  it("computes margins against total income", () => {
    const ctx = context([account({ id: 1, code: "PURCHASES", name: "Purchases" })]);

    const stats = computeStats(ctx, balances([[1, 250, 0]]), 1000, 0, 0);

    expect(stats.grossMarginPct).toBeCloseTo(75, 6);
    expect(stats.netMarginPct).toBeCloseTo(75, 6);
  });
});

describe("net profit formatting", () => {
  it("rounds money to two decimal places", () => {
    expect(fmt(1.005)).toBe(1.0);
    expect(fmt(2.346)).toBe(2.35);
    expect(fmt(-0.004)).toBe(-0);
  });

  it("renders a month key as a short month and year", () => {
    expect(fmtMonthLabel("2026-01")).toBe("Jan 2026");
    expect(fmtMonthLabel("2026-12")).toBe("Dec 2026");
  });
});

describe("net profit sheet writers", () => {
  const ctx = context([
    account({ id: 1, code: "PURCHASES", name: "Purchases" }),
    account({ id: 2, code: "RENT", name: "Rent", accountType: "Indirect Expense" }),
  ]);

  function statsFixture(monthlyMode = false) {
    return computeStats(
      ctx,
      balances([
        [1, 400, 0],
        [2, 100, 0],
      ]),
      2000,
      0,
      0,
      monthlyMode
    );
  }

  it("writes the period sheet with its headline figures", () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("P&L");

    writeSheet(ctx, ws, statsFixture(), "2026", true, 12345);

    const values = sheetValues(ws);
    expect(values).toContain("Profit & Loss — Test Company");
    // Income 2000, COGS 500, gross profit 1500 — the three numbers a reader
    // checks first, and the ones a row-offset bug moves.
    expect(values).toContain(2000);
    expect(values).toContain(500);
    expect(values).toContain(1500);
    expect(ws.rowCount).toBeGreaterThan(10);
  });

  it("notes in the period sheet when a month excludes stock movement", () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("P&L");

    writeSheet(ctx, ws, statsFixture(true), "Mar 2026", false, 0);

    const subtitle = String(ws.getCell("A2").value);
    expect(subtitle).toContain("Mar 2026");
    expect(subtitle).toContain("no stock adjustment");
  });

  it("writes a summary sheet with one column per month and a total column", () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Summary");
    const january = statsFixture(true);
    const february = statsFixture(true);

    writeSummarySheet(ctx, ws, [january, february], statsFixture(), ["Jan 2026", "Feb 2026"], 500);

    const header = ws.getRow(2);
    expect(header.getCell(2).value).toBe("Jan 2026");
    expect(header.getCell(3).value).toBe("Feb 2026");
    // The total column sits immediately after the last month, so a month added
    // to the list must not overwrite it.
    expect(header.getCell(4).value).toBe("TOTAL");
    expect(String(ws.getCell(1, 1).value)).toContain("Test Company");
  });
});
