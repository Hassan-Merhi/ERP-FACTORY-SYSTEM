/**
 * Phase 26 review finding — consolidation eliminates intercompany revenue and
 * cost in the presentation currency.
 *
 * Before: a company's trial-balance rows were translated by its factor
 * (USD per unit of its book currency), but its intercompany income / expense
 * amounts were put in the elimination maps in its book currency, so a sale
 * between a EUR subsidiary and its USD parent matched book-currency figures
 * against USD ones and eliminated the wrong amount from the translated rows.
 * Now the amounts are translated by the same factor first.
 *
 * CodeQL (type confusion through parameter tampering): the route's query
 * parameters must each be one string; a repeated one (an array) is refused
 * with a 400 instead of being coerced or compared as an array.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { buildConsolidation } from "../server/services/accounting/consolidation/consolidationService";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIXES = ["p26ctA", "p26ctB"] as const;
let parent: TestContext;
let child: TestContext;
let seq = 0;

async function account(companyId: number, code: string, type: string, subType: string | null = null) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance)
     VALUES ($1, $2, $3, $4, $5, '0') RETURNING id`,
    [companyId, code, code, type, subType]
  );
  return rows[0].id;
}

async function voucher(
  companyId: number,
  date: string,
  lines: { accountId: number; debit?: string; credit?: string }[]
) {
  seq += 1;
  return withFixtureTransaction(async (client) => {
    const total = lines.find((line) => line.debit)?.debit ?? "0";
    const { rows } = await client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, 'Journal', $3, $4) RETURNING id`,
      [companyId, `P26CT-${companyId}-${seq}-${Date.now()}`, date, total]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [rows[0].id, line.accountId, line.debit ?? "0", line.credit ?? "0"]
      );
    }
    return Number(rows[0].id);
  });
}

beforeAll(async () => {
  parent = await seedTestData(PREFIXES[0]);
  child = await seedTestData(PREFIXES[1]);
  await pool.query(`UPDATE companies SET parent_company_id = $1, base_currency = 'EUR' WHERE id = $2`, [
    parent.companyId,
    child.companyId,
  ]);
  // 0.5 EUR per USD: the child's EUR 15 is USD 30.
  await pool.query(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
     VALUES ($1, 'USD', 'EUR', '0.5', '2026-01-01')`,
    [child.companyId]
  );
}, 180_000);

afterAll(async () => {
  const ids = [parent?.companyId, child?.companyId].filter(Boolean);
  if (parent && child) {
    await pool.query(`DELETE FROM user_company_roles WHERE user_id = $1 AND company_id = $2`, [
      parent.userId,
      child.companyId,
    ]);
  }
  await pool.query(`DELETE FROM exchange_rates WHERE company_id = ANY($1)`, [ids]);
  await pool.query(`UPDATE companies SET parent_company_id = NULL, base_currency = 'USD' WHERE id = ANY($1)`, [ids]);
  for (const prefix of PREFIXES) await cleanupTestData(prefix);
  closeTestServer();
}, 180_000);

describe("review finding: intercompany revenue/cost elimination is translated", () => {
  it("matches a EUR subsidiary's sale to its USD parent in USD and eliminates it from the translated rows", async () => {
    const stamp = Date.now() % 100000;
    const childIc = await account(child.companyId, `IC-TO-CT${stamp}`, "Intercompany", "Due From");
    const childIncome = await account(child.companyId, `CT-INC-${stamp}`, "Income");
    const parentIc = await account(parent.companyId, `IC-FROM-CT${stamp}`, "Intercompany", "Due To");
    const parentExpense = await account(parent.companyId, `CT-EXP-${stamp}`, "Expense");
    // The child sells EUR 15 (USD 30) to the parent, which books USD 30.
    const sold = await voucher(child.companyId, "2026-07-01", [
      { accountId: childIc, debit: "15.00" },
      { accountId: childIncome, credit: "15.00" },
    ]);
    const bought = await voucher(parent.companyId, "2026-07-01", [
      { accountId: parentExpense, debit: "30.00" },
      { accountId: parentIc, credit: "30.00" },
    ]);
    await pool.query(
      `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
         from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id, from_ic_account_id, to_ic_account_id, source_type)
       VALUES ('Cash', $1, $2, '2026-07-01', 15, $3, $4, $5, $6, $3, $4, 'p26ct-test')`,
      [child.companyId, parent.companyId, childIc, parentIc, sold, bought]
    );

    const result = await buildConsolidation({ parentCompanyId: parent.companyId, asOf: "2026-12-31" });
    expect(result.companies.find((c) => c.companyId === child.companyId)).toMatchObject({
      baseCurrency: "EUR",
      translated: true,
    });
    const incomeRow = result.rows.find((r) => r.companyId === child.companyId && r.id === childIncome)!;
    const expenseRow = result.rows.find((r) => r.companyId === parent.companyId && r.id === parentExpense)!;
    expect(incomeRow.balance).toBe("-30.00");
    expect(expenseRow.balance).toBe("30.00");

    const revenueCost = result.eliminations.find(
      (e) => e.type === "intercompany-revenue-cost" && e.companyIds[0] === child.companyId
    )!;
    // Before the fix: EUR 15 matched against USD 30 — matched 15, difference -15.
    expect(revenueCost).toMatchObject({ matched: "30.00", difference: "0.00" });
    expect(incomeRow.consolidated).toBe("0.00");
    expect(expenseRow.consolidated).toBe("0.00");
    expect(result.totals.eliminationsBalanced).toBe(true);
  });
});

describe("CodeQL: consolidation query parameters are single strings", () => {
  it("refuses an array-valued (repeated) parameter with a 400 and serves a single one", async () => {
    await pool.query(
      `INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin') ON CONFLICT DO NOTHING`,
      [parent.userId, child.companyId]
    );
    const agent = request.agent(parent.app);
    expect(
      (await agent.post("/api/auth/login").send({ username: `${PREFIXES[0]}_testuser`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await agent.post("/api/auth/set-company").send({ companyId: parent.companyId })).status).toBe(200);
    const url = "/api/accounting/consolidation";
    const repeated = await agent.get(`${url}?asOf=2026-12-31&asOf=2026-11-30`);
    expect(repeated.status).toBe(400);
    const arrayParent = await agent.get(
      `${url}?asOf=2026-12-31&parentCompanyId=${parent.companyId}&parentCompanyId=${parent.companyId}`
    );
    expect(arrayParent.status).toBe(400);
    const arrayFrom = await agent.get(`${url}?asOf=2026-12-31&from=2026-01-01&from=2026-02-01`);
    expect(arrayFrom.status).toBe(400);
    const single = await agent.get(`${url}?asOf=2026-12-31&parentCompanyId=${parent.companyId}`);
    expect(single.status).toBe(200);
  });
});
