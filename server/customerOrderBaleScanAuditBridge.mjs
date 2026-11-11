import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.PGHOST
    ? `postgresql://${encodeURIComponent(process.env.PGUSER || "")}:${encodeURIComponent(process.env.PGPASSWORD || "")}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE || ""}`
    : "");

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "customer-order-bale-scan-audit",
      action: "startup-ensure",
      ...extra,
    })
  );
}

/**
 * `options.connectionString` overrides the environment-derived target. Server
 * boot never passes it; it exists so the routine can be driven against a
 * stubbed client without mutating process-wide database configuration.
 */
export async function ensureCustomerOrderBaleScanAudit(options = {}) {
  const target = options.connectionString ?? connectionString;
  if (!target) {
    if (process.env.BALE_SCAN_AUDIT_SCHEMA_MODE === "verify-only") throw new Error("Bale scan audit schema verify-only requires database configuration");
    log("WARN", "Scan-audit schema check skipped because no database configuration is available");
    return;
  }

  const client = new Client({
    connectionString: target,
    ssl: resolveDatabaseSsl(target),
    connectionTimeoutMillis: 8_000,
  });

  const repaired = [];

  try {
    await client.connect();
    const verifyOnly = process.env.BALE_SCAN_AUDIT_SCHEMA_MODE === "verify-only";
    if (verifyOnly) {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '45s'");
      const tables = await client.query(`
        SELECT to_regclass('public.customer_order_bales') IS NOT NULL AS live,
               to_regclass('public.customer_order_bales_history') IS NOT NULL AS history
      `);
      if (!tables.rows[0]?.live || !tables.rows[0]?.history) {
        throw new Error("Bale scan audit live/history tables missing; manual controlled schema migration required");
      }
      const columns=await client.query(`
        SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('customer_order_bales','customer_order_bales_history')
          AND column_name='scanned_at'
      `);
      const scanColumns=new Set(columns.rows.map(x=>x.table_name));
      if (!scanColumns.has('customer_order_bales') || !scanColumns.has('customer_order_bales_history')) {
        throw new Error("Bale scan audit scanned_at timestamp column missing");
      }
      const definitions=await client.query(`
        SELECT p.proname, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
          AND p.proname IN ('set_customer_order_bale_scanned_at','copy_customer_order_bale_scanned_at_to_history')
      `);
      const foundFunctions=new Set(definitions.rows.map(x=>x.proname));
      if (!foundFunctions.has('set_customer_order_bale_scanned_at') ||
          !foundFunctions.has('copy_customer_order_bale_scanned_at_to_history')) {
        throw new Error("Bale scan audit preservation functions missing");
      }
      const triggers=await client.query(`
        SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE NOT t.tgisinternal AND (
          (c.relname='customer_order_bales' AND t.tgname='customer_order_bales_set_scanned_at')
          OR (c.relname='customer_order_bales_history' AND t.tgname='customer_order_bales_history_copy_scanned_at')
        )
      `);
      if (triggers.rows.length!==2 || triggers.rows.some(t=>!['O','A'].includes(t.tgenabled))) {
        throw new Error("Bale scan audit timestamp triggers missing or disabled");
      }
      await client.query("ROLLBACK");
      log("INFO","Bale scan audit schema verified read-only without modifying scan timestamps");
      return;
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");

    const liveLookup = await client.query(`SELECT to_regclass('public.customer_order_bales') AS table_name`);
    if (!liveLookup.rows[0]?.table_name) {
      await client.query("COMMIT");
      log("WARN", "Scan-audit schema check skipped because customer_order_bales does not exist");
      return;
    }

    const liveColumn = await client.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'customer_order_bales'
        AND column_name = 'scanned_at'
      LIMIT 1
    `);
    if (liveColumn.rowCount === 0) {
      await client.query(`ALTER TABLE public.customer_order_bales ADD COLUMN scanned_at TIMESTAMPTZ`);
      repaired.push("customer_order_bales.scanned_at");
    }

    let historyLookup = await client.query(`SELECT to_regclass('public.customer_order_bales_history') AS table_name`);
    let hasHistory = Boolean(historyLookup.rows[0]?.table_name);

    // This bridge can be preloaded before the ordered startup migrations. On a
    // first upgrade the live bale table may already exist while the archive
    // table does not. Create the canonical archive shape here so the live
    // trigger never points at a later-created table that lacks scanned_at.
    if (!hasHistory) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.customer_order_bales_history (
          id serial PRIMARY KEY,
          original_id integer NOT NULL,
          order_id integer NOT NULL,
          bale_id integer NOT NULL,
          bale_reference varchar(100) NOT NULL,
          location_id integer NOT NULL,
          weight decimal(15,3) NOT NULL,
          article_code varchar(50),
          bale_name text,
          price_used decimal(20,2) NOT NULL,
          scanned_by text,
          scanned_at timestamptz,
          cancelled_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      repaired.push("customer_order_bales_history table");
      historyLookup = await client.query(`SELECT to_regclass('public.customer_order_bales_history') AS table_name`);
      hasHistory = Boolean(historyLookup.rows[0]?.table_name);
    }

    if (hasHistory) {
      const historyColumn = await client.query(`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'customer_order_bales_history'
          AND column_name = 'scanned_at'
        LIMIT 1
      `);
      if (historyColumn.rowCount === 0) {
        await client.query(`ALTER TABLE public.customer_order_bales_history ADD COLUMN scanned_at TIMESTAMPTZ`);
        repaired.push("customer_order_bales_history.scanned_at");
      }
    }

    // Preserve a prior timestamp when a cancelled loading is restored. For a
    // genuinely new scan/import, scanned_by is populated by the authenticated
    // route and the database server supplies the timestamp. Recovery/admin
    // reconstruction rows intentionally have no scanner identity, so they stay
    // NULL instead of receiving a fabricated scan time.
    await client.query(`
      CREATE OR REPLACE FUNCTION public.set_customer_order_bale_scanned_at()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        restored_at TIMESTAMPTZ;
        restored_match BOOLEAN := FALSE;
        history_has_scanned_at BOOLEAN := FALSE;
      BEGIN
        IF NEW.scanned_at IS NOT NULL THEN
          RETURN NEW;
        END IF;

        IF to_regclass('public.customer_order_bales_history') IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'customer_order_bales_history'
              AND column_name = 'scanned_at'
          ) INTO history_has_scanned_at;

          IF history_has_scanned_at THEN
            SELECT h.scanned_at, TRUE
            INTO restored_at, restored_match
            FROM public.customer_order_bales_history h
            WHERE h.order_id = NEW.order_id
              AND h.bale_id = NEW.bale_id
            ORDER BY h.cancelled_at DESC
            LIMIT 1;

            IF restored_match THEN
              NEW.scanned_at := restored_at;
              RETURN NEW;
            END IF;
          END IF;
        END IF;

        IF NEW.scanned_by IS NOT NULL AND btrim(NEW.scanned_by) <> '' THEN
          NEW.scanned_at := CURRENT_TIMESTAMP;
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    const liveTrigger = await client.query(`
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = 'public.customer_order_bales'::regclass
        AND tgname = 'customer_order_bales_set_scanned_at'
        AND NOT tgisinternal
      LIMIT 1
    `);
    if (liveTrigger.rowCount === 0) {
      await client.query(`
        CREATE TRIGGER customer_order_bales_set_scanned_at
        BEFORE INSERT ON public.customer_order_bales
        FOR EACH ROW
        EXECUTE FUNCTION public.set_customer_order_bale_scanned_at()
      `);
      repaired.push("customer_order_bales_set_scanned_at trigger");
    }

    if (hasHistory) {
      // Cancellation code intentionally copies a fixed legacy column list. Fill
      // scanned_at in a trigger while the live row still exists so restore keeps
      // the original scanner timestamp without changing the cancellation API.
      await client.query(`
        CREATE OR REPLACE FUNCTION public.copy_customer_order_bale_scanned_at_to_history()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.scanned_at IS NULL THEN
            SELECT cob.scanned_at
            INTO NEW.scanned_at
            FROM public.customer_order_bales cob
            WHERE cob.id = NEW.original_id
            LIMIT 1;
          END IF;
          RETURN NEW;
        END;
        $$
      `);

      const historyTrigger = await client.query(`
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'public.customer_order_bales_history'::regclass
          AND tgname = 'customer_order_bales_history_copy_scanned_at'
          AND NOT tgisinternal
        LIMIT 1
      `);
      if (historyTrigger.rowCount === 0) {
        await client.query(`
          CREATE TRIGGER customer_order_bales_history_copy_scanned_at
          BEFORE INSERT ON public.customer_order_bales_history
          FOR EACH ROW
          EXECUTE FUNCTION public.copy_customer_order_bale_scanned_at_to_history()
        `);
        repaired.push("customer_order_bales_history_copy_scanned_at trigger");
      }
    }

    await client.query("COMMIT");
    log("INFO", "Customer order bale scan-audit schema verified", { repaired });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Customer order bale scan-audit schema verification failed; aborting startup", {
      errorCode: error?.code,
      errorMessage: error?.message || String(error),
      repaired,
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

// Importing this module installs the schema on a real server boot. Tests import
// it for the exported routine and drive it against a stubbed client instead.
if (process.env.NODE_ENV !== "test") {
  await ensureCustomerOrderBaleScanAudit();
}
