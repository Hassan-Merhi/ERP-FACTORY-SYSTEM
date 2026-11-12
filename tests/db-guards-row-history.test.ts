/**
 * Factory row history: every insert, material update and delete on the audited
 * Factory, Properties and ledger-account tables must leave a history row.
 *
 * One trigger function (erp_factory_row_history) is attached three times to
 * each of twenty tables. The application never reads its own writes back from
 * factory_row_history, so nothing fails if a table silently loses its
 * triggers; an edit to a container cost or a tenant contract would simply stop
 * being recorded. Each table is exercised here in SQL: the test performs the
 * write and reads the history the database recorded for it.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { seedRow, withRollback } from "./helpers/dbGuardHarness";

interface AuditedTable {
  table: string;
  /** A free-text column whose change is material and breaks no constraint. */
  column: string;
  /** How the company is found when the table has no company_id of its own. */
  companyVia?: { parent: string; foreignKey: string };
}

const AUDITED_TABLES: AuditedTable[] = [
  {
    table: "customer_order_bales",
    column: "bale_name",
    companyVia: { parent: "customer_orders", foreignKey: "order_id" },
  },
  {
    table: "customer_order_charges",
    column: "name",
    companyVia: { parent: "customer_orders", foreignKey: "order_id" },
  },
  { table: "customer_orders", column: "container_notes" },
  { table: "factory_advance_repayments", column: "notes" },
  { table: "factory_bale_products", column: "description" },
  { table: "factory_bales", column: "worker_name" },
  { table: "factory_container_other_charges", column: "description" },
  { table: "factory_container_receipts", column: "created_by" },
  { table: "factory_containers", column: "notes" },
  {
    table: "factory_mix_batch_sources",
    column: "notes",
    companyVia: { parent: "factory_mix_batches", foreignKey: "mix_batch_id" },
  },
  { table: "factory_mix_batches", column: "notes" },
  { table: "factory_payrolls", column: "notes" },
  { table: "factory_raw_stock", column: "commission_person_name" },
  { table: "factory_suppliers", column: "notes" },
  { table: "factory_worker_advances", column: "notes" },
  { table: "ledger_accounts", column: "category" },
  { table: "property_contracts", column: "notes" },
  { table: "property_monthly_ledger", column: "notes" },
  { table: "property_payments", column: "notes" },
  { table: "property_units", column: "notes" },
];

type HistoryRow = {
  op: string;
  actor: string;
  company_id: number | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
};

async function historyOf(client: PoolClient, table: string, id: unknown): Promise<HistoryRow[]> {
  const { rows } = await client.query(
    `SELECT op, actor, company_id, old_values, new_values
       FROM factory_row_history WHERE table_name = $1 AND record_id = $2 ORDER BY id`,
    [table, id]
  );
  return rows;
}

/**
 * Seeds one row of an audited table with `value` in its tracked column. Tables
 * that take their company from a parent get a real parent row: the link is not
 * always a foreign key, so the harness would not create one on its own.
 */
async function seedAudited(client: PoolClient, audited: AuditedTable, value: string) {
  const values: Record<string, unknown> = { [audited.column]: value };
  if (audited.companyVia) {
    const parent = await seedRow(client, audited.companyVia.parent);
    values[audited.companyVia.foreignKey] = parent.id;
  }
  return seedRow(client, audited.table, values);
}

async function expectedCompany(client: PoolClient, audited: AuditedTable, row: Record<string, unknown>) {
  if (!audited.companyVia) return Number(row.company_id);
  const { rows } = await client.query(`SELECT company_id FROM "${audited.companyVia.parent}" WHERE id = $1`, [
    row[audited.companyVia.foreignKey],
  ]);
  return Number(rows[0].company_id);
}

