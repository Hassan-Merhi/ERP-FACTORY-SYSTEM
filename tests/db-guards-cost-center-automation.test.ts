/**
 * Automatic cost-centre allocation and its follow-up when a source changes,
 * exercised in SQL.
 *
 * When a voucher line or a Factory daybook expense is committed, database
 * triggers split it across cost centres by the company's rules. When the
 * source later changes, its splits are cleared and recomputed, and anything a
 * person allocated by hand that had to go is reported for review. None of this
 * raises an error, so a broken trigger shows only as missing or stale splits.
 * Each test commits the write (the triggers wait for commit) and reads what the
 * database recorded.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { expectCommittable, insertRow, seedRow, withRollback } from "./helpers/dbGuardHarness";
import { addLine, seedLedger, seedVoucher } from "./helpers/ledgerGuardFixtures";

type Row = Record<string, unknown>;

let sequence = 0;

async function setUp(client: PoolClient) {
  // The voucher balance and line-owner guards are tested elsewhere; one-sided lines keep these tests short.
  await client.query("SELECT set_config('app.ledger_integrity_bypass', 'on', true)");
  const company = await seedRow(client, "companies");
  const centre = (values: Row = {}) =>
    seedRow(client, "cost_centers", {
      company_id: company.id,
      code: `AUTO-${process.pid}-${(sequence += 1)}`,
      active: true,
      ...values,
    });
  const expense = await seedLedger(client, company.id, { account_type: "Expense" });
  return { company, centre, expense };
}

async function voucherRule(client: PoolClient, company: Row, centre: Row, account: Row, values: Row = {}) {
  return insertRow(client, "cost_center_auto_rules", {
    company_id: company.id,
    source_kind: "VOUCHER_ENTRY",
    ledger_account_id: account.id,
    cost_center_id: centre.id,
    allocation_percent: "100",
    active: true,
    ...values,
  });
}

async function splitsOf(client: PoolClient, column: string, sourceId: unknown) {
  const { rows } = await client.query(
    `SELECT cost_center_id, amount_native::numeric AS native, amount_base::numeric AS base,
            allocation_origin, auto_rule_id, historical_rate::numeric AS rate
       FROM cost_center_allocations WHERE "${column}" = $1 ORDER BY id`,
    [sourceId]
  );
  return rows.map((row) => ({
    centre: row.cost_center_id,
    native: Number(row.native),
    base: Number(row.base),
    origin: row.allocation_origin,
    rule: row.auto_rule_id === null ? null : Number(row.auto_rule_id),
    rate: row.rate === null ? null : Number(row.rate),
  }));
}

async function reviewNotes(client: PoolClient, companyId: unknown, sourceKind: string, sourceId: unknown) {
  const { rows } = await client.query(
    `SELECT last_error FROM cost_center_auto_failures
      WHERE company_id = $1 AND source_kind = $2 AND source_id = $3`,
    [companyId, sourceKind, sourceId]
  );
  return rows.map((row) => String(row.last_error));
}

describe("automatic allocation of voucher lines", () => {
  it("splits a committed expense line across cost centres by the company's rules", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const first = await centre();
      const second = await centre();
      const sixty = await voucherRule(client, company, first, expense, { allocation_percent: "60" });
      const forty = await voucherRule(client, company, second, expense, { allocation_percent: "40" });
      const voucher = await seedVoucher(client, { company_id: company.id });

      const line = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "250" });
      expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([]);
      await expectCommittable(client);

      expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([
        { centre: first.id, native: 150, base: 150, origin: "AUTO", rule: Number(sixty.id), rate: 1 },
        { centre: second.id, native: 100, base: 100, origin: "AUTO", rule: Number(forty.id), rate: 1 },
      ]);
    });
  });

  it("prefers rules for the voucher's own module over the general ones", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const general = await centre();
      const payroll = await centre();
      await voucherRule(client, company, general, expense);
      await voucherRule(client, company, payroll, expense, { source_module: "payroll" });
      const payrollVoucher = await seedVoucher(client, { company_id: company.id, source_module: "payroll" });
      const otherVoucher = await seedVoucher(client, { company_id: company.id, source_module: "pos" });

      const payrollLine = await addLine(client, payrollVoucher, { ledger_account_id: expense.id, debit_amount: "80" });
      const otherLine = await addLine(client, otherVoucher, { ledger_account_id: expense.id, debit_amount: "80" });
      await expectCommittable(client);

      expect((await splitsOf(client, "voucher_entry_id", payrollLine.id)).map((split) => split.centre)).toEqual([
        payroll.id,
      ]);
      expect((await splitsOf(client, "voucher_entry_id", otherLine.id)).map((split) => split.centre)).toEqual([
        general.id,
      ]);
    });
  });

  it("leaves credits, non-expense lines, archived centres and inactive rules alone", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const active = await centre();
      const archived = await centre({ active: false });
      const otherExpense = await seedLedger(client, company.id, { account_type: "Expense" });
      const asset = await seedLedger(client, company.id, { account_type: "Asset" });
      await voucherRule(client, company, active, expense);
      await voucherRule(client, company, archived, otherExpense, { active: false });
      await seedRow(client, "cost_center_auto_rules", {
        company_id: company.id,
        source_kind: "VOUCHER_ENTRY",
        ledger_account_id: asset.id,
        cost_center_id: active.id,
        allocation_percent: "100",
        active: true,
      });
      const voucher = await seedVoucher(client, { company_id: company.id });

      const credit = await addLine(client, voucher, { ledger_account_id: expense.id, credit_amount: "40" });
      const unruled = await addLine(client, voucher, { ledger_account_id: otherExpense.id, debit_amount: "40" });
      const onAsset = await addLine(client, voucher, { ledger_account_id: asset.id, debit_amount: "40" });
      await expectCommittable(client);

      for (const line of [credit, unruled, onAsset]) {
        expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([]);
      }
    });
  });

  it("waits for a draft voucher to be posted, then allocates its lines", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const target = await centre();
      await voucherRule(client, company, target, expense);
      const draft = await seedVoucher(client, { company_id: company.id, optional: true });
      const line = await addLine(client, draft, { ledger_account_id: expense.id, debit_amount: "60" });
      await expectCommittable(client);
      expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([]);

      await client.query("UPDATE vouchers SET optional = false WHERE id = $1", [draft.id]);
      await expectCommittable(client);

      expect((await splitsOf(client, "voucher_entry_id", line.id)).map((split) => split.native)).toEqual([60]);
    });
  });

  it("never overrides a split someone made by hand, or a decision to leave a line unallocated", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const automatic = await centre();
      const chosen = await centre();
      await voucherRule(client, company, automatic, expense);
      const voucher = await seedVoucher(client, { company_id: company.id });
      // The automatic split runs at commit, so a person's choice made in the same transaction comes first.
      const manual = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "50" });
      const declined = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "50" });
      await insertRow(client, "cost_center_allocations", {
        company_id: company.id,
        cost_center_id: chosen.id,
        voucher_entry_id: manual.id,
        amount_native: "30",
        currency: "USD",
        amount_base: "30",
        base_currency: "USD",
        cost_treatment: "EXPENSE",
        allocation_origin: "MANUAL",
      });
      await insertRow(client, "cost_center_source_overrides", {
        company_id: company.id,
        voucher_entry_id: declined.id,
        reason: "Shared overhead, not allocated",
      });

      await expectCommittable(client);

      expect(
        (await splitsOf(client, "voucher_entry_id", manual.id)).map((split) => [split.centre, split.origin])
      ).toEqual([[chosen.id, "MANUAL"]]);
      expect(await splitsOf(client, "voucher_entry_id", declined.id)).toEqual([]);
    });
  });
});

describe("automatic allocation of Factory daybook expenses", () => {
  async function daybook(client: PoolClient, company: Row, values: Row = {}) {
    return insertRow(client, "factory_daybook_entries", {
      company_id: company.id,
      tx_date: "2026-03-10",
      tx_type: "EXPENSE",
      description: "Generator fuel",
      currency_code: "USD",
      amount_currency: "120",
      fx_rate_to_usd: "1",
      amount_usd: "120",
      reference_table: null,
      reference_id: null,
      ...values,
    });
  }

  it("splits a standalone expense, and never one that mirrors a voucher or payment", async () => {
    await withRollback(async (client) => {
      const { company, centre } = await setUp(client);
      const target = await centre();
      await insertRow(client, "cost_center_auto_rules", {
        company_id: company.id,
        source_kind: "FACTORY_DAYBOOK",
        factory_tx_type: "EXPENSE",
        cost_center_id: target.id,
        allocation_percent: "100",
        active: true,
      });

      const standalone = await daybook(client, company);
      const mirror = await daybook(client, company, { reference_table: "vouchers", reference_id: 1 });
      await expectCommittable(client);

      expect(await splitsOf(client, "factory_daybook_entry_id", standalone.id)).toEqual([
        { centre: target.id, native: 120, base: 120, origin: "AUTO", rule: expect.any(Number), rate: 1 },
      ]);
      expect(await splitsOf(client, "factory_daybook_entry_id", mirror.id)).toEqual([]);
    });
  });

  it("recomputes the split when the amount changes, and only restamps the rate when the rate changes", async () => {
    await withRollback(async (client) => {
      const { company, centre } = await setUp(client);
      const target = await centre();
      await insertRow(client, "cost_center_auto_rules", {
        company_id: company.id,
        source_kind: "FACTORY_DAYBOOK",
        factory_tx_type: "EXPENSE",
        cost_center_id: target.id,
        allocation_percent: "100",
        active: true,
      });
      const entry = await daybook(client, company);
      await expectCommittable(client);

      await client.query("UPDATE factory_daybook_entries SET amount_currency = 90, amount_usd = 90 WHERE id = $1", [
        entry.id,
      ]);
      expect((await splitsOf(client, "factory_daybook_entry_id", entry.id)).map((split) => split.native)).toEqual([90]);

      await client.query("UPDATE factory_daybook_entries SET fx_rate_to_usd = 1.05 WHERE id = $1", [entry.id]);
      expect(await splitsOf(client, "factory_daybook_entry_id", entry.id)).toEqual([
        { centre: target.id, native: 90, base: 90, origin: "AUTO", rule: expect.any(Number), rate: 1.05 },
      ]);
    });
  });
});

describe("splits follow their source when it changes", () => {
  async function manualSplit(client: PoolClient, company: Row, centre: Row, line: Row, amount: string) {
    return insertRow(client, "cost_center_allocations", {
      company_id: company.id,
      cost_center_id: centre.id,
      voucher_entry_id: line.id,
      amount_native: amount,
      currency: "USD",
      amount_base: amount,
      base_currency: "USD",
      cost_treatment: "EXPENSE",
      allocation_origin: "MANUAL",
    });
  }

  it("clears a hand-made split when the line's amount changes, and reports it for review", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const target = await centre();
      const voucher = await seedVoucher(client, { company_id: company.id });
      const line = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "100" });
      await manualSplit(client, company, target, line, "100");

      await client.query("UPDATE voucher_entries SET debit_amount = 70 WHERE id = $1", [line.id]);

      expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([]);
      const notes = await reviewNotes(client, company.id, "VOUCHER_ENTRY", line.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("amount, currency or source changed after allocation");
      expect(notes[0]).toContain("1 cost center split(s) cleared for review (1 manual)");
    });
  });

  it("re-applies the automatic split to the new amount without asking anyone to review it", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const target = await centre();
      await voucherRule(client, company, target, expense);
      const voucher = await seedVoucher(client, { company_id: company.id });
      const line = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "100" });
      await expectCommittable(client);

      await client.query("UPDATE voucher_entries SET debit_amount = 130 WHERE id = $1", [line.id]);

      expect((await splitsOf(client, "voucher_entry_id", line.id)).map((split) => split.native)).toEqual([130]);
      expect(await reviewNotes(client, company.id, "VOUCHER_ENTRY", line.id)).toEqual([]);
    });
  });

  it("clears the split when the line moves to an account that cannot carry it, and keeps it for another expense account", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const target = await centre();
      const otherExpense = await seedLedger(client, company.id, { account_type: "Indirect Expense" });
      const liability = await seedLedger(client, company.id, { account_type: "Liability" });
      const voucher = await seedVoucher(client, { company_id: company.id });
      const kept = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "40" });
      const moved = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "40" });
      await manualSplit(client, company, target, kept, "40");
      await manualSplit(client, company, target, moved, "40");

      await client.query("UPDATE voucher_entries SET ledger_account_id = $1 WHERE id = $2", [otherExpense.id, kept.id]);
      await client.query("UPDATE voucher_entries SET ledger_account_id = $1 WHERE id = $2", [liability.id, moved.id]);

      expect(await splitsOf(client, "voucher_entry_id", kept.id)).toHaveLength(1);
      expect(await splitsOf(client, "voucher_entry_id", moved.id)).toEqual([]);
      expect((await reviewNotes(client, company.id, "VOUCHER_ENTRY", moved.id))[0]).toContain(
        "moved to an ineligible ledger account"
      );
    });
  });

  it("restamps the historical rate on its splits when only the line's rate is re-expressed", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const target = await centre();
      const voucher = await seedVoucher(client, { company_id: company.id, currency: "EUR", exchange_rate: "2" });
      const line = await addLine(client, voucher, {
        ledger_account_id: expense.id,
        transaction_currency: "EUR",
        transaction_debit_amount: "20",
        transaction_credit_amount: "0",
        base_debit_amount: "40",
        base_credit_amount: "0",
        historical_exchange_rate: "2",
        rate_convention: "BASE_PER_TRANSACTION",
      });
      await insertRow(client, "cost_center_allocations", {
        company_id: company.id,
        cost_center_id: target.id,
        voucher_entry_id: line.id,
        amount_native: "20",
        currency: "EUR",
        amount_base: "40",
        base_currency: "USD",
        historical_rate: "2",
        rate_convention: "BASE_PER_TRANSACTION",
        cost_treatment: "EXPENSE",
        allocation_origin: "MANUAL",
      });

      // 2 USD per EUR, written the other way round: no amount moves.
      await client.query(
        "UPDATE voucher_entries SET historical_exchange_rate = 0.5, rate_convention = 'TRANSACTION_PER_BASE' WHERE id = $1",
        [line.id]
      );

      expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([
        { centre: target.id, native: 20, base: 40, origin: "MANUAL", rule: null, rate: 0.5 },
      ]);
      expect(await reviewNotes(client, company.id, "VOUCHER_ENTRY", line.id)).toEqual([]);
    });
  });

  it("reports hand-made splits that disappear when their line is deleted", async () => {
    await withRollback(async (client) => {
      const { company, centre, expense } = await setUp(client);
      const voucher = await seedVoucher(client, { company_id: company.id });
      const line = await addLine(client, voucher, { ledger_account_id: expense.id, debit_amount: "40" });
      await manualSplit(client, company, await centre(), line, "25");
      await manualSplit(client, company, await centre(), line, "15");

      await client.query("DELETE FROM voucher_entries WHERE id = $1", [line.id]);

      expect(await splitsOf(client, "voucher_entry_id", line.id)).toEqual([]);
      expect(await reviewNotes(client, company.id, "VOUCHER_ENTRY", line.id)).toEqual([
        "Source deleted; 2 manual cost center split(s) were removed with it. Re-assign the replacement entry if needed.",
      ]);
    });
  });
});
