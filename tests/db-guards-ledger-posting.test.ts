/**
 * The database's own guards on vouchers and voucher lines, attacked in SQL.
 *
 * The posting engine balances vouchers, refuses closed periods and checks who a
 * line belongs to. These triggers are the second line: they apply to every
 * writer, including a script or a future route that forgets the engine. Each
 * test performs the write the guard forbids and reads the refusal, then shows
 * the nearest allowed write still succeeds.
 *
 * The balance checks are held until commit, so the tests ask the database to
 * run them early (expectRefusedAtCommit / expectCommittable).
 *
 * The shared test database does not keep the balance guard installed: other
 * suites write unbalanced fixtures, so the suites that test it install it and
 * take it away again. This one installs it and leaves the database as it was.
 */
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import {
  ensureVoucherBalanceGuard,
  VOUCHER_BALANCE_GUARD_TRIGGERS,
} from "../server/services/accounting/voucherBalanceGuard";

import {
  dropTriggers,
  expectAccepted,
  expectCommittable,
  expectRefused,
  expectRefusedAtCommit,
  missingTriggers,
  reread,
  seedRow,
  withRollback,
} from "./helpers/dbGuardHarness";

const CHECK_VIOLATION = "23514";
const PERIOD_CLOSED = "EPL01";

type Row = Record<string, unknown>;

let installedHere: Awaited<ReturnType<typeof missingTriggers>> = [];

beforeAll(async () => {
  installedHere = await missingTriggers(VOUCHER_BALANCE_GUARD_TRIGGERS);
  expect(await ensureVoucherBalanceGuard(pool)).toBe(true);
}, 60000);

afterAll(async () => {
  await dropTriggers(installedHere);
}, 60000);

let voucherSequence = 0;

/** A posted, non-optional USD voucher in an open period, with no lines. */
async function seedVoucher(client: PoolClient, values: Row = {}): Promise<Row> {
  voucherSequence += 1;
  return seedRow(client, "vouchers", {
    voucher_number: `GUARD-V-${process.pid}-${voucherSequence}`,
    voucher_type: "Journal",
    voucher_date: "2026-03-10",
    effective_date: "2026-03-10",
    currency: "USD",
    exchange_rate: "1",
    optional: false,
    posted_by_engine: false,
    balance_guard_exempt_history: false,
    ...values,
  });
}

async function seedLedger(client: PoolClient, companyId: unknown, values: Row = {}): Promise<Row> {
  return seedRow(client, "ledger_accounts", { company_id: companyId, account_type: "Asset", ...values });
}

/** Adds a line the way an application would: every trigger runs. */
async function addLine(client: PoolClient, voucher: Row, values: Row): Promise<Row> {
  const row: Row = { voucher_id: voucher.id, ...values };
  const names = Object.keys(row);
  const { rows } = await client.query(
    `INSERT INTO voucher_entries (${names.map((name) => `"${name}"`).join(", ")})
     VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`,
    names.map((name) => row[name])
  );
  return rows[0];
}

/** A voucher with one debit and one credit line of the same amount. */
async function seedBalancedVoucher(client: PoolClient, values: Row = {}) {
  const voucher = await seedVoucher(client, values);
  const ledger = await seedLedger(client, voucher.company_id);
  const debit = await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "100" });
  const credit = await addLine(client, voucher, { ledger_account_id: ledger.id, credit_amount: "100" });
  await expectCommittable(client);
  return { voucher, ledger, debit, credit };
}

async function closeBooks(client: PoolClient, companyId: unknown, through: string, status = "CLOSED") {
  return seedRow(client, "fiscal_period_closures", {
    company_id: companyId,
    period_start_date: "2025-01-01",
    period_end_date: through,
    status,
  });
}

