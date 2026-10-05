/**
 * Sheets & Sacks inventory (factory_sheets_sacks) and its IN/OUT log
 * (factory_sheets_sacks_log).
 *
 * These statements used to live only in the ordered startup pass
 * (startup-schema/010), which production skips, so production kept the
 * tables an earlier version created ad hoc: the log carried legacy columns
 * the app never reads or writes (entry_id, color, current_stock,
 * packs_to_deduct, pieces_per_pack, pieces_to_deduct, remaining_stock, reason,
 * created_by, updated_at), looser types and no action check, while a fresh
 * database got the shape the app writes. ensureFactorySheetsSacksSchema() runs
 * on every boot: it applies the app's DDL, then converges a legacy table to
 * it. Every convergence step is guarded by the data it would affect: a legacy
 * column is dropped only while it holds nothing but its default, and a type,
 * NOT NULL or CHECK is tightened only when every existing row already fits.
 * A step whose guard fails is skipped and reported, never forced.
 */

export const factorySheetsSacksSchema: string[] = [
  `CREATE TABLE IF NOT EXISTS factory_sheets_sacks (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      type       TEXT NOT NULL DEFAULT 'Sheet',
      name       TEXT NOT NULL,
      size       TEXT,
      quantity   DECIMAL(15,3) NOT NULL DEFAULT 0,
      unit_price DECIMAL(15,2) NOT NULL DEFAULT 0,
      notes      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_factory_sheets_sacks_company ON factory_sheets_sacks (company_id)`,
  `ALTER TABLE factory_sheets_sacks ADD COLUMN IF NOT EXISTS pack_qty INTEGER`,
  `ALTER TABLE factory_sheets_sacks ADD COLUMN IF NOT EXISTS pcs_per_pack INTEGER`,
  `ALTER TABLE factory_sheets_sacks ADD COLUMN IF NOT EXISTS row_color TEXT`,
  // Kept from earlier versions, which stamped edits here; production rows
  // still carry those times.
  `ALTER TABLE factory_sheets_sacks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
  `CREATE TABLE IF NOT EXISTS factory_sheets_sacks_log (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER NOT NULL,
      item_id     INTEGER NOT NULL,
      item_name   TEXT NOT NULL,
      item_type   TEXT NOT NULL,
      action      TEXT NOT NULL CONSTRAINT factory_sheets_sacks_log_action_check CHECK (action IN ('IN','OUT','ADJUST')),
      pieces      INTEGER NOT NULL DEFAULT 0,
      packs       INTEGER,
      unit_price  DECIMAL(20,6),
      total_value DECIMAL(20,4),
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_fss_log_company_created ON factory_sheets_sacks_log (company_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_fss_log_item ON factory_sheets_sacks_log (item_id)`,
  // Converge a legacy ad hoc log table to the shape above. Guarded, so a no-op
  // on a table that already matches and safe to run on every boot.
  `DO $fss_log_converge$
   DECLARE
     legacy RECORD;
     has_column BOOLEAN;
     only_default BOOLEAN;
   BEGIN
     FOR legacy IN
       SELECT * FROM (VALUES
         ('entry_id', 'entry_id IS NOT NULL'),
         ('color', 'color IS NOT NULL'),
         ('reason', 'reason IS NOT NULL'),
         ('created_by', 'created_by IS NOT NULL'),
         ('current_stock', 'current_stock IS DISTINCT FROM 0'),
         ('packs_to_deduct', 'packs_to_deduct IS DISTINCT FROM 0'),
         ('pieces_to_deduct', 'pieces_to_deduct IS DISTINCT FROM 0'),
         ('remaining_stock', 'remaining_stock IS DISTINCT FROM 0'),
         ('pieces_per_pack', 'pieces_per_pack IS DISTINCT FROM 500'),
         ('updated_at', 'updated_at IS DISTINCT FROM created_at')
       ) AS columns_to_retire(name, carries_data)
     LOOP
       SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'factory_sheets_sacks_log' AND column_name = legacy.name
       ) INTO has_column;
       CONTINUE WHEN NOT has_column;
       EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM factory_sheets_sacks_log WHERE %s)', legacy.carries_data)
         INTO only_default;
       IF only_default THEN
         EXECUTE format('ALTER TABLE factory_sheets_sacks_log DROP COLUMN %I', legacy.name);
       ELSE
         RAISE WARNING 'factory_sheets_sacks_log.% holds data; legacy column kept', legacy.name;
       END IF;
     END LOOP;

     IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'factory_sheets_sacks_log'
         AND column_name = 'pieces' AND data_type <> 'integer'
     ) THEN
       IF NOT EXISTS (SELECT 1 FROM factory_sheets_sacks_log WHERE pieces <> trunc(pieces)) THEN
         ALTER TABLE factory_sheets_sacks_log ALTER COLUMN pieces TYPE INTEGER USING pieces::INTEGER;
       ELSE
         RAISE WARNING 'factory_sheets_sacks_log.pieces holds fractions; kept as numeric';
       END IF;
     END IF;

     IF NOT EXISTS (
       SELECT 1 FROM factory_sheets_sacks_log
       WHERE unit_price <> round(unit_price, 6) OR total_value <> round(total_value, 4)
     ) THEN
       ALTER TABLE factory_sheets_sacks_log
         ALTER COLUMN unit_price TYPE DECIMAL(20,6),
         ALTER COLUMN unit_price DROP DEFAULT,
         ALTER COLUMN unit_price DROP NOT NULL,
         ALTER COLUMN total_value TYPE DECIMAL(20,4),
         ALTER COLUMN total_value DROP DEFAULT,
         ALTER COLUMN total_value DROP NOT NULL;
     ELSE
       RAISE WARNING 'factory_sheets_sacks_log prices exceed the declared scale; kept';
     END IF;

     IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'factory_sheets_sacks_log'
         AND column_name = 'created_at' AND data_type = 'timestamp without time zone'
     ) THEN
       -- Legacy rows were stamped by now() on a UTC server.
       ALTER TABLE factory_sheets_sacks_log
         ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
     END IF;

     IF NOT EXISTS (
       SELECT 1 FROM factory_sheets_sacks_log
       WHERE company_id IS NULL OR item_id IS NULL OR item_name IS NULL OR item_type IS NULL OR created_at IS NULL
     ) THEN
       ALTER TABLE factory_sheets_sacks_log
         ALTER COLUMN company_id SET NOT NULL,
         ALTER COLUMN item_id SET NOT NULL,
         ALTER COLUMN item_name SET NOT NULL,
         ALTER COLUMN item_type SET NOT NULL,
         ALTER COLUMN created_at SET NOT NULL,
         ALTER COLUMN created_at SET DEFAULT NOW(),
         ALTER COLUMN action DROP DEFAULT;
     ELSE
       RAISE WARNING 'factory_sheets_sacks_log has rows missing required values; NOT NULL not applied';
     END IF;

     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'factory_sheets_sacks_log'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%action%'
     ) THEN
       IF NOT EXISTS (SELECT 1 FROM factory_sheets_sacks_log WHERE action NOT IN ('IN', 'OUT', 'ADJUST')) THEN
         ALTER TABLE factory_sheets_sacks_log
           ADD CONSTRAINT factory_sheets_sacks_log_action_check CHECK (action IN ('IN', 'OUT', 'ADJUST'));
       ELSE
         RAISE WARNING 'factory_sheets_sacks_log has actions outside IN/OUT/ADJUST; check not added';
       END IF;
     END IF;
   END $fss_log_converge$`,
  // Indexes the legacy tables carried beside the ones above: exact duplicates
  // (company_id, item_id), a prefix of idx_fss_log_company_created, or on
  // columns no query filters by.
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_company_id`,
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_type`,
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_log_action`,
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_log_company_id`,
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_log_created_at`,
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_log_entry_id`,
  `DROP INDEX IF EXISTS idx_factory_sheets_sacks_log_item_id`,
];

type StartupQueryable = {
  query: (queryText: string) => Promise<unknown>;
};

export async function ensureFactorySheetsSacksSchema(database: StartupQueryable): Promise<void> {
  for (const statement of factorySheetsSacksSchema) {
    await database.query(statement);
  }
}
