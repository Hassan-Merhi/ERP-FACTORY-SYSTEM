/**
 * Phase 23 (chart of accounts and general ledger model) — the database guards
 * and the classification:
 *   - C3: account_class derived from the type (a generated column with a CHECK),
 *     tax accounts a liability (an asset when receivable), intercompany by sub-type;
 *     isAccountType replaces raw comparisons;
 *   - C7: new lines only on active, non-deleted leaf accounts and live parties
 *     (ledger guard v5); history (an unchanged line) unaffected;
 *   - G17: a supplier of another company (the parent's) is refused;
 *   - C10: bank / fixed-asset codes unique per company;
 *   - DI3: the sub-ledger period lock (customer_balances, sales cost, payroll runs);
 *   - DI5/M8: currency trigger v3 (line currency in the voucher's set, rate near
 *     the recorded rate; unchanged legacy lines exempt);
 *   - G15: the base (functional) currency is fixed once vouchers exist.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import {
  accountNatureOf,
  classifyAccountType,
  defaultOpeningSide,
  isAccountType,
} from "../server/services/accounting/accountClassification";
import {
  ensureLedgerIntegrityGuard,
  LEDGER_INTEGRITY_GUARD_VERSION,
} from "../server/services/accounting/ledgerIntegrityGuard";
import {
  ensureLedgerModelSchema,
  installedLedgerModelSchemaVersion,
  LEDGER_MODEL_SCHEMA_VERSION,
} from "../server/services/accounting/ledgerModelSchema";
import { ensureCurrencyNormalizationGuard } from "../server/services/accounting/currencyNormalizationGuard";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "ph23guard";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let otherCompanyId = 0;
let sequence = 0;

const errorOf = async (work: () => Promise<unknown>): Promise<string | null> => {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function account(code: string, type: string, extra: Record<string, unknown> = {}): Promise<number> {
  const fields: Record<string, unknown> = {
    company_id: ctx.companyId,
    code: `${PREFIX}-${code}`,
    name: `${PREFIX} ${code}`,
    account_type: type,
    ...extra,
  };
  const keys = Object.keys(fields);
  const { rows } = await pool.query(
    `INSERT INTO ledger_accounts (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(fields)
  );
  return rows[0].id;
}

/** A balanced two-line USD voucher; `first` names the target of the debit line. */
function postPair(first: Record<string, number | null>, date = "2026-09-15", companyId = ctx.companyId) {
  sequence += 1;
  return withFixtureTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, 'Journal', $3, 10, 'USD') RETURNING id`,
      [companyId, `${PREFIX}-V${sequence}`, date]
    );
    const voucherId = rows[0].id as number;
    const keys = Object.keys(first);
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ${keys.join(", ")}, debit_amount, credit_amount)
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}, 10, 0)`,
      [voucherId, ...Object.values(first)]
    );
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 10)`,
      [voucherId, ctx.cashAccountId]
    );
    return voucherId;
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await ensureLedgerIntegrityGuard(pool);
  await ensureLedgerModelSchema(pool);
  await ensureCurrencyNormalizationGuard(pool);
  const other = await pool.query(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1::varchar, $1::text, 'USD') RETURNING id`,
    [`${PREFIX.toUpperCase()}O`]
  );
  otherCompanyId = other.rows[0].id;
  await pool.query(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [otherCompanyId, ctx.companyId]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const ids = [ctx.companyId, otherCompanyId];
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM exchange_rates WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM customer_balances WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM erp_payroll_runs WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`UPDATE companies SET parent_company_id = NULL WHERE id = $1`, [ctx.companyId]);
  await withFixtureTransaction(async (client) => {
    await client.query("SET LOCAL app.closed_period_override = 'on'");
    await client.query(
      `DELETE FROM sales_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(`DELETE FROM vouchers WHERE company_id = ANY($1::int[])`, [ids]);
  });
  await pool.query(`DELETE FROM suppliers WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`UPDATE ledger_accounts SET parent_id = NULL WHERE company_id = ANY($1::int[])`, [ids]);
  await pool.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [otherCompanyId]);
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [ids]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [otherCompanyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("C3: account class", () => {
  it("classifies natures, taxes and intercompany accounts, and keeps sideless tax openings on Dr", () => {
    expect(accountNatureOf("Bank")).toBe("ASSET");
    expect(accountNatureOf("Duty Agent")).toBe("LIABILITY");
    expect(accountNatureOf("Profit")).toBe("EQUITY");
    expect(accountNatureOf("Revenue")).toBe("INCOME");
    expect(accountNatureOf("Indirect Expense")).toBe("EXPENSE");
    expect(accountNatureOf("Government Taxes")).toBe("LIABILITY");
    expect(accountNatureOf("Government Taxes", "Input VAT receivable")).toBe("ASSET");
    expect(classifyAccountType("Government Taxes")).toBe("liability");
    expect(defaultOpeningSide("Government Taxes")).toBe("Dr");
    expect(accountNatureOf("Intercompany", "sp_hadi_intercompany")).toBe("LIABILITY");
    expect(accountNatureOf("Intercompany", "hadi_sp_intercompany")).toBe("ASSET");
    expect(accountNatureOf("Intercompany", "something")).toBeNull();
    expect(accountNatureOf("Customer")).toBe("ASSET");
    expect(accountNatureOf("Weird Type")).toBeNull();
    expect(isAccountType(" CASH ", "Cash")).toBe(true);
    expect(isAccountType("Bank", "Cash", "Bank")).toBe(true);
    expect(isAccountType(null, "Cash")).toBe(false);
  });

  it("stores the class in a generated column the SQL derives the same way, with a CHECK", async () => {
    const ids = {
      bank: await account("C3BANK", "Bank"),
      tax: await account("C3TAX", "Government Taxes"),
      taxIn: await account("C3TAXIN", "Government Taxes", { sub_type: "Input VAT receivable" }),
      ic: await account("C3IC", "Intercompany", { sub_type: "sp_hadi_intercompany" }),
      income: await account("C3INC", "INCOME"),
      unknown: await account("C3UNK", "Weird Type"),
    };
    const { rows } = await pool.query(`SELECT id, account_class FROM ledger_accounts WHERE id = ANY($1::int[])`, [
      Object.values(ids),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row.account_class]));
    expect(byId.get(ids.bank)).toBe("ASSET");
    expect(byId.get(ids.tax)).toBe("LIABILITY");
    expect(byId.get(ids.taxIn)).toBe("ASSET");
    expect(byId.get(ids.ic)).toBe("LIABILITY");
    expect(byId.get(ids.income)).toBe("INCOME");
    expect(byId.get(ids.unknown)).toBeNull();
    // A retype follows at once.
    await pool.query(`UPDATE ledger_accounts SET account_type = 'Expense' WHERE id = $1`, [ids.unknown]);
    const retyped = await pool.query(`SELECT account_class FROM ledger_accounts WHERE id = $1`, [ids.unknown]);
    expect(retyped.rows[0].account_class).toBe("EXPENSE");
    const check = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ledger_accounts_account_class_check'`
    );
    expect(check.rows[0].def).toContain("ASSET");
  });

  it("is installed at the current versions", async () => {
    const version = await pool.query(
      `SELECT obj_description(to_regprocedure('erp_voucher_entry_target_guard()'), 'pg_proc') AS v`
    );
    expect(version.rows[0].v).toBe(LEDGER_INTEGRITY_GUARD_VERSION);
    expect(await installedLedgerModelSchemaVersion(pool)).toBe(LEDGER_MODEL_SCHEMA_VERSION);
  });
});

