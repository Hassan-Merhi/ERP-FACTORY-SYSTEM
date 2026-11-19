/**
 * Check constraints: what a row may contain, enforced by the database.
 *
 * Two kinds of test live here.
 *
 * The inventory pins every check constraint on a table it knows, with its exact
 * definition, against config/database-check-constraints.json. Dropping or
 * loosening one fails with its name, and so does quietly adding one alongside
 * an existing table's rules; constraints that are NOT VALID (old rows were never
 * checked) are listed separately so the list can only shrink. Tables the
 * inventory does not know yet are left to their own feature's tests, and tables
 * created later by a lazy installer are skipped when absent.
 *
 *     UPDATE_DB_CHECK_INVENTORY=1 npm run test:backend -- db-guards-check-constraints
 *
 * The attacks then write a row that breaks each money- and status-related
 * constraint, with triggers off so only the constraint can refuse, and check
 * the refusal names that constraint. Each table's valid row is inserted first,
 * so the refusal is caused by the one value that changed.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { seedRow, withRollback } from "./helpers/dbGuardHarness";

type Row = Record<string, unknown>;

interface Inventory {
  description: string;
  constraints: Record<string, string>;
  notValidated: string[];
}

const INVENTORY_PATH = path.join(process.cwd(), "config/database-check-constraints.json");
/** Created by the offline-sync DBA installer, not by the application; covered by the offline-sync suite. */
const EXCLUDED_TABLE = /^factory_edge_/;

async function catalogConstraints() {
  return withRollback(async (client) => {
    const { rows } = await client.query(
      `SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition,
              c.convalidated AS validated
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'c' AND t.relnamespace = 'public'::regnamespace AND t.relkind IN ('r', 'p')
        ORDER BY t.relname, c.conname`
    );
    return rows
      .filter((row) => !EXCLUDED_TABLE.test(row.table_name))
      .map((row) => ({
        key: `${row.table_name}.${row.name}`,
        table: String(row.table_name),
        definition: String(row.definition),
        validated: Boolean(row.validated),
      }));
  });
}

