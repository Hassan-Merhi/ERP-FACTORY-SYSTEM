/**
 * Wave 17 (A) — reporting.
 *
 * One seeded company (A) plus a second (B) carry every case:
 *   1. a fiscal close leaves the closed year's P&L, the income statement, the
 *      dashboard month and the expense breakdown unchanged (the closing
 *      journal is not period profit), while the ledger balances include it;
 *      the close takes a sideless income opening on the Cr side, refuses a
 *      deleted P&L account that still carries a balance, skips one with none,
 *      and writes its audit row;
 *   2. the ledger-balance route and the pre-period balance follow the engine
 *      (sideless liability opening Cr; a bank linked to a ledger is not folded
 *      in; a line naming a ledger and a bank is the ledger's);
 *   3. a line of A's voucher on B's account is A's missing-account line in A's
 *      net position and not in B's;
 *   4. group elimination per company pair;
 *   5. the expense breakdown nets refunds, counts hidden accounts, takes a range;
 *   6. an invoice whose voucher is dated after asOf is a memo line at asOf;
 *   7. a statement without an end date lists future-dated lines, flagged;
 *   8. the aging report buckets the engine balance by voucher date.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { getProfitLoss } from "../server/services/reports/financialReportsService";
import { getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { MISSING_ACCOUNT_CATEGORY } from "../server/services/accounting/balances/netPositionParties";
import { calculateIncomeStatementForPeriod } from "../server/helpers/calculateIncomeStatementForPeriod";
import { calculateNetPositionAsOf } from "../server/helpers/calculateNetPositionAsOf";
import { pairIntercompanyBalances } from "../server/helpers/groupNetPosition";
import { getExpenseBreakdown, getMonthlyData } from "../server/services/stats/dashboardStatsService";
import { closeFiscalPeriod, FiscalPeriodCloseError } from "../server/storage/accounting/fiscal-periods";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w17rep";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
const now = new Date();
const today = iso(now);
const daysAgo = (days: number) =>
  iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)));
const monthStart = (offset: number) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)));
const monthEnd = (offset: number) => iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0)));
const monthDay = (offset: number, day: number) =>
  iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day)));

/** The closed period: eight months ago to the end of last month. */
const closeFrom = monthStart(-8);
const closeTo = monthEnd(-1);
const closingMonth = closeTo.slice(0, 7);

let ctx: TestContext;
let agent: request.SuperAgentTest;
let companyB: number;
const ids: Record<string, number> = {};
let sequence = 0;

async function insertId(text: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(text, params);
  return rows[0].id;
}

async function account(
  key: string,
  accountType: string,
  opts: { opening?: string; side?: "Dr" | "Cr" | null; hidden?: boolean; companyId?: number } = {}
) {
  ids[key] = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, is_hidden)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      opts.companyId ?? ctx.companyId,
      `${TEST_PREFIX}-${key}`,
      `${TEST_PREFIX} ${key}`,
      accountType,
      opts.opening ?? "0",
      opts.side === undefined ? "Dr" : opts.side,
      opts.hidden ?? false,
    ]
  );
}

interface Line {
  ledger?: number;
  bank?: number;
  supplier?: number;
  customer?: number;
  debit?: string;
  credit?: string;
}