describe("C7 / G17: what a new line may post to", () => {
  it("refuses a group account, an inactive account, a deleted party and another company's supplier", async () => {
    const parent = await account("GRP", "Asset");
    const child = await account("CHILD", "Asset", { parent_id: parent });
    const header = await account("HDR", "Expense", { sub_type: "Group" });
    const inactive = await account("OFF", "Expense", { active: false });
    expect(await errorOf(() => postPair({ ledger_account_id: child }))).toBeNull();
    expect(await errorOf(() => postPair({ ledger_account_id: parent }))).toMatch(/LEDGER_ACCOUNT_NOT_LEAF/);
    expect(await errorOf(() => postPair({ ledger_account_id: header }))).toMatch(/LEDGER_ACCOUNT_NOT_LEAF/);
    expect(await errorOf(() => postPair({ ledger_account_id: inactive }))).toMatch(/LEDGER_ACCOUNT_INACTIVE/);

    const customer = await pool.query(
      `INSERT INTO customers (company_id, code, legal_name, deleted_at) VALUES ($1, $2::varchar, $2::text, now()) RETURNING id`,
      [ctx.companyId, `${PREFIX}-DELCUS`]
    );
    expect(await errorOf(() => postPair({ customer_id: customer.rows[0].id }))).toMatch(/PARTY_DELETED/);

    const parentSupplier = await pool.query(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::varchar, $2::text, 'p23@example.com') RETURNING id`,
      [otherCompanyId, `${PREFIX}-PSUP`]
    );
    expect(await errorOf(() => postPair({ supplier_id: parentSupplier.rows[0].id }))).toMatch(
      /SUPPLIER_COMPANY_MISMATCH/
    );
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customer.rows[0].id]);
  });

  it("leaves history alone: an existing line on an account that became a group still edits its narration", async () => {
    const holder = await account("HIST", "Asset");
    const voucherId = await postPair({ ledger_account_id: holder });
    await account("HISTCHILD", "Asset", { parent_id: holder });
    await pool.query(`UPDATE voucher_entries SET narration = 'kept' WHERE voucher_id = $1 AND ledger_account_id = $2`, [
      voucherId,
      holder,
    ]);
    const { rows } = await pool.query(
      `SELECT narration FROM voucher_entries WHERE voucher_id = $1 AND ledger_account_id = $2`,
      [voucherId, holder]
    );
    expect(rows[0].narration).toBe("kept");
  });
});

describe("C10: bank and fixed-asset codes are unique per company", () => {
  it("allows the same code in two companies and refuses it twice in one", async () => {
    const insert = (companyId: number) =>
      pool.query(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, 'P23-BANK', 'B', 'B', '1')`,
        [companyId]
      );
    await insert(ctx.companyId);
    expect(await errorOf(() => insert(otherCompanyId))).toBeNull();
    expect(await errorOf(() => insert(ctx.companyId))).toMatch(/bank_accounts_company_code_unique/);
    const create = await agent.post("/api/bank-accounts").send({
      code: "P23-BANK",
      name: "Again",
      bankName: "B",
      accountNumber: "2",
    });
    expect(create.status).toBe(400);
  });
});

