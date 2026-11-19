/**
 * Wave 13 (A) — reports on the engine and the classifier.
 *
 * One seeded company carries every case, so the file seeds once:
 *   - R1 the balance sheet classifies every row with classifyAccountType:
 *     Government Taxes is an expense (current earnings), Profit is equity,
 *     Intercompany counts by sign; current earnings equal the P&L's net profit
 *     to the same date, and the difference is still the trial balance's;
 *   - C1 a sideless Liability opening is counted Cr by the engine (and the
 *     trial balance still counts the assumption);
 *   - R2 a voucher dated on the last day of a month with an effective date in
 *     the next counts in the next month for the P&L, the period income
 *     statement, the net-profit drill-downs and the chat expense report;
 *   - R3 the dashboard buckets by year-month: last year's sale in this month
 *     is not added to this month;
 *   - R4 ratios skip optional and deleted vouchers and take assets and
 *     liabilities from the balance sheet;
 *   - R5 the net-profit workbook's net position is calculateNetPositionAsOf,
 *     and its indirect income has a row of its own.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { getBalanceSheet, getProfitLoss } from "../server/services/reports/financialReportsService";
import { buildTrialBalance } from "../server/services/accounting/integrity/trialBalance";
import { getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { calculateIncomeStatementForPeriod } from "../server/helpers/calculateIncomeStatementForPeriod";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { getMonthlyData } from "../server/services/stats/dashboardStatsService";
import { loadNetProfitDrillDown } from "../server/routes/reportsNetProfitStatementRoutes";
import { runReportImplementation } from "../server/chat/reports/implementations/reportImplementationRegistry";
import type { DataQueryContext } from "../server/chat/reports/types";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w13rep";

// Dates relative to today, so the fixture means the same on any run day.
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
const now = new Date();
const today = iso(now);
const monthStart = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
const monthEnd = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
/** The month before this one: the period most of the fixture is booked in. */
const periodFrom = iso(monthStart(-1));
const periodTo = iso(monthEnd(-1));
const periodMid = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
/** The month before the period. */
const priorFrom = iso(monthStart(-2));
const priorTo = iso(monthEnd(-2));
/** This month, a year ago. */
const lastYearSameMonth = iso(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 5)));
const thisYearMonth = today.slice(0, 7);

let ctx: TestContext;
let agent: request.SuperAgentTest;
const ids: Record<string, number> = {};
let sequence = 0;

async function account(
  key: string,
  accountType: string,
  opts: { subType?: string; opening?: string; side?: "Dr" | "Cr" | null } = {}
) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      ctx.companyId,
      `${TEST_PREFIX}-${key}`,
      `${TEST_PREFIX} ${key}`,
      accountType,
      opts.subType ?? null,
      opts.opening ?? "0",
      opts.side === undefined ? "Dr" : opts.side,
    ]
  );
  ids[key] = rows[0].id;
}