describe("a voucher must balance before it can be committed", () => {
  it("refuses a voucher whose debits and credits differ", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const ledger = await seedLedger(client, voucher.company_id);

      await expectRefusedAtCommit(
        client,
        async () => {
          await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "100" });
          await addLine(client, voucher, { ledger_account_id: ledger.id, credit_amount: "60" });
        },
        { code: CHECK_VIOLATION, message: "does not balance in its transaction currency: debits 100.00, credits 60.00" }
      );
    });
  });

  it("accepts a balanced voucher, and one-sided lines while the transaction is still open", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const ledger = await seedLedger(client, voucher.company_id);

      // The first line alone is unbalanced; the check waits for commit.
      await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "100" });
      await addLine(client, voucher, { ledger_account_id: ledger.id, credit_amount: "100" });

      await expectCommittable(client);
    });
  });

  it("refuses to change or remove a line so that a posted voucher stops balancing", async () => {
    await withRollback(async (client) => {
      const { debit, credit } = await seedBalancedVoucher(client);

      await expectRefusedAtCommit(
        client,
        () => client.query("UPDATE voucher_entries SET debit_amount = 150 WHERE id = $1", [debit.id]),
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
      await expectRefusedAtCommit(
        client,
        () => client.query("DELETE FROM voucher_entries WHERE id = $1", [credit.id]),
        {
          code: CHECK_VIOLATION,
          message: "does not balance",
        }
      );

      // A change that keeps both sides equal is fine.
      await client.query("UPDATE voucher_entries SET debit_amount = 150 WHERE id = $1", [debit.id]);
      await client.query("UPDATE voucher_entries SET credit_amount = 150 WHERE id = $1", [credit.id]);
      await expectCommittable(client);
    });
  });

  it("checks both vouchers when a line is moved from one to another", async () => {
    await withRollback(async (client) => {
      const { voucher, debit } = await seedBalancedVoucher(client);
      const other = await seedVoucher(client, { company_id: voucher.company_id });

      await expectRefusedAtCommit(
        client,
        () => client.query("UPDATE voucher_entries SET voucher_id = $1 WHERE id = $2", [other.id, debit.id]),
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
    });
  });

  it("does not check optional or deleted vouchers, but checks them the moment they become live", async () => {
    await withRollback(async (client) => {
      const optional = await seedVoucher(client, { optional: true });
      const deleted = await seedVoucher(client, { deleted_at: "2026-03-11T00:00:00Z" });
      for (const voucher of [optional, deleted]) {
        const ledger = await seedLedger(client, voucher.company_id);
        await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "100" });
      }
      await expectCommittable(client);

      await expectRefusedAtCommit(
        client,
        () => client.query("UPDATE vouchers SET optional = false WHERE id = $1", [optional.id]),
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
      await expectRefusedAtCommit(
        client,
        () => client.query("UPDATE vouchers SET deleted_at = NULL WHERE id = $1", [deleted.id]),
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
    });
  });

  it("leaves an unbalanced voucher marked as history alone until its lines change", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client, { balance_guard_exempt_history: true });
      const ledger = await seedLedger(client, voucher.company_id);
      const line = await seedRow(client, "voucher_entries", {
        voucher_id: voucher.id,
        company_id: voucher.company_id,
        ledger_account_id: ledger.id,
        debit_amount: "100",
        credit_amount: "0",
      });

      await client.query("UPDATE vouchers SET voucher_date = '2026-03-12' WHERE id = $1", [voucher.id]);
      await client.query("UPDATE voucher_entries SET narration = 'reviewed' WHERE id = $1", [line.id]);
      await expectCommittable(client);

      await expectRefusedAtCommit(
        client,
        () => client.query("UPDATE voucher_entries SET debit_amount = 90 WHERE id = $1", [line.id]),
        { code: CHECK_VIOLATION, message: "does not balance in its transaction currency: debits 90.00, credits 0.00" }
      );
    });
  });

  it("refuses a voucher that balances in base currency but not in the currency it was written in", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client, { currency: "EUR", exchange_rate: "1.1" });
      const ledger = await seedLedger(client, voucher.company_id);
      const euroLine = (side: "debit" | "credit", amount: string, rate: string, base: string) => ({
        ledger_account_id: ledger.id,
        transaction_currency: "EUR",
        transaction_debit_amount: side === "debit" ? amount : "0",
        transaction_credit_amount: side === "credit" ? amount : "0",
        base_debit_amount: side === "debit" ? base : "0",
        base_credit_amount: side === "credit" ? base : "0",
        historical_exchange_rate: rate,
        rate_convention: "BASE_PER_TRANSACTION",
      });

      await expectRefusedAtCommit(
        client,
        async () => {
          await addLine(client, voucher, euroLine("debit", "100", "1.1", "110"));
          await addLine(client, voucher, euroLine("credit", "110", "1", "110"));
        },
        {
          code: CHECK_VIOLATION,
          message: "does not balance in its transaction currency: debits 100.00, credits 110.00",
        }
      );

      await addLine(client, voucher, euroLine("debit", "100", "1.1", "110"));
      await addLine(client, voucher, euroLine("credit", "100", "1.1", "110"));
      await expectCommittable(client);
    });
  });

  it("is lifted only for a session that declares the ledger integrity bypass", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const ledger = await seedLedger(client, voucher.company_id);
      await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "100" });

      for (const value of ["off", "true", ""]) {
        await client.query("SELECT set_config('app.ledger_integrity_bypass', $1, true)", [value]);
        await expectRefusedAtCommit(client, async () => {}, { code: CHECK_VIOLATION, message: "does not balance" });
      }

      await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");
      await expectCommittable(client);
    });
  });
});

