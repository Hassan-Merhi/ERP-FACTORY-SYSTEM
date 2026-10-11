/**
 * Boot-time schema of the non-USD purchase order columns (phase 24, M5; same
 * statements as migrations/20261011_024_purchase_order_native_currency.sql).
 * Additive and idempotent; no data is changed.
 */
import type { DatabasePool } from "../../../db";
import { logger } from "../../../lib/logger";

export const PURCHASE_ORDER_CURRENCY_SCHEMA_SQL = [
  `ALTER TABLE purchase_orders
     ADD COLUMN IF NOT EXISTS native_currency VARCHAR(10),
     ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 10),
     ADD COLUMN IF NOT EXISTS native_items_total NUMERIC(20, 2),
     ADD COLUMN IF NOT EXISTS native_grand_total NUMERIC(20, 2)`,
  `ALTER TABLE po_line_items
     ADD COLUMN IF NOT EXISTS native_rate NUMERIC(20, 6),
     ADD COLUMN IF NOT EXISTS native_line_total NUMERIC(20, 2)`,
] as const;

export async function ensurePurchaseOrderCurrencySchema(pool: DatabasePool): Promise<void> {
  for (const statement of PURCHASE_ORDER_CURRENCY_SCHEMA_SQL) {
    await pool.query(statement);
  }
  logger.info("[startup] ✓ Purchase order native currency columns ensured");
}
