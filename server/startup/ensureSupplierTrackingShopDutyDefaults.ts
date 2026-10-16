import type { Pool } from "pg";
import { supplierTrackingDefaultsSchema } from "../startup-schema/028-supplier-tracking-defaults";
import { supplierTrackingShopDutyDefaultsSchema } from "../startup-schema/034-supplier-tracking-shop-duty-defaults";

/**
 * Ensure supplier defaults before HTTP starts even when bulk migrations are off.
 * Atomic DDL avoids exposing the old trigger during deployment. On a freshly
 * empty database, defer to the later bulk migration which creates base tables.
 */
export async function ensureSupplierTrackingShopDutyDefaults(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const prerequisite = await client.query(
      `SELECT to_regclass('public.companies') IS NOT NULL
           AND to_regclass('public.suppliers') IS NOT NULL
           AND to_regclass('public.locations') IS NOT NULL
           AND to_regclass('public.containers') IS NOT NULL AS ready`
    );
    if (!prerequisite.rows[0]?.ready) return;
    await client.query("BEGIN");
    try {
      for (const statement of [...supplierTrackingDefaultsSchema, ...supplierTrackingShopDutyDefaultsSchema]) {
        await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}