async function voucher(
  type: string,
  date: string,
  lines: Array<[number, string, string]>,
  opts: { effectiveDate?: string; optional?: boolean; deleted?: boolean } = {}
) {
  sequence += 1;
  await withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount,
                             currency, optional, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8) RETURNING id`,
      [
        ctx.companyId,
        `${TEST_PREFIX.toUpperCase()}-${sequence}`,
        type,
        date,
        opts.effectiveDate ?? null,
        lines.reduce((sum, [, debit]) => sum + Number(debit), 0).toFixed(2),
        opts.optional ?? false,
        opts.deleted ? new Date() : null,
      ]
    );
    for (const [ledgerAccountId, debit, credit] of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [created.rows[0].id, ledgerAccountId, debit, credit]
      );
    }
  });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const cash = ctx.cashAccountId;
  const sales = ctx.salesAccountId;
  await account("GOVTAX", "Government Taxes");
  await account("CAPITAL", "Profit");
  await account("INTERCO", "Intercompany");
  await account("RENT", "EXPENSE");
  await account("OTHERINC", "Income", { subType: "Indirect Income" });
  // A loan opened at 300 with no recorded side: a liability, so Cr (C1).
  await account("LOAN", "Liability", { opening: "300", side: null });

  await voucher("Sales", lastYearSameMonth, [
    [cash, "1000.00", "0"],
    [sales, "0", "1000.00"],
  ]);
  await voucher("Sales", today, [
    [cash, "400.00", "0"],
    [sales, "0", "400.00"],
  ]);
  await voucher("Payment", periodMid, [
    [ids.GOVTAX, "50.00", "0"],
    [cash, "0", "50.00"],
  ]);
  // Dated on the prior month's last day, effective on the period's first (R2).
  await voucher(
    "Payment",
    priorTo,
    [
      [ids.RENT, "120.00", "0"],
      [cash, "0", "120.00"],
    ],
    { effectiveDate: periodFrom }
  );
  await voucher("Receipt", periodMid, [
    [cash, "30.00", "0"],
    [ids.OTHERINC, "0", "30.00"],
  ]);
  await voucher("Journal", periodMid, [
    [cash, "500.00", "0"],
    [ids.CAPITAL, "0", "500.00"],
  ]);
  await voucher("Journal", periodMid, [
    [ids.INTERCO, "200.00", "0"],
    [cash, "0", "200.00"],
  ]);
  // Neither counts anywhere.
  await voucher(
    "Payment",
    periodMid,
    [
      [ids.RENT, "999.00", "0"],
      [cash, "0", "999.00"],
    ],
    { optional: true }
  );
  await voucher(
    "Payment",
    periodMid,
    [
      [ids.RENT, "777.00", "0"],
      [cash, "0", "777.00"],
    ],
    { deleted: true }
  );
}, 180_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

type SheetLine = { kind: string; id: number | null; balance: string };
const lineOf = (lines: SheetLine[], id: number) => lines.find((line) => line.kind === "ledger" && line.id === id);

describe("R1: balance sheet on the classifier", () => {
  it("puts Government Taxes in earnings, Profit in equity, Intercompany by sign", async () => {
    const sheet = await getBalanceSheet(ctx.companyId, today);
    expect(lineOf(sheet.liabilities.lines, ids.GOVTAX)).toBeUndefined();
    expect(lineOf(sheet.unclassified.lines, ids.GOVTAX)).toBeUndefined();
    expect(lineOf(sheet.equity.lines, ids.CAPITAL)?.balance).toBe("500.00");
    expect(lineOf(sheet.assets.lines, ids.INTERCO)?.balance).toBe("200.00");
  });

  it("reports current earnings equal to the P&L's net profit to the same date", async () => {
    const [sheet, profitLoss, trialBalance] = await Promise.all([
      getBalanceSheet(ctx.companyId, today),
      getProfitLoss(ctx.companyId, undefined, today),
      buildTrialBalance(ctx.companyId, today),
    ]);
    // 1000 + 400 sales + 30 indirect income − 50 duties − 120 rent.
    expect(profitLoss.netProfit).toBe(1260);
    expect(sheet.equity.currentEarnings).toBe(profitLoss.netProfit.toFixed(2));
    expect(sheet.difference).toBe(trialBalance.unexplainedDifference);
  });
});

describe("C1: sideless openings take their type's side", () => {
  it("counts a sideless liability opening as a credit and reports the assumption", async () => {
    const trialBalance = await buildTrialBalance(ctx.companyId, today);
    const loan = trialBalance.rows.find((row) => row.kind === "ledger" && row.id === ids.LOAN);
    expect(loan).toMatchObject({ openingDebit: "0.00", openingCredit: "300.00", closingCredit: "300.00" });
    expect(trialBalance.openingSidesAssumed).toBeGreaterThanOrEqual(1);

    const party = await getPartyBalances(db, { companyId: ctx.companyId, kind: "ledger", ids: [ids.LOAN] });
    expect(party.parties[0]).toMatchObject({ masterOpening: "-300.00", openingSideAssumed: true });

    const sheet = await getBalanceSheet(ctx.companyId, today);
    expect(lineOf(sheet.liabilities.lines, ids.LOAN)?.balance).toBe("300.00");
  });
});

describe("R2: one date basis, COALESCE(effective_date, voucher_date)", () => {
  it("books the rent in the effective month for the P&L and the period income statement", async () => {
    const period = await getProfitLoss(ctx.companyId, periodFrom, periodTo);
    const prior = await getProfitLoss(ctx.companyId, priorFrom, priorTo);
    expect(period.expenseItems.find((item) => item.id === ids.RENT)?.balance).toBe(120);
    expect(period.totalExpenses).toBe(170);
    expect(prior.expenseItems.find((item) => item.id === ids.RENT)).toBeUndefined();
    expect(period.netProfit).toBe(30 - 50 - 120);

    const statement = await calculateIncomeStatementForPeriod(ctx.companyId, periodFrom, periodTo);
    expect(statement.totalRevenue).toBe(30);
    expect(statement.totalExpenses).toBe(170);
    const priorStatement = await calculateIncomeStatementForPeriod(ctx.companyId, priorFrom, priorTo);
    expect(priorStatement.totalExpenses).toBe(0);
  });

  it("filters the net-profit drill-downs by the period on the same basis", async () => {
    const period = await loadNetProfitDrillDown(ctx.companyId, "indirectExpense", "debit", periodFrom, periodTo);
    expect(period.accounts.map((a) => [a.id, a.balance]).sort()).toEqual(
      [
        [ids.GOVTAX, 50],
        [ids.RENT, 120],
      ].sort()
    );
    const prior = await loadNetProfitDrillDown(ctx.companyId, "indirectExpense", "debit", priorFrom, priorTo);
    expect(prior.total).toBe(0);
  });

  it("uses it in the chat expense report", async () => {
    const run = (dateFrom: string, dateTo: string) =>
      runReportImplementation({
        companyId: ctx.companyId,
        params: { queryType: "expense_breakdown" } as DataQueryContext["params"],
        dateFrom,
        dateTo,
        todayStr: today,
        todayDate: now,
        thisMonthStart: iso(monthStart(0)),
        lastMonthStart: periodFrom,
        lastMonthEnd: periodTo,
        rowLimit: 50,
        userMessage: "expense breakdown",
        fmt: (n: number) => n.toFixed(2),
        fmtDec: (n: number) => n.toFixed(2),
      });
    const names = (result: unknown) =>
      ((result as { table?: { rows: string[][] } }).table?.rows ?? []).map((row) => row[0]);
    expect(names(await run(periodFrom, periodTo))).toEqual(
      expect.arrayContaining([`${TEST_PREFIX} RENT`, `${TEST_PREFIX} GOVTAX`])
    );
    expect(names(await run(priorFrom, priorTo))).not.toContain(`${TEST_PREFIX} RENT`);
  });
});

describe("R3: dashboard monthly data", () => {
  it("buckets by year-month in base amounts", async () => {
    const months = await getMonthlyData(ctx.companyId);
    const current = months.find((month) => month.yearMonth === thisYearMonth);
    // Last year's sale in this month is not added to this month.
    expect(current).toMatchObject({ sales: 400, profit: 400 });
    const period = months.find((month) => month.yearMonth === periodFrom.slice(0, 7));
    expect(period).toMatchObject({ sales: 0, profit: 30 - 50 - 120 });
  });
});

describe("R4: ratios", () => {
  it("skips optional and deleted vouchers and reads balances from the balance sheet", async () => {
    const res = await agent.get(`/api/reports/ratios?endDate=${today}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sheet = await getBalanceSheet(ctx.companyId, today);
    expect(res.body.underlying).toMatchObject({
      totalIncome: 1430,
      totalExpenses: 170,
      netProfit: 1260,
      totalAssets: Number(sheet.assets.total),
      totalLiabilities: Number(sheet.liabilities.total),
    });
  });
});