describe("a one-sided stock adjustment voucher needs its stock document", () => {
  async function seedOneSided(client: PoolClient, voucherValues: Row = {}) {
    const voucher = await seedVoucher(client, { voucher_type: "Stock Adjustment", ...voucherValues });
    const ledger = await seedLedger(client, voucher.company_id);
    await seedRow(client, "voucher_entries", {
      voucher_id: voucher.id,
      company_id: voucher.company_id,
      ledger_account_id: ledger.id,
      debit_amount: "100",
      credit_amount: "0",
    });
    const adjustment = await seedRow(client, "stock_adjustment_vouchers", { voucher_id: voucher.id });
    const item = await seedRow(client, "stock_adjustment_items", { adjustment_id: adjustment.id });
    return { voucher, adjustment, item };
  }

  /** Makes the database look at the voucher again. */
  const recheck = (client: PoolClient, voucher: Row) =>
    client.query("UPDATE vouchers SET voucher_date = voucher_date + 1 WHERE id = $1", [voucher.id]);

  it("accepts the one-sided voucher while a stock document with items backs it", async () => {
    await withRollback(async (client) => {
      const { voucher } = await seedOneSided(client);

      await recheck(client, voucher);

      await expectCommittable(client);
    });
  });

  it("refuses to remove the items or the stock document from under the voucher", async () => {
    await withRollback(async (client) => {
      const { adjustment, item } = await seedOneSided(client);

      await expectRefusedAtCommit(
        client,
        () => client.query("DELETE FROM stock_adjustment_items WHERE id = $1", [item.id]),
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
      await expectRefusedAtCommit(
        client,
        async () => {
          await client.query("DELETE FROM stock_adjustment_items WHERE adjustment_id = $1", [adjustment.id]);
          await client.query("DELETE FROM stock_adjustment_vouchers WHERE id = $1", [adjustment.id]);
        },
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
    });
  });

  it("refuses to point the stock document at a different voucher", async () => {
    await withRollback(async (client) => {
      const { voucher, adjustment } = await seedOneSided(client);
      const other = await seedVoucher(client, { company_id: voucher.company_id });

      await expectRefusedAtCommit(
        client,
        () =>
          client.query("UPDATE stock_adjustment_vouchers SET voucher_id = $1 WHERE id = $2", [other.id, adjustment.id]),
        { code: CHECK_VIOLATION, message: "does not balance" }
      );
    });
  });

  it("does not extend the exception to other voucher types or to perpetual-inventory companies", async () => {
    await withRollback(async (client) => {
      const journal = await seedOneSided(client, { voucher_type: "Journal" });
      await expectRefusedAtCommit(client, () => recheck(client, journal.voucher), {
        code: CHECK_VIOLATION,
        message: "does not balance",
      });

      const perpetual = await seedOneSided(client);
      await seedRow(client, "gl_inventory_cutovers", {
        company_id: perpetual.voucher.company_id,
        effective_from: "2026-01-01",
      });
      await expectRefusedAtCommit(client, () => recheck(client, perpetual.voucher), {
        code: CHECK_VIOLATION,
        message: "does not balance",
      });
    });
  });
});

describe("a closed period cannot be written to", () => {
  const insertVoucher = `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount)
                         VALUES ($1, $2, 'Journal', $3, $4, 0) RETURNING id`;

  it("refuses a new voucher dated on or before the closing date, by either of its dates", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      await closeBooks(client, company.id, "2026-01-31");

      await expectRefused(client, insertVoucher, [company.id, "GUARD-CLOSED-1", "2026-01-31", "2026-01-31"], {
        code: PERIOD_CLOSED,
        message: "ACCOUNTING_PERIOD_CLOSED: the books are closed through 2026-01-31",
      });
      await expectRefused(client, insertVoucher, [company.id, "GUARD-CLOSED-2", "2026-02-10", "2026-01-15"], {
        code: PERIOD_CLOSED,
        message: "an entry dated 2026-01-15",
      });

      await expectAccepted(client, insertVoucher, [company.id, "GUARD-OPEN-1", "2026-02-01", "2026-02-01"]);
    });
  });

  it("refuses to change the money or dates of a voucher in the closed period, or delete it", async () => {
    await withRollback(async (client) => {
      const closed = await seedVoucher(client, { voucher_date: "2026-01-20", effective_date: "2026-01-20" });
      const open = await seedVoucher(client, { company_id: closed.company_id });
      await closeBooks(client, closed.company_id, "2026-01-31");
      const refusal = { code: PERIOD_CLOSED, message: "ACCOUNTING_PERIOD_CLOSED" };

      await expectRefused(client, "UPDATE vouchers SET total_amount = 5 WHERE id = $1", [closed.id], refusal);
      await expectRefused(
        client,
        "UPDATE vouchers SET voucher_date = '2026-02-05' WHERE id = $1",
        [closed.id],
        refusal
      );
      await expectRefused(client, "UPDATE vouchers SET deleted_at = now() WHERE id = $1", [closed.id], refusal);
      await expectRefused(client, "DELETE FROM vouchers WHERE id = $1", [closed.id], refusal);
      // Moving an open voucher back into the closed period is the same offence.
      await expectRefused(client, "UPDATE vouchers SET voucher_date = '2026-01-10' WHERE id = $1", [open.id], refusal);

      expect(String((await reread(client, "vouchers", closed.id)).total_amount)).toBe(String(closed.total_amount));
      await expectAccepted(
        client,
        "UPDATE vouchers SET description = 'note for the auditor' WHERE id = $1 RETURNING id",
        [closed.id]
      );
      await expectAccepted(client, "UPDATE vouchers SET total_amount = 5 WHERE id = $1 RETURNING id", [open.id]);
    });
  });

  it("refuses to add, change or remove the lines of a voucher in the closed period", async () => {
    await withRollback(async (client) => {
      const { voucher, ledger, debit } = await seedBalancedVoucher(client, {
        voucher_date: "2026-01-20",
        effective_date: "2026-01-20",
      });
      await closeBooks(client, voucher.company_id, "2026-01-31");
      const refusal = { code: PERIOD_CLOSED, message: "ACCOUNTING_PERIOD_CLOSED" };

      await expectRefused(
        client,
        "INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount) VALUES ($1, $2, 10)",
        [voucher.id, ledger.id],
        refusal
      );
      await expectRefused(client, "UPDATE voucher_entries SET debit_amount = 90 WHERE id = $1", [debit.id], refusal);
      await expectRefused(client, "DELETE FROM voucher_entries WHERE id = $1", [debit.id], refusal);

      await expectAccepted(client, "UPDATE voucher_entries SET narration = 'explained' WHERE id = $1 RETURNING id", [
        debit.id,
      ]);
    });
  });

  it("is locked only by a CLOSED closure of the same company", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const other = await seedRow(client, "companies");
      await closeBooks(client, other.id, "2026-01-31");
      await closeBooks(client, company.id, "2026-01-31", "REOPENED");

      await expectAccepted(client, insertVoucher, [company.id, "GUARD-REOPENED-1", "2026-01-15", "2026-01-15"]);
    });
  });

  it("is lifted only for a session that declares the closed-period override", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      await closeBooks(client, company.id, "2026-01-31");

      await client.query("SELECT set_config('app.closed_period_override', 'yes', true)");
      await expectRefused(client, insertVoucher, [company.id, "GUARD-OVERRIDE-1", "2026-01-15", "2026-01-15"], {
        code: PERIOD_CLOSED,
      });

      await client.query("SELECT set_config('app.closed_period_override', 'on', true)");
      await expectAccepted(client, insertVoucher, [company.id, "GUARD-OVERRIDE-2", "2026-01-15", "2026-01-15"]);
    });
  });
});

