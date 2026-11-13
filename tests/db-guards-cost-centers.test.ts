/**
 * Cost-centre guards, attacked in SQL.
 *
 * Cost centres re-slice money that is already in the ledger, so the database
 * itself holds the rules that keep the slices honest: the tree stays a tree
 * inside one company, an allocation can never exceed or outlive its source
 * line, only real expense and factory stock lines can be allocated, automatic
 * splits never pass 100 percent, and a historical preview is applied once and
 * never edited. Each test performs the forbidden write and reads the refusal,
 * then shows the nearest allowed write still succeeds.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { expectAccepted, expectRefused, insertRow, reread, seedRow, withRollback } from "./helpers/dbGuardHarness";

const RAISED = "P0001";

type Row = Record<string, unknown>;

let sequence = 0;
const nextCode = (prefix: string) => `${prefix}-${process.pid}-${(sequence += 1)}`;

async function seedCentre(client: PoolClient, companyId: unknown, values: Row = {}): Promise<Row> {
  return seedRow(client, "cost_centers", { company_id: companyId, code: nextCode("CC"), active: true, ...values });
}

/** A posted USD voucher with one 100.00 debit line on a ledger account of the given type. */
async function seedSourceLine(
  client: PoolClient,
  companyId: unknown,
  options: { accountType?: string; voucher?: Row; line?: Row; account?: Row } = {}
) {
  const account = await seedRow(client, "ledger_accounts", {
    company_id: companyId,
    account_type: options.accountType ?? "Expense",
    ...options.account,
  });
  const voucher = await seedRow(client, "vouchers", {
    company_id: companyId,
    voucher_number: nextCode("GUARD-CC"),
    voucher_date: "2026-03-10",
    currency: "USD",
    optional: false,
    source_module: null,
    ...options.voucher,
  });
  const line = await seedRow(client, "voucher_entries", {
    voucher_id: voucher.id,
    company_id: companyId,
    ledger_account_id: account.id,
    debit_amount: "100",
    credit_amount: "0",
    transaction_currency: "USD",
    transaction_debit_amount: "100",
    transaction_credit_amount: "0",
    base_debit_amount: "100",
    base_credit_amount: "0",
    ...options.line,
  });
  return { account, voucher, line };
}

const allocation = (company: Row, centre: Row, line: Row, values: Row = {}): Row => ({
  company_id: company.id,
  cost_center_id: centre.id,
  voucher_entry_id: line.id,
  amount_native: "60",
  currency: "USD",
  amount_base: "60",
  base_currency: "USD",
  cost_treatment: "EXPENSE",
  allocation_origin: "MANUAL",
  ...values,
});

