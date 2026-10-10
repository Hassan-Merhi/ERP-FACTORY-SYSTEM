/**
 * Factory foreign-currency entries (2026-10 accounting audit, wave 6): writers
 * and the legacy repair, against the database.
 *
 * - The normalized factory amounts must be accepted by the production
 *   voucher-entry currency trigger (migrations/20260720_005), which neither the
 *   test database nor CI installs; it is installed here inside a transaction
 *   that is rolled back.
 * - The legacy repair classifies each line from its own voucher, converts at the
 *   voucher's stored rate, never half-converts a voucher, skips unset rates and
 *   closed periods, and is idempotent.
 */
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { normFactoryEntry } from "../server/services/factory/factoryVoucherEntryAmounts";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import {
  applyFactoryFxLegacyRepair,
  planFactoryFxLegacyRepair,
} from "../server/services/factory/factoryFxLegacyRepair";

const PREFIX = `fxr${Date.now().toString(36)}`;
const TRIGGER_SQL = fs.readFileSync(
  path.join(process.cwd(), "migrations/20260720_005_voucher_entry_currency_normalization_trigger.sql"),
  "utf8"
);

let companyId: number;
let supplierId: number;
let expenseId: number;
let cashId: number;
let userId: string;
const voucherIds: Record<string, number> = {};

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("factory-fx-test", work);

async function maintenance(work: (q: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await work((text, values) => client.query(text, values) as never);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function voucher(
  q: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>,
  key: string,
  currency: string,
  rate: string,
  total: string,
  date: string,
  lines: [target: "expense" | "cash" | "supplier", debit: string, credit: string][]
) {
  // Legacy-shaped lines as history left them: the currency trigger v2 (wave 17 D)
  // refuses a new non-USD line without native amounts, so triggers are off here.
  await q("SET LOCAL session_replication_role = replica");
  const id = (
    await q(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, source_module)
       VALUES ($1, $2, 'Journal', $3, $4, $5, $6, 'FACTORY') RETURNING id`,
      [companyId, `${PREFIX}-${key}`, date, total, currency, rate]
    )
  ).rows[0].id;
  voucherIds[key] = id;
  for (const [target, debit, credit] of lines) {
    await q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, factory_supplier_id, debit_amount, credit_amount, company_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        target === "expense" ? expenseId : target === "cash" ? cashId : null,
        target === "supplier" ? supplierId : null,
        debit,
        credit,
        companyId,
      ]
    );
  }
}

beforeAll(async () => {
  await maintenance(async (q) => {
    companyId = (
      await q(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [PREFIX.toUpperCase()])
    ).rows[0].id;
    supplierId = (
      await q(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
        companyId,
        `${PREFIX} S`,
      ])
    ).rows[0].id;
    const account = async (code: string, type: string) =>
      (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
          [companyId, `${PREFIX}-${code}`, type]
        )
      ).rows[0].id;
    expenseId = await account("FREIGHT", "Direct Expense");
    cashId = await account("CASH", "Asset");
    // Supplier-paid EUR freight: both legs hold the native 100.
    await voucher(q, "native", "EUR", "1.1", "100", "2026-09-10", [
      ["expense", "100", "0"],
      ["supplier", "0", "100"],
    ]);
    // Own-account EUR freight: both legs already hold USD (100 at 1.1 = 110).
    await voucher(q, "usd", "EUR", "1.1", "100", "2026-09-10", [
      ["expense", "110", "0"],
      ["cash", "0", "110"],
    ]);
    // A rate nobody set (the column default 1).
    await voucher(q, "unset", "AUD", "1", "40", "2026-09-10", [
      ["expense", "40", "0"],
      ["supplier", "0", "40"],
    ]);
    // In a closed period.
    await voucher(q, "closed", "EUR", "1.1", "10", "2026-01-15", [
      ["expense", "10", "0"],
      ["supplier", "0", "10"],
    ]);
    userId = (await q(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`${PREFIX}_user`]))
      .rows[0].id;
    await q(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2026-01-01', '2026-01-31', $4, $2, $3, 0, 0, 0, 'CLOSED')`,
      [companyId, voucherIds.closed, cashId, userId]
    );
  });
  // One leg recognised, the other not: the voucher is left whole. It models a
  // legacy unbalanced row predating the voucher balance guard, so it is written
  // in its own transaction with the ledger integrity bypass.
  await maintenance(async (q) => {
    await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await voucher(q, "mixed", "AUD", "0.65", "200", "2026-09-10", [
      ["expense", "200", "0"],
      ["supplier", "0", "199"],
    ]);
  });
}, 60000);