describe("the set of audited tables", () => {
  it("is exactly the tables this suite exercises, each with insert, update and delete triggers", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT c.relname AS table_name,
                bool_or((t.tgtype & 4) > 0) AS on_insert,
                bool_or((t.tgtype & 16) > 0) AS on_update,
                bool_or((t.tgtype & 8) > 0) AS on_delete,
                bool_and(t.tgenabled = 'O') AS enabled
           FROM pg_trigger t
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE p.proname = 'erp_factory_row_history' AND NOT t.tgisinternal
          GROUP BY c.relname ORDER BY c.relname`
      );

      expect(rows.map((row) => row.table_name)).toEqual(AUDITED_TABLES.map((audited) => audited.table).sort());
      for (const row of rows) {
        expect(row, row.table_name).toMatchObject({ on_insert: true, on_update: true, on_delete: true, enabled: true });
      }
    });
  });
});

describe.each(AUDITED_TABLES)("row history for $table", (audited) => {
  const { table, column } = audited;

  it("records a material update with only the changed values, the actor and the company", async () => {
    await withRollback(async (client) => {
      const row = await seedAudited(client, audited, "before");
      await client.query("SELECT set_config('app.current_actor', 'auditor@example.test', true)");

      await client.query(`UPDATE "${table}" SET "${column}" = 'after' WHERE id = $1`, [row.id]);

      const history = await historyOf(client, table, row.id);
      expect(history).toHaveLength(1);
      expect(history[0].op).toBe("U");
      expect(history[0].actor).toBe("auditor@example.test");
      expect(history[0].company_id).toBe(await expectedCompany(client, audited, row));
      expect(history[0].old_values?.[column]).toBe("before");
      expect(history[0].new_values?.[column]).toBe("after");
      // Only what changed is stored, not a second copy of the whole row.
      const stored = Object.keys(history[0].old_values ?? {}).filter((key) => key !== "updated_at");
      expect(stored).toEqual([column]);
      expect(Object.keys(history[0].new_values ?? {}).sort()).toEqual(Object.keys(history[0].old_values ?? {}).sort());
    });
  });

  it("records nothing for an update that changes nothing", async () => {
    await withRollback(async (client) => {
      const row = await seedAudited(client, audited, "same");

      await client.query(`UPDATE "${table}" SET "${column}" = 'same' WHERE id = $1`, [row.id]);

      expect(await historyOf(client, table, row.id)).toEqual([]);
    });
  });

  it("records a delete with the whole row as it was", async () => {
    await withRollback(async (client) => {
      const row = await seedAudited(client, audited, "to be deleted");

      await client.query(`DELETE FROM "${table}" WHERE id = $1`, [row.id]);

      const history = await historyOf(client, table, row.id);
      expect(history).toHaveLength(1);
      expect(history[0].op).toBe("D");
      expect(history[0].new_values).toBeNull();
      expect(history[0].old_values?.[column]).toBe("to be deleted");
      expect(Number(history[0].old_values?.id)).toBe(Number(row.id));
      expect(history[0].company_id).toBe(await expectedCompany(client, audited, row));
    });
  });

  it("names the actor 'unknown' when the session did not identify one", async () => {
    await withRollback(async (client) => {
      const row = await seedAudited(client, audited, "before");

      await client.query(`UPDATE "${table}" SET "${column}" = 'after' WHERE id = $1`, [row.id]);

      const history = await historyOf(client, table, row.id);
      expect(history.map((entry) => entry.actor)).toEqual(["unknown"]);
    });
  });
});

describe("row history details", () => {
  it("records an insert with the whole new row", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      await client.query("SELECT set_config('app.current_actor', 'creator@example.test', true)");

      const { rows } = await client.query(
        `INSERT INTO property_units (company_id, unit_number, unit_type, location_group, notes)
         VALUES ($1, 'U-HISTORY-1', 'SHOP', 'Ground floor', 'created with triggers on') RETURNING id`,
        [company.id]
      );

      const history = await historyOf(client, "property_units", rows[0].id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ op: "I", actor: "creator@example.test", company_id: Number(company.id) });
      expect(history[0].old_values).toBeNull();
      expect(history[0].new_values).toMatchObject({ unit_number: "U-HISTORY-1", notes: "created with triggers on" });
    });
  });

  it("writes one history row per affected row for a multi-row statement", async () => {
    await withRollback(async (client) => {
      const first = await seedRow(client, "property_units", { notes: "a" });
      const second = await seedRow(client, "property_units", { notes: "b" });
      const untouched = await seedRow(client, "property_units", { notes: "c" });

      await client.query("UPDATE property_units SET notes = 'bulk' WHERE id = ANY($1::int[])", [[first.id, second.id]]);

      expect(await historyOf(client, "property_units", first.id)).toHaveLength(1);
      expect(await historyOf(client, "property_units", second.id)).toHaveLength(1);
      expect(await historyOf(client, "property_units", untouched.id)).toEqual([]);
    });
  });

  it("ignores container tracking refreshes, which are noise, but not a real edit made with one", async () => {
    await withRollback(async (client) => {
      const { rows: noise } = await client.query(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a
          WHERE a.attrelid = 'factory_containers'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname LIKE 'tracking\\_%' AND a.atttypid IN ('text'::regtype, 'varchar'::regtype)
          ORDER BY a.attnum LIMIT 1`
      );
      expect(noise, "factory_containers needs a text tracking_ column for this test").toHaveLength(1);
      const tracking = noise[0].name as string;
      const container = await seedRow(client, "factory_containers", { notes: "before" });

      await client.query(`UPDATE factory_containers SET "${tracking}" = 'refreshed' WHERE id = $1`, [container.id]);
      expect(await historyOf(client, "factory_containers", container.id)).toEqual([]);

      await client.query(`UPDATE factory_containers SET "${tracking}" = 'again', notes = 'after' WHERE id = $1`, [
        container.id,
      ]);
      const history = await historyOf(client, "factory_containers", container.id);
      expect(history).toHaveLength(1);
      expect(history[0].new_values?.notes).toBe("after");
    });
  });

  it("leaves the caller's company-scope maintenance setting as it found it", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "property_units", { notes: "before" });

      for (const [before, after] of [
        ["off", "off"],
        ["on", "on"],
      ]) {
        await client.query("SELECT set_config('app.company_scope_maintenance', $1, true)", [before]);
        await client.query("UPDATE property_units SET notes = notes || '.' WHERE id = $1", [row.id]);
        const { rows } = await client.query("SELECT current_setting('app.company_scope_maintenance', true) AS value");
        expect(rows[0].value).toBe(after);
      }
    });
  });
});