describe("a voucher line must have one owner inside the voucher's company", () => {
  const insertLine = (columns: string[]) =>
    `INSERT INTO voucher_entries (voucher_id, debit_amount, ${columns.join(", ")})
     VALUES ($1, 10, ${columns.map((_, index) => `$${index + 2}`).join(", ")}) RETURNING id`;

  it("refuses a line with no owner, two accounts or two parties", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const company = voucher.company_id;
      const ledger = await seedLedger(client, company);
      const bank = await seedRow(client, "bank_accounts", { company_id: company });
      const customer = await seedRow(client, "customers", { company_id: company });
      const employee = await seedRow(client, "employees", { company_id: company });
      const refusal = { code: CHECK_VIOLATION, message: "VOUCHER_LINE_TARGET_REQUIRED" };

      await expectRefused(
        client,
        "INSERT INTO voucher_entries (voucher_id, debit_amount) VALUES ($1, 10)",
        [voucher.id],
        refusal
      );
      await expectRefused(
        client,
        insertLine(["ledger_account_id", "bank_account_id"]),
        [voucher.id, ledger.id, bank.id],
        { ...refusal, message: "names 2 accounts and 0 parties" }
      );
      await expectRefused(client, insertLine(["customer_id", "employee_id"]), [voucher.id, customer.id, employee.id], {
        ...refusal,
        message: "names 0 accounts and 2 parties",
      });
      await expectRefused(
        client,
        insertLine(["ledger_account_id", "customer_id", "employee_id"]),
        [voucher.id, ledger.id, customer.id, employee.id],
        refusal
      );
    });
  });

  it("accepts one account, one party, an account tagged with a party, and a bank with its own ledger", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const company = voucher.company_id;
      const ledger = await seedLedger(client, company);
      const bank = await seedRow(client, "bank_accounts", { company_id: company, linked_ledger_id: ledger.id });
      const asset = await seedRow(client, "fixed_assets", { company_id: company });
      const customer = await seedRow(client, "customers", { company_id: company });
      const factorySupplier = await seedRow(client, "factory_suppliers", { company_id: company });

      await expectAccepted(client, insertLine(["ledger_account_id"]), [voucher.id, ledger.id]);
      await expectAccepted(client, insertLine(["fixed_asset_id"]), [voucher.id, asset.id]);
      await expectAccepted(client, insertLine(["customer_id"]), [voucher.id, customer.id]);
      await expectAccepted(client, insertLine(["factory_supplier_id"]), [voucher.id, factorySupplier.id]);
      await expectAccepted(client, insertLine(["ledger_account_id", "customer_id"]), [
        voucher.id,
        ledger.id,
        customer.id,
      ]);
      await expectAccepted(client, insertLine(["ledger_account_id", "bank_account_id"]), [
        voucher.id,
        ledger.id,
        bank.id,
      ]);
    });
  });

  it.each([
    { column: "ledger_account_id", table: "ledger_accounts", message: "LEDGER_ACCOUNT_COMPANY_MISMATCH" },
    { column: "bank_account_id", table: "bank_accounts", message: "BANK_ACCOUNT_NOT_POSTABLE" },
    { column: "fixed_asset_id", table: "fixed_assets", message: "FIXED_ASSET_COMPANY_MISMATCH" },
    { column: "customer_id", table: "customers", message: "CUSTOMER_COMPANY_MISMATCH" },
    { column: "employee_id", table: "employees", message: "EMPLOYEE_COMPANY_MISMATCH" },
    { column: "factory_supplier_id", table: "factory_suppliers", message: "FACTORY_SUPPLIER_COMPANY_MISMATCH" },
    { column: "supplier_id", table: "suppliers", message: "SUPPLIER_COMPANY_MISMATCH" },
  ])("refuses a line posted to another company's $table row", async ({ column, table, message }) => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const stranger = await seedRow(client, "companies");
      const foreign = await seedRow(client, table, { company_id: stranger.id });
      const own = await seedRow(client, table, { company_id: voucher.company_id });

      await expectRefused(client, insertLine([column]), [voucher.id, foreign.id], { code: CHECK_VIOLATION, message });

      await expectAccepted(client, insertLine([column]), [voucher.id, own.id]);
    });
  });

  it.each([
    { column: "ledger_account_id", table: "ledger_accounts", message: "LEDGER_ACCOUNT_DELETED" },
    { column: "bank_account_id", table: "bank_accounts", message: "BANK_ACCOUNT_NOT_POSTABLE" },
    { column: "fixed_asset_id", table: "fixed_assets", message: "FIXED_ASSET_DELETED" },
  ])("refuses a line posted to a deleted $table row", async ({ column, table, message }) => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const deleted = await seedRow(client, table, {
        company_id: voucher.company_id,
        deleted_at: "2026-02-01T00:00:00Z",
      });

      await expectRefused(client, insertLine([column]), [voucher.id, deleted.id], { code: CHECK_VIOLATION, message });
    });
  });

  it("shares a supplier between a parent company and its subsidiaries, in both directions, and no further", async () => {
    await withRollback(async (client) => {
      const parent = await seedRow(client, "companies");
      const subsidiary = await seedRow(client, "companies", { parent_company_id: parent.id });
      const sibling = await seedRow(client, "companies", { parent_company_id: parent.id });
      const parentSupplier = await seedRow(client, "suppliers", { company_id: parent.id });
      const subsidiarySupplier = await seedRow(client, "suppliers", { company_id: subsidiary.id });
      const parentVoucher = await seedVoucher(client, { company_id: parent.id });
      const subsidiaryVoucher = await seedVoucher(client, { company_id: subsidiary.id });
      const siblingVoucher = await seedVoucher(client, { company_id: sibling.id });

      await expectAccepted(client, insertLine(["supplier_id"]), [subsidiaryVoucher.id, parentSupplier.id]);
      await expectAccepted(client, insertLine(["supplier_id"]), [parentVoucher.id, subsidiarySupplier.id]);

      await expectRefused(client, insertLine(["supplier_id"]), [siblingVoucher.id, subsidiarySupplier.id], {
        code: CHECK_VIOLATION,
        message: "SUPPLIER_COMPANY_MISMATCH",
      });
    });
  });

  it("re-checks a line whose owner changes, and leaves an old ownerless line editable otherwise", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const stranger = await seedRow(client, "companies");
      const foreignLedger = await seedLedger(client, stranger.id);
      const legacy = await seedRow(client, "voucher_entries", {
        voucher_id: voucher.id,
        company_id: voucher.company_id,
        debit_amount: "10",
        credit_amount: "0",
      });

      await expectAccepted(client, "UPDATE voucher_entries SET narration = 'legacy line' WHERE id = $1 RETURNING id", [
        legacy.id,
      ]);
      await expectRefused(
        client,
        "UPDATE voucher_entries SET ledger_account_id = $1 WHERE id = $2",
        [foreignLedger.id, legacy.id],
        { code: CHECK_VIOLATION, message: "LEDGER_ACCOUNT_COMPANY_MISMATCH" }
      );
    });
  });

  it("is lifted only for a session that declares the ledger integrity bypass", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");

      await expectAccepted(
        client,
        "INSERT INTO voucher_entries (voucher_id, debit_amount) VALUES ($1, 10) RETURNING id",
        [voucher.id]
      );
    });
  });
});