if (process.env.UPDATE_DB_CHECK_INVENTORY === "1") {
  it("regenerates the check constraint inventory", async () => {
    const existing = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
    const catalog = await catalogConstraints();
    const inventory: Inventory = {
      description: existing.description,
      constraints: Object.fromEntries(catalog.map((entry) => [entry.key, entry.definition])),
      notValidated: catalog.filter((entry) => !entry.validated).map((entry) => entry.key),
    };
    fs.writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`);
  });
}

describe("the check constraint inventory", () => {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
  const inventoriedTables = new Set(Object.keys(inventory.constraints).map((key) => key.split(".")[0]));

  it("still holds every recorded constraint, unchanged, on every table that exists", async () => {
    const catalog = await catalogConstraints();
    const present = new Map(catalog.map((entry) => [entry.key, entry.definition]));
    const presentTables = new Set(catalog.map((entry) => entry.table));
    const { rows } = await withRollback((client) =>
      client.query("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')")
    );
    const existingTables = new Set(rows.map((row) => String(row.relname)));

    const problems: string[] = [];
    for (const [key, definition] of Object.entries(inventory.constraints)) {
      const table = key.split(".")[0];
      if (!existingTables.has(table)) continue;
      const actual = present.get(key);
      if (actual === undefined) problems.push(`missing: ${key}`);
      else if (actual !== definition) problems.push(`changed: ${key}\n    was ${definition}\n    now ${actual}`);
    }
    for (const entry of catalog) {
      if (inventoriedTables.has(entry.table) && !(entry.key in inventory.constraints)) {
        problems.push(`unrecorded: ${entry.key} ${entry.definition}`);
      }
    }

    expect(presentTables.size, "the catalog query returned no constraints at all").toBeGreaterThan(0);
    expect(problems, "Regenerate with UPDATE_DB_CHECK_INVENTORY=1 only for a reviewed change").toEqual([]);
  });

  it("lets the list of constraints that skipped old rows only shrink", async () => {
    const catalog = await catalogConstraints();
    const unvalidated = catalog.filter((entry) => !entry.validated).map((entry) => entry.key);
    const recorded = new Set(inventory.notValidated);

    expect(
      unvalidated.filter((key) => !recorded.has(key)),
      "A new constraint was added NOT VALID: validate it, or record why old rows cannot be checked"
    ).toEqual([]);
    const nowValidated = inventory.notValidated.filter((key) =>
      catalog.some((entry) => entry.key === key && entry.validated)
    );
    expect(nowValidated, "These are validated now: remove them from notValidated").toEqual([]);
  });
});

interface Attack {
  table: string;
  /** A row the table accepts. */
  valid: Row;
  /** Each breaks exactly one constraint, named first. */
  breaks: Array<[constraint: string, change: Row]>;
}

const ATTACKS: Attack[] = [
  {
    table: "voucher_entries",
    valid: { debit_amount: "10", credit_amount: "0" },
    breaks: [
      ["voucher_entries_amounts_non_negative", { debit_amount: "-10" }],
      ["voucher_entries_single_side", { credit_amount: "10" }],
    ],
  },
  {
    table: "canonical_stock_movements",
    valid: { quantity_delta: "5", unit_cost: "2" },
    breaks: [
      ["canonical_stock_movements_quantity_nonzero", { quantity_delta: "0" }],
      ["canonical_stock_movements_unit_cost_nonnegative", { unit_cost: "-2" }],
    ],
  },
  {
    table: "cost_center_allocations",
    valid: {
      voucher_entry_id: 1,
      factory_daybook_entry_id: null,
      amount_native: "10",
      amount_base: "10",
      currency: "USD",
      base_currency: "USD",
      cost_treatment: "EXPENSE",
      allocation_origin: "MANUAL",
    },
    breaks: [
      ["cost_center_allocations_one_source_check", { factory_daybook_entry_id: 1 }],
      ["cost_center_allocations_native_positive_check", { amount_native: "0" }],
      ["cost_center_allocations_base_nonnegative_check", { amount_base: "-1" }],
      ["cost_center_allocations_treatment_check", { cost_treatment: "GUESS" }],
    ],
  },
  {
    table: "accounting_open_item_matches",
    valid: { domain: "customer", party_id: 7, amount: "25", charge_entry_id: 1, settlement_entry_id: 2 },
    breaks: [
      ["accounting_open_item_matches_amount_check", { amount: "0" }],
      ["accounting_open_item_matches_distinct_entries", { settlement_entry_id: 1 }],
      ["accounting_open_item_matches_domain_check", { domain: "employee" }],
      ["accounting_open_item_matches_party_id_check", { party_id: 0 }],
      ["accounting_open_item_matches_void_consistent", { voided_at: "2026-03-01T00:00:00Z" }],
    ],
  },
  {
    table: "customer_destination_price_lists",
    valid: { destination: "Port A", price_per_bale: "40" },
    breaks: [
      ["customer_destination_price_lists_price_per_bale_check", { price_per_bale: "0" }],
      ["cdpl_destination_not_blank", { destination: "   " }],
    ],
  },
  {
    table: "factory_dispatch_trip_charges",
    valid: { kind: "BILLABLE", amount: "15", revision: 1 },
    breaks: [
      ["factory_dispatch_trip_charges_amount_ck", { amount: "-1" }],
      ["factory_dispatch_trip_charges_kind_ck", { kind: "OTHER" }],
      ["factory_dispatch_trip_charges_revision_ck", { revision: 0 }],
    ],
  },
  {
    table: "factory_dispatch_trip_financials",
    valid: {
      status: "DRAFT",
      snapshot_revision: 0,
      posting_revision: 0,
      goods_subtotal: "100",
      billable_charges_total: "20",
      discount_total: "5",
      customer_total: "115",
    },
    breaks: [
      ["factory_dispatch_trip_financials_total_math_ck", { customer_total: "120" }],
      // An unknown status breaks the posted-source rule as well, so it carries what a posted trip needs.
      [
        "factory_dispatch_trip_financials_status_ck",
        {
          status: "PAID",
          closure_history_id: 1,
          snapshot_revision: 1,
          posting_revision: 1,
          source_fingerprint: "s",
          manifest_fingerprint: "m",
          posted_at: "2026-03-01T00:00:00Z",
        },
      ],
      ["factory_dispatch_trip_financials_posted_source_ck", { status: "POSTED" }],
      ["factory_dispatch_trip_financials_revision_ck", { snapshot_revision: -1 }],
    ],
  },
  {
    table: "factory_target_bonus_payments",
    valid: { status: "POSTED", currency_code: "USD", bonus_amount: "30", reversal_voucher_id: null, reversed_at: null },
    breaks: [
      ["factory_target_bonus_payments_bonus_amount_check", { bonus_amount: "0" }],
      ["factory_target_bonus_payments_currency_code_check", { currency_code: "EUR" }],
      ["factory_target_bonus_payments_reversal_consistency", { status: "REVERSED" }],
    ],
  },
  {
    table: "erp_supplier_return_allocation_rows",
    valid: { input_row: 2, requested_quantity: "3", allocated_quantity: "3" },
    breaks: [
      ["erp_supplier_return_allocation_rows_allocated_quantity_check", { allocated_quantity: "0" }],
      ["erp_supplier_return_allocation_rows_requested_quantity_check", { requested_quantity: "0" }],
      ["erp_supplier_return_allocation_rows_input_row_check", { input_row: 1 }],
    ],
  },
  {
    table: "sp_profit_manual_corrections",
    valid: { period_month: "2026-03", reason: "Late supplier credit note" },
    breaks: [
      ["sp_manual_profit_period", { period_month: "2026-13" }],
      ["sp_manual_profit_reason", { reason: "typo" }],
    ],
  },
];

describe.each(ATTACKS)("check constraints on $table", ({ table, valid, breaks }) => {
  it.each(breaks)("%s refuses the row that breaks it", async (constraint, change) => {
    await withRollback(async (client) => {
      const exists = await client.query("SELECT to_regclass($1) AS oid", [table]);
      expect(exists.rows[0].oid, `${table} does not exist in this database`).not.toBeNull();

      await seedRow(client, table, valid);

      await expect(seedRow(client, table, { ...valid, ...change })).rejects.toThrow(
        `violates check constraint "${constraint}"`
      );
    });
  });
});
