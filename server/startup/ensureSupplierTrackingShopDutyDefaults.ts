import type { Pool } from "pg";
import { supplierTrackingDefaultsSchema } from "../startup-schema/028-supplier-tracking-defaults";
import { supplierTrackingShopDutyDefaultsSchema } from "../startup-schema/034-supplier-tracking-shop-duty-defaults";

/**
 * Always apply the supplier default columns + trigger before opening HTTP.
 * Production may disable the bulk startup-migration pass, so this feature
 * must be independently bootstrapped and never serve against an old trigger.
 */
export async function ensureSupplierTrackingShopDutyDefaults(pool: Pool): Promise<void> {
  for (const statement of [...supplierTrackingDefaultsSchema, ...supplierTrackingShopDutyDefaultsSchema]) {
    await pool.query(statement);
  }
}