describe("a voucher line always carries its voucher's company", () => {
  it("overwrites whatever company the writer supplies", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const ledger = await seedLedger(client, voucher.company_id);
      const stranger = await seedRow(client, "companies");

      const line = await addLine(client, voucher, {
        ledger_account_id: ledger.id,
        debit_amount: "10",
        company_id: stranger.id,
      });
      expect(line.company_id).toBe(voucher.company_id);

      await client.query("UPDATE voucher_entries SET company_id = $1 WHERE id = $2", [stranger.id, line.id]);
      expect((await reread(client, "voucher_entries", line.id)).company_id).toBe(voucher.company_id);
    });
  });

  it("refuses a line whose voucher does not exist", async () => {
    await withRollback(async (client) => {
      await expectRefused(
        client,
        "INSERT INTO voucher_entries (voucher_id, debit_amount) VALUES (2147480000, 10)",
        [],
        {
          message: "Voucher 2147480000 not found",
        }
      );
    });
  });

  it("moves the lines with the voucher, and refuses the move when a line's account stays behind", async () => {
    await withRollback(async (client) => {
      const { voucher, debit } = await seedBalancedVoucher(client);
      const destination = await seedRow(client, "companies");
      const move = "UPDATE vouchers SET company_id = $1 WHERE id = $2";

      await expectRefused(client, move, [destination.id, voucher.id], {
        code: CHECK_VIOLATION,
        message: "LEDGER_ACCOUNT_COMPANY_MISMATCH",
      });

      await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");
      await client.query(move, [destination.id, voucher.id]);
      expect((await reread(client, "voucher_entries", debit.id)).company_id).toBe(destination.id);
    });
  });
});