describe("DI3: sub-ledgers under the period lock", () => {
  it("refuses writes dated in a closed period on customer balances, sales cost and payroll runs", async () => {
    const closing = await postPair({ ledger_account_id: ctx.salesAccountId }, "2026-01-31");
    const salesVoucher = await postPair({ ledger_account_id: ctx.salesAccountId }, "2026-01-20");
    const item = await pool.query(
      `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
       VALUES ($1, $2, 1, 10, 4, 10, 4, 6) RETURNING id`,
      [salesVoucher, ctx.stockItemIds[0]]
    );
    const customer = await pool.query(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`,
      [ctx.companyId, `${PREFIX}-LOCKCUS`]
    );
    const balanceRow = await pool.query(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, debit_amount, balance)
       VALUES ($1, $2, '2026-01-10', 'sale', 5, 5) RETURNING id`,
      [ctx.companyId, customer.rows[0].id]
    );
    const run = await pool.query(
      `INSERT INTO erp_payroll_runs (company_id, status, date, created_at) VALUES ($1, 'DRAFT', '2026-01-25', now()::text) RETURNING id`,
      [ctx.companyId]
    );
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2026-01-01', '2026-01-31', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
      [ctx.companyId, ctx.userId, closing, ctx.cashAccountId]
    );
    try {
      const closed = /ACCOUNTING_PERIOD_CLOSED/;
      expect(
        await errorOf(() =>
          pool.query(
            `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, debit_amount, balance)
             VALUES ($1, $2, '2026-01-15', 'sale', 1, 1)`,
            [ctx.companyId, customer.rows[0].id]
          )
        )
      ).toMatch(closed);
      expect(
        await errorOf(() =>
          pool.query(`UPDATE customer_balances SET debit_amount = 6 WHERE id = $1`, [balanceRow.rows[0].id])
        )
      ).toMatch(closed);
      // A note and the derived running balance are not financial fields.
      expect(
        await errorOf(() =>
          pool.query(`UPDATE customer_balances SET description = 'note', balance = 7 WHERE id = $1`, [
            balanceRow.rows[0].id,
          ])
        )
      ).toBeNull();
      expect(
        await errorOf(() =>
          pool.query(
            `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, debit_amount, balance)
             VALUES ($1, $2, '2026-02-02', 'sale', 1, 1)`,
            [ctx.companyId, customer.rows[0].id]
          )
        )
      ).toBeNull();
      expect(
        await errorOf(() =>
          pool.query(`UPDATE sales_items SET cost_price = 5, total_cost = 5 WHERE id = $1`, [item.rows[0].id])
        )
      ).toMatch(closed);
      expect(
        await errorOf(() => pool.query(`UPDATE erp_payroll_runs SET status = 'PAID' WHERE id = $1`, [run.rows[0].id]))
      ).toMatch(closed);
      expect(
        await errorOf(() => pool.query(`UPDATE erp_payroll_runs SET notes = 'n' WHERE id = $1`, [run.rows[0].id]))
      ).toBeNull();
    } finally {
      await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
      await pool.query(`DELETE FROM customer_balances WHERE customer_id = $1`, [customer.rows[0].id]);
      await pool.query(`DELETE FROM customers WHERE id = $1`, [customer.rows[0].id]);
    }
  });
});

