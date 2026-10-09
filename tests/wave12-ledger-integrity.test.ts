/**
 * Wave 12 (A) — ledger integrity (docs/accounting-audit-2026-10.md, wave log).
 *
 *   - Generic voucher routes refuse the stock adjustment types; the stock
 *     adjustment writer creates its own voucher, one net line per adjustment.
 *   - Balance guard v3: history marked once by an immutable column, stock types
 *     exempt only one-sided with a stock document, base columns always checked,
 *     the transaction columns too for single-currency vouchers, re-checks on
 *     voucher_type / created_at changes and on stock document removal.
 *   - Installers are idempotent and fatal on failure.
 *   - Zero-balances is Owner only, audited in its transaction, refused after a close.
 *   - Fiscal close brings every P&L account to exactly zero, retained earnings
 *     move by exactly the net profit, activity is dated by effective date.
 *   - Opening balances are locked once a period is closed.
 *   - Company import refuses unbalanced posted vouchers, cannot mark history,
 *     and is audited.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

import { pool } from "../server/db";
import { accountTypeNamesOf } from "../server/services/accounting/accountClassification";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { ensureLedgerIntegrityGuard } from "../server/services/accounting/ledgerIntegrityGuard";
import {
  ensureOpeningBalanceLock,
  OPENING_BALANCE_LOCK_TABLES,
  openingBalanceLockTriggerName,
} from "../server/services/accounting/openingBalanceLock";
import { ensureInventoryCutoverSchema } from "../server/services/accounting/perpetualInventory/cutover";
import {
  ensureVoucherBalanceGuard,
  installedVoucherBalanceGuardVersion,
  VOUCHER_BALANCE_GUARD_TRIGGERS,
  VOUCHER_BALANCE_GUARD_VERSION,
} from "../server/services/accounting/voucherBalanceGuard";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { normalizedLineFields } from "./helpers/normalizedVoucherLine";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave12ledger";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let importCompanyId: number;
let sequence = 0;
const nextNumber = () => `${PREFIX}-${++sequence}`;

type Line = { account: number; debit: string; credit: string; currency?: string; native?: string };

/** Writes a voucher and its lines in one transaction. */
async function insertVoucher(
  client: PoolClient,
  lines: Line[],
  options: { type?: string; date?: string; effectiveDate?: string | null; stockDocument?: boolean } = {}
): Promise<number> {
  const id = (
    await client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount, optional)
       VALUES ($1, $2, $3, $4, $5, 0, false) RETURNING id`,
      [
        ctx.companyId,
        nextNumber(),
        options.type ?? "Journal",
        options.date ?? "2026-10-02",
        options.effectiveDate ?? null,
      ]
    )
  ).rows[0].id as number;
  if (options.stockDocument) {
    const adjustment = (
      await client.query(
        `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, 'Mixed') RETURNING id`,
        [id, ctx.locationId]
      )
    ).rows[0].id;
    await client.query(
      `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 1, 10, 10)`,
      [adjustment, ctx.stockItemIds[0]]
    );
  }
  for (const line of lines) {
    // Fully normalized (rate and convention too): the currency trigger keeps it as given.
    const isDebit = Number(line.debit) > 0;
    const dual = line.currency
      ? normalizedLineFields(isDebit ? line.debit : line.credit, line.native ?? "0", isDebit ? "debit" : "credit")
      : null;
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount,
                                    transaction_currency, transaction_debit_amount, transaction_credit_amount,
                                    base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        line.account,
        line.debit,
        line.credit,
        line.currency ?? null,
        dual?.transactionDebit ?? null,
        dual?.transactionCredit ?? null,
        dual?.baseDebit ?? null,
        dual?.baseCredit ?? null,
        dual?.rate ?? null,
        dual?.convention ?? null,
      ]
    );
  }
  return id;
}

async function account(code: string, accountType: string, opening = "0", side = "Dr"): Promise<number> {
  return (
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2::varchar, $2::text, $3, $4, $5) RETURNING id`,
      [ctx.companyId, `${PREFIX}_${code}`, accountType, opening, side]
    )
  ).rows[0].id as number;
}

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  expect(await ensureInventoryCutoverSchema(pool)).toBe(true);
  await ensureClosedPeriodGuard(pool);
  expect(await ensureVoucherBalanceGuard(pool)).toBe(true);
  expect(await ensureOpeningBalanceLock(pool)).toBe(true);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  // The rest of the suite writes fixtures freely: remove the guards this file installed.
  for (const [table, trigger] of VOUCHER_BALANCE_GUARD_TRIGGERS) {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
  }
  for (const table of OPENING_BALANCE_LOCK_TABLES) {
    await pool.query(`DROP TRIGGER IF EXISTS ${openingBalanceLockTriggerName(table)} ON ${table}`);
  }
  const companies = [ctx.companyId, importCompanyId].filter(Boolean);
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.closed_period_override = 'on'`);
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query(`DELETE FROM fiscal_period_closures WHERE company_id = ANY($1::int[])`, [companies]);
    // Not removed by cleanupTestData.
    await client.query(`DELETE FROM bank_accounts WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
    if (importCompanyId) {
      await client.query(
        `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
        [importCompanyId]
      );
      await client.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [importCompanyId]);
      await client.query(`DELETE FROM vouchers WHERE company_id = $1`, [importCompanyId]);
      await client.query(`DELETE FROM ledger_accounts WHERE company_id = $1`, [importCompanyId]);
      await client.query(`DELETE FROM user_company_roles WHERE company_id = $1`, [importCompanyId]);
      await client.query(`DELETE FROM user_security_permissions WHERE company_id = $1`, [importCompanyId]);
    }
  });
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [companies]);
  if (importCompanyId) {
    await withFixtureTransaction(async (client) => {
      await client.query(`SET LOCAL session_replication_role = replica`);
      await client.query(`DELETE FROM companies WHERE id = $1`, [importCompanyId]);
    });
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120000);

describe("generic voucher routes refuse stock voucher types", () => {
  const refused = (response: request.Response) => {
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("STOCK_VOUCHER_TYPE_NOT_ALLOWED");
  };

  it("refuses the 1,000,000 Production voucher on every generic create route", async () => {
    refused(
      await agent.post("/api/vouchers").send({
        voucherNumber: nextNumber(),
        voucherType: "Production",
        voucherDate: "2026-10-02",
        totalAmount: "1000000",
      })
    );
    const entries = [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "1000000", creditAmount: "0" },
      { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "0" },
    ];
    for (const clientRequestId of [undefined, `${PREFIX}-central`]) {
      refused(
        await agent.post("/api/vouchers/with-entries").send({
          clientRequestId,
          voucher: { voucherNumber: nextNumber(), voucherType: " production ", voucherDate: "2026-10-02" },
          entries,
        })
      );
    }
    // The database refuses it too: a Production voucher without a stock document must balance.
    await expect(
      withFixtureTransaction((client) =>
        insertVoucher(client, [{ account: ctx.cashAccountId, debit: "1000000", credit: "0" }], { type: "Production" })
      )
    ).rejects.toThrow(/does not balance/);
  });

  it("refuses generic line edits and re-typing on stock vouchers", async () => {
    const created = await agent.post("/api/stock-adjustments").send({
      voucher: { voucherNumber: nextNumber(), voucherDate: "2026-10-03" },
      locationId: ctx.locationId,
      adjustmentType: "Production",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "10" }],
    });
    expect(created.status).toBe(201);
    const stockVoucherId = created.body.voucher.id as number;
    const line = { ledgerAccountId: ctx.cashAccountId, debitAmount: "1000000", creditAmount: "0" };

    refused(await agent.post("/api/voucher-entries").send({ voucherId: stockVoucherId, ...line }));
    refused(await agent.patch(`/api/vouchers/${stockVoucherId}`).send({ entries: [line] }));
    refused(
      await agent
        .put(`/api/vouchers/${stockVoucherId}/with-entries`)
        .send({ voucher: { voucherType: "Journal" }, entries: [line] })
    );

    const journal = await withFixtureTransaction((client) =>
      insertVoucher(client, [
        { account: ctx.cashAccountId, debit: "5", credit: "0" },
        { account: ctx.salesAccountId, debit: "0", credit: "5" },
      ])
    );
    refused(
      await agent
        .put(`/api/vouchers/${journal}/with-entries`)
        .send({ voucher: { voucherType: "Mixed" }, entries: [line] })
    );
    // A header-only edit of the stock voucher (the stock form's own PATCH) still works.
    expect((await agent.patch(`/api/vouchers/${stockVoucherId}`).send({ description: "moved" })).status).toBe(200);
  });
});

describe("stock adjustment writer and the stock exemption", () => {
  it("creates a one-sided stock voucher with its stock document, and nets a Mixed adjustment", async () => {
    const production = await agent.post("/api/stock-adjustments").send({
      voucher: { voucherNumber: nextNumber(), voucherDate: "2026-10-04" },
      locationId: ctx.locationId,
      adjustmentType: "Production",
      items: [{ stockItemId: ctx.stockItemIds[1], quantity: "2", rate: "10" }],
    });
    expect(production.status).toBe(201);
    expect(production.body.voucher.voucherType).toBe("Production");
    const productionLines = (
      await pool.query(`SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`, [
        production.body.voucher.id,
      ])
    ).rows;
    expect(productionLines).toEqual([{ debit_amount: "0.00", credit_amount: "20.00" }]);

    // Produce 3 × 10, consume 1 at the location's average rate (10): one net line, Cr 20.
    const mixed = await agent.post("/api/stock-adjustments").send({
      voucher: { voucherNumber: nextNumber(), voucherDate: "2026-10-04" },
      locationId: ctx.locationId,
      adjustmentType: "Mixed",
      items: [
        { stockItemId: ctx.stockItemIds[1], quantity: "3", rate: "10" },
        { stockItemId: ctx.stockItemIds[2], quantity: "-1", rate: "10" },
      ],
    });
    expect(mixed.status).toBe(201);
    const mixedLines = (
      await pool.query(`SELECT debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1`, [
        mixed.body.voucher.id,
      ])
    ).rows;
    expect(mixedLines).toEqual([{ debit_amount: "0.00", credit_amount: "20.00" }]);
  });

  it("refuses a two-sided unbalanced Mixed voucher even with a stock document", async () => {
    await expect(
      withFixtureTransaction((client) =>
        insertVoucher(
          client,
          [
            { account: ctx.salesAccountId, debit: "30", credit: "0" },
            { account: ctx.salesAccountId, debit: "0", credit: "10" },
          ],
          { type: "Mixed", stockDocument: true }
        )
      )
    ).rejects.toThrow(/does not balance/);
  });

  it("re-checks a one-sided stock voucher whose stock document is removed", async () => {
    const id = await withFixtureTransaction((client) =>
      insertVoucher(client, [{ account: ctx.salesAccountId, debit: "0", credit: "10" }], {
        type: "Production",
        stockDocument: true,
      })
    );
    await expect(
      withFixtureTransaction((client) =>
        client.query(`DELETE FROM stock_adjustment_vouchers WHERE voucher_id = $1`, [id])
      )
    ).rejects.toThrow(/does not balance/);
  });
});

describe("history marker and re-checks", () => {
  it("keeps history editable, never checked, and the marker immutable", async () => {
    // The marker was written once by the installer; only a superuser with
    // triggers off can write it (this models a voucher that existed at install).
    const history = await withFixtureTransaction(async (client) => {
      await client.query(`SET LOCAL session_replication_role = replica`);
      const id = await insertVoucher(client, [{ account: ctx.cashAccountId, debit: "100", credit: "0" }]);
      await client.query(`UPDATE vouchers SET balance_guard_exempt_history = true WHERE id = $1`, [id]);
      return id;
    });
    await expect(
      withFixtureTransaction((client) =>
        client.query(`UPDATE voucher_entries SET debit_amount = 90 WHERE voucher_id = $1`, [history])
      )
    ).resolves.toBeDefined();
    await expect(
      withFixtureTransaction((client) =>
        client.query(`UPDATE vouchers SET balance_guard_exempt_history = false WHERE id = $1`, [history])
      )
    ).rejects.toThrow(/history marker/);

    // A new voucher can never be history, whatever it sends or later sets.
    const fresh = await withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, balance_guard_exempt_history)
           VALUES ($1, $2, 'Journal', '2026-10-05', 0, true) RETURNING id`,
          [ctx.companyId, nextNumber()]
        )
      ).rows[0].id as number;
      return id;
    });
    expect(
      (await pool.query(`SELECT balance_guard_exempt_history FROM vouchers WHERE id = $1`, [fresh])).rows[0]
        .balance_guard_exempt_history
    ).toBe(false);
    await expect(
      withFixtureTransaction((client) =>
        client.query(`UPDATE vouchers SET balance_guard_exempt_history = true WHERE id = $1`, [fresh])
      )
    ).rejects.toThrow(/history marker/);
  });

  it("re-checks a voucher whose created_at or voucher_type changes", async () => {
    // An unbalanced voucher written under a reviewed bypass (not history).
    const unbalanced = await withFixtureTransaction(
      (client) => insertVoucher(client, [{ account: ctx.cashAccountId, debit: "70", credit: "0" }]),
      { legacyUnbalanced: true }
    );
    await expect(
      withFixtureTransaction((client) =>
        client.query(`UPDATE vouchers SET created_at = '2020-01-01' WHERE id = $1`, [unbalanced])
      )
    ).rejects.toThrow(/does not balance/);
    await expect(
      withFixtureTransaction((client) =>
        client.query(`UPDATE vouchers SET voucher_type = 'Production' WHERE id = $1`, [unbalanced])
      )
    ).rejects.toThrow(/does not balance/);
  });
});

