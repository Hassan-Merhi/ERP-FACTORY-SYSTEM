/**
 * The database's own guards on the chart of accounts, attacked in SQL.
 *
 * Three rules live in triggers so that no writer can skip them: the account
 * tree must stay a tree of like accounts inside one company, an account or bank
 * that still carries a balance cannot be deleted, and an opening balance cannot
 * be touched once the company has closed a period. Each test performs the
 * forbidden write and reads the refusal, then shows the nearest allowed write.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { expectAccepted, expectRefused, reread, seedRow, withRollback } from "./helpers/dbGuardHarness";

const CHECK_VIOLATION = "23514";
const PERIOD_CLOSED = "EPL01";
const DELETED = "2026-02-01T00:00:00Z";

type Row = Record<string, unknown>;

async function seedAccount(client: PoolClient, companyId: unknown, values: Row = {}): Promise<Row> {
  return seedRow(client, "ledger_accounts", { company_id: companyId, account_type: "Asset", ...values });
}

let voucherSequence = 0;

/** Posts `debit - credit` to an account on a voucher of its company, bypassing the posting triggers. */
async function seedPosting(
  client: PoolClient,
  companyId: unknown,
  target: Row,
  amounts: { debit?: string; credit?: string },
  voucherValues: Row = {}
): Promise<void> {
  voucherSequence += 1;
  const voucher = await seedRow(client, "vouchers", {
    company_id: companyId,
    voucher_number: `GUARD-A-${process.pid}-${voucherSequence}`,
    voucher_date: "2026-03-10",
    optional: false,
    ...voucherValues,
  });
  await seedRow(client, "voucher_entries", {
    voucher_id: voucher.id,
    company_id: companyId,
    debit_amount: amounts.debit ?? "0",
    credit_amount: amounts.credit ?? "0",
    ...target,
  });
}

async function closeBooks(client: PoolClient, companyId: unknown, status = "CLOSED") {
  return seedRow(client, "fiscal_period_closures", {
    company_id: companyId,
    period_start_date: "2025-01-01",
    period_end_date: "2025-12-31",
    status,
  });
}