describe("DI5/M8: currency trigger v3", () => {
  it("refuses a line outside the voucher's currencies and a rate away from the recorded rate", async () => {
    await pool.query(
      `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
       VALUES ($1, 'USD', 'CFA', 600, '2026-09-01'), ($1, 'USD', 'EUR', 0.9, '2026-09-01')`,
      [ctx.companyId]
    );
    const cfaVoucher = (rate: string) => {
      sequence += 1;
      return withFixtureTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
           VALUES ($1, $2, 'Journal', '2026-09-20', 6000, 'CFA', $3) RETURNING id`,
          [ctx.companyId, `${PREFIX}-CFA${sequence}`, rate]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
           VALUES ($1, $2, 6000, 0), ($1, $3, 0, 6000)`,
          [rows[0].id, ctx.cashAccountId, ctx.salesAccountId]
        );
      });
    };
    expect(await errorOf(() => cfaVoucher("601"))).toBeNull();
    expect(await errorOf(() => cfaVoucher("700"))).toMatch(/VOUCHER_LINE_RATE_MISMATCH/);

    const eurLine = (voucherCurrency: string, rate: string) => {
      sequence += 1;
      return withFixtureTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
           VALUES ($1, $2, 'Journal', '2026-09-20', 100, $3, 1) RETURNING id`,
          [ctx.companyId, `${PREFIX}-EUR${sequence}`, voucherCurrency]
        );
        const base = (90 / Number(rate)).toFixed(6);
        for (const [accountId, debit, credit] of [
          [ctx.cashAccountId, "90", "0"],
          [ctx.salesAccountId, "0", "90"],
        ] as const) {
          await client.query(
            `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount,
               transaction_currency, transaction_debit_amount, transaction_credit_amount,
               base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
             VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7, $8, $9, 'TRANSACTION_PER_BASE')`,
            [
              rows[0].id,
              accountId,
              debit === "0" ? 0 : base,
              credit === "0" ? 0 : base,
              debit,
              credit,
              debit === "0" ? 0 : base,
              credit === "0" ? 0 : base,
              rate,
            ]
          );
        }
      });
    };
    expect(await errorOf(() => eurLine("EUR", "0.9"))).toBeNull();
    expect(await errorOf(() => eurLine("CFA", "0.9"))).toMatch(/VOUCHER_LINE_CURRENCY_MISMATCH/);
    expect(await errorOf(() => eurLine("EUR", "1.2"))).toMatch(/VOUCHER_LINE_RATE_MISMATCH/);
  });
});

describe("G15: functional currency", () => {
  it("refuses a base-currency change once the company has posted vouchers", async () => {
    await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    const response = await agent.patch(`/api/companies/${ctx.companyId}`).send({ baseCurrency: "EUR" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("FUNCTIONAL_CURRENCY_LOCKED");
    const same = await agent.patch(`/api/companies/${ctx.companyId}`).send({ baseCurrency: "USD" });
    expect(same.status).toBe(200);
  });
});