describe("voucher line amounts are normalised to base currency by the database", () => {
  async function voucherIn(client: PoolClient, currency: string, rate: string | null) {
    const voucher = await seedVoucher(client, { currency, exchange_rate: rate });
    const ledger = await seedLedger(client, voucher.company_id);
    return { voucher, ledger };
  }

  it("fills the dual-currency fields of a USD line", async () => {
    await withRollback(async (client) => {
      const { voucher, ledger } = await voucherIn(client, "USD", "1");

      const line = await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "125.5" });

      expect(line).toMatchObject({ transaction_currency: "USD", rate_convention: "IDENTITY" });
      expect(Number(line.transaction_debit_amount)).toBe(125.5);
      expect(Number(line.base_debit_amount)).toBe(125.5);
      expect(Number(line.base_credit_amount)).toBe(0);
      expect(Number(line.historical_exchange_rate)).toBe(1);
    });
  });

  it.each(["CFA", "XOF", "cfa"])(
    "converts a %s line to USD at the voucher's rate and keeps the original",
    async (currency) => {
      await withRollback(async (client) => {
        const { voucher, ledger } = await voucherIn(client, currency, "600");

        const line = await addLine(client, voucher, { ledger_account_id: ledger.id, credit_amount: "6000" });

        expect(line).toMatchObject({ transaction_currency: "CFA", rate_convention: "TRANSACTION_PER_BASE" });
        expect(Number(line.transaction_credit_amount)).toBe(6000);
        expect(Number(line.credit_amount)).toBe(10);
        expect(Number(line.base_credit_amount)).toBe(10);
        expect(Number(line.historical_exchange_rate)).toBe(600);
      });
    }
  );

  it("reads a later amount edit as the original currency and keeps the line's own historical rate", async () => {
    await withRollback(async (client) => {
      const { voucher, ledger } = await voucherIn(client, "CFA", "600");
      const line = await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "6000" });
      // The voucher's rate moves later; the line was booked at 600.
      await client.query("UPDATE vouchers SET exchange_rate = 650 WHERE id = $1", [voucher.id]);

      await client.query("UPDATE voucher_entries SET debit_amount = 12000 WHERE id = $1", [line.id]);

      const after = await reread(client, "voucher_entries", line.id);
      expect(Number(after.transaction_debit_amount)).toBe(12000);
      expect(Number(after.debit_amount)).toBe(20);
      expect(Number(after.historical_exchange_rate)).toBe(600);
    });
  });

  it("refuses a CFA line when the voucher has no usable rate", async () => {
    await withRollback(async (client) => {
      for (const rate of [null, "0"]) {
        const { voucher, ledger } = await voucherIn(client, "CFA", rate);
        await expectRefused(
          client,
          "INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount) VALUES ($1, $2, 6000)",
          [voucher.id, ledger.id],
          { message: "requires a positive historical exchange rate" }
        );
      }
    });
  });

  it("refuses negative, two-sided and empty lines", async () => {
    await withRollback(async (client) => {
      const { voucher, ledger } = await voucherIn(client, "USD", "1");
      const insert = `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
                      VALUES ($1, $2, $3, $4)`;

      await expectRefused(client, insert, [voucher.id, ledger.id, "-5", "0"], { message: "cannot be negative" });
      await expectRefused(client, insert, [voucher.id, ledger.id, "5", "5"], {
        message: "cannot contain both a debit and a credit amount",
      });
      await expectRefused(client, insert, [voucher.id, ledger.id, "0", "0"], {
        message: "must contain a debit or credit amount",
      });
      await expectRefused(client, insert, [voucher.id, ledger.id, null, null], {
        message: "must contain a debit or credit amount",
      });
    });
  });

  it("never guesses a rate for another currency: the writer must supply the original amounts", async () => {
    await withRollback(async (client) => {
      const { voucher, ledger } = await voucherIn(client, "EUR", "1.1");

      await expectRefused(
        client,
        "INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount) VALUES ($1, $2, 100)",
        [voucher.id, ledger.id],
        { code: CHECK_VIOLATION, message: "VOUCHER_LINE_NATIVE_AMOUNT_REQUIRED: a EUR voucher line" }
      );

      const line = await addLine(client, voucher, {
        ledger_account_id: ledger.id,
        transaction_currency: "eur",
        transaction_debit_amount: "100",
        transaction_credit_amount: "0",
        base_debit_amount: "110",
        base_credit_amount: "0",
        historical_exchange_rate: "1.1",
        rate_convention: "BASE_PER_TRANSACTION",
      });
      expect(line.transaction_currency).toBe("EUR");
      expect(Number(line.debit_amount)).toBe(110);
    });
  });

  it("refuses base amounts that contradict the original amount and its rate", async () => {
    await withRollback(async (client) => {
      const { voucher, ledger } = await voucherIn(client, "EUR", "1.1");
      const insert = `INSERT INTO voucher_entries
          (voucher_id, ledger_account_id, transaction_currency, transaction_debit_amount, transaction_credit_amount,
           base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
        VALUES ($1, $2, 'EUR', 100, 0, $3, 0, $4, $5)`;

      await expectRefused(client, insert, [voucher.id, ledger.id, "150", "1.1", "BASE_PER_TRANSACTION"], {
        message: "do not match the historical rate and convention",
      });
      await expectRefused(client, insert, [voucher.id, ledger.id, "110", "0", "BASE_PER_TRANSACTION"], {
        message: "requires a positive historical rate",
      });
      await expectRefused(client, insert, [voucher.id, ledger.id, "110", "1.1", "SOMETHING_ELSE"], {
        message: "Unknown voucher-entry rate convention",
      });
    });
  });
});

