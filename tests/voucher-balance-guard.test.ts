/**
 * Voucher balance guard (wave 8.5).
 *
 * From a company's perpetual-inventory cut-over, an active voucher dated on or
 * after it must balance when its transaction commits. Lines may be written one
 * by one inside the transaction; vouchers dated before the cut-over, optional
 * vouchers, companies without a cut-over and supplier-partner companies are
 * left alone; re-activating an unbalanced voucher is refused; a reviewed repair
 * can bypass the guard for its own transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensureVoucherBalanceGuard } from "../server/services/accounting/voucherBalanceGuard";
import { ensureLedgerIntegrityGuard } from "../server/services/accounting/ledgerIntegrityGuard";
import { ensureInventoryCutoverSchema } from "../server/services/accounting/perpetualInventory/cutover";

const PREFIX = `vbg${Date.now().toString(36)}`;
let companyId: number;
let partnerId: number;
let debitAccount: number;
let creditAccount: number;
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

async function voucher(q: Q, company: number, date: string, lines: Array<[string, string]>, optional = false) {
  sequence += 1;
  const id = (
    await q(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
       VALUES ($1, $2, 'Journal', $3, 0, $4) RETURNING id`,
      [company, `${PREFIX}-V${sequence}`, date, optional]
    )
  ).rows[0].id;
  for (const [debit, credit] of lines) {
    await q(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
      [id, Number(debit) > 0 ? debitAccount : creditAccount, debit, credit]
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
    debitAccount = await account(companyId, `${PREFIX}_DR`);
    creditAccount = await account(companyId, `${PREFIX}_CR`);
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
      await q(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
        company,
      ]);
      await q(`DELETE FROM vouchers WHERE company_id = $1`, [company]);
      await q(`DELETE FROM ledger_accounts WHERE company_id = $1`, [company]);
      await q(`DELETE FROM audit_log WHERE company_id = $1`, [company]);
      await q(`DELETE FROM companies WHERE id = $1`, [company]);
    }
  });
}, 60000);

describe("voucher balance guard", () => {
  it("accepts a voucher whose lines balance at commit, written one by one", async () => {
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-11-02", [
          ["60", "0"],
          ["40", "0"],
          ["0", "100"],
        ])
      )
    ).resolves.toBeGreaterThan(0);
  });

  it("refuses an unbalanced voucher dated on or after the cut-over", async () => {
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-11-01", [
          ["100", "0"],
          ["0", "90"],
        ])
      )
    ).rejects.toThrow(/does not balance/);
  });

  it("leaves vouchers before the cut-over, optional ones and supplier-partner companies alone", async () => {
    await expect(
      transaction((q) =>
        voucher(q, companyId, "2026-10-31", [
          ["100", "0"],
          ["0", "90"],
        ])
      )
    ).resolves.toBeGreaterThan(0);
    const optionalId = (await transaction((q) => voucher(q, companyId, "2026-11-03", [["100", "0"]], true))) as number;
    await expect(
      transaction((q) =>
        q(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Stock Adjustment', '2026-11-03', 0)`,
          [partnerId, `${PREFIX}-SP1`]
        )
      )
    ).resolves.toBeDefined();

    // Re-activating the unbalanced optional voucher is refused.
    await expect(
      transaction((q) => q(`UPDATE vouchers SET optional = false WHERE id = $1`, [optionalId]))
    ).rejects.toThrow(/does not balance/);
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