describe("the account tree stays a tree of like accounts in one company", () => {
  const setParent = "UPDATE ledger_accounts SET parent_id = $1 WHERE id = $2 RETURNING id";
  const refusal = (reason: string) => ({ code: CHECK_VIOLATION, message: `LEDGER_ACCOUNT_PARENT_INVALID: ${reason}` });
  const refusalFor = (account: Row, reason: string) => refusal(`account ${String(account.code)}: ${reason}`);

  it("accepts a parent of the same class in the same company", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const parent = await seedAccount(client, company.id, { account_type: "Current Asset" });
      const child = await seedAccount(client, company.id, { account_type: "Bank" });

      await expectAccepted(client, setParent, [parent.id, child.id]);
    });
  });

  it("refuses an account as its own parent, and a parent that is one of its sub-accounts", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const top = await seedAccount(client, company.id);
      const middle = await seedAccount(client, company.id, { parent_id: top.id });
      const bottom = await seedAccount(client, company.id, { parent_id: middle.id });

      await expectRefused(client, setParent, [top.id, top.id], refusalFor(top, "an account cannot be its own parent"));
      await expectRefused(
        client,
        setParent,
        [bottom.id, top.id],
        refusalFor(top, "the parent is the account itself or one of its sub-accounts")
      );
      expect((await reread(client, "ledger_accounts", top.id)).parent_id).toBeNull();
    });
  });

  it("refuses a parent from another company, a missing parent and a deleted parent", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const stranger = await seedRow(client, "companies");
      const account = await seedAccount(client, company.id);
      const foreign = await seedAccount(client, stranger.id);
      const deleted = await seedAccount(client, company.id, { deleted_at: DELETED });

      await expectRefused(
        client,
        setParent,
        [foreign.id, account.id],
        refusalFor(account, "the parent is not an account of this company")
      );
      await expectRefused(
        client,
        setParent,
        [deleted.id, account.id],
        refusalFor(account, "the parent account is deleted")
      );
      await expectRefused(
        client,
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, parent_id)
         VALUES ($1, 'GUARD-ORPHAN', 'Orphan', 'Asset', 2147480000)`,
        [company.id],
        refusal("account GUARD-ORPHAN: the parent is not an account of this company")
      );
    });
  });

  it("refuses a parent of a different class, on insert and when the type changes later", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const assets = await seedAccount(client, company.id, { account_type: "Asset" });
      const child = await seedAccount(client, company.id, { account_type: "Cash", parent_id: assets.id });

      await expectRefused(
        client,
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, parent_id)
         VALUES ($1, 'GUARD-RENT', 'Rent', 'Indirect Expense', $2)`,
        [company.id, assets.id],
        refusal("account GUARD-RENT: the parent is asset and the account is expense")
      );
      await expectRefused(
        client,
        "UPDATE ledger_accounts SET account_type = 'Loan' WHERE id = $1",
        [child.id],
        refusalFor(child, "the parent is asset and the account is liability")
      );

      // A different type of the same class is not a change of class.
      await expectAccepted(
        client,
        "UPDATE ledger_accounts SET account_type = 'Fixed Asset' WHERE id = $1 RETURNING id",
        [child.id]
      );
    });
  });

  it("falls back to the sub-type to classify an account whose type is not a known class", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const assets = await seedAccount(client, company.id, { account_type: "Asset" });
      const insert = `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, parent_id)
                      VALUES ($1, $2, 'Custom', 'Custom group', $3, $4) RETURNING id`;

      await expectAccepted(client, insert, [company.id, "GUARD-SUB-1", "Bank", assets.id]);
      await expectRefused(
        client,
        insert,
        [company.id, "GUARD-SUB-2", "Revenue", assets.id],
        refusal("account GUARD-SUB-2: the parent is asset and the account is income")
      );
    });
  });

  it("refuses to delete, reclassify or move an account that still has live sub-accounts", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const destination = await seedRow(client, "companies");
      const parent = await seedAccount(client, company.id);
      const child = await seedAccount(client, company.id, { parent_id: parent.id });
      const blocked = refusalFor(parent, "the account has sub-accounts: move them first");

      await expectRefused(client, "UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1", [parent.id], blocked);
      await expectRefused(
        client,
        "UPDATE ledger_accounts SET account_type = 'Expense' WHERE id = $1",
        [parent.id],
        blocked
      );
      await expectRefused(
        client,
        "UPDATE ledger_accounts SET company_id = $1 WHERE id = $2",
        [destination.id, parent.id],
        blocked
      );

      // Once the sub-account is gone the parent can be deleted.
      await client.query("UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1", [child.id]);
      await expectAccepted(client, "UPDATE ledger_accounts SET deleted_at = now() WHERE id = $1 RETURNING id", [
        parent.id,
      ]);
    });
  });

  it("refuses to restore a deleted account under a parent that has since been deleted", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const parent = await seedAccount(client, company.id, { deleted_at: DELETED });
      const child = await seedAccount(client, company.id, { parent_id: parent.id, deleted_at: DELETED });

      await expectRefused(
        client,
        "UPDATE ledger_accounts SET deleted_at = NULL WHERE id = $1",
        [child.id],
        refusalFor(child, "the parent account is deleted")
      );
    });
  });

  it("is lifted only for a session that declares the ledger integrity bypass", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const account = await seedAccount(client, company.id);

      await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");

      await expectAccepted(client, setParent, [account.id, account.id]);
    });
  });
});

