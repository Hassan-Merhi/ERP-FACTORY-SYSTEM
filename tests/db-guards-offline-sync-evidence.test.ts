/**
 * Factory offline-sync records are evidence and can never be rewritten.
 *
 * When a Factory site works offline, what it did arrives later as staged
 * events, outbox rows, receipts and operator decisions. Reconciling a dispute
 * depends on those rows being exactly what was received, so every one of these
 * tables has a trigger that refuses any update or delete, with no bypass. The
 * tests attempt both on each table and check the row is still there, and pin
 * the list of protected tables so a new evidence table cannot arrive unguarded
 * without this suite noticing.
 */
import { describe, expect, it } from "vitest";

import { expectRefused, reread, seedRow, withRollback } from "./helpers/dbGuardHarness";

const CHECK_VIOLATION = "23514";

const EVIDENCE_TABLES = [
  { table: "factory_edge_applied_events", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_attachment_file_receipts", message: "PHASE9_ATTACHMENT_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_attachment_outbox", message: "PHASE9_ATTACHMENT_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_event_applied_receipts", message: "PHASE9_PRESSING_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_event_conflict_decisions", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_event_conflicts", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_event_stage_receipts", message: "PHASE9_PRESSING_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_payment_outbox", message: "PHASE9_PAYMENT_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_pos_outbox", message: "PHASE9_POS_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_pressing_outbox", message: "PHASE9_PRESSING_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_receiving_outbox", message: "PHASE9_RECEIVING_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_staged_events", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_staged_files", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_stock_item_map", message: "PHASE9_STOCK_ITEM_MAP_IMMUTABLE" },
  { table: "factory_edge_stock_outbox", message: "PHASE9_STOCK_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_sync_control_log", message: "PHASE10_SYNC_CONTROL_IMMUTABLE" },
];

/** Counters and cursors: working state that is meant to change. */
const WORKING_STATE_TABLES = [
  "factory_edge_apply_cursor",
  "factory_edge_attachment_counter",
  "factory_edge_event_apply_cursor",
  "factory_edge_event_stage_cursor",
  "factory_edge_outbox_counter",
  "factory_edge_payment_counter",
  "factory_edge_pos_counter",
  "factory_edge_pressing_counter",
  "factory_edge_receiving_counter",
  "factory_edge_stage_cursor",
  "factory_edge_stock_counter",
];

/**
 * The first-generation voucher sync records. The application only ever inserts
 * into them, but unlike the later tables above they have no trigger refusing an
 * update or delete. Recorded here as they are, and reported to the owner: when
 * a guard is added, move the table to EVIDENCE_TABLES.
 */
const UNGUARDED_RECORD_TABLES = [
  "factory_edge_applied_receipts",
  "factory_edge_applied_vouchers",
  "factory_edge_apply_approvals",
  "factory_edge_stage_receipts",
  "factory_edge_staged_vouchers",
  "factory_edge_voucher_outbox",
];

/** The column that identifies a row: `id` where there is one, otherwise the first primary-key column. */
async function keyColumn(client: Parameters<Parameters<typeof withRollback>[0]>[0], table: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [table]
  );
  expect(rows, `${table} has no primary key`).toHaveLength(1);
  return rows[0].name;
}

describe("the set of offline-sync evidence tables", () => {
  it("is exactly the tables this suite attacks, each guarded against update and delete", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT c.relname AS table_name, t.tgtype, t.tgenabled
           FROM pg_trigger t
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE p.proname LIKE 'factory\\_edge\\_%\\_immutable' AND NOT t.tgisinternal
          ORDER BY c.relname`
      );

      expect(rows.map((row) => row.table_name)).toEqual(EVIDENCE_TABLES.map((entry) => entry.table));
      for (const row of rows) {
        // Row-level (1), before (2), delete (8) and update (16); not insert (4).
        expect(row.tgtype & 31, row.table_name).toBe(27);
        expect(row.tgenabled, row.table_name).toBe("O");
      }
    });
  });

  it("accounts for every other factory_edge table by name", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT c.relname AS table_name
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'factory\\_edge\\_%'
          ORDER BY c.relname`
      );
      const guarded = new Set(EVIDENCE_TABLES.map((entry) => entry.table));

      // A new factory_edge table must be added to one of the lists on purpose.
      expect(rows.map((row) => row.table_name).filter((name) => !guarded.has(name))).toEqual(
        [...WORKING_STATE_TABLES, ...UNGUARDED_RECORD_TABLES].sort()
      );
    });
  });
});

describe.each(EVIDENCE_TABLES)("offline-sync evidence in $table", ({ table, message }) => {
  it("refuses any update, even one that changes nothing", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, table);
      const key = await keyColumn(client, table);

      await expectRefused(client, `UPDATE "${table}" SET "${key}" = "${key}" WHERE "${key}" = $1`, [row[key]], {
        code: CHECK_VIOLATION,
        message,
      });
    });
  });

  it("refuses to delete a row, and has no session setting that lifts the refusal", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, table);
      const key = await keyColumn(client, table);
      const remove = `DELETE FROM "${table}" WHERE "${key}" = $1`;

      await expectRefused(client, remove, [row[key]], { code: CHECK_VIOLATION, message });
      for (const setting of [
        "app.ledger_integrity_bypass",
        "app.closed_period_override",
        "app.company_scope_maintenance",
      ]) {
        await client.query("SELECT set_config($1, 'on', true)", [setting]);
      }
      await expectRefused(client, remove, [row[key]], { code: CHECK_VIOLATION, message });

      const { rowCount } = await client.query(`SELECT 1 FROM "${table}" WHERE "${key}" = $1`, [row[key]]);
      expect(rowCount).toBe(1);
    });
  });
});

describe("offline-sync evidence can still be recorded", () => {
  it("accepts new rows: the guard is on rewriting, not on writing", async () => {
    await withRollback(async (client) => {
      for (const { table } of EVIDENCE_TABLES) {
        const row = await seedRow(client, table);
        const key = await keyColumn(client, table);
        if (key === "id") await reread(client, table, row.id);
      }
    });
  });
});