afterAll(async () => {
  await maintenance(async (q) => {
    await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await q(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM vouchers WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM ledger_accounts WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM factory_suppliers WHERE company_id = $1`, [companyId]);
    await q(`DELETE FROM companies WHERE id = $1`, [companyId]);
    await q(`DELETE FROM users WHERE id = $1`, [userId]);
  });
}, 60000);

describe("normalized factory amounts and the production currency trigger", () => {
  it("are accepted exactly, including amounts the inverse rate could not reproduce", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      await client.query(TRIGGER_SQL);
      const v = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, source_module)
           VALUES ($1, $2, 'Journal', '2026-09-20', 250000, 'AUD', 0.6543219, 'FACTORY') RETURNING id`,
          [companyId, `${PREFIX}-trigger`]
        )
      ).rows[0].id;
      for (const [debit, credit, target] of [
        ["250000", "0", expenseId],
        ["0", "250000", cashId],
      ] as const) {
        const amounts = normFactoryEntry("AUD", debit, credit, "0.6543219");
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
             transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
             historical_exchange_rate, rate_convention)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            v,
            target,
            amounts.debitAmount,
            amounts.creditAmount,
            amounts.transactionCurrency,
            amounts.transactionDebitAmount,
            amounts.transactionCreditAmount,
            amounts.baseDebitAmount,
            amounts.baseCreditAmount,
            amounts.historicalExchangeRate,
            amounts.rateConvention,
          ]
        );
      }
      const stored = await client.query(
        `SELECT debit_amount::text AS d, credit_amount::text AS c FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [v]
      );
      expect(stored.rows).toEqual([
        { d: "163580.48", c: "0.00" },
        { d: "0.00", c: "163580.48" },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("legacy factory foreign-currency repair", () => {
  it("plans from each voucher's own total and rate, and reports what it cannot classify", async () => {
    const plan = await asMaintenance(() => planFactoryFxLegacyRepair(companyId));
    const byVoucher = (key: string) => plan.lines.filter((line) => line.voucherId === voucherIds[key]);

    expect(byVoucher("native").map((line) => [line.kind, line.newStoredAmount, line.transactionAmount])).toEqual([
      ["native", "110.00", "100.000000"],
      ["native", "110.00", "100.000000"],
    ]);
    expect(byVoucher("usd").map((line) => [line.kind, line.newStoredAmount, line.usdChange])).toEqual([
      ["usd", "110.00", "0.00"],
      ["usd", "110.00", "0.00"],
    ]);
    expect(byVoucher("unset").map((line) => line.skipReason)).toEqual(["RATE_NOT_SET", "RATE_NOT_SET"]);
    expect(byVoucher("mixed").map((line) => line.skipReason)).toEqual([
      "OTHER_LINE_NOT_REPAIRABLE",
      "AMOUNT_NOT_RECOGNISED",
    ]);
    expect(byVoucher("closed").map((line) => line.skipReason)).toEqual(["PERIOD_CLOSED", "PERIOD_CLOSED"]);
    expect(plan.repairableVouchers).toBe(2);
    expect(plan.usdChangeByTarget).toEqual({
      [`ledger:${expenseId}`]: "10.00",
      [`factorySupplier:${supplierId}`]: "-10.00",
    });
  });

  it("applies only the repairable lines, through the production trigger, and is idempotent", async () => {
    // Test files run one at a time, so the trigger is installed for this apply
    // only, and removed again unless the database already had it.
    const hadTrigger =
      (await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'voucher_entries_normalize_currency_before_write'`))
        .rowCount === 1;
    if (!hadTrigger) await pool.query(TRIGGER_SQL);
    let applied;
    try {
      // The reviewed plan's hash is required since wave 17 C.
      const reviewed = await asMaintenance(() => planFactoryFxLegacyRepair(companyId));
      applied = await asMaintenance(() =>
        applyFactoryFxLegacyRepair(companyId, { expectedPlanHash: reviewed.planHash })
      );
    } finally {
      if (!hadTrigger) {
        await pool.query(`DROP TRIGGER IF EXISTS voucher_entries_normalize_currency_before_write ON voucher_entries`);
        await pool.query(`DROP FUNCTION IF EXISTS normalize_voucher_entry_currency_amounts()`);
      }
    }
    expect(applied.repairableLines).toBe(4);

    const rows = await asMaintenance(() =>
      pool.query(
        `SELECT v.voucher_number, ve.debit_amount::text AS d, ve.credit_amount::text AS c, ve.transaction_currency AS tc,
                ve.transaction_debit_amount::text AS td, ve.transaction_credit_amount::text AS tcr,
                ve.historical_exchange_rate::text AS r, ve.rate_convention AS rc
           FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = $1 ORDER BY v.id, ve.id`,
        [companyId]
      )
    );
    const of = (key: string) => rows.rows.filter((row) => row.voucher_number === `${PREFIX}-${key}`);
    expect(of("native").map((row) => [row.d, row.c, row.tc, row.td, row.tcr, row.rc])).toEqual([
      ["110.00", "0.00", "EUR", "100.000000", "0.000000", "BASE_PER_TRANSACTION"],
      ["0.00", "110.00", "EUR", "0.000000", "100.000000", "BASE_PER_TRANSACTION"],
    ]);
    expect(of("usd").map((row) => [row.d, row.c, row.td, row.tcr])).toEqual([
      ["110.00", "0.00", "100.000000", "0.000000"],
      ["0.00", "110.00", "0.000000", "100.000000"],
    ]);
    for (const key of ["unset", "mixed", "closed"]) {
      expect(of(key).every((row) => row.tc === null)).toBe(true);
    }
    expect(of("mixed").map((row) => [row.d, row.c])).toEqual([
      ["200.00", "0.00"],
      ["0.00", "199.00"],
    ]);

    const again = await asMaintenance(() => planFactoryFxLegacyRepair(companyId));
    expect(again.repairableLines).toBe(0);
    expect(again.legacyLines).toBe(6);
  });
});