describe("an account that still carries a balance cannot be deleted", () => {
  const softDelete = (table: string) => `UPDATE "${table}" SET deleted_at = now() WHERE id = $1 RETURNING id`;

  it("refuses to delete a ledger account with an opening balance or a posted balance", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const opening = await seedAccount(client, company.id, { opening_balance: "50", opening_balance_side: "Dr" });
      const posted = await seedAccount(client, company.id);
      await seedPosting(client, company.id, { ledger_account_id: posted.id }, { debit: "75.25" });

      await expectRefused(client, softDelete("ledger_accounts"), [opening.id], {
        code: CHECK_VIOLATION,
        message: `LEDGER_ACCOUNT_HAS_BALANCE: account ${String(opening.id)} has a balance of 50`,
      });
      await expectRefused(client, softDelete("ledger_accounts"), [posted.id], {
        code: CHECK_VIOLATION,
        message: "has a balance of 75.25",
      });
      expect((await reread(client, "ledger_accounts", posted.id)).deleted_at).toBeNull();
    });
  });

  it("lets a ledger account go once its postings cancel its opening balance", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const account = await seedAccount(client, company.id, { opening_balance: "50", opening_balance_side: "Cr" });
      await seedPosting(client, company.id, { ledger_account_id: account.id }, { debit: "50" });

      await expectAccepted(client, softDelete("ledger_accounts"), [account.id]);
    });
  });

  it("reads an opening balance with no side as the normal side for the account's type", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const liability = await seedAccount(client, company.id, {
        account_type: "Liability",
        opening_balance: "50",
        opening_balance_side: null,
      });
      // A liability opens on the credit side, so a 50 debit clears it.
      await seedPosting(client, company.id, { ledger_account_id: liability.id }, { debit: "50" });

      await expectAccepted(client, softDelete("ledger_accounts"), [liability.id]);
    });
  });

  it("ignores postings on deleted and optional vouchers when working out the balance", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const account = await seedAccount(client, company.id);
      await seedPosting(
        client,
        company.id,
        { ledger_account_id: account.id },
        { debit: "10" },
        { deleted_at: DELETED }
      );
      await seedPosting(client, company.id, { ledger_account_id: account.id }, { debit: "20" }, { optional: true });

      await expectAccepted(client, softDelete("ledger_accounts"), [account.id]);
    });
  });

  it("refuses to delete a bank account with a balance, counting only lines posted to the bank itself", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const ledger = await seedAccount(client, company.id);
      const withBalance = await seedRow(client, "bank_accounts", { company_id: company.id });
      const viaLedger = await seedRow(client, "bank_accounts", { company_id: company.id, linked_ledger_id: ledger.id });
      const overdrawn = await seedRow(client, "bank_accounts", {
        company_id: company.id,
        opening_balance: "30",
        opening_balance_side: "Cr",
      });
      await seedPosting(client, company.id, { bank_account_id: withBalance.id }, { credit: "40" });
      // A line that names the bank's ledger counts on the ledger, not on the bank.
      await seedPosting(
        client,
        company.id,
        { bank_account_id: viaLedger.id, ledger_account_id: ledger.id },
        { debit: "99" }
      );

      await expectRefused(client, softDelete("bank_accounts"), [withBalance.id], {
        code: CHECK_VIOLATION,
        message: `BANK_ACCOUNT_HAS_BALANCE: bank account ${String(withBalance.id)} has a balance of -40`,
      });
      await expectRefused(client, softDelete("bank_accounts"), [overdrawn.id], {
        code: CHECK_VIOLATION,
        message: "has a balance of -30",
      });
      await expectAccepted(client, softDelete("bank_accounts"), [viaLedger.id]);
    });
  });

  it("does not stand in the way of restoring an account or editing a deleted one", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const account = await seedAccount(client, company.id, { opening_balance: "50", deleted_at: DELETED });
      const bank = await seedRow(client, "bank_accounts", {
        company_id: company.id,
        opening_balance: "50",
        deleted_at: DELETED,
      });

      await expectAccepted(client, softDelete("ledger_accounts"), [account.id]);
      await expectAccepted(client, softDelete("bank_accounts"), [bank.id]);
      await expectAccepted(client, "UPDATE ledger_accounts SET deleted_at = NULL WHERE id = $1 RETURNING id", [
        account.id,
      ]);
      await expectAccepted(client, "UPDATE bank_accounts SET deleted_at = NULL WHERE id = $1 RETURNING id", [bank.id]);
    });
  });

  it("is lifted only for a session that declares the ledger integrity bypass", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const account = await seedAccount(client, company.id, { opening_balance: "50" });
      const bank = await seedRow(client, "bank_accounts", { company_id: company.id, opening_balance: "50" });

      await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");

      await expectAccepted(client, softDelete("ledger_accounts"), [account.id]);
      await expectAccepted(client, softDelete("bank_accounts"), [bank.id]);
    });
  });
});

