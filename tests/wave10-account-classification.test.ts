/**
 * Wave 10, part A: one account-type classification for every balance engine.
 *
 * The ledger stores income in two forms ("Income" + subType "Indirect Income"
 * from the UI, and type "Indirect Income" from bulk payroll), legacy "Revenue"
 * for factory sales, "Profit" for capital, "Government Taxes" for duties, and
 * mis-cased types ('EXPENSE'). These tests prove that the shared classifier
 * reads them all the same way in net position, the P&L, net profit, the
 * monthly income statement, the chat trial balance and the fiscal close.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, like } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import {
  classifyAccountType,
  defaultOpeningSide,
  expenseCategory,
  isIndirectIncome,
} from "../server/services/accounting/accountClassification";
import { classifyNetPositionAccounts, getAccountNetBalance } from "../server/netPositionHelper";
import { getProfitLoss } from "../server/services/reports/financialReportsService";
import { calculateIncomeStatementForPeriod } from "../server/helpers/calculateIncomeStatementForPeriod";
import { phase5ReportShard } from "../server/chat/reports/implementations/phase5ReportShard";
import { closeFiscalPeriod } from "../server/storage/accounting/fiscal-periods";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { insertLedgerAccountSchema } from "../shared/schema";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w10acls";

describe("classifyAccountType", () => {
  it("classifies every stored spelling, case-insensitively", () => {
    expect(classifyAccountType("Income", "Indirect Income")).toBe("income");
    expect(classifyAccountType("Indirect Income")).toBe("income");
    expect(classifyAccountType("Revenue")).toBe("income");
    expect(classifyAccountType("INCOME")).toBe("income");
    expect(classifyAccountType("Government Taxes")).toBe("expense");
    expect(classifyAccountType("EXPENSE")).toBe("expense");
    expect(classifyAccountType(" direct expense ")).toBe("expense");
    expect(classifyAccountType("Profit")).toBe("equity");
    expect(classifyAccountType("EQUITY")).toBe("equity");
    expect(classifyAccountType("Loans")).toBe("liability");
    expect(classifyAccountType("Loan")).toBe("liability");
    expect(classifyAccountType("Duty Agent")).toBe("liability");
    expect(classifyAccountType("Accounts Payable")).toBe("liability");
    expect(classifyAccountType("Current Asset")).toBe("asset");
    expect(classifyAccountType("Fixed Asset")).toBe("asset");
    expect(classifyAccountType("Bank")).toBe("asset");
    expect(classifyAccountType("Customer")).toBe("party");
    expect(classifyAccountType("Supplier")).toBe("party");
    expect(classifyAccountType("Intercompany")).toBe("party");
  });

  it("reports an unknown type as unknown instead of guessing", () => {
    expect(classifyAccountType("Stock")).toBe("unknown");
    expect(classifyAccountType(null)).toBe("unknown");
    expect(classifyAccountType("")).toBe("unknown");
    // A subType that is itself a known type decides only when the type is unknown.
    expect(classifyAccountType(null, "Indirect Income")).toBe("income");
    expect(classifyAccountType("Asset", "Indirect Income")).toBe("asset");
  });

  it("normalises the sub-classifications both storage forms use", () => {
    expect(isIndirectIncome("Income", "Indirect Income")).toBe(true);
    expect(isIndirectIncome("Indirect Income")).toBe(true);
    expect(isIndirectIncome("Income", "Direct Income")).toBe(false);
    expect(expenseCategory("Expense", "Direct Expense")).toBe("Direct Expense");
    expect(expenseCategory("Indirect Expense")).toBe("Indirect Expense");
    expect(expenseCategory("EXPENSE")).toBe("Expense");
    expect(expenseCategory("Government Taxes")).toBe("Government Taxes");
    expect(expenseCategory("Income")).toBeNull();
  });

  it("defaults an opening with no side by class", () => {
    expect(defaultOpeningSide("Asset")).toBe("Dr");
    expect(defaultOpeningSide("Fixed Asset")).toBe("Dr");
    expect(defaultOpeningSide("Expense")).toBe("Dr");
    expect(defaultOpeningSide("Customer")).toBe("Dr");
    expect(defaultOpeningSide("Liability")).toBe("Cr");
    expect(defaultOpeningSide("Indirect Income")).toBe("Cr");
    expect(defaultOpeningSide("Profit")).toBe("Cr");
    expect(defaultOpeningSide("Supplier")).toBe("Cr");
    expect(defaultOpeningSide("Stock")).toBeNull();
  });

  it("accepts the Indirect Income type the ledger already stores, and not Intercompany", () => {
    const base = { companyId: 1, name: "x" };
    expect(insertLedgerAccountSchema.safeParse({ ...base, accountType: "Indirect Income" }).success).toBe(true);
    expect(insertLedgerAccountSchema.safeParse({ ...base, accountType: "Intercompany" }).success).toBe(false);
  });
});

describe("net position helper", () => {
  const acc = (id: number, accountType: string, subType: string | null = null) => ({
    id,
    name: `Account ${id}`,
    code: `ACC${id}`,
    accountType,
    subType,
    openingBalance: "0",
    openingBalanceSide: "Dr",
  });

  it("leaves every income and expense account out of net position", () => {
    const accounts = [
      acc(1, "Income", "Indirect Income"),
      acc(2, "Indirect Income"),
      acc(3, "Revenue"),
      acc(4, "INCOME"),
      acc(5, "Government Taxes"),
      acc(6, "EXPENSE"),
      acc(7, "Profit"),
    ];
    const balances = new Map([
      [1, { debit: 0, credit: 100 }],
      [2, { debit: 0, credit: 40 }],
      [3, { debit: 0, credit: 300 }],
      [4, { debit: 0, credit: 9 }],
      [5, { debit: 25, credit: 0 }],
      [6, { debit: 10, credit: 0 }],
      [7, { debit: 0, credit: 500 }],
    ]);
    const result = classifyNetPositionAccounts(accounts, balances);
    expect(result.forUsTotal).toBe(0);
    expect(result.onUsTotal).toBe(0);
    expect(result.forUsAccounts).toEqual([]);
    expect(result.onUsAccounts).toEqual([]);
  });

  it("still splits asset, liability and party accounts by sign", () => {
    const result = classifyNetPositionAccounts(
      [acc(10, "ASSET"), acc(11, "LIABILITY"), acc(12, "Customer")],
      new Map([
        [10, { debit: 70, credit: 0 }],
        [11, { debit: 0, credit: 30 }],
        [12, { debit: 0, credit: 5 }],
      ])
    );
    expect(result.forUsTotal).toBe(70);
    expect(result.onUsTotal).toBe(35);
  });

  it("reads a sideless opening on the classifier's default side", () => {
    const noSide = (accountType: string) => ({
      ...acc(20, accountType),
      openingBalance: "50",
      openingBalanceSide: null,
    });
    const none = new Map<number, { debit: number; credit: number }>();
    expect(getAccountNetBalance(noSide("Fixed Asset"), none)).toBe(50);
    expect(getAccountNetBalance(noSide("Expense"), none)).toBe(50);
    expect(getAccountNetBalance(noSide("Indirect Income"), none)).toBe(-50);
    expect(getAccountNetBalance(noSide("Liability"), none)).toBe(-50);
  });
});

describe("ledger reports", () => {
  let ctx: TestContext;
  let agent: request.SuperAgentTest;
  let seq = 0;
  const ids: Record<string, number> = {};

  async function account(key: string, accountType: string, subType: string | null = null) {
    const [row] = await db
      .insert(schema.ledgerAccounts)
      .values({
        companyId: ctx.companyId,
        code: `${TEST_PREFIX}_${key}`,
        name: `${TEST_PREFIX} ${key}`,
        accountType,
        subType,
        openingBalance: "0",
        openingBalanceSide: "Dr",
      })
      .returning();
    ids[key] = row.id;
  }

  async function voucher(
    date: string,
    debitId: number,
    creditId: number,
    amount: string,
    flags: { optional?: boolean; deleted?: boolean } = {}
  ) {
    seq += 1;
    await withFixtureTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, description, total_amount, optional, currency, deleted_at)
         VALUES ($1, 'Journal', $2, $3, 'wave 10 classification', $4, $5, 'USD', $6) RETURNING id`,
        [
          ctx.companyId,
          `${TEST_PREFIX}-${seq}`,
          date,
          amount,
          flags.optional ?? false,
          flags.deleted ? new Date() : null,
        ]
      );
      const voucherId = Number(rows[0].id);
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, '0'), ($1, $4, '0', $3)`,
        [voucherId, debitId, amount, creditId]
      );
    });
  }

  beforeAll(async () => {
    ctx = await seedTestData(TEST_PREFIX);
    await ensureClosedPeriodGuard(pool);
    agent = request.agent(ctx.app);
    expect(
      (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

    await account("RENT", "Income", "Indirect Income");
    await account("RECOVERY", "Indirect Income");
    await account("REVENUE", "Revenue");
    await account("DUTY", "Government Taxes");
    await account("UPPER", "EXPENSE");
    await account("CAPITAL", "Profit");
    await account("RE", "Equity");
    await account("TBA", "Asset");
    await account("TBL", "Liability");

    const cash = ctx.cashAccountId;
    await voucher("2026-03-02", cash, ids.RENT, "100.00");
    await voucher("2026-03-03", cash, ids.RECOVERY, "40.00");
    await voucher("2026-03-04", cash, ids.REVENUE, "300.00");
    await voucher("2026-03-05", ids.DUTY, cash, "25.00");
    await voucher("2026-03-06", ids.UPPER, cash, "10.00");
    await voucher("2026-03-07", cash, ids.CAPITAL, "500.00");
    // Trial-balance probes: one live line in range, and deleted, optional and
    // out-of-range vouchers that must not be summed.
    await voucher("2026-03-08", ids.TBA, ids.TBL, "7.00");
    await voucher("2026-03-09", ids.TBA, ids.TBL, "1000.00", { deleted: true });
    await voucher("2026-03-10", ids.TBA, ids.TBL, "2000.00", { optional: true });
    await voucher("2026-05-01", ids.TBA, ids.TBL, "4000.00");
  }, 120000);

  afterAll(async () => {
    await cleanupTestData(TEST_PREFIX);
    closeTestServer();
  }, 60000);

  it("P&L reads both Indirect Income forms and Revenue as income, Government Taxes as expense, Profit as neither", async () => {
    const pl = await getProfitLoss(ctx.companyId, "2026-03-01", "2026-03-31");
    const income = new Map(pl.incomeItems.map((item) => [item.id, item.balance]));
    const expense = new Map(pl.expenseItems.map((item) => [item.id, item.balance]));
    expect(income.get(ids.RENT)).toBe(100);
    expect(income.get(ids.RECOVERY)).toBe(40);
    expect(income.get(ids.REVENUE)).toBe(300);
    expect(income.has(ids.CAPITAL)).toBe(false);
    // Expense balances are debit-minus-credit since wave 13 (they were
    // credit-minus-debit, which made netProfit add the expenses).
    expect(expense.get(ids.DUTY)).toBe(25);
    expect(expense.get(ids.UPPER)).toBe(10);
  });

  it("the monthly income statement counts Indirect Income and not Profit as revenue", async () => {
    const statement = await calculateIncomeStatementForPeriod(ctx.companyId, "2026-03-01", "2026-03-31");
    const revenue = new Map(statement.revenueLines.map((line) => [line.label, line.value]));
    expect(revenue.get(`${TEST_PREFIX} RENT`)).toBe(100);
    expect(revenue.get(`${TEST_PREFIX} RECOVERY`)).toBe(40);
    expect(revenue.get(`${TEST_PREFIX} REVENUE`)).toBe(300);
    expect(revenue.has(`${TEST_PREFIX} CAPITAL`)).toBe(false);
    expect(statement.generalExpLines).toEqual(
      expect.arrayContaining([
        { label: `${TEST_PREFIX} DUTY`, value: 25, category: "Government Taxes" },
        { label: `${TEST_PREFIX} UPPER`, value: 10, category: "Expense" },
      ])
    );
  });

  it("net profit counts Indirect Income as income and keeps it and Government Taxes out of net position", async () => {
    const response = await agent.get("/api/stats/net-profit");
    expect(response.status).toBe(200);
    const accountIds = (list: Array<{ id?: number }>) => new Set(list.map((item) => item.id));
    const income = accountIds(response.body.income.accounts);
    const expenses = accountIds(response.body.expenses.accounts);
    const forUs = accountIds(response.body.forUs.accounts);
    const onUs = accountIds(response.body.onUs.accounts);
    for (const key of ["RENT", "RECOVERY", "REVENUE"]) {
      expect(income.has(ids[key])).toBe(true);
      expect(onUs.has(ids[key])).toBe(false);
    }
    for (const key of ["DUTY", "UPPER"]) {
      expect(expenses.has(ids[key])).toBe(true);
      expect(forUs.has(ids[key])).toBe(false);
    }
    const recovery = response.body.income.accounts.find((item: { id: number }) => item.id === ids.RECOVERY);
    expect(recovery).toMatchObject({ value: 40, category: "Indirect Income" });
  });

  it("the chat trial balance sums only live, non-optional lines in the date range", async () => {
    const result = await phase5ReportShard.run({
      companyId: ctx.companyId,
      params: { queryType: "trial_balance" },
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      todayStr: "2026-03-31",
      todayDate: new Date("2026-03-31T00:00:00Z"),
      rowLimit: 100,
      fmt: (value: number) => value.toFixed(2),
      fmtDec: (value: number) => value.toFixed(2),
    } as unknown as Parameters<typeof phase5ReportShard.run>[0]);
    const rows = result.table?.rows ?? [];
    const probe = rows.find((row) => row[1] === `${TEST_PREFIX} TBA`);
    const liability = rows.find((row) => row[1] === `${TEST_PREFIX} TBL`);
    expect(probe?.slice(3, 5)).toEqual(["7.00", "0.00"]);
    expect(liability?.slice(3, 5)).toEqual(["0.00", "7.00"]);
  });

  it("the fiscal close closes Revenue, both Indirect Income forms, Government Taxes and mis-cased types, not Profit", async () => {
    const closure = await closeFiscalPeriod(ctx.companyId, "2026-01-01", "2026-04-30", ids.RE, ctx.userId);
    const [closing] = await db
      .select()
      .from(schema.vouchers)
      .where(
        and(
          eq(schema.vouchers.companyId, ctx.companyId),
          like(schema.vouchers.voucherNumber, "FISCAL-CLOSE-2026-04-30-%"),
          isNull(schema.vouchers.deletedAt)
        )
      );
    const lines = await db.select().from(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, closing.id));
    const byAccount = new Map(
      lines.map((line) => [
        line.ledgerAccountId,
        `${Number(line.debitAmount).toFixed(2)}/${Number(line.creditAmount).toFixed(2)}`,
      ])
    );
    expect(byAccount.get(ids.RENT)).toBe("100.00/0.00");
    expect(byAccount.get(ids.RECOVERY)).toBe("40.00/0.00");
    expect(byAccount.get(ids.REVENUE)).toBe("300.00/0.00");
    expect(byAccount.get(ids.DUTY)).toBe("0.00/25.00");
    expect(byAccount.get(ids.UPPER)).toBe("0.00/10.00");
    expect(byAccount.has(ids.CAPITAL)).toBe(false);
    expect(byAccount.has(ids.TBA)).toBe(false);
    // The seeded sales account has no entries in the period, so these are our totals.
    expect(Number(closure.totalIncome)).toBe(440);
    expect(Number(closure.totalExpense)).toBe(35);
    expect(Number(closure.netIncome)).toBe(405);
  });
});
