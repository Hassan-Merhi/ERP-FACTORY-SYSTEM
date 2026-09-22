/**
 * Startup data repairs for legacy rows that predate the foreign-key rollout.
 *
 * These statements run after the source tables exist and before 006 adds the
 * strict foreign keys. Every affected row is copied into an archive table
 * first, with the original primary key retained, so the repair is reversible
 * and auditable. The predicates only select rows whose referenced parent is
 * genuinely missing.
 */

const archiveColumns = (table: string) => [
  `CREATE TABLE IF NOT EXISTS _orphan_archive_${table} AS TABLE ${table} WITH NO DATA`,
  `ALTER TABLE _orphan_archive_${table} ADD COLUMN IF NOT EXISTS archived_at timestamp NOT NULL DEFAULT now()`,
  `ALTER TABLE _orphan_archive_${table} ADD COLUMN IF NOT EXISTS archive_reason text NOT NULL DEFAULT 'missing foreign-key parent'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS _orphan_archive_${table}_id_idx ON _orphan_archive_${table}(id)`,
];

/**
 * Copies orphan rows into their archive table.
 *
 * The archive table is created once with `CREATE TABLE IF NOT EXISTS ... AS
 * TABLE <source>`, so it freezes the source's column list as it stood on the
 * first run. Later migrations and the runtime schema bridges keep adding
 * columns to the source, and on the next startup the archive is then narrower
 * than the source. A positional `SELECT r.*, now(), reason` insert fails at
 * that point with "INSERT has more expressions than target columns", which
 * aborts the repair for every environment that has orphan rows to archive.
 *
 * This runs the copy dynamically instead: it first adds any column the source
 * has gained to the archive, then inserts by explicit column name. Naming the
 * columns is what makes the backfill safe — appended columns land at the end of
 * the archive's column order, so positional insertion could not survive it.
 */
const archiveOrphans = (options: {
  table: string;
  alias: string;
  from: string;
  where: string;
  reason: string;
}): string => {
  const { table, alias, from, where, reason } = options;
  const archive = `_orphan_archive_${table}`;
  return `DO $orphan_archive$
DECLARE
  missing record;
  target_columns text;
  source_columns text;
BEGIN
  IF to_regclass('public.${table}') IS NULL OR to_regclass('public.${archive}') IS NULL THEN
    RETURN;
  END IF;

  FOR missing IN
    SELECT source_attribute.attname AS name,
           format_type(source_attribute.atttypid, source_attribute.atttypmod) AS type_name
      FROM pg_attribute source_attribute
     WHERE source_attribute.attrelid = 'public.${table}'::regclass
       AND source_attribute.attnum > 0
       AND NOT source_attribute.attisdropped
       AND NOT EXISTS (
         SELECT 1
           FROM pg_attribute archive_attribute
          WHERE archive_attribute.attrelid = 'public.${archive}'::regclass
            AND archive_attribute.attnum > 0
            AND NOT archive_attribute.attisdropped
            AND archive_attribute.attname = source_attribute.attname
       )
  LOOP
    EXECUTE format('ALTER TABLE public.${archive} ADD COLUMN %I %s', missing.name, missing.type_name);
  END LOOP;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum),
         string_agg('${alias}.' || quote_ident(attname), ', ' ORDER BY attnum)
    INTO target_columns, source_columns
    FROM pg_attribute
   WHERE attrelid = 'public.${table}'::regclass
     AND attnum > 0
     AND NOT attisdropped;

  EXECUTE 'INSERT INTO public.${archive} (' || target_columns || ', archived_at, archive_reason) '
       || 'SELECT ' || source_columns || ', now(), ' || quote_literal('${reason}') || ' '
       || 'FROM ${from} WHERE ${where} ON CONFLICT (id) DO NOTHING';
END
$orphan_archive$;`;
};

export const orphanForeignKeyRepairs: string[] = [
  ...archiveColumns("customer_order_bale_removals"),
  archiveOrphans({
    table: "customer_order_bale_removals",
    alias: "r",
    from: "customer_order_bale_removals r",
    where: "NOT EXISTS (SELECT 1 FROM customer_orders o WHERE o.id = r.order_id)",
    reason: "customer order foreign-key repair",
  }),
  `DELETE FROM customer_order_bale_removals r
   WHERE NOT EXISTS (SELECT 1 FROM customer_orders o WHERE o.id = r.order_id)`,

  ...archiveColumns("supplier_container_loaded_items"),
  archiveOrphans({
    table: "supplier_container_loaded_items",
    alias: "r",
    from: "supplier_container_loaded_items r",
    where: "NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = r.container_id)",
    reason: "container foreign-key repair",
  }),
  `DELETE FROM supplier_container_loaded_items r
   WHERE NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = r.container_id)`,

  ...archiveColumns("chat_messages"),
  archiveOrphans({
    table: "chat_messages",
    alias: "m",
    from: "chat_messages m",
    where: "m.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = m.company_id)",
    reason: "nullable company foreign-key repair",
  }),
  `UPDATE chat_messages m
   SET company_id = NULL
   WHERE m.company_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = m.company_id)`,

  ...archiveColumns("container_offloads"),
  ...archiveColumns("container_offload_items"),
  archiveOrphans({
    table: "container_offloads",
    alias: "o",
    from: "container_offloads o",
    where: "NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = o.location_id)",
    reason: "location foreign-key repair",
  }),
  archiveOrphans({
    table: "container_offload_items",
    alias: "i",
    from: "container_offload_items i JOIN container_offloads o ON o.id = i.offload_id",
    where: "NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = o.location_id)",
    reason: "parent offload foreign-key repair",
  }),
  `DELETE FROM container_offloads o
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = o.location_id)`,

  ...archiveColumns("import_logs"),
  archiveOrphans({
    table: "import_logs",
    alias: "i",
    from: "import_logs i",
    where: "i.container_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = i.container_id)",
    reason: "nullable container foreign-key repair",
  }),
  `UPDATE import_logs i
   SET container_id = NULL
   WHERE i.container_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.id = i.container_id)`,

  ...archiveColumns("inventory"),
  archiveOrphans({
    table: "inventory",
    alias: "i",
    from: "inventory i",
    where: "NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id)",
    reason: "location foreign-key repair",
  }),
  `DELETE FROM inventory i
   WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.location_id)`,

  ...archiveColumns("stock_transfer_items"),
  archiveOrphans({
    table: "stock_transfer_items",
    alias: "i",
    from: "stock_transfer_items i",
    where:
      "NOT EXISTS (SELECT 1 FROM stock_transfer_vouchers t WHERE t.id = i.transfer_id) " +
      "OR (i.source_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.source_location_id))",
    reason: "transfer/location foreign-key repair",
  }),
  `DELETE FROM stock_transfer_items i
   WHERE NOT EXISTS (SELECT 1 FROM stock_transfer_vouchers t WHERE t.id = i.transfer_id)
      OR (i.source_location_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = i.source_location_id))`,
];
