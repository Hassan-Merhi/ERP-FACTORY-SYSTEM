import { pool } from "../../db";

let schemaSetupPromise: Promise<void> | null = null;
let triggerSetupPromise: Promise<void> | null = null;

const REQUIRED_TABLES = ["sp_containers", "vouchers", "voucher_entries", "ledger_accounts"] as const;
const REQUIRED_COLUMNS = [
  {
    table: "vouchers",
    column: "supplier_id",
    ddl: `ALTER TABLE vouchers ADD COLUMN supplier_id INTEGER`,
  },
  {
    table: "voucher_entries",
    column: "supplier_id",
    ddl: `ALTER TABLE voucher_entries ADD COLUMN supplier_id INTEGER`,
  },
  {
    table: "sp_containers",
    column: "supplier_id",
    ddl: `ALTER TABLE sp_containers ADD COLUMN supplier_id INTEGER`,
  },
  {
    table: "sp_containers",
    column: "goods_otw_voucher_id",
    ddl: `ALTER TABLE sp_containers ADD COLUMN goods_otw_voucher_id INTEGER`,
  },
  {
    table: "ledger_accounts",
    column: "sub_type",
    ddl: `ALTER TABLE ledger_accounts ADD COLUMN sub_type TEXT`,
  },
] as const;

/**
 * Ensures the legacy supplier-link columns required by Supplier Partner voucher
 * synchronization exist even when bulk startup migrations are disabled.
 * Existing columns are detected first so normal restarts do not request table locks.
 */
export function ensureSpSupplierVoucherSyncSchema(): Promise<void> {
  if (!schemaSetupPromise) {
    schemaSetupPromise = (async () => {
      const client = await pool.connect();
      let transactionStarted = false;

      try {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('sp-supplier-voucher-sync-schema-v1'))`);

        const tableResult = await client.query<{ table_name: string }>(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ANY($1::text[])`,
          [[...REQUIRED_TABLES]],
        );
        const found = new Set(tableResult.rows.map((row) => row.table_name));
        const missingTables = REQUIRED_TABLES.filter((table) => !found.has(table));
        if (missingTables.length > 0) {
          throw new Error(`SP supplier voucher synchronization tables are not ready: ${missingTables.join(", ")}`);
        }

        for (const spec of REQUIRED_COLUMNS) {
          const columnResult = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = $1
                  AND column_name = $2
             ) AS exists`,
            [spec.table, spec.column],
          );
          if (!columnResult.rows[0]?.exists) {
            await client.query(spec.ddl);
          }
        }

        await client.query("COMMIT");
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaSetupPromise = null;
      throw error;
    });
  }

  return schemaSetupPromise;
}

/**
 * Installs an idempotent PostgreSQL trigger that keeps the supplier on an SP
 * container's Goods-OTW voucher header and OTW-clearing entry synchronized with
 * the container. Supplier statements are scoped through vouchers.supplier_id,
 * while some legacy surfaces still inspect voucher_entries.supplier_id.
 */
export function ensureSpSupplierVoucherSyncTrigger(): Promise<void> {
  if (!triggerSetupPromise) {
    triggerSetupPromise = (async () => {
      await ensureSpSupplierVoucherSyncSchema();

      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('sp-supplier-voucher-sync-trigger-v1'))`);

        await client.query(`
          CREATE OR REPLACE FUNCTION sync_sp_container_supplier_to_voucher()
          RETURNS trigger AS $sp_supplier_sync$
          BEGIN
            IF NEW.goods_otw_voucher_id IS NOT NULL THEN
              UPDATE vouchers
              SET supplier_id = NEW.supplier_id
              WHERE id = NEW.goods_otw_voucher_id
                AND company_id = NEW.company_id
                AND supplier_id IS DISTINCT FROM NEW.supplier_id;

              UPDATE voucher_entries ve
              SET supplier_id = NEW.supplier_id
              FROM ledger_accounts la
              WHERE ve.voucher_id = NEW.goods_otw_voucher_id
                AND ve.ledger_account_id = la.id
                AND la.company_id = NEW.company_id
                AND la.sub_type = 'sp_otw_clearing'
                AND ve.supplier_id IS DISTINCT FROM NEW.supplier_id;
            END IF;
            RETURN NEW;
          END;
          $sp_supplier_sync$ LANGUAGE plpgsql;
        `);

        await client.query(`DROP TRIGGER IF EXISTS trg_sp_container_supplier_voucher_sync ON sp_containers`);
        await client.query(`
          CREATE TRIGGER trg_sp_container_supplier_voucher_sync
          AFTER INSERT OR UPDATE OF supplier_id, goods_otw_voucher_id ON sp_containers
          FOR EACH ROW
          EXECUTE FUNCTION sync_sp_container_supplier_to_voucher()
        `);

        await client.query("COMMIT");
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      // Allow a later retry after a fresh-database setup or a transient lock timeout.
      triggerSetupPromise = null;
      throw error;
    });
  }

  return triggerSetupPromise;
}

