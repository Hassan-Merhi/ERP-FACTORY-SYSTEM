import { pool } from "../../db";
import {
  InventoryCutoverRefusalError,
  PERPETUAL_INVENTORY_ACTIVE,
  PERPETUAL_INVENTORY_ACTIVE_MESSAGE,
} from "../accounting/perpetualInventory/cutoverRefusal";
import { enableMaintenanceScope } from "./historicalSalesCostRepairLoaders";

/**
 * Wave 11: applying (or rolling back) a historical sales-cost repair rewrites
 * stock costs with no journal, so it is refused when any company the run
 * touches has its perpetual-inventory cut-over applied. Dry runs, previews and
 * reports stay available.
 */
export async function assertRunBeforeCutover(runId: number, action: string): Promise<void> {
  const client = await pool.connect();
  let refused: { company_id: number; effective_from: string } | undefined;
  try {
    await client.query("BEGIN");
    await enableMaintenanceScope(client);
    const { rows } = await client.query<{ company_id: number; effective_from: string }>(
      `SELECT c.company_id, gic.effective_from::text AS effective_from
         FROM (SELECT DISTINCT company_id FROM historical_sales_cost_repair_rows WHERE run_id = $1
               UNION SELECT unnest(requested_company_ids) FROM historical_sales_cost_repair_runs WHERE id = $1) c
         JOIN gl_inventory_cutovers gic ON gic.company_id = c.company_id
        ORDER BY c.company_id LIMIT 1`,
      [runId]
    );
    refused = rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (refused) {
    throw new InventoryCutoverRefusalError({
      code: PERPETUAL_INVENTORY_ACTIVE,
      message: PERPETUAL_INVENTORY_ACTIVE_MESSAGE,
      action,
      effectiveFrom: refused.effective_from,
    });
  }
}