describe("R5: net-profit workbook", () => {
  it("takes its net position from calculateNetPositionAsOf and shows indirect income", async () => {
    const res = await agent
      .get(`/api/reports/net-profit-excel?startDate=${priorFrom}&endDate=${today}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as never);
    const expected = await calculateNetPositionAsOf(ctx.companyId, today);
    expect(workbook.description).toBe(`Net position as of ${today}: ${expected.netPosition.toFixed(2)}`);

    const summary = workbook.getWorksheet("Summary");
    expect(summary).toBeDefined();
    const rowsByLabel = new Map<string, unknown[]>();
    summary!.eachRow((row) => {
      const values = row.values as unknown[];
      rowsByLabel.set(String(values[1] ?? "").trim(), values);
    });
    const total = (label: string) => {
      const values = rowsByLabel.get(label);
      return values ? values[values.length - 1] : undefined;
    };
    expect(total("Indirect Incomes")).toBe(30);
    // Rent (mis-cased EXPENSE) and duties (Government Taxes) are in a section now.
    expect(total("Indirect Expenses")).toBe(170);
  });
});

describe("integrity diagnostic: non_canonical_account_types", () => {
  it("accepts every type the classifier knows", async () => {
    await account("COGS", "COGS");
    await account("REV", "Revenue");
    await account("CURASSET", "Current Asset");
    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const check = report.checks.find((c) => c.key === "non_canonical_account_types");
    const flagged = ((check?.samples ?? []) as Array<{ id: number }>).map((row) => row.id);
    for (const key of ["COGS", "REV", "CURASSET", "RENT", "GOVTAX", "CAPITAL"]) {
      expect(flagged).not.toContain(ids[key]);
    }
  });
});