/** Attempts an insert that must be refused, with every trigger on. */
async function expectInsertRefused(client: PoolClient, table: string, values: Row, message: string) {
  const names = Object.keys(values);
  await expectRefused(
    client,
    `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
     VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
    names.map((name) => values[name]),
    { code: RAISED, message }
  );
}

describe("the cost-centre tree", () => {
  it("refuses a cycle, however long", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const top = await seedCentre(client, company.id);
      const middle = await seedCentre(client, company.id, { parent_id: top.id });
      const bottom = await seedCentre(client, company.id, { parent_id: middle.id });
      const setParent = "UPDATE cost_centers SET parent_id = $1 WHERE id = $2 RETURNING id";

      await expectRefused(client, setParent, [bottom.id, top.id], {
        code: RAISED,
        message: "Cost center hierarchy cannot contain a cycle",
      });
      await expectRefused(client, setParent, [top.id, top.id], { code: RAISED, message: "cannot contain a cycle" });

      const sibling = await seedCentre(client, company.id);
      await expectAccepted(client, setParent, [sibling.id, bottom.id]);
    });
  });

  it("refuses to move a cost centre to another company", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const other = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);

      await expectRefused(client, "UPDATE cost_centers SET company_id = $1 WHERE id = $2", [other.id, centre.id], {
        code: RAISED,
        message: "Cost centers cannot be moved between companies",
      });
    });
  });

  it("refuses to archive a cost centre that still has active children", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const parent = await seedCentre(client, company.id);
      const child = await seedCentre(client, company.id, { parent_id: parent.id });
      const archive = "UPDATE cost_centers SET active = false WHERE id = $1 RETURNING id";

      await expectRefused(client, archive, [parent.id], {
        code: RAISED,
        message: "Archive active child cost centers first",
      });

      await expectAccepted(client, archive, [child.id]);
      await expectAccepted(client, archive, [parent.id]);
    });
  });
});

describe("cost-centre allocations stay inside their source line", () => {
  it("refuses allocations that together exceed the source amount", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const other = await seedCentre(client, company.id);
      const { line } = await seedSourceLine(client, company.id);
      await insertRow(client, "cost_center_allocations", allocation(company, centre, line));

      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, other, line, { amount_native: "50", amount_base: "50" }),
        "Cost center allocations exceed the source transaction amount"
      );

      // The remaining 40 is the most a second centre may take.
      await insertRow(
        client,
        "cost_center_allocations",
        allocation(company, other, line, { amount_native: "40", amount_base: "40" })
      );
    });
  });

  it("refuses to grow an existing allocation past the source amount", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const { line } = await seedSourceLine(client, company.id);
      const row = await insertRow(client, "cost_center_allocations", allocation(company, centre, line));

      await expectRefused(
        client,
        "UPDATE cost_center_allocations SET amount_native = 101, amount_base = 101 WHERE id = $1",
        [row.id],
        {
          code: RAISED,
          message: "exceed the source transaction amount",
        }
      );
      await expectAccepted(
        client,
        "UPDATE cost_center_allocations SET amount_native = 100, amount_base = 100 WHERE id = $1 RETURNING id",
        [row.id]
      );
    });
  });

  it("refuses a different currency, a non-USD base and a source in another company", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const stranger = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const { line } = await seedSourceLine(client, company.id);
      const foreign = await seedSourceLine(client, stranger.id);

      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, line, { currency: "EUR" }),
        "Cost center allocation currency differs from source currency"
      );
      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, line, { base_currency: "EUR" }),
        "Phase 1 cost center base snapshots must use USD"
      );
      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, foreign.line),
        "Voucher entry is unavailable for cost allocation"
      );
    });
  });

  it("never lets an allocation be pointed at a different source", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const { line } = await seedSourceLine(client, company.id);
      const second = await seedSourceLine(client, company.id);
      const row = await insertRow(client, "cost_center_allocations", allocation(company, centre, line));

      await expectRefused(
        client,
        "UPDATE cost_center_allocations SET voucher_entry_id = $1 WHERE id = $2",
        [second.line.id, row.id],
        {
          code: RAISED,
          message: "Allocation company and source are immutable; reallocate instead",
        }
      );
      expect((await reread(client, "cost_center_allocations", row.id)).voucher_entry_id).toBe(line.id);
    });
  });
});

describe("only real costs can be allocated", () => {
  it("refuses an archived or foreign cost centre", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const archived = await seedCentre(client, company.id, { active: false });
      const { line } = await seedSourceLine(client, company.id);

      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, archived, line),
        "Cannot allocate to missing or archived cost center"
      );
    });
  });

  it.each([
    { name: "an optional voucher", voucher: { optional: true } },
    { name: "a deleted voucher", voucher: { deleted_at: "2026-03-11T00:00:00Z" } },
    { name: "a Golden Coast voucher", voucher: { voucher_number: `GC-GUARD-${process.pid}` } },
    { name: "a migrated voucher", voucher: { voucher_number: `MIG-GUARD-${process.pid}` } },
    { name: "a read-only migration voucher", voucher: { source_module: "SP_MIGRATION_READONLY" } },
    { name: "an intercompany voucher", voucher: { source_module: "intercompany_transfer" } },
  ])("refuses to allocate a line of $name", async ({ voucher }) => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const { line } = await seedSourceLine(client, company.id, { voucher });

      await expectRefused(
        client,
        `INSERT INTO cost_center_allocations
           (company_id, cost_center_id, voucher_entry_id, amount_native, currency, amount_base, base_currency, cost_treatment)
         VALUES ($1, $2, $3, 10, 'USD', 10, 'USD', 'EXPENSE')`,
        [company.id, centre.id, line.id],
        { code: RAISED }
      );
    });
  });

  it("allows expense lines as expense only, and nothing on liability or income lines", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const expense = await seedSourceLine(client, company.id, { accountType: "Indirect Expense" });
      const liability = await seedSourceLine(client, company.id, { accountType: "Liability" });

      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, expense.line, { cost_treatment: "INVENTORY_COST" }),
        "Expense ledger lines must keep EXPENSE cost treatment"
      );
      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, liability.line),
        "Only expense or asset ledger lines may have cost center allocations"
      );
      await insertRow(client, "cost_center_allocations", allocation(company, centre, expense.line));
    });
  });

  it("allows an asset line only when it is a debit to a factory stock account, as inventory cost", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const stock = await seedSourceLine(client, company.id, {
        accountType: "Asset",
        account: { code: "FACTORY_WIP" },
      });
      const otherAsset = await seedSourceLine(client, company.id, { accountType: "Asset" });
      const stockCredit = await seedSourceLine(client, company.id, {
        accountType: "Asset",
        account: { code: "FACTORY_FINISHED_GOODS" },
        line: {
          debit_amount: "0",
          credit_amount: "100",
          transaction_debit_amount: "0",
          transaction_credit_amount: "100",
          base_debit_amount: "0",
          base_credit_amount: "100",
        },
      });
      const refusal = "Only factory inventory stock accounts may receive INVENTORY_COST treatment";
      const inventory = { cost_treatment: "INVENTORY_COST" };

      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, otherAsset.line, inventory),
        refusal
      );
      await expectInsertRefused(
        client,
        "cost_center_allocations",
        allocation(company, centre, stockCredit.line, inventory),
        refusal
      );
      await expectInsertRefused(client, "cost_center_allocations", allocation(company, centre, stock.line), refusal);

      await insertRow(client, "cost_center_allocations", allocation(company, centre, stock.line, inventory));
    });
  });

  it("allows a factory daybook entry only when it is a standalone expense", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const daybook = (values: Row = {}) =>
        seedRow(client, "factory_daybook_entries", {
          company_id: company.id,
          tx_type: "EXPENSE",
          currency_code: "USD",
          amount_currency: "100",
          amount_usd: "100",
          reference_table: null,
          reference_id: null,
          ...values,
        });
      const standalone = await daybook();
      const mirror = await daybook({ reference_table: "vouchers", reference_id: 1 });
      const payment = await daybook({ tx_type: "PAYMENT" });
      const fromDaybook = (entry: Row): Row => {
        const row = allocation(company, centre, { id: null });
        return { ...row, voucher_entry_id: null, factory_daybook_entry_id: entry.id };
      };

      for (const entry of [mirror, payment]) {
        await expectInsertRefused(
          client,
          "cost_center_allocations",
          fromDaybook(entry),
          "Factory daybook source is not a standalone expense"
        );
      }
      await insertRow(client, "cost_center_allocations", fromDaybook(standalone));
    });
  });
});

describe("automatic allocation rules", () => {
  const rule = (company: Row, centre: Row, account: Row, values: Row = {}): Row => ({
    company_id: company.id,
    source_kind: "VOUCHER_ENTRY",
    ledger_account_id: account.id,
    cost_center_id: centre.id,
    allocation_percent: "60",
    active: true,
    ...values,
  });

  it("never lets the active rules for one source split more than 100 percent", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const first = await seedCentre(client, company.id);
      const second = await seedCentre(client, company.id);
      const third = await seedCentre(client, company.id);
      const account = await seedRow(client, "ledger_accounts", { company_id: company.id, account_type: "Expense" });
      const otherAccount = await seedRow(client, "ledger_accounts", {
        company_id: company.id,
        account_type: "Expense",
      });
      await insertRow(client, "cost_center_auto_rules", rule(company, first, account));

      await expectInsertRefused(
        client,
        "cost_center_auto_rules",
        rule(company, second, account, { allocation_percent: "50" }),
        "Automatic cost center split exceeds 100 percent for this source"
      );

      // An inactive rule, a rule for another account, and the exact remainder are all fine.
      await insertRow(
        client,
        "cost_center_auto_rules",
        rule(company, second, account, { allocation_percent: "50", active: false })
      );
      await insertRow(
        client,
        "cost_center_auto_rules",
        rule(company, second, otherAccount, { allocation_percent: "100" })
      );
      await insertRow(client, "cost_center_auto_rules", rule(company, third, account, { allocation_percent: "40" }));
    });
  });

  it("requires an active cost centre and an expense account of the same company", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const stranger = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const archived = await seedCentre(client, company.id, { active: false });
      const expense = await seedRow(client, "ledger_accounts", {
        company_id: company.id,
        account_type: "Direct Expense",
      });
      const asset = await seedRow(client, "ledger_accounts", { company_id: company.id, account_type: "Asset" });
      const foreign = await seedRow(client, "ledger_accounts", { company_id: stranger.id, account_type: "Expense" });
      const accountRefusal = "Automatic voucher rules require an eligible expense account in the same company";

      await expectInsertRefused(
        client,
        "cost_center_auto_rules",
        rule(company, archived, expense),
        "Auto rule requires an active cost center"
      );
      await expectInsertRefused(client, "cost_center_auto_rules", rule(company, centre, asset), accountRefusal);
      await expectInsertRefused(client, "cost_center_auto_rules", rule(company, centre, foreign), accountRefusal);
      await expectInsertRefused(
        client,
        "cost_center_auto_rules",
        rule(company, centre, expense, { source_module: "   " }),
        "Source module must not be blank"
      );

      await insertRow(client, "cost_center_auto_rules", rule(company, centre, expense));
    });
  });
});

describe("budgets, manual overrides and historical previews", () => {
  it("accepts a budget only for an active cost centre, and never lets it change owner", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const centre = await seedCentre(client, company.id);
      const other = await seedCentre(client, company.id);
      const archived = await seedCentre(client, company.id, { active: false });
      const budget = (target: Row): Row => ({
        company_id: company.id,
        cost_center_id: target.id,
        budget_month: "2026-03-01",
        amount_usd: "500",
      });

      await expectInsertRefused(
        client,
        "cost_center_monthly_budgets",
        budget(archived),
        "New or updated budgets require an active cost center"
      );
      const row = await insertRow(client, "cost_center_monthly_budgets", budget(centre));
      await expectRefused(
        client,
        "UPDATE cost_center_monthly_budgets SET cost_center_id = $1 WHERE id = $2",
        [other.id, row.id],
        {
          code: RAISED,
          message: "Budget company and cost center are immutable",
        }
      );
      await expectAccepted(
        client,
        "UPDATE cost_center_monthly_budgets SET amount_usd = 750 WHERE id = $1 RETURNING id",
        [row.id]
      );
    });
  });

  it("ties a manual override to one source of the same company for good", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const stranger = await seedRow(client, "companies");
      const { line } = await seedSourceLine(client, company.id);
      const second = await seedSourceLine(client, company.id);
      const foreign = await seedSourceLine(client, stranger.id);
      const override = (source: Row): Row => ({
        company_id: company.id,
        voucher_entry_id: source.id,
        reason: "Allocated by hand after review",
      });

      await expectInsertRefused(
        client,
        "cost_center_source_overrides",
        override(foreign.line),
        "Manual override must refer to a source in the same company"
      );
      const row = await insertRow(client, "cost_center_source_overrides", override(line));
      await expectRefused(
        client,
        "UPDATE cost_center_source_overrides SET voucher_entry_id = $1 WHERE id = $2",
        [second.line.id, row.id],
        {
          code: RAISED,
          message: "Cannot change the company or source of a manual override",
        }
      );
    });
  });

  it("lets a historical preview be applied once and never edited", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const batch = await seedRow(client, "cost_center_historical_batches", {
        company_id: company.id,
        source_kind: "VOUCHER_ENTRY",
        candidate_count: 3,
        candidate_native_total: "300",
        candidate_usd_total: "300",
        status: "PREVIEW",
      });
      const refusal = {
        code: RAISED,
        message: "Historical allocation preview is immutable and may be applied only once",
      };
      const apply = `UPDATE cost_center_historical_batches
                        SET status = 'APPLIED', applied_by = 'reviewer', applied_at = now()
                      WHERE id = $1 RETURNING id`;

      await expectRefused(
        client,
        "UPDATE cost_center_historical_batches SET candidate_count = 4 WHERE id = $1",
        [batch.id],
        refusal
      );
      await expectRefused(
        client,
        `UPDATE cost_center_historical_batches
            SET status = 'APPLIED', applied_by = 'reviewer', applied_at = now(), candidate_usd_total = 1
          WHERE id = $1`,
        [batch.id],
        refusal
      );

      await expectAccepted(client, apply, [batch.id]);
      await expectRefused(client, apply, [batch.id], refusal);
    });
  });
});