async function voucher(
  date: string,
  lines: Line[],
  opts: { number?: string; legacy?: boolean; type?: string; companyId?: number } = {}
): Promise<number> {
  sequence += 1;
  return withFixtureTransaction(
    async (client) => {
      const created = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, optional)
         VALUES ($1, $2, $3, $4, $5, 'USD', false) RETURNING id`,
        [
          opts.companyId ?? ctx.companyId,
          opts.number ?? `${TEST_PREFIX.toUpperCase()}-${sequence}`,
          opts.type ?? "Journal",
          date,
          lines.reduce((sum, line) => sum + Number(line.debit ?? 0), 0).toFixed(2),
        ]
      );
      for (const line of lines) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, bank_account_id, supplier_id, customer_id,
                                        debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.bank ?? null,
            line.supplier ?? null,
            line.customer ?? null,
            line.debit ?? "0",
            line.credit ?? "0",
          ]
        );
      }
      return created.rows[0].id;
    },
    { legacyUnbalanced: opts.legacy }
  );
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

  // ── 1. fiscal close ──────────────────────────────────────────────────────
  await account("REV", "Income");
  await account("INC2", "Income", { opening: "50", side: null }); // sideless: Cr
  await account("EXP", "Expense");
  await account("HIDEXP", "Expense", { hidden: true });
  await account("DELB", "Expense");
  await account("DELZ", "Expense");
  await account("RE", "Equity");
  await voucher(monthDay(-6, 10), [
    { ledger: cash, debit: "1000.00" },
    { ledger: ids.REV, credit: "1000.00" },
  ]);
  await voucher(monthDay(-5, 5), [
    { ledger: ids.DELB, debit: "40.00" },
    { ledger: cash, credit: "40.00" },
  ]);
  await voucher(monthDay(-1, 15), [
    { ledger: ids.EXP, debit: "300.00" },
    { ledger: cash, credit: "300.00" },
  ]);
  // A refund in the same month (wave 17 A: counts in the expense breakdown).
  await voucher(monthDay(-1, 20), [
    { ledger: cash, debit: "20.00" },
    { ledger: ids.EXP, credit: "20.00" },
  ]);
  await voucher(monthDay(-1, 21), [
    { ledger: ids.HIDEXP, debit: "10.00" },
    { ledger: cash, credit: "10.00" },
  ]);
  // A deleted account still carrying a balance exists only as legacy data (the
  // delete guard refuses it now), so it is modelled under the reviewed bypass.
  await withFixtureTransaction(
    (client) =>
      client.query("UPDATE ledger_accounts SET deleted_at = now() WHERE id = ANY($1::int[])", [[ids.DELB, ids.DELZ]]),
    { legacyUnbalanced: true }
  );

  // ── 2. ledger-balance route and pre-period ───────────────────────────────
  await account("LIAB", "Liability", { opening: "100", side: null });
  await account("BANKLEDGER", "Bank");
  ids.BANK = await insertId(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance,
                                opening_balance_side, linked_ledger_id)
     VALUES ($1, $2, $3, 'Bank', '001', 70, 'Dr', $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-BANK-${ctx.companyId}`, `${TEST_PREFIX} bank`, ids.BANKLEDGER]
  );
  // A legacy line naming both the ledger and the bank: the ledger's line.
  await voucher(
    daysAgo(3),
    [
      { ledger: ids.BANKLEDGER, bank: ids.BANK, debit: "25.00" },
      { ledger: cash, credit: "25.00" },
    ],
    { legacy: true }
  );
  await voucher(daysAgo(3), [
    { bank: ids.BANK, debit: "5.00" },
    { ledger: cash, credit: "5.00" },
  ]);

  // ── 3. a line of A's voucher on B's account ──────────────────────────────
  companyB = await insertId(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}B`, `${TEST_PREFIX} company B`]
  );
  await account("BX", "Asset", { companyId: companyB });
  await voucher(
    daysAgo(2),
    [
      { ledger: ids.BX, debit: "60.00" },
      { ledger: cash, credit: "60.00" },
    ],
    { legacy: true }
  );

  // ── 6. an invoice posted after the as-of date ────────────────────────────
  ids.CU = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CU`, `${TEST_PREFIX} memo customer`]
  );
  ids.ORDER = await insertId(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total, finalized_at)
     VALUES ($1, $2, $3, 'FINALIZED', $4, 200, $5) RETURNING id`,
    [ctx.companyId, ids.CU, daysAgo(10), `${TEST_PREFIX.toUpperCase()}-INV-1`, `${daysAgo(10)}T12:00:00Z`]
  );
  await voucher(
    today,
    [
      { customer: ids.CU, debit: "200.00" },
      { ledger: ctx.salesAccountId, credit: "200.00" },
    ],
    { number: `INV-GL-${ctx.companyId}-${ids.ORDER}`, type: "Sales" }
  );

  // ── 7. a future-dated supplier line ──────────────────────────────────────
  ids.SUP = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 0, 'Cr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} supplier`, `${TEST_PREFIX}@example.test`]
  );
  await account("EXP2", "Expense");
  await voucher(daysAgo(1), [
    { ledger: ids.EXP2, debit: "12.00" },
    { supplier: ids.SUP, credit: "12.00" },
  ]);
  await voucher(daysAgo(-5), [
    { ledger: ids.EXP2, debit: "30.00" },
    { supplier: ids.SUP, credit: "30.00" },
  ]);

  // ── 8. aging ─────────────────────────────────────────────────────────────
  ids.CU2 = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CU2`, `${TEST_PREFIX} aging customer`]
  );
  const sale = async (date: string, amount: string) =>
    voucher(date, [
      { customer: ids.CU2, debit: amount },
      { ledger: ctx.salesAccountId, credit: amount },
    ]);
  await sale(daysAgo(100), "100.00");
  await sale(daysAgo(45), "50.00");
  await voucher(daysAgo(10), [
    { ledger: cash, debit: "30.00" },
    { customer: ids.CU2, credit: "30.00" },
  ]);
  await sale(daysAgo(5), "20.00");
}, 180_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("1: the fiscal closing journal is not period profit", () => {
  it("refuses a deleted P&L account that still carries a balance", async () => {
    const attempt = closeFiscalPeriod(ctx.companyId, closeFrom, closeTo, ids.RE, ctx.userId, undefined, {
      username: "w17",
    });
    await expect(attempt).rejects.toBeInstanceOf(FiscalPeriodCloseError);
    await expect(
      closeFiscalPeriod(ctx.companyId, closeFrom, closeTo, ids.RE, ctx.userId, undefined, { username: "w17" })
    ).rejects.toThrow(/DELB.*40\.00 Dr/);
  });

  it("closes the live accounts (sideless income opening Cr), skips a deleted zero account, audits in its transaction", async () => {
    await pool.query("UPDATE ledger_accounts SET deleted_at = NULL WHERE id = $1", [ids.DELB]);
    const before = await getProfitLoss(ctx.companyId, closeFrom, closeTo);
    const closure = await closeFiscalPeriod(ctx.companyId, closeFrom, closeTo, ids.RE, ctx.userId, undefined, {
      username: "w17",
    });
    // REV 1000 + the aging sales 150 + the sideless INC2 opening 50 on its Cr
    // side (it was read as Dr, which gave 1100).
    expect(closure.totalIncome).toBe("1200.00");
    expect(closure.totalExpense).toBe("330.00");
    const lines = await pool.query<{ ledger_account_id: number }>(
      "SELECT ledger_account_id FROM voucher_entries WHERE voucher_id = $1",
      [closure.closingVoucherId]
    );
    expect(lines.rows.map((row) => row.ledger_account_id)).not.toContain(ids.DELZ);
    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE table_name = 'fiscal_period_closures' AND record_id = $1`,
      [closure.id]
    );
    expect(audit.rows).toEqual([{ action: "create" }]);

    // The closed period's P&L is unchanged by its closing journal.
    const after = await getProfitLoss(ctx.companyId, closeFrom, closeTo);
    expect(after.totalIncome).toBe(before.totalIncome);
    expect(after.totalExpenses).toBe(before.totalExpenses);
    expect(after.netProfit).toBe(820);

    // The closing month is the month's own activity, not a loss of the year's profit.
    const month = await calculateIncomeStatementForPeriod(ctx.companyId, monthStart(-1), closeTo);
    expect(month.totalRevenue).toBe(0);
    expect(month.netProfit).toBe(-290);
    const dashboard = await getMonthlyData(ctx.companyId);
    const closing = dashboard.find((row) => row.yearMonth === closingMonth);
    expect(closing?.profit).toBe(-290);

    // Balances keep it: income and expense accounts are zero at the period end.
    const ledger = await getPartyBalances(db, {
      companyId: ctx.companyId,
      kind: "ledger",
      ids: [ids.REV, ids.EXP, ids.INC2, ids.RE],
      asOf: closeTo,
    });
    const closingOf = (id: number) => ledger.parties.find((party) => party.id === id)?.closing;
    expect(closingOf(ids.REV)).toBe("0.00");
    expect(closingOf(ids.EXP)).toBe("0.00");
    expect(closingOf(ids.INC2)).toBe("0.00");
    expect(closingOf(ids.RE)).toBe("-870.00");
  });

  it("the expense breakdown nets the refund, counts the hidden account and leaves the closing journal out", async () => {
    const month = await getExpenseBreakdown(ctx.companyId, { startDate: monthStart(-1), endDate: closeTo });
    expect(month).toEqual([{ name: "Expense", value: 290 }]);
    const year = await getExpenseBreakdown(ctx.companyId, { startDate: closeFrom, endDate: closeTo });
    expect(year).toEqual([{ name: "Expense", value: 330 }]);
  });
});