describe("voucher markers and actor stamps cannot be forged", () => {
  const insertVoucher = (extraColumns: string[]) =>
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount${extraColumns
      .map((column) => `, ${column}`)
      .join("")})
     VALUES ($1, $2, 'Journal', '2026-03-10', 0${extraColumns.map((_, index) => `, $${index + 3}`).join("")})
     RETURNING *`;

  it("never lets a new voucher be born as exempt history, and never lets the marker change", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");

      const [created] = await expectAccepted(client, insertVoucher(["balance_guard_exempt_history"]), [
        company.id,
        "GUARD-MARKER-1",
        true,
      ]);
      expect(created.balance_guard_exempt_history).toBe(false);

      await expectRefused(
        client,
        "UPDATE vouchers SET balance_guard_exempt_history = true WHERE id = $1",
        [created.id],
        {
          code: CHECK_VIOLATION,
          message: "history marker is set once",
        }
      );
    });
  });

  it("lets a voucher be marked as posted by the engine but never unmarked", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);

      await expectAccepted(client, "UPDATE vouchers SET posted_by_engine = true WHERE id = $1 RETURNING id", [
        voucher.id,
      ]);
      await expectRefused(client, "UPDATE vouchers SET posted_by_engine = false WHERE id = $1", [voucher.id], {
        code: CHECK_VIOLATION,
        message: "that marker cannot be cleared",
      });
    });
  });

  it("stamps the creator from the session, not from what the writer sends", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const columns = ["created_by", "updated_by", "deleted_by", "original_voucher_number"];
      const forged = ["someone.else", "someone.else", "someone.else", "FORGED-1"];

      const [anonymous] = await expectAccepted(client, insertVoucher(columns), [
        company.id,
        "GUARD-ACTOR-1",
        ...forged,
      ]);
      // With no session actor the supplied creator is all there is, so it is kept.
      expect(anonymous).toMatchObject({
        created_by: "someone.else",
        updated_by: null,
        deleted_by: null,
        original_voucher_number: null,
      });

      await client.query("SELECT set_config('app.current_actor', 'real.user', true)");
      const [stamped] = await expectAccepted(client, insertVoucher(columns), [company.id, "GUARD-ACTOR-2", ...forged]);
      expect(stamped).toMatchObject({ created_by: "real.user", updated_by: null, deleted_by: null });
    });
  });

  it("records who changed, deleted and restored a voucher, and keeps the creator fixed", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client, { created_by: "creator" });

      await client.query("SELECT set_config('app.current_actor', 'editor', true)");
      await client.query("UPDATE vouchers SET description = 'edited', created_by = 'forger' WHERE id = $1", [
        voucher.id,
      ]);
      expect(await reread(client, "vouchers", voucher.id)).toMatchObject({
        created_by: "creator",
        updated_by: "editor",
      });

      await client.query("SELECT set_config('app.current_actor', 'remover', true)");
      await client.query("UPDATE vouchers SET deleted_at = now(), deleted_by = 'forger' WHERE id = $1", [voucher.id]);
      expect((await reread(client, "vouchers", voucher.id)).deleted_by).toBe("remover");

      await client.query("SELECT set_config('app.current_actor', 'restorer', true)");
      await client.query("UPDATE vouchers SET deleted_at = NULL WHERE id = $1", [voucher.id]);
      expect(await reread(client, "vouchers", voucher.id)).toMatchObject({ deleted_by: null, updated_by: "restorer" });
    });
  });

  it("does not record an editor for an update that changes nothing", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client, { description: "same" });
      await client.query("SELECT set_config('app.current_actor', 'editor', true)");

      await client.query("UPDATE vouchers SET description = 'same' WHERE id = $1", [voucher.id]);

      expect((await reread(client, "vouchers", voucher.id)).updated_by).toBeNull();
    });
  });

  it("remembers the number a voucher had before it was renamed for deletion", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const original = String(voucher.voucher_number);

      await client.query("UPDATE vouchers SET voucher_number = $1 WHERE id = $2", [`${original}~DEL1`, voucher.id]);
      expect((await reread(client, "vouchers", voucher.id)).original_voucher_number).toBe(original);

      await client.query("UPDATE vouchers SET original_voucher_number = 'FORGED' WHERE id = $1", [voucher.id]);
      expect((await reread(client, "vouchers", voucher.id)).original_voucher_number).toBe(original);
    });
  });
});

describe("every voucher and line write is copied to the audit log by the database", () => {
  const auditOf = async (client: PoolClient, table: string, id: unknown) => {
    const { rows } = await client.query(
      `SELECT action, user_id, username, company_id, record_identifier, changes
         FROM audit_log WHERE table_name = $1 AND record_id = $2 ORDER BY id`,
      [table, id]
    );
    return rows;
  };

  it("records the insert, a real update and the delete of a voucher, with the actor", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      await client.query("SELECT set_config('app.current_actor', 'clerk-7', true)");
      await client.query("SELECT set_config('app.current_actor_name', 'Clerk Seven', true)");

      const { rows } = await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, 'GUARD-AUDIT-1', 'Journal', '2026-03-10', 0) RETURNING id`,
        [company.id]
      );
      const id = rows[0].id;
      await client.query("UPDATE vouchers SET description = 'changed' WHERE id = $1", [id]);
      await client.query("DELETE FROM vouchers WHERE id = $1", [id]);

      const audit = await auditOf(client, "vouchers", id);
      expect(audit.map((entry) => entry.action)).toEqual(["row_insert", "row_update", "row_delete"]);
      for (const entry of audit) {
        expect(entry).toMatchObject({
          user_id: "clerk-7",
          username: "Clerk Seven",
          company_id: company.id,
          record_identifier: "GUARD-AUDIT-1",
        });
        expect(entry.changes.source).toBe("db_trigger");
      }
      expect(audit[1].changes.row.old.description).toBeNull();
      expect(audit[1].changes.row.new.description).toBe("changed");
      expect(audit[2].changes.row.old.voucher_number).toBe("GUARD-AUDIT-1");
    });
  });

  it("records line writes under their voucher, and nothing for an update that changes nothing", async () => {
    await withRollback(async (client) => {
      const voucher = await seedVoucher(client);
      const ledger = await seedLedger(client, voucher.company_id);

      const line = await addLine(client, voucher, { ledger_account_id: ledger.id, debit_amount: "10" });
      await client.query("UPDATE voucher_entries SET narration = narration WHERE id = $1", [line.id]);
      await client.query("UPDATE voucher_entries SET narration = 'explained' WHERE id = $1", [line.id]);
      await client.query("DELETE FROM voucher_entries WHERE id = $1", [line.id]);

      const audit = await auditOf(client, "voucher_entries", line.id);
      expect(audit.map((entry) => entry.action)).toEqual(["row_insert", "row_update", "row_delete"]);
      expect(audit.map((entry) => entry.record_identifier)).toEqual(Array(3).fill(`voucher:${voucher.id}`));
      expect(audit.map((entry) => entry.user_id)).toEqual(Array(3).fill("unknown"));
      expect(audit[1].changes.row.new.narration).toBe("explained");
    });
  });
});
