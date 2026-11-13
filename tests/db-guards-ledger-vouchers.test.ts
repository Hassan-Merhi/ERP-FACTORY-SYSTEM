/**
 * What the database itself writes onto vouchers and their lines, checked in SQL.
 *
 * Beyond refusing bad writes (see db-guards-ledger-posting.test.ts), triggers
 * rewrite what a writer sends: line amounts are normalised to base currency,
 * the history and engine markers cannot be forged, the creator and editor come
 * from the session, and every write is copied to the audit log. No application
 * code reads these back as it writes, so each test reads what the database
 * stored.
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
  expectRefused,
  missingTriggers,
  reread,
  seedRow,
  withRollback,
} from "./helpers/dbGuardHarness";
import { addLine, seedLedger, seedVoucher } from "./helpers/ledgerGuardFixtures";

const CHECK_VIOLATION = "23514";

// The history marker trigger is installed with the balance guard, which the
// shared test database does not keep: install it and leave things as found.
let installedHere: Awaited<ReturnType<typeof missingTriggers>> = [];

beforeAll(async () => {
  installedHere = await missingTriggers(VOUCHER_BALANCE_GUARD_TRIGGERS);
  expect(await ensureVoucherBalanceGuard(pool)).toBe(true);
}, 60000);

afterAll(async () => {
  await dropTriggers(installedHere);
}, 60000);

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
