/**
 * Voucher balance guard (waves 8.5, 9 and 12).
 *
 * An active voucher must balance when its transaction commits, in every
 * company; lines may be written one by one inside the transaction. Left alone:
 * history (vouchers that existed when v3 was installed, marked by the immutable
 * balance_guard_exempt_history column), optional vouchers, and one-sided stock
 * adjustments backed by stock_adjustment_items under periodic inventory
 * (before a cut-over, or in a supplier-partner company). From a company's
 * cut-over its stock adjustments must balance too. Lines in one transaction
 * currency balance in that currency (and within a cent in the base columns);
 * re-activating an unbalanced voucher is refused; a reviewed repair can bypass
 * the guard for its own transaction. The wave 12 cases are in
 * wave12-ledger-integrity.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { normalizedLineFields } from "./helpers/normalizedVoucherLine";
import {
  ensureVoucherBalanceGuard,
  VOUCHER_BALANCE_GUARD_TRIGGERS,
} from "../server/services/accounting/voucherBalanceGuard";
import { ensureLedgerIntegrityGuard } from "../server/services/accounting/ledgerIntegrityGuard";
import { ensureInventoryCutoverSchema } from "../server/services/accounting/perpetualInventory/cutover";

const PREFIX = `vbg${Date.now().toString(36)}`;
let companyId: number;
let partnerId: number;
const accounts = new Map<number, { debit: number; credit: number }>();
const stock = new Map<number, { location: number; item: number }>();
let sequence = 0;

type Q = (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
async function transaction(work: (q: Q) => Promise<unknown>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const result = await work((text, values) => client.query(text, values) as never);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

type Line = [debit: string, credit: string, currency?: string, native?: string];

async function voucher(
  q: Q,
  company: number,
  date: string,
  lines: Line[],
  options: { optional?: boolean; type?: string; stockDocument?: boolean } = {}
) {
  sequence += 1;
  const id = (
    await q(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
       VALUES ($1, $2, $3, $4, 0, $5) RETURNING id`,
      [company, `${PREFIX}-V${sequence}`, options.type ?? "Journal", date, options.optional ?? false]
    )
  ).rows[0].id;
  if (options.stockDocument) {
    const { location, item } = stock.get(company)!;
    const adjustment = (
      await q(
        `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, 'Production') RETURNING id`,
        [id, location]
      )
    ).rows[0].id;
    await q(
      `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 1, 50, 50)`,
      [adjustment, item]
    );
  }
  for (const [debit, credit, currency, native] of lines) {
    const isDebit = Number(debit) > 0;
    // Fully normalized (rate and convention too): the currency trigger keeps it as given.
    const dual = currency
      ? normalizedLineFields(isDebit ? debit : credit, native ?? "0", isDebit ? "debit" : "credit")
      : null;
    await q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount,
                                    transaction_currency, transaction_debit_amount, transaction_credit_amount,
                                    base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        isDebit ? accounts.get(company)!.debit : accounts.get(company)!.credit,
        debit,
        credit,
        currency ?? null,
        dual?.transactionDebit ?? null,
        dual?.transactionCredit ?? null,
        dual?.baseDebit ?? null,
        dual?.baseCredit ?? null,
        dual?.rate ?? null,
        dual?.convention ?? null,
      ]
    );
  }
  return id as number;
}

beforeAll(async () => {
  expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  expect(await ensureInventoryCutoverSchema(pool)).toBe(true);
  expect(await ensureVoucherBalanceGuard(pool)).toBe(true);
  await transaction(async (q) => {
    companyId = (
      await q(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [PREFIX.toUpperCase()])
    ).rows[0].id;
    partnerId = (
      await q(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'supplier_partner') RETURNING id`,
        [`${PREFIX.toUpperCase()}SP`]
      )
    ).rows[0].id;
    const account = async (company: number, code: string) =>
      (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
           VALUES ($1, $2::varchar, $2::text, 'Asset', 0, 'Dr') RETURNING id`,
          [company, code]
        )
      ).rows[0].id;
    for (const company of [companyId, partnerId]) {
      accounts.set(company, {
        debit: await account(company, `${PREFIX}_${company}_DR`),
        credit: await account(company, `${PREFIX}_${company}_CR`),
      });
    }
    for (const company of [companyId, partnerId]) {
      stock.set(company, {
        location: (
          await q(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
            company,
            `${PREFIX}_${company}_LOC`,
          ])
        ).rows[0].id,
        item: (
          await q(
            `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, 'pcs') RETURNING id`,
            [company, `${PREFIX}_${company}_ITEM`]
          )
        ).rows[0].id,
      });
    }
    for (const company of [companyId, partnerId]) {
      await q(
        `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-11-01', '{}'::jsonb, 'test')`,
        [company]
      );
    }
  });
}, 60000);

afterAll(async () => {
  await transaction(async (q) => {
    await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    for (const company of [companyId, partnerId]) {
      await q(`DELETE FROM gl_inventory_cutovers WHERE company_id = $1`, [company]);
      await q(
        `DELETE FROM stock_adjustment_vouchers WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`,
        [company]
      );
      await q(`DELETE FROM stock_items WHERE company_id = $1`, [company]);
      await q(`DELETE FROM locations WHERE company_id = $1`, [company]);
      await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
        company,
      ]);
      await q(`DELETE FROM vouchers WHERE company_id = $1`, [company]);
      await q(`DELETE FROM ledger_accounts WHERE company_id = $1`, [company]);
      await deleteAuditLogRowsForTests(pool, "company_id = $1", [company]);
      await q(`DELETE FROM companies WHERE id = $1`, [company]);
    }
  });
  // The rest of the suite writes fixtures freely: leave the database as it was
  // (the history marker column stays; with no trigger it is inert).
  for (const [table, trigger] of VOUCHER_BALANCE_GUARD_TRIGGERS) {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
  }
}, 60000);

describe("voucher balance guard", () => {
  it("accepts a voucher whose lines balance at commit, written one by one", async () => {
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-10-02", [
          ["60", "0"],
          ["40", "0"],
          ["0", "100"],
        ])
      )
    ).resolves.toBeGreaterThan(0);
  });

  it("refuses an unbalanced voucher in any company, whatever its date", async () => {
    for (const date of ["2026-10-01", "2026-11-01"]) {
      await expect(
        transaction((q) =>
          voucher(q, companyId, date, [
            ["100", "0"],
            ["0", "90"],
          ])
        )
      ).rejects.toThrow(/does not balance/);
    }
  });

  it("leaves history, optional vouchers and periodic stock adjustments alone", async () => {
    // A voucher that existed at the install is history: its lines stay editable.
    // Only a superuser with triggers off can write the marker (as the install did).
    const legacy = (await transaction(async (q) => {
      await q(`SET LOCAL session_replication_role = replica`);
      const id = await voucher(q, companyId, "2026-09-01", [["100", "0"]]);
      await q(`UPDATE vouchers SET balance_guard_exempt_history = true WHERE id = $1`, [id]);
      return id;
    })) as number;
    await expect(
      transaction((q) => q(`UPDATE voucher_entries SET debit_amount = 90 WHERE voucher_id = $1`, [legacy]))
    ).resolves.toBeDefined();

    // Stock adjustments backed by a stock document are one-sided before a
    // cut-over and in a supplier partner.
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-10-31", [["0", "50"]], { type: "Production", stockDocument: true })
      )
    ).resolves.toBeGreaterThan(0);
    await expect(
      transaction((q) =>
        voucher(q, partnerId, "2026-11-03", [["0", "50"]], { type: "Stock Adjustment", stockDocument: true })
      )
    ).resolves.toBeGreaterThan(0);
    // From the cut-over, a stock adjustment carries its inventory line and must balance.
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-11-03", [["0", "50"]], { type: "Production", stockDocument: true })
      )
    ).rejects.toThrow(/does not balance/);

    // An unbalanced optional voucher is allowed; activating it is refused.
    const optionalId = (await transaction((q) =>
      voucher(q, companyId, "2026-11-03", [["100", "0"]], { optional: true })
    )) as number;
    await expect(
      transaction((q) => q(`UPDATE vouchers SET optional = false WHERE id = $1`, [optionalId]))
    ).rejects.toThrow(/does not balance/);
  });

  it("balances lines in one transaction currency in that currency, the base within a cent", async () => {
    // XOF 500 + 500 against XOF 1,000: the per-line USD bases are a cent apart.
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-10-05", [
          ["0.83", "0", "XOF", "500"],
          ["0.83", "0", "XOF", "500"],
          ["0", "1.67", "XOF", "1000"],
        ])
      )
    ).resolves.toBeGreaterThan(0);
  });

  it("lets a reviewed repair bypass the guard for its own transaction", async () => {
    await expect(
      transaction(async (q) => {
        await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
        return voucher(q, companyId, "2026-11-04", [["100", "0"]]);
      })
    ).resolves.toBeGreaterThan(0);
  });
});
