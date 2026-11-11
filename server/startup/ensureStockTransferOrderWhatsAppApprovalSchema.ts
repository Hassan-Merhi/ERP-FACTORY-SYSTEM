/**
 * Production-safe Phase 1 schema ensure.
 *
 * Render disables the bulk startup migration pass in some environments. These
 * additive, idempotent statements must therefore run before requests are
 * served, even if that bulk pass is disabled. No existing accounting rows
 * are rewritten or deleted.
 */
import type { Pool } from "pg";
import { stockTransferOrderWaApprovalFoundation } from "../startup-schema/039-stock-transfer-order-wa-approval";

export async function ensureStockTransferOrderWhatsAppApprovalSchema(pool: Pick<Pool, "query">): Promise<void> {
  for (const statement of stockTransferOrderWaApprovalFoundation) {
    await pool.query(statement);
  }
}
