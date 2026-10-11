/**
 * Phase 27 — reporting complete.
 *
 * One seeded company. Prior year PY and fiscal year FY (two and one calendar
 * years back, so every date is before the business date):
 *   PY-06-15  cash 500 / revenue 500                     (prior-year earnings, never closed)
 *   FY-01-05  inventory 600 / payable 600
 *   FY-02-10  cash 1000 / revenue 1000
 *   FY-02-11  cost of sales 400 / inventory 400
 *   FY-02-12  rent 100 / bank 100                       (the bank is overdrawn by 100)
 *   FY-02-13  fixed asset 300 / loan 300
 *   FY-02-14  depreciation 30 / fixed asset 30
 *   FY-02-15  cash 50 / indirect income 50
 *   FY-02-16  cash 200 / capital 200
 * FY P&L: revenue 1000, cost of sales 400, gross 600, other income 50,
 * operating expenses 130, net 520. Balance sheet at FY-12-31: current assets
 * 1950 (cash 1750, inventory 200), non-current 270, current liabilities 700
 * (bank overdraft 100, payable 600), non-current 300 (loan), equity 200 +
 * retained 500 + current 520.
 * FY-03: a sale on the customer's linked ledger (60) and its receipt in cash.
 * Today: a revenue line on an account deleted afterwards (P&L tie-out) and a
 * voucher dated 30 days ahead (business-date default).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { getBalanceSheet, getFinancialRatios, getProfitLoss } from "../server/services/reports/financialReportsService";
import { buildClassifiedBalanceSheet } from "../server/services/accounting/reporting/classifiedBalanceSheet";
import { buildPeriodTrialBalance } from "../server/services/accounting/reporting/periodTrialBalance";
import { buildCashFlowStatement } from "../server/services/accounting/reporting/cashFlowStatement";
import { buildTrialBalance } from "../server/services/accounting/integrity/trialBalance";
import { reportTieOutChecks } from "../server/services/accounting/integrity/reportTieOutChecks";
import { reconcileNetPosition } from "../server/services/accounting/reporting/netPositionReconciliation";
import {
  fiscalYearStart,
  priorPeriod,
  sameDateLastYear,
  statementSectionOf,
} from "../server/services/accounting/reporting/classificationMap";
import { toMoney } from "../server/lib/money";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p27rep";
const now = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(now);
const inDays = (days: number) =>
  iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)));
const FY = now.getUTCFullYear() - 1;
const PY = FY - 1;
const fyEnd = `${FY}-12-31`;

let ctx: TestContext;
let agent: request.SuperAgentTest;
const ids: Record<string, number> = {};
let sequence = 0;

async function insertId(text: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(text, params);
  return rows[0].id;
}

async function account(key: string, accountType: string, subType: string | null = null) {
  ids[key] = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, 0, NULL) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-${key}`, `${TEST_PREFIX} ${key}`, accountType, subType]
  );
}

interface Line {
  ledger?: number;
  bank?: number;
  customer?: number;
  debit?: string;
  credit?: string;
}

async function voucher(date: string, lines: Line[], number?: string): Promise<number> {
  sequence += 1;
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
       VALUES ($1, $2, 'Journal', $3, $4, 'USD', false) RETURNING id`,
      [
        ctx.companyId,
        number ?? `${TEST_PREFIX.toUpperCase()}-${sequence}`,
        date,
        lines.reduce((sum, line) => sum + Number(line.debit ?? 0), 0).toFixed(2),
      ]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, customer_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          created.rows[0].id,
          line.ledger ?? null,
          line.bank ?? null,
          line.customer ?? null,
          line.debit ?? "0",
          line.credit ?? "0",
        ]
      );
    }
    return created.rows[0].id;
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
  await account("REV", "Income");
  await account("COGS", "COGS");
  await account("RENT", "Expense");
  await account("DEP", "Expense", "Depreciation");
  await account("INDINC", "Income", "Indirect Income");
  await account("CAPITAL", "Equity");
  await account("LOAN", "Loans");
  await account("PAYABLE", "Liability");
  await account("INV", "Current Asset");
  await account("FA", "Fixed Asset");
  await account("DELREV", "Income");
  await account("CUSTLEDGER", "Customer");
  // The linked ledger's own opening is not counted (engine rule 1: the customer's is).
  await pool.query("UPDATE ledger_accounts SET opening_balance = 40, opening_balance_side = 'Dr' WHERE id = $1", [
    ids.CUSTLEDGER,
  ]);
  ids.BANK = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Bank', '27', 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-BANK-${ctx.companyId}`, `${TEST_PREFIX} bank`]
  );
  ids.CUSTOMER = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, ledger_account_id)
     VALUES ($1, $2, $3, 0, 'Dr', $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-C1`, `${TEST_PREFIX} customer`, ids.CUSTLEDGER]
  );

  await voucher(`${PY}-06-15`, [
    { ledger: cash, debit: "500.00" },
    { ledger: ids.REV, credit: "500.00" },
  ]);
  await voucher(`${FY}-01-05`, [
    { ledger: ids.INV, debit: "600.00" },
    { ledger: ids.PAYABLE, credit: "600.00" },
  ]);
  await voucher(`${FY}-02-10`, [
    { ledger: cash, debit: "1000.00" },
    { ledger: ids.REV, credit: "1000.00" },
  ]);
  await voucher(`${FY}-02-11`, [
    { ledger: ids.COGS, debit: "400.00" },
    { ledger: ids.INV, credit: "400.00" },
  ]);
  await voucher(`${FY}-02-12`, [
    { ledger: ids.RENT, debit: "100.00" },
    { bank: ids.BANK, credit: "100.00" },
  ]);
  await voucher(`${FY}-02-13`, [
    { ledger: ids.FA, debit: "300.00" },
    { ledger: ids.LOAN, credit: "300.00" },
  ]);
  await voucher(`${FY}-02-14`, [
    { ledger: ids.DEP, debit: "30.00" },
    { ledger: ids.FA, credit: "30.00" },
  ]);
  await voucher(`${FY}-02-15`, [
    { ledger: cash, debit: "50.00" },
    { ledger: ids.INDINC, credit: "50.00" },
  ]);
  await voucher(`${FY}-02-16`, [
    { ledger: cash, debit: "200.00" },
    { ledger: ids.CAPITAL, credit: "200.00" },
  ]);
  // The customer's linked ledger: the customer owns its lines (engine rule 1).
  await voucher(`${FY}-03-01`, [
    { ledger: ids.CUSTLEDGER, debit: "60.00" },
    { ledger: ids.REV, credit: "60.00" },
  ]);
  await voucher(`${FY}-03-20`, [
    { ledger: cash, debit: "60.00" },
    { ledger: ids.CUSTLEDGER, credit: "60.00" },
  ]);
  // Today: revenue on an account deleted afterwards (a P&L account the P&L no longer reads).
  await voucher(today, [
    { ledger: cash, debit: "5.00" },
    { ledger: ids.DELREV, credit: "5.00" },
  ]);
  await withFixtureTransaction(
    (client) => client.query("UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1", [ids.DELREV]),
    { legacyUnbalanced: true }
  );
  // A voucher dated ahead of the business date.
  await voucher(
    inDays(30),
    [
      { ledger: cash, debit: "10.00" },
      { ledger: ids.REV, credit: "10.00" },
    ],
    `${TEST_PREFIX.toUpperCase()}-FUTURE`
  );
  await pool.query(
    `INSERT INTO dashboard_cash_accounts (company_id, account_type, account_id, display_order)
     VALUES ($1, 'ledger', $2, 0), ($1, 'bank', $3, 1)`,
    [ctx.companyId, cash, ids.BANK]
  );
}, 120_000);

afterAll(async () => {
  await pool.query("DELETE FROM dashboard_cash_accounts WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

const lineOf = (lines: Array<{ kind: string; id: number | null; balance: string }>, kind: string, id: number) =>
  lines.find((line) => line.kind === kind && line.id === id);

describe("RP-4/RP-6: classified balance sheet, fiscal-year earnings, overdrawn banks", () => {
  it("splits current and non-current, puts the overdrawn bank in liabilities and earnings at the fiscal year", async () => {
    const sheet = await buildClassifiedBalanceSheet(ctx.companyId, fyEnd);
    expect(sheet.fiscalYear).toEqual({ start: `${FY}-01-01`, end: fyEnd });
    expect(lineOf(sheet.currentAssets.lines, "ledger", ctx.cashAccountId)).toMatchObject({
      balance: "1810.00",
      cash: true,
    });
    expect(lineOf(sheet.currentAssets.lines, "ledger", ids.INV)?.balance).toBe("200.00");
    expect(lineOf(sheet.nonCurrentAssets.lines, "ledger", ids.FA)?.balance).toBe("270.00");
    expect(lineOf(sheet.currentLiabilities.lines, "bank", ids.BANK)).toMatchObject({ balance: "100.00", cash: true });
    expect(lineOf(sheet.currentAssets.lines, "bank", ids.BANK)).toBeUndefined();
    expect(lineOf(sheet.currentLiabilities.lines, "ledger", ids.PAYABLE)?.balance).toBe("600.00");
    expect(lineOf(sheet.nonCurrentLiabilities.lines, "ledger", ids.LOAN)?.balance).toBe("300.00");
    expect(lineOf(sheet.equity.lines, "ledger", ids.CAPITAL)?.balance).toBe("200.00");
    expect(sheet.equity.retainedEarnings).toBe("500.00");
    expect(sheet.equity.currentEarnings).toBe("580.00"); // 520 + the customer's 60 sale
    expect(sheet.totals.cash).toBe("1710.00");
    expect(sheet.difference).toBe("0.00");
    expect(sheet.totals.netAssets).toBe(sheet.equity.total);
  });

  it("keeps getBalanceSheet's totals and difference equal to the trial balance's", async () => {
    const [sheet, trialBalance] = await Promise.all([
      getBalanceSheet(ctx.companyId, fyEnd),
      buildTrialBalance(ctx.companyId, fyEnd),
    ]);
    expect(sheet.difference).toBe(trialBalance.unexplainedDifference);
    expect(toMoney(sheet.equity.currentEarnings).plus(sheet.equity.retainedEarnings).toFixed(2)).toBe("1080.00");
    expect(lineOf(sheet.liabilities.lines, "bank", ids.BANK)?.balance).toBe("100.00");
  });

  it("computes the current ratio from current items and the gross margin from the ledger", async () => {
    const ratios = await getFinancialRatios(ctx.companyId, `${FY}-01-01`, fyEnd);
    // Current assets: cash 1810 + inventory 200, over current liabilities 700.
    expect(ratios.exact.currentAssets).toBe("2010.00");
    expect(ratios.exact.currentLiabilities).toBe("700.00");
    expect(ratios.ratios.currentRatio).toBeCloseTo(2010 / 700, 10);
    expect(ratios.exact).toMatchObject({ revenue: "1060.00", costOfSales: "400.00", grossProfit: "660.00" });
    expect(ratios.ratios.grossProfitMargin).toBeCloseTo((660 / 1060) * 100, 10);
    expect(ratios.marginBasis).toBe("ledger");
  });

  it("reports P&L sections", async () => {
    const pl = await getProfitLoss(ctx.companyId, `${FY}-01-01`, fyEnd);
    expect(pl.sections).toEqual({
      revenue: "1060.00",
      costOfSales: "400.00",
      grossProfit: "660.00",
      otherIncome: "50.00",
      operatingExpenses: "130.00",
      netProfit: "580.00",
    });
  });
});

describe("RP-2: cash flow statement (indirect)", () => {
  it("ties operating, investing and financing to the change in cash", async () => {
    const flow = await buildCashFlowStatement({ companyId: ctx.companyId, from: `${FY}-01-01`, to: fyEnd });
    expect(flow.operating.netProfit).toBe("580.00");
    expect(flow.operating.depreciation.total).toBe("30.00");
    // Inventory −200, payable +600, the customer's linked-ledger lines net 0.
    expect(flow.operating.workingCapital.total).toBe("400.00");
    expect(flow.operating.total).toBe("1010.00");
    expect(flow.investing.total).toBe("-300.00");
    expect(flow.financing.total).toBe("500.00");
    expect(flow.cash).toMatchObject({ opening: "500.00", netChange: "1210.00", closing: "1710.00" });
    expect(flow.computedNetChange).toBe("1210.00");
    expect(flow.difference).toBe("0.00");
    expect(flow.balanced).toBe(true);
  });
});

describe("RP-7/RP-8: period trial balance, comparatives, business-date default", () => {
  it("reports the period with comparatives and closings equal to the as-of trial balance", async () => {
    const period = await buildPeriodTrialBalance({
      companyId: ctx.companyId,
      from: `${FY}-02-01`,
      to: `${FY}-02-28`,
      compare: "priorYear",
    });
    expect(period.comparativePeriod).toEqual({ from: `${PY}-02-01`, to: `${PY}-02-28` });
    const cash = period.rows.find((row) => row.kind === "ledger" && row.id === ctx.cashAccountId)!;
    expect(cash).toMatchObject({ openingDebit: "500.00", periodDebit: "1250.00", closingDebit: "1750.00" });
    expect(cash.comparative).toMatchObject({ closingDebit: "0.00" });
    const asOf = await buildTrialBalance(ctx.companyId, `${FY}-02-28`);
    const asOfCash = asOf.rows.find((row) => row.kind === "ledger" && row.id === ctx.cashAccountId)!;
    expect(asOfCash.closingDebit).toBe(cash.closingDebit);
    expect(period.balanced).toBe(true);
    const prior = await buildPeriodTrialBalance({
      companyId: ctx.companyId,
      from: `${FY}-02-01`,
      to: `${FY}-02-28`,
      compare: "priorPeriod",
    });
    expect(prior.comparativePeriod).toEqual(priorPeriod(`${FY}-02-01`, `${FY}-02-28`));
    const inventory = prior.rows.find((row) => row.kind === "ledger" && row.id === ids.INV)!;
    expect(inventory.comparative).toMatchObject({ periodDebit: "600.00", closingDebit: "600.00" });
  });

  it("defaults to the business date and flags the future-dated voucher", async () => {
    const res = await agent.get("/api/accounting/trial-balance");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.asOfDefaulted).toBe(true);
    expect(res.body.asOf).toBe(res.body.businessDate);
    expect(res.body.futureDated.count).toBe(1);
    expect(res.body.futureDated.vouchers[0].voucherNumber).toBe(`${TEST_PREFIX.toUpperCase()}-FUTURE`);
    const cash = res.body.rows.find(
      (row: { kind: string; id: number }) => row.kind === "ledger" && row.id === ctx.cashAccountId
    );
    expect(cash.closingDebit).toBe("1815.00"); // the 10 dated ahead is not in it

    const period = await agent.get("/api/reports/trial-balance");
    expect(period.status).toBe(200);
    expect(period.body).toMatchObject({ toDefaulted: true, from: fiscalYearStart(period.body.to) });

    const sheet = await agent.get("/api/reports/balance-sheet");
    expect(sheet.status).toBe(200);
    expect(sheet.body).toMatchObject({ asOfDefaulted: true, futureDated: { count: 1 } });

    expect((await agent.get("/api/reports/trial-balance?compare=bogus")).status).toBe(400);
    expect((await agent.get("/api/reports/cash-flow?from=2026-13-01")).status).toBe(400);
  });

  it("adds comparatives to the balance sheet and the P&L routes", async () => {
    const sheet = await agent.get(`/api/reports/balance-sheet?asOfDate=${fyEnd}&compareAsOfDate=${PY}-12-31`);
    expect(sheet.status).toBe(200);
    expect(sheet.body.comparative.equity.currentEarnings).toBe("500.00");
    const pl = await agent.get(
      `/api/reports/profit-loss?startDate=${FY}-01-01&endDate=${fyEnd}&compareStartDate=${PY}-01-01&compareEndDate=${PY}-12-31`
    );
    expect(pl.status).toBe(200);
    expect(pl.body.sections.netProfit).toBe("580.00");
    expect(pl.body.comparative.sections.netProfit).toBe("500.00");
  });
});

describe("RP-1: Excel and PDF exports", () => {
  it.each([
    ["balance-sheet", `asOfDate=${fyEnd}`],
    ["trial-balance", `from=${FY}-01-01&to=${fyEnd}&compare=priorYear`],
    ["profit-loss", `startDate=${FY}-01-01&endDate=${fyEnd}`],
    ["ratios", `startDate=${FY}-01-01&endDate=${fyEnd}`],
    ["cash-flow", `from=${FY}-01-01&to=${fyEnd}`],
    ["aging", "kind=customer"],
  ])("exports %s as xlsx and pdf", async (report, query) => {
    const xlsx = await agent
      .get(`/api/reports/export/${report}?format=xlsx&${query}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    const pdf = await agent
      .get(`/api/reports/export/${report}?format=pdf&${query}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("refuses an unknown report or format", async () => {
    expect((await agent.get("/api/reports/export/nothing?format=xlsx")).status).toBe(404);
    expect((await agent.get("/api/reports/export/ratios?format=docx")).status).toBe(400);
  });
});

describe("RP-9/RP-10: ledger monthly summary and dashboard cards on the engine", () => {
  it("opens at the engine balance and buckets by booked month", async () => {
    const res = await agent.get(
      `/api/reports/ledger-monthly-summary/${ctx.cashAccountId}?startDate=${FY}-01-01&endDate=${fyEnd}`
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.openingBalance).toBe(-500); // credit-positive
    const february = res.body.months.find((month: { yearMonth: string }) => month.yearMonth === `${FY}-02`);
    expect(february).toMatchObject({ debit: 1250, credit: 0 });
    expect(res.body.months).toHaveLength(12);
    expect(res.body.grandTotal.closingBalance).toBe(-1810);
  });

  it("reads a customer-linked ledger as its customer's row", async () => {
    const res = await agent.get(
      `/api/reports/ledger-monthly-summary/${ids.CUSTLEDGER}?startDate=${FY}-01-01&endDate=${fyEnd}`
    );
    expect(res.status).toBe(200);
    expect(res.body.balanceOwner).toEqual({ kind: "customer", id: ids.CUSTOMER });
    expect(res.body.openingBalance).toBe(0); // the customer's opening; the ledger's own 40 is not counted
    const detail = await agent.get(`/api/reports/ledger-vouchers/${ids.CUSTLEDGER}/${FY}/3`);
    expect(detail.status).toBe(200);
    expect(detail.body.vouchers).toHaveLength(2);
    expect(detail.body.closingBalance).toBe(0);
  });

  it("shows engine closings on the dashboard cash cards", async () => {
    const res = await agent.get("/api/dashboard-cash-accounts");
    expect(res.status).toBe(200);
    const byType = Object.fromEntries(
      res.body.map((row: { accountType: string; account: { balance: number } }) => [
        row.accountType,
        row.account.balance,
      ])
    );
    // Balance cards show everything posted (wave 17 A's one end-date rule), the 10 dated ahead included.
    expect(byType).toEqual({ ledger: 1825, bank: -100 });
  });
});

describe("RP-14: tie-out diagnostics", () => {
  it("lists the P&L account the P&L does not read and reports the other tie-outs", async () => {
    const checks = await reportTieOutChecks(ctx.companyId);
    const byKey = Object.fromEntries(checks.map((item) => [item.key, item]));
    expect(byKey.report_tieout_balance_sheet_earnings_vs_pl).toMatchObject({ status: "warn", amount: "5.00" });
    expect(byKey.report_tieout_aging_vs_control.status).toBe("pass");
    expect(byKey.report_tieout_net_position_vs_balance_sheet).toBeDefined();
    expect(byKey.report_tieout_net_position_vs_balance_sheet.status).not.toBe("fail");
  });

  it("reconciles a net position with labelled memo lines", () => {
    const result = reconcileNetPosition("2026-01-31", "1300.00", "1000.00", [
      { label: "Stock (memo)", amount: "250.00" },
      { label: "Rent payable (memo)", amount: "-20.00" },
    ]);
    expect(result).toMatchObject({ memoTotal: "230.00", unexplained: "70.00", reconciled: false });
  });
});

describe("RP-15: report access roles", () => {
  it("refuses the statements to a role outside Admin/Owner/Manager", async () => {
    await pool.query("UPDATE user_company_roles SET role = 'Normal User' WHERE user_id = $1", [ctx.userId]);
    try {
      for (const path of [
        "/api/reports/ratios",
        "/api/reports/balance-sheet",
        "/api/reports/trial-balance",
        "/api/reports/cash-flow",
      ]) {
        expect((await agent.get(path)).status, path).toBe(403);
      }
    } finally {
      await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1", [ctx.userId]);
    }
  });
});

describe("classification map", () => {
  const negative = toMoney("-1");
  const positive = toMoney("1");
  it("places cash by sign and loans as non-current unless short-term", () => {
    expect(statementSectionOf({ kind: "bank", accountType: "Bank" }, negative)).toBe("currentLiabilities");
    expect(statementSectionOf({ kind: "ledger", accountType: "Cash" }, positive)).toBe("currentAssets");
    expect(statementSectionOf({ kind: "ledger", accountType: "Loans" }, negative)).toBe("nonCurrentLiabilities");
    expect(statementSectionOf({ kind: "ledger", accountType: "Loans", subType: "Short-term loan" }, negative)).toBe(
      "currentLiabilities"
    );
    expect(statementSectionOf({ kind: "fixedAsset", accountType: "Fixed Asset" }, positive)).toBe("nonCurrentAssets");
    expect(statementSectionOf({ kind: "customer", accountType: "Customer" }, negative)).toBe("currentLiabilities");
    expect(statementSectionOf({ kind: "ledger", accountType: "Mystery" }, positive)).toBe("unclassified");
    expect(sameDateLastYear("2024-02-29")).toBe("2023-02-28");
  });
});