describe("2: ledger balance and pre-period on the engine", () => {
  it("a sideless liability opening is Cr; a linked bank is not folded into its ledger", async () => {
    const liability = await agent.get(`/api/accounts/ledger/${ids.LIAB}/balance`);
    expect(liability.status).toBe(200);
    expect(liability.body.balance).toBe(-100);
    const bankLedger = await agent.get(`/api/accounts/ledger/${ids.BANKLEDGER}/balance`);
    expect(bankLedger.body.balance).toBe(25);
    const asOf = await agent.get(`/api/accounts/ledger/${ids.BANKLEDGER}/balance?asOf=${daysAgo(4)}`);
    expect(asOf.body.balance).toBe(0);
  });

  it("the pre-period balance takes the engine's side and line ownership", async () => {
    const liability = await agent.get(`/api/accounts/ledger/${ids.LIAB}/pre-period-balance?endDate=${today}`);
    expect(liability.body.balance).toBe(-100);
    // Bank: opening 70 + its bank-only line 5; the line naming the ledger too is the ledger's.
    const bank = await agent.get(`/api/accounts/bank/${ids.BANK}/pre-period-balance?endDate=${daysAgo(-1)}`);
    expect(bank.body.balance).toBe(75);
  });
});

describe("3: net positions read lines by the voucher's company", () => {
  it("A's line on B's account is A's missing-account line, not B's", async () => {
    const a = await calculateNetPositionAsOf(ctx.companyId, today);
    const missing = a.forUsLines.filter((line) => line.category === MISSING_ACCOUNT_CATEGORY);
    expect(missing.map((line) => line.value)).toEqual([60]);
    const b = await calculateNetPositionAsOf(companyB, today);
    expect(b.forUsLines.some((line) => line.label === `${TEST_PREFIX} BX`)).toBe(false);
    expect(b.forUsTotal).toBe(0);
  });
});

