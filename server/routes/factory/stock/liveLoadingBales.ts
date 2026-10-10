/**
 * V5 loaded bales stay IN_STOCK while on a live loading (main #2134). A stock
 * writer that takes a bale out of stock (waste disposal) refuses such a bale:
 * it would leave stock while still counted on that loading and in Priority
 * Scan, so it must be removed from the loading first.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";

export async function assertNoBaleOnLiveLoadingTx(
  tx: DbTransaction,
  companyId: number,
  baleIds: readonly number[]
): Promise<void> {
  if (baleIds.length === 0) return;
  const loaded = await tx.execute(sql`
    SELECT fb.reference_number AS "referenceNumber"
      FROM customer_order_bales cob
      JOIN customer_orders co ON co.id = cob.order_id
      JOIN factory_bales fb ON fb.id = cob.bale_id
     WHERE cob.bale_id = ANY(string_to_array(${baleIds.join(",")}, ',')::int[])
       AND co.company_id = ${companyId} AND co.status <> 'CANCELLED' AND co.deleted_at IS NULL
     LIMIT 1
  `);
  const loadedRow = resultRows(loaded)[0] as { referenceNumber?: string } | undefined;
  if (loadedRow) {
    throw new Error(`Bale ${loadedRow.referenceNumber} is on a customer loading. Remove it from the loading first.`);
  }
}