describe("base and transaction columns", () => {
  it("checks both: single currency within a cent in base, mixed currencies exactly", async () => {
    const xof = (debit: string, credit: string, native: string) => ({
      account: Number(debit) > 0 ? ctx.cashAccountId : ctx.salesAccountId,
      debit,
      credit,
      currency: "XOF",
      native,
    });
    // Balanced in XOF, the base two cents apart: refused.
    await expect(
      withFixtureTransaction((client) => insertVoucher(client, [xof("1.65", "0", "1000"), xof("0", "1.67", "1000")]))
    ).rejects.toThrow(/does not balance: debits 1.65, credits 1.67/);
    // Balanced in base, not in XOF: refused.
    await expect(
      withFixtureTransaction((client) => insertVoucher(client, [xof("1.67", "0", "1000"), xof("0", "1.67", "999")]))
    ).rejects.toThrow(/does not balance in its transaction currency/);
    // A line without a transaction currency: the base must balance exactly.
    await expect(
      withFixtureTransaction((client) =>
        insertVoucher(client, [xof("1.66", "0", "1000"), { account: ctx.salesAccountId, debit: "0", credit: "1.67" }])
      )
    ).rejects.toThrow(/does not balance: debits 1.66, credits 1.67/);
  });
});

describe("zero opening balances", () => {
  it("is Owner only, one transaction, and audited with the old values", async () => {
    const accountId = await account("ZERO", "Asset", "7.00", "Dr");
    expect((await agent.post("/api/ledger-accounts/zero-balances").send({ accountIds: [accountId] })).status).toBe(403);

    await setRole("Owner");
    const response = await agent.post("/api/ledger-accounts/zero-balances").send({ accountIds: [accountId] });
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(
      (await pool.query(`SELECT opening_balance FROM ledger_accounts WHERE id = $1`, [accountId])).rows[0]
        .opening_balance
    ).toBe("0.00");
    const audit = (
      await pool.query(
        `SELECT changes FROM audit_log WHERE company_id = $1 AND record_identifier = 'zero-opening-balances'`,
        [ctx.companyId]
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.openingBalances.old).toEqual([
      expect.objectContaining({ id: accountId, openingBalance: "7.00", openingBalanceSide: "Dr" }),
    ]);
  });
});

describe("fiscal close and the opening-balance lock", () => {
  let retainedId: number;
  let incomeId: number;
  let expenseId: number;
  let bankId: number;
  let customerId: number;
  const PERIOD_END = "2025-01-31";

  async function balanceThrough(accountId: number, through: string) {
    const row = (
      await pool.query(
        `SELECT (CASE WHEN COALESCE(la.opening_balance_side, 'Dr') = 'Cr' THEN -1 ELSE 1 END) * COALESCE(la.opening_balance, 0)
                + COALESCE((SELECT SUM(ve.debit_amount - ve.credit_amount) FROM voucher_entries ve
                              JOIN vouchers v ON v.id = ve.voucher_id
                             WHERE ve.ledger_account_id = la.id AND v.deleted_at IS NULL AND v.optional = false
                               AND COALESCE(v.effective_date, v.voucher_date) <= $2), 0) AS balance
           FROM ledger_accounts la WHERE la.id = $1`,
        [accountId, through]
      )
    ).rows[0];
    return Number(row.balance).toFixed(2);
  }

  beforeAll(async () => {
    retainedId = await account("RE", "Equity", "0", "Cr");
    incomeId = await account("INCOME", "Income", "50.00", "Cr");
    expenseId = await account("EXPENSE", "EXPENSE", "20.00", "Dr");
    bankId = (
      await pool.query(
        `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name, opening_balance, opening_balance_side)
         VALUES ($1, $2::varchar, $2::text, '1', 'Bank', 0, 'Dr') RETURNING id`,
        [ctx.companyId, `${PREFIX}_BANK`]
      )
    ).rows[0].id;
    customerId = (
      await pool.query(
        `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side)
         VALUES ($1, $2::varchar, $2::text, 0, 'Dr') RETURNING id`,
        [ctx.companyId, `${PREFIX}_CUST`]
      )
    ).rows[0].id;
    await withFixtureTransaction(async (client) => {
      // Income 30 in January; an expense dated in February but effective in January.
      await insertVoucher(
        client,
        [
          { account: ctx.cashAccountId, debit: "30.00", credit: "0" },
          { account: incomeId, debit: "0", credit: "30.00" },
        ],
        { date: "2025-01-10" }
      );
      await insertVoucher(
        client,
        [
          { account: expenseId, debit: "12.50", credit: "0" },
          { account: ctx.cashAccountId, debit: "0", credit: "12.50" },
        ],
        { date: "2025-02-03", effectiveDate: "2025-01-20" }
      );
      // Voucher-dated in January, effective in February: not part of January.
      await insertVoucher(
        client,
        [
          { account: expenseId, debit: "4.00", credit: "0" },
          { account: ctx.cashAccountId, debit: "0", credit: "4.00" },
        ],
        { date: "2025-01-25", effectiveDate: "2025-02-02" }
      );
    });
  });

  it("brings every P&L account to exactly zero and moves retained earnings by the net profit", async () => {
    const response = await agent.post("/api/fiscal-period/close").send({
      periodStartDate: "2025-01-01",
      periodEndDate: PERIOD_END,
      retainedEarningsAccountId: retainedId,
    });
    expect(response.status).toBe(200);
    // Income: opening 50 + 30; expense: opening 20 + 12.50 (by effective date).
    expect(response.body.totalIncome).toBe("80.00");
    expect(response.body.totalExpense).toBe("32.50");
    expect(response.body.netIncome).toBe("47.50");

    const profitAndLoss = (
      await pool.query(`SELECT id FROM ledger_accounts WHERE company_id = $1 AND LOWER(TRIM(account_type)) = ANY($2)`, [
        ctx.companyId,
        accountTypeNamesOf("income", "expense"),
      ])
    ).rows.map((row) => row.id as number);
    expect(profitAndLoss).toEqual(expect.arrayContaining([incomeId, expenseId]));
    for (const id of profitAndLoss) expect(await balanceThrough(id, PERIOD_END)).toBe("0.00");
    // Retained earnings (credit-positive) moved by exactly the net profit.
    expect(await balanceThrough(retainedId, PERIOD_END)).toBe("-47.50");
    // Openings stay in place: the closing line already carried them.
    expect(
      (await pool.query(`SELECT opening_balance FROM ledger_accounts WHERE id = $1`, [incomeId])).rows[0]
        .opening_balance
    ).toBe("50.00");
  });

  it("refuses opening changes after the close, and zero-balances too", async () => {
    const locked = (response: request.Response) => {
      expect(response.status).toBe(409);
      expect(response.body.message).toContain(`closed through ${PERIOD_END}, so an opening balance cannot`);
    };
    locked(
      await agent.put(`/api/ledger-accounts/${incomeId}`).send({ openingBalance: "55", openingBalanceSide: "Cr" })
    );
    locked(await agent.put(`/api/customers/${customerId}`).send({ openingBalance: "9", openingBalanceSide: "Dr" }));
    locked(await agent.put(`/api/bank-accounts/${bankId}`).send({ openingBalance: "9", openingBalanceSide: "Dr" }));
    // Other fields stay editable.
    expect((await agent.put(`/api/ledger-accounts/${incomeId}`).send({ name: `${PREFIX} Income` })).status).toBe(200);

    const zero = await agent.post("/api/ledger-accounts/zero-balances").send({ accountIds: [incomeId] });
    expect(zero.status).toBe(409);
    expect(
      (await pool.query(`SELECT opening_balance FROM ledger_accounts WHERE id = $1`, [incomeId])).rows[0]
        .opening_balance
    ).toBe("50.00");
  });
});

describe("company import", () => {
  const upload = (payload: unknown) =>
    agent.post("/api/factory/import-company-data").attach("file", Buffer.from(JSON.stringify(payload)), {
      filename: "export.json",
      contentType: "application/json",
    });

  const file = (credit: string) => ({
    sourceCompanyId: ctx.companyId,
    tables: {
      ledger_accounts: [
        { id: 1, code: "IMP_CASH", name: "Imported Cash", accountType: "Asset", openingBalance: "0" },
        { id: 2, code: "IMP_SALES", name: "Imported Sales", accountType: "Income", openingBalance: "0" },
      ],
      vouchers: [
        {
          id: 10,
          voucherNumber: `${PREFIX}-IMPORTED`,
          voucherType: "Journal",
          voucherDate: "2026-03-01",
          totalAmount: "5.00",
          optional: false,
          deletedAt: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          balanceGuardExemptHistory: true,
        },
      ],
      voucher_entries: [
        { id: 100, voucherId: 10, ledgerAccountId: 1, debitAmount: "5.00", creditAmount: "0" },
        { id: 101, voucherId: 10, ledgerAccountId: 2, debitAmount: "0", creditAmount: credit },
      ],
    },
  });

  beforeAll(async () => {
    importCompanyId = // The company import is a factory route: it needs a factory company.
      (
        await pool.query(
          `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
          [`${PREFIX.toUpperCase().slice(0, 6)}IMP`]
        )
      ).rows[0].id;
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
      ctx.userId,
      importCompanyId,
    ]);
    await pool.query(
      `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by)
       SELECT user_id, $2, permission, granted_by FROM user_security_permissions WHERE user_id = $1 AND company_id = $3`,
      [ctx.userId, importCompanyId, ctx.companyId]
    );
    expect((await agent.post("/api/auth/set-company").send({ companyId: importCompanyId })).status).toBe(200);
  });

  it("refuses unbalanced posted vouchers, imports balanced ones as non-history, and audits", async () => {
    const refused = await upload(file("4.00"));
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("IMPORT_UNBALANCED_VOUCHERS");
    expect(refused.body.vouchers).toEqual([
      { voucherNumber: `${PREFIX}-IMPORTED`, voucherType: "Journal", debit: "5.00", credit: "4.00" },
    ]);

    const imported = await upload(file("5.00"));
    expect(imported.status).toBe(200);
    const [voucher] = (
      await pool.query(`SELECT balance_guard_exempt_history FROM vouchers WHERE company_id = $1`, [importCompanyId])
    ).rows;
    expect(voucher.balance_guard_exempt_history).toBe(false);
    const audit = (
      await pool.query(`SELECT action, changes FROM audit_log WHERE company_id = $1 AND table_name = 'companies'`, [
        importCompanyId,
      ])
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("import");
    expect(audit[0].changes.totalRecords.new).toBeGreaterThan(0);
  });
});

describe("installers", () => {
  it("are idempotent", async () => {
    expect(await ensureVoucherBalanceGuard(pool)).toBe(true);
    expect(await ensureVoucherBalanceGuard(pool)).toBe(true);
    expect(await installedVoucherBalanceGuardVersion(pool)).toBe(VOUCHER_BALANCE_GUARD_VERSION);
    expect(await ensureOpeningBalanceLock(pool)).toBe(true);
  });

  it("are fatal on failure, rolling back and releasing the connection", async () => {
    for (const install of [ensureVoucherBalanceGuard, ensureOpeningBalanceLock]) {
      const release = vi.fn();
      const query = vi.fn(async (text: string) => {
        if (/CREATE|ALTER|DO \$/.test(text)) throw new Error("lock timeout");
        return { rows: [] };
      });
      const fakePool = { connect: async () => ({ query, release }) } as never;
      await expect(install(fakePool)).rejects.toThrow(/lock timeout/);
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledTimes(1);
    }
  });
});
