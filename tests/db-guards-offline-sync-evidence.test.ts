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
 *
 * The offline schema is not created when the server starts: a DBA installs it
 * (server/edge/offlineSchemaInstall.ts), the cloud half on the cloud database
 * and the LAN half on a site's. The test database has neither until a suite
 * installs it, so this one runs the same installers first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The site-side installers only act when the server is configured as a LAN site.
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => ({ mode: "lan" }),
}));

import { pool } from "../server/db";
import { ensureCloudEdgeStageSchema } from "../server/edge/edgeCloudStaging";
import { ensureEdgeVoucherOutboxSchema } from "../server/edge/edgeVoucherOutbox";
import { ensurePhase10SyncControlSchema } from "../server/edge/phase10SyncControl.mjs";
import { ensurePhase8ApplySchema } from "../server/edge/phase8ApplyStore.mjs";
import { ensurePhase9AttachmentOutboxSchema } from "../server/edge/phase9AttachmentOutbox";
import { ensurePhase9CloudEventSchema } from "../server/edge/phase9CloudEventStore.mjs";
import { ensurePhase9PaymentOutboxSchema } from "../server/edge/phase9PaymentOutbox";
import { ensurePhase9PosOutboxSchema } from "../server/edge/phase9PosOutbox";
import { ensurePhase9PressingOutboxSchema } from "../server/edge/phase9PressingOutbox";
import { ensurePhase9ReceivingOutboxSchema } from "../server/edge/phase9ReceivingOutbox";
import { ensurePhase9StockItemMapSchema } from "../server/edge/phase9StockItemMap.mjs";
import { ensurePhase9StockOutboxSchema } from "../server/edge/phase9StockOutbox";

import { dropTriggers, expectRefused, reread, seedRow, withRollback } from "./helpers/dbGuardHarness";

const CHECK_VIOLATION = "23514";

type TriggerName = readonly [table: string, trigger: string];

async function edgeTriggers(): Promise<TriggerName[]> {
  const { rows } = await pool.query(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname LIKE 'factory\\_edge\\_%' AND NOT t.tgisinternal`
  );
  return rows.map((row) => [row.table_name, row.trigger_name] as const);
}

let presentBefore = new Set<string>();

// Other offline suites clear these tables between tests and expect whatever
// guards they did not install to be absent, so anything added here is removed.
afterAll(async () => {
  await dropTriggers((await edgeTriggers()).filter(([table, trigger]) => !presentBefore.has(`${table}.${trigger}`)));
}, 60000);

beforeAll(async () => {
  presentBefore = new Set((await edgeTriggers()).map(([table, trigger]) => `${table}.${trigger}`));
  // The cloud half, then the LAN half, in the installer's own order.
  await ensureCloudEdgeStageSchema(pool, true);
  await ensurePhase8ApplySchema(pool);
  await ensurePhase9CloudEventSchema(pool);
  await ensurePhase9StockItemMapSchema(pool);
  await ensureEdgeVoucherOutboxSchema(pool);
  await ensurePhase9PressingOutboxSchema(pool);
  await ensurePhase9StockOutboxSchema(pool);
  await ensurePhase9PosOutboxSchema(pool);
  await ensurePhase9ReceivingOutboxSchema(pool);
  await ensurePhase9AttachmentOutboxSchema(pool);
  await ensurePhase9PaymentOutboxSchema(pool);
  await ensurePhase10SyncControlSchema(pool);
}, 120000);

const EVIDENCE_TABLES = [
  { table: "factory_edge_applied_events", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_applied_receipts", message: "EDGE_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_applied_vouchers", message: "PHASE8_APPLIED_RECEIPT_IMMUTABLE" },
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
  { table: "factory_edge_stage_receipts", message: "EDGE_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_staged_events", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_staged_files", message: "PHASE9_EVENT_EVIDENCE_IMMUTABLE" },
  { table: "factory_edge_staged_vouchers", message: "EDGE_STAGED_VOUCHER_IMMUTABLE" },
  { table: "factory_edge_stock_item_map", message: "PHASE9_STOCK_ITEM_MAP_IMMUTABLE" },
  { table: "factory_edge_stock_outbox", message: "PHASE9_STOCK_OUTBOX_IMMUTABLE" },
  { table: "factory_edge_sync_control_log", message: "PHASE10_SYNC_CONTROL_IMMUTABLE" },
  { table: "factory_edge_voucher_outbox", message: "EDGE_OUTBOX_IMMUTABLE" },
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
 * Cloud apply approvals are protected differently: the application's database
 * role is denied every write on the table (server/edge/phase8ApplyStore.mjs
 * checks that before it trusts an approval), so there is no trigger to attack.
 */
const PRIVILEGE_PROTECTED_TABLES = ["factory_edge_apply_approvals"];

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
          WHERE p.proname LIKE 'factory\\_edge\\_%immutable' AND NOT t.tgisinternal
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
        [...WORKING_STATE_TABLES, ...PRIVILEGE_PROTECTED_TABLES].sort()
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
