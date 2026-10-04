import type { Pool } from "pg";

import { logger } from "../../lib/logger";
import { ensureAccountingPostingRequests } from "../accounting/ensureAccountingPostingRequests";

import { canonicalStockMovementJournal } from "../../startup-schema/021-canonical-stock-movement-journal";
import { inventoryValuationOverrides } from "../../startup-schema/031-inventory-valuation-overrides";

/**
 * Creates the canonical stock movement journal regardless of migration mode.
 *
 * Stock transfers write their canonical evidence inside the same transaction
 * that applies inventory, so these tables must exist wherever the application
 * runs — including production, which skips the ordered startup pass via
 * RUN_STARTUP_MIGRATIONS=false.
 *
 * This unconditional startup hook also ensures the accounting posting request
 * table. Both are write-safety evidence that must exist before routes serve
 * mutations, including deployments where the ordered startup pass is disabled.
 *
 * This rejects rather than resolving on failure. A deployment that cannot
 * record canonical write evidence must fail loudly at startup instead of serving
 * writes without their journal/idempotency protection.
 */
export async function ensureCanonicalStockMovementJournal(pool: Pool): Promise<void> {
  for (const statement of [...canonicalStockMovementJournal, ...inventoryValuationOverrides]) {
    await pool.query(statement);
  }
  logger.info("[startup] ✓ Canonical stock movement journal ensured");

  await ensureAccountingPostingRequests(pool);
}