/** Backfills voucher headers and OTW-clearing entries already linked to SP containers. */
export async function repairSpSupplierVoucherLinks(companyId?: number): Promise<number> {
  await ensureSpSupplierVoucherSyncTrigger();

  const params = companyId ? [companyId] : [];
  const companyFilter = companyId ? "AND c.company_id = $1" : "";
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('sp-supplier-voucher-link-repair-v1'))`);

    const candidateResult = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM sp_containers c
         JOIN vouchers v ON v.id = c.goods_otw_voucher_id AND v.company_id = c.company_id
        WHERE c.goods_otw_voucher_id IS NOT NULL
          ${companyFilter}
          AND (
            v.supplier_id IS DISTINCT FROM c.supplier_id
            OR EXISTS (
              SELECT 1
                FROM voucher_entries ve
                JOIN ledger_accounts la ON la.id = ve.ledger_account_id
               WHERE ve.voucher_id = v.id
                 AND la.company_id = c.company_id
                 AND la.sub_type = 'sp_otw_clearing'
                 AND ve.supplier_id IS DISTINCT FROM c.supplier_id
            )
          )`,
      params,
    );

    await client.query(
      `UPDATE vouchers v
          SET supplier_id = c.supplier_id
         FROM sp_containers c
        WHERE v.id = c.goods_otw_voucher_id
          AND v.company_id = c.company_id
          AND c.goods_otw_voucher_id IS NOT NULL
          ${companyFilter}
          AND v.supplier_id IS DISTINCT FROM c.supplier_id`,
      params,
    );

    await client.query(
      `UPDATE voucher_entries ve
          SET supplier_id = c.supplier_id
         FROM sp_containers c, ledger_accounts la
        WHERE ve.voucher_id = c.goods_otw_voucher_id
          AND ve.ledger_account_id = la.id
          AND la.company_id = c.company_id
          AND la.sub_type = 'sp_otw_clearing'
          AND c.goods_otw_voucher_id IS NOT NULL
          ${companyFilter}
          AND ve.supplier_id IS DISTINCT FROM c.supplier_id`,
      params,
    );

    await client.query("COMMIT");
    transactionStarted = false;
    return Number(candidateResult.rows[0]?.count ?? 0);
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Counts SP Goods-OTW supplier links that differ from their container. */
export async function getSpSupplierVoucherLinkGapCount(companyId: number): Promise<number> {
  await ensureSpSupplierVoucherSyncSchema();

  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM sp_containers c
       JOIN vouchers v ON v.id = c.goods_otw_voucher_id AND v.company_id = c.company_id
      WHERE c.company_id = $1
        AND c.goods_otw_voucher_id IS NOT NULL
        AND (
          v.supplier_id IS DISTINCT FROM c.supplier_id
          OR EXISTS (
            SELECT 1
              FROM voucher_entries ve
              JOIN ledger_accounts la ON la.id = ve.ledger_account_id
             WHERE ve.voucher_id = v.id
               AND la.company_id = c.company_id
               AND la.sub_type = 'sp_otw_clearing'
               AND ve.supplier_id IS DISTINCT FROM c.supplier_id
          )
        )`,
    [companyId],
  );

  return Number(result.rows[0]?.count ?? 0);
}
