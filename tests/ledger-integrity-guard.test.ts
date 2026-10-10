/**
 * Database ledger guards (2026-10 accounting audit, wave 4).
 *
 * Production held lines on hard-deleted, soft-deleted and other-company
 * accounts, and accounts with history had been deleted. The guards must refuse
 * each of those writes whatever code path issues them, allow the group's
 * shared-supplier pattern (a subsidiary posting against its parent's
 * supplier), and leave existing rows editable for non-financial fields.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensureLedgerIntegrityGuard } from "../server/services/accounting/ledgerIntegrityGuard";

const PREFIX = `lig${Date.now().toString(36)}`;
let companyA: number;
let companyB: number;
let subsidiary: number;
let accountA: number;
let accountB: number;
// Balancing legs: the voucher balance guard checks every voucher at COMMIT, so
// a line this file expects to be accepted is written with its counter-line.
let accountA2: number;
let accountSub: number;
let voucherA: number;
let voucherSub: number;

async function maintenance<T>(
  work: (q: (text: string, values?: unknown[]) => Promise<{ rows: T[] }>) => Promise<void>
) {
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

async function attempt(text: string, values: unknown[]): Promise<string | null> {
  try {
    await maintenance(async (q) => {
      await q(text, values);
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

beforeAll(async () => {
  expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  await maintenance<{ id: number }>(async (q) => {
    const company = async (code: string, parent: number | null) =>
      (
        await q(
          `INSERT INTO companies (code, name, parent_company_id) VALUES ($1::varchar, $1::text, $2) RETURNING id`,
          [`${PREFIX}${code}`, parent]
        )
      ).rows[0].id;
    companyA = await company("A", null);
    companyB = await company("B", null);
    subsidiary = await company("S", companyA);
    const account = async (companyId: number, code: string) =>
      (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
          [companyId, `${PREFIX}${code}`]
        )
      ).rows[0].id;
    accountA = await account(companyA, "ACC-A");
    accountB = await account(companyB, "ACC-B");
    accountA2 = await account(companyA, "ACC-A2");
    accountSub = await account(subsidiary, "ACC-S");
    const voucher = async (companyId: number, number: string) =>
      (
        await q(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', '2026-10-01', 10) RETURNING id`,
          [companyId, `${PREFIX}${number}`]
        )
      ).rows[0].id;
    voucherA = await voucher(companyA, "VA");
    voucherSub = await voucher(subsidiary, "VS");
  });
}, 60000);

afterAll(async () => {
  await maintenance(async (q) => {
    await q(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await q(`DELETE FROM vouchers WHERE company_id IN ($1, $2, $3)`, [companyA, companyB, subsidiary]);
    await q(`DELETE FROM suppliers WHERE company_id IN ($1, $2, $3)`, [companyA, companyB, subsidiary]);
    await q(`DELETE FROM ledger_accounts WHERE company_id IN ($1, $2, $3)`, [companyA, companyB, subsidiary]);
    await q(`DELETE FROM companies WHERE id IN ($1, $2, $3)`, [subsidiary, companyA, companyB]);
  });
}, 60000);

const insertLine = `INSERT INTO voucher_entries (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount)
                    VALUES ($1, $2, $3, $4, $5)`;
// A line and its balancing counter-line in one statement, for the cases that
// must commit: the voucher balance guard refuses a one-sided voucher.
const insertBalancedLines = `INSERT INTO voucher_entries (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount)
                    VALUES ($1, $2, $3, $4, $5), ($1, $6, NULL, $5, $4)`;

describe("voucher_entries target guard", () => {
  it("refuses a line on another company's account", async () => {
    expect(await attempt(insertLine, [voucherA, accountB, null, "10", "0"])).toMatch(/LEDGER_ACCOUNT_COMPANY_MISMATCH/);
  });

  it("refuses a line on a soft-deleted account", async () => {
    let deleted = 0;
    await maintenance<{ id: number }>(async (q) => {
      deleted = (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, deleted_at)
           VALUES ($1, $2::varchar, $2::text, 'Asset', NOW()) RETURNING id`,
          [companyA, `${PREFIX}GONE`]
        )
      ).rows[0].id;
    });
    expect(await attempt(insertLine, [voucherA, deleted, null, "10", "0"])).toMatch(/LEDGER_ACCOUNT_DELETED/);
  });

  it("refuses a line on an account that does not exist", async () => {
    expect(await attempt(insertLine, [voucherA, 2147480000, null, "10", "0"])).toMatch(
      /LEDGER_ACCOUNT_COMPANY_MISMATCH|foreign key/
    );
  });

  it("refuses a negative amount and a line with both sides", async () => {
    expect(await attempt(insertLine, [voucherA, accountA, null, "-5", "0"])).not.toBeNull();
    expect(await attempt(insertLine, [voucherA, accountA, null, "5", "5"])).not.toBeNull();
  });

  it("lets a subsidiary post against its parent's supplier but not an unrelated company's", async () => {
    let parentSupplier = 0;
    let otherSupplier = 0;
    await maintenance<{ id: number }>(async (q) => {
      const supplier = async (companyId: number, code: string) =>
        (
          await q(
            `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2::varchar, $2::text, 'x@example.test') RETURNING id`,
            [companyId, `${PREFIX}${code}`]
          )
        ).rows[0].id;
      parentSupplier = await supplier(companyA, "SUP-A");
      otherSupplier = await supplier(companyB, "SUP-B");
    });
    expect(await attempt(insertBalancedLines, [voucherSub, null, parentSupplier, "0", "10", accountSub])).toBeNull();
    expect(await attempt(insertBalancedLines, [voucherSub, null, otherSupplier, "0", "10", accountSub])).toMatch(
      /SUPPLIER_COMPANY_MISMATCH/
    );
  });

  it("accepts a valid line and keeps it editable for narration", async () => {
    expect(await attempt(insertBalancedLines, [voucherA, accountA, null, "10", "0", accountA2])).toBeNull();
    expect(
      await attempt(
        `UPDATE voucher_entries SET narration = 'edited' WHERE voucher_id = $1 AND ledger_account_id = $2`,
        [voucherA, accountA]
      )
    ).toBeNull();
  });
});

describe("ledger_accounts delete guard", () => {
  it("refuses to soft-delete an account with a non-zero posted balance", async () => {
    expect(await attempt(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [accountA])).toMatch(
      /LEDGER_ACCOUNT_HAS_BALANCE/
    );
  });

  it("refuses to hard-delete an account with lines", async () => {
    expect(await attempt(`DELETE FROM ledger_accounts WHERE id = $1`, [accountA])).toMatch(/foreign key/);
  });

  it("refuses to soft-delete an account with an opening balance, but allows an unused one and an emptied one", async () => {
    let opened = 0;
    let unused = 0;
    await maintenance<{ id: number }>(async (q) => {
      opened = (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
           VALUES ($1, $2::varchar, $2::text, 'Asset', 50, 'Dr') RETURNING id`,
          [companyA, `${PREFIX}OPEN`]
        )
      ).rows[0].id;
      unused = (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
          [companyA, `${PREFIX}UNUSED`]
        )
      ).rows[0].id;
    });
    expect(await attempt(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [opened])).toMatch(
      /LEDGER_ACCOUNT_HAS_BALANCE/
    );
    expect(await attempt(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [unused])).toBeNull();

    // History that nets to zero (a balance moved out by a journal) may be retired.
    let emptied = 0;
    await maintenance<{ id: number }>(async (q) => {
      emptied = (
        await q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
          [companyA, `${PREFIX}EMPTIED`]
        )
      ).rows[0].id;
      await q(insertLine, [voucherA, emptied, null, "25", "0"]);
      await q(insertLine, [voucherA, emptied, null, "0", "25"]);
    });
    expect(await attempt(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1`, [emptied])).toBeNull();
  });

  it("is idempotent to install again", async () => {
    expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  });
});

describe("first install", () => {
  const guardsPresent = async () =>
    (
      await pool.query<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('voucher_entries_target_guard', 'ledger_accounts_delete_guard'))
              + (SELECT COUNT(*) FROM pg_constraint WHERE conname = 'voucher_entries_single_side') AS n`
      )
    ).rows[0].n;

  it("installs on a database where the guard function does not exist yet", async () => {
    await maintenance(async (q) => {
      await q(`DROP TRIGGER IF EXISTS voucher_entries_target_guard ON voucher_entries`);
      await q(`DROP TRIGGER IF EXISTS ledger_accounts_delete_guard ON ledger_accounts`);
      await q(`DROP FUNCTION IF EXISTS erp_voucher_entry_target_guard()`);
      await q(`ALTER TABLE voucher_entries DROP CONSTRAINT IF EXISTS voucher_entries_single_side`);
    });
    expect(Number(await guardsPresent())).toBe(0);
    expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
    expect(Number(await guardsPresent())).toBe(3);
  });
});