describe("4: group elimination per company pair", () => {
  it("eliminates each pair's matched part and shows each pair's difference", () => {
    const companies = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
      { id: 4, name: "D" },
    ];
    const base = { sources: ["transfer" as const], balance: "0" };
    const result = pairIntercompanyBalances(
      [
        // A ↔ B matched; B ↔ C one-sided each way (C's payable is to B, not to A).
        { ...base, companyId: 1, accountId: 11, accountName: "A due from B", counterpartyCompanyIds: [2], value: 50 },
        { ...base, companyId: 2, accountId: 21, accountName: "B due to A", counterpartyCompanyIds: [1], value: -50 },
        { ...base, companyId: 2, accountId: 22, accountName: "B due from C", counterpartyCompanyIds: [3], value: 100 },
        // C ↔ D mismatched.
        { ...base, companyId: 3, accountId: 31, accountName: "C due from D", counterpartyCompanyIds: [4], value: 80 },
        { ...base, companyId: 4, accountId: 41, accountName: "D due to C", counterpartyCompanyIds: [3], value: -60 },
        { ...base, companyId: 4, accountId: 42, accountName: "D due to A", counterpartyCompanyIds: [1], value: -100 },
      ],
      companies
    );
    const pair = (a: number, b: number) => result.pairs.find((p) => p.companyIds.join(",") === `${a},${b}`);
    expect(pair(1, 2)).toMatchObject({ eliminated: 50, difference: 0, status: "matched" });
    expect(pair(2, 3)).toMatchObject({ eliminated: 0, difference: 100, status: "mismatched" });
    expect(pair(3, 4)).toMatchObject({ eliminated: 60, difference: 20, status: "mismatched" });
    expect(pair(1, 4)).toMatchObject({ eliminated: 0, difference: -100, status: "mismatched" });
    // A set-wide netting would have matched B's 100 receivable against D's 100 payable to A.
    expect(result.eliminated).toBe(110);
    expect(result.differences.map((line) => [line.side, line.value]).sort()).toEqual([
      ["forUs", 100],
      ["forUs", 20],
      ["onUs", 100],
    ]);
  });
});

describe("6: memo lines at a past date", () => {
  it("an invoice whose voucher is dated after asOf is not yet in the ledger at asOf", async () => {
    const past = await getPartyBalances(db, {
      companyId: ctx.companyId,
      kind: "customer",
      ids: [ids.CU],
      asOf: daysAgo(5),
      memo: true,
    });
    expect(past.parties[0].closing).toBe("0.00");
    expect(past.parties[0].memoTotal).toBe("200.00");
    const now = await getPartyBalances(db, {
      companyId: ctx.companyId,
      kind: "customer",
      ids: [ids.CU],
      asOf: today,
      memo: true,
    });
    expect(now.parties[0].closing).toBe("200.00");
    expect(now.parties[0].memoTotal).toBe("0.00");
  });
});

describe("7: statements follow the engine's end-date rule", () => {
  it("without an end date the supplier statement lists the future-dated line, flagged", async () => {
    const all = await agent.get(`/api/accounts/supplier/${ids.SUP}/transactions`);
    expect(all.status).toBe(200);
    expect(all.body.endDate).toBeNull();
    expect(all.body.futureDatedCount).toBe(1);
    const flagged = all.body.transactions.filter((row: { futureDated?: boolean }) => row.futureDated);
    expect(flagged.map((row: { creditAmount: string }) => Number(row.creditAmount))).toEqual([30]);
    const cut = await agent.get(`/api/accounts/supplier/${ids.SUP}/transactions?endDate=${today}`);
    expect(cut.body.transactions.map((row: { creditAmount: string }) => Number(row.creditAmount))).toEqual([12]);
  });
});

describe("8: aging on the engine", () => {
  it("buckets the balance by the lines that raised it, newest first", async () => {
    const response = await agent.get(`/api/reports/aging?kind=customer&asOf=${today}`);
    expect(response.status).toBe(200);
    const row = response.body.parties.find((party: { id: number }) => party.id === ids.CU2);
    expect(row.balance).toBe("140.00");
    expect(row.buckets).toMatchObject({
      current: "20.00",
      days31to60: "50.00",
      days61to90: "0.00",
      over90: "70.00",
      opening: "0.00",
    });
    expect((await agent.get("/api/reports/aging?kind=other")).status).toBe(400);
  });
});