const OPENING_BALANCE_TABLES = [
  { table: "bank_accounts", side: true, softDelete: true },
  { table: "customers", side: true, softDelete: true },
  { table: "employees", side: true, softDelete: true },
  { table: "factory_suppliers", side: false, softDelete: false },
  { table: "fixed_assets", side: false, softDelete: true },
  { table: "ledger_accounts", side: true, softDelete: true },
];

describe("the set of tables with a locked opening balance", () => {
  it("is exactly the tables this suite exercises, each guarded on insert, update and delete", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT c.relname AS table_name, t.tgtype, t.tgenabled
           FROM pg_trigger t
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE p.proname = 'erp_opening_balance_lock_guard' AND NOT t.tgisinternal
          ORDER BY c.relname`
      );

      expect(rows.map((row) => row.table_name)).toEqual(OPENING_BALANCE_TABLES.map((entry) => entry.table));
      for (const row of rows) {
        // Row-level (1), before (2), insert (4), delete (8) and update (16).
        expect(row.tgtype & 31, row.table_name).toBe(31);
        expect(row.tgenabled, row.table_name).toBe("O");
      }
    });
  });
});

const refusal = {
  code: PERIOD_CLOSED,
  message: "ACCOUNTING_PERIOD_CLOSED: the books are closed through 2025-12-31, so an opening balance cannot be",
};

describe.each(OPENING_BALANCE_TABLES)("opening balance lock on $table", ({ table }) => {
  const setOpening = `UPDATE "${table}" SET opening_balance = $1 WHERE id = $2 RETURNING id`;

  it("refuses to change or clear an opening balance once the company has closed a period", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const row = await seedRow(client, table, { company_id: company.id, opening_balance: "100" });
      const empty = await seedRow(client, table, { company_id: company.id, opening_balance: "0" });
      await closeBooks(client, company.id);

      await expectRefused(client, setOpening, ["250", row.id], refusal);
      await expectRefused(client, setOpening, ["0", row.id], refusal);
      await expectRefused(client, setOpening, ["10", empty.id], refusal);

      expect(Number((await reread(client, table, row.id)).opening_balance)).toBe(100);
    });
  });

  it("refuses to delete a row that carries an opening balance, but not one that carries none", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const row = await seedRow(client, table, { company_id: company.id, opening_balance: "100" });
      const empty = await seedRow(client, table, { company_id: company.id, opening_balance: "0" });
      await closeBooks(client, company.id);

      await expectRefused(client, `DELETE FROM "${table}" WHERE id = $1`, [row.id], refusal);

      await expectAccepted(client, `DELETE FROM "${table}" WHERE id = $1 RETURNING id`, [empty.id]);
    });
  });

  it("refuses to move a row with an opening balance into or out of a closed company", async () => {
    await withRollback(async (client) => {
      const closed = await seedRow(client, "companies");
      const open = await seedRow(client, "companies");
      const inClosed = await seedRow(client, table, { company_id: closed.id, opening_balance: "100" });
      const inOpen = await seedRow(client, table, { company_id: open.id, opening_balance: "100" });
      await closeBooks(client, closed.id);
      // The tree guard has its own say about moving ledger accounts; it is not under test here.
      await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");
      const move = `UPDATE "${table}" SET company_id = $1 WHERE id = $2`;

      await expectRefused(client, move, [open.id, inClosed.id], refusal);
      await expectRefused(client, move, [closed.id, inOpen.id], refusal);
    });
  });

  it("leaves opening balances editable until a period is closed, and for other companies afterwards", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const other = await seedRow(client, "companies");
      const reopened = await seedRow(client, "companies");
      const rows = [];
      for (const owner of [company, other, reopened]) {
        rows.push(await seedRow(client, table, { company_id: owner.id, opening_balance: "100" }));
      }

      await expectAccepted(client, setOpening, ["150", rows[0].id]);

      await closeBooks(client, company.id);
      await closeBooks(client, reopened.id, "REOPENED");
      await expectRefused(client, setOpening, ["200", rows[0].id], refusal);
      await expectAccepted(client, setOpening, ["200", rows[1].id]);
      await expectAccepted(client, setOpening, ["200", rows[2].id]);
    });
  });

  it("is lifted only for a session that declares the closed-period override", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const row = await seedRow(client, table, { company_id: company.id, opening_balance: "100" });
      await closeBooks(client, company.id);

      await client.query("SELECT set_config('app.closed_period_override', 'on', true)");

      await expectAccepted(client, setOpening, ["250", row.id]);
    });
  });
});

describe.each(OPENING_BALANCE_TABLES.filter((entry) => entry.side))("opening balance side on $table", ({ table }) => {
  it("refuses to flip the side of an opening balance", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const row = await seedRow(client, table, {
        company_id: company.id,
        opening_balance: "100",
        opening_balance_side: "Dr",
      });
      const empty = await seedRow(client, table, { company_id: company.id, opening_balance: "0" });
      await closeBooks(client, company.id);
      const flip = `UPDATE "${table}" SET opening_balance_side = 'Cr' WHERE id = $1 RETURNING id`;

      await expectRefused(client, flip, [row.id], refusal);

      // The side of a zero balance means nothing, so it stays editable.
      await expectAccepted(client, flip, [empty.id]);
    });
  });
});

describe.each(OPENING_BALANCE_TABLES.filter((entry) => entry.softDelete))(
  "opening balance of a deleted row on $table",
  ({ table }) => {
    it("refuses to soft-delete or restore a row that carries an opening balance", async () => {
      await withRollback(async (client) => {
        const company = await seedRow(client, "companies");
        const live = await seedRow(client, table, { company_id: company.id, opening_balance: "100" });
        const gone = await seedRow(client, table, {
          company_id: company.id,
          opening_balance: "100",
          deleted_at: DELETED,
        });
        const empty = await seedRow(client, table, { company_id: company.id, opening_balance: "0" });
        await closeBooks(client, company.id);
        // Deleting an account with a balance is refused separately; that guard is not under test here.
        await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");

        await expectRefused(client, `UPDATE "${table}" SET deleted_at = now() WHERE id = $1`, [live.id], refusal);
        await expectRefused(client, `UPDATE "${table}" SET deleted_at = NULL WHERE id = $1`, [gone.id], refusal);

        await expectAccepted(client, `UPDATE "${table}" SET deleted_at = now() WHERE id = $1 RETURNING id`, [empty.id]);
      });
    });
  }
);

describe("opening balance lock on new rows", () => {
  it("refuses a new account with an opening balance in a closed company, but not one without", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      await closeBooks(client, company.id);
      const insert = `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance)
                      VALUES ($1, $2, 'New account', 'Asset', $3) RETURNING id`;

      await expectRefused(client, insert, [company.id, "GUARD-NEW-1", "500"], {
        code: PERIOD_CLOSED,
        message: "an opening balance cannot be created, changed or deleted",
      });

      await expectAccepted(client, insert, [company.id, "GUARD-NEW-2", "0"]);
    });
  });
});
