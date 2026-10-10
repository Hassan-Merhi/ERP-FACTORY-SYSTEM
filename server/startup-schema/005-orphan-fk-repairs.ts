/**
 * Startup data repairs for legacy rows that predate the foreign-key rollout.
 *
 * These statements run after the source tables exist and before 006 adds the
 * strict foreign keys. Every affected row is copied into an archive table
 * first, with the original primary key retained, so the repair is reversible
 * and auditable. The predicates only select rows whose referenced parent is
 * genuinely missing.
 *
 * Rows are copied into the archive by column name (jsonb_populate_record), not
 * by position: an archive table created on an earlier boot keeps the columns
 * its source had then, and a column added to the source later (for example
 * wave 11's value_moved on stock_transfer_items) must not break the copy. A
 * source column the archive does not have yet is added first (archiveColumns).
 */

const archiveColumns = (table: string) => [
  `CREATE TABLE IF NOT EXISTS _orphan_archive_${table} AS TABLE ${table} WITH NO DATA`,
  `ALTER TABLE _orphan_archive_${table} ADD COLUMN IF NOT EXISTS archived_at timestamp NOT NULL DEFAULT now()`,
  `ALTER TABLE _orphan_archive_${table} ADD COLUMN IF NOT EXISTS archive_reason text NOT NULL DEFAULT 'missing foreign-key parent'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS _orphan_archive_${table}_id_idx ON _orphan_archive_${table}(id)`,
  // Columns added to the source after the archive was first created.
  `DO $archive$
   DECLARE missing record;
   BEGIN
     FOR missing IN
       SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS coltype
         FROM pg_attribute a
        WHERE a.attrelid = '${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND NOT EXISTS (SELECT 1 FROM pg_attribute b
                           WHERE b.attrelid = '_orphan_archive_${table}'::regclass
                             AND b.attname = a.attname AND NOT b.attisdropped)
     LOOP
       EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s', '_orphan_archive_${table}', missing.attname, missing.coltype);
     END LOOP;
   END $archive$`,
];

export const orphanForeignKeyRepairs: string[] = [
  ...archiveColumns("customer_order_bale_removals"),
  `INSERT INTO _orphan_archive_customer_order_bale_removals
   SELECT (jsonb_populate_record(NULL::_orphan_archive_customer_order_bale_removals,
           to_jsonb(r) || jsonb_build_object('archived_at', now(), 'archive_reason', 'customer order foreign-key repair'))).*
   FROM customer_order_bale_removals r
   WHERE NOT EXISTS (SELECT 1 FROM customer_orders o WHERE o.id = r.order_id)
   ON CONFLICT (id) DO NOTHING`,
  `DELETE FROM customer_order_bale_removals r
   WHERE NOT EXISTS (SELECT 1 FROM customer_orders o WHERE o.id = r.order_id)`,

  ...archiveColumns("supplier_container_loaded_items"),
  `INSERT INTO _orphan_archive_supplier_container_loaded_items
   SELECT (jsonb_populate_record(NULL::_orphan_archive_supplier_container_loaded_items,
           to_jsonb(r) || jsonb_build_object('archived_at', now(), 'archive_reason', 'container foreign-key repair'))).*
   FROM supplier_container_loaded_items r
   WHERE NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = r.container_id)
   ON CONFLICT (id) DO NOTHING`,
  `DELETE FROM supplier_container_loaded_items r
   WHERE NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = r.container_id)`,

  ...archiveColumns("chat_messages"),
  `INSERT INTO _orphan_archive_chat_messages
   SELECT (jsonb_populate_record(NULL::_orphan_archive_chat_messages,
           to_jsonb(m) || jsonb_build_object('archived_at', now(), 'archive_reason', 'nullable company foreign-key repair'))).*
   FROM chat_messages m
   WHERE m.company_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = m.company_id)
   ON CONFLICT (id) DO NOTHING`,
  `UPDATE chat_messages m
   SET company_id = NULL
   WHERE m.company_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = m.company_id)`,

  ...archiveColumns("container_offloads"),
  ...archiveColumns("container_offload_items"),
  `INSERT INTO _orphan_archive_container_offloads
   SELECT (jsonb_populate_record(NULL::_orphan_archive_container_offloads,
           to_jsonb(o) || jsonb_build_object('archived_at', now(), 'archive_reason', 'location foreign-key repair'))).*
   FROM container_offloads o
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = o.location_id)
   ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO _orphan_archive_container_offload_items
   SELECT (jsonb_populate_record(NULL::_orphan_archive_container_offload_items,
           to_jsonb(i) || jsonb_build_object('archived_at', now(), 'archive_reason', 'parent offload foreign-key repair'))).*
   FROM container_offload_items i
   JOIN container_offloads o ON o.id = i.offload_id
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = o.location_id)
   ON CONFLICT (id) DO NOTHING`,
  `DELETE FROM container_offloads o
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = o.location_id)`,

  ...archiveColumns("import_logs"),
  `INSERT INTO _orphan_archive_import_logs
   SELECT (jsonb_populate_record(NULL::_orphan_archive_import_logs,
           to_jsonb(i) || jsonb_build_object('archived_at', now(), 'archive_reason', 'nullable container foreign-key repair'))).*
   FROM import_logs i
   WHERE i.container_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = i.container_id)
   ON CONFLICT (id) DO NOTHING`,
  `UPDATE import_logs i
   SET container_id = NULL
   WHERE i.container_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = i.container_id)`,

  ...archiveColumns("inventory"),
  `INSERT INTO _orphan_archive_inventory
   SELECT (jsonb_populate_record(NULL::_orphan_archive_inventory,
           to_jsonb(i) || jsonb_build_object('archived_at', now(), 'archive_reason', 'location foreign-key repair'))).*
   FROM inventory i
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id)
   ON CONFLICT (id) DO NOTHING`,
  `DELETE FROM inventory i
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id)`,

  ...archiveColumns("stock_transfer_items"),
  `INSERT INTO _orphan_archive_stock_transfer_items
   SELECT (jsonb_populate_record(NULL::_orphan_archive_stock_transfer_items,
           to_jsonb(i) || jsonb_build_object('archived_at', now(), 'archive_reason', 'transfer/location foreign-key repair'))).*
   FROM stock_transfer_items i
   WHERE NOT EXISTS (SELECT 1 FROM stock_transfer_vouchers t WHERE t.id = i.transfer_id)
      OR (i.source_location_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.source_location_id))
   ON CONFLICT (id) DO NOTHING`,
  `DELETE FROM stock_transfer_items i
   WHERE NOT EXISTS (SELECT 1 FROM stock_transfer_vouchers t WHERE t.id = i.transfer_id)
      OR (i.source_location_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.source_location_id))`,
];
