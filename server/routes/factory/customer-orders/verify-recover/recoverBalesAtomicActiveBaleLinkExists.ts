// Extracted from ./recoverBalesAtomic.ts
import { sql } from "drizzle-orm";
import { type DbTransaction } from "../../../../db";
import { firstRow } from "../../../../lib/queryResult";

export const RECOVERABLE_STATUSES = ["LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"];

export async function activeBaleLinkExists(tx: DbTransaction, baleId: number, orderId: number): Promise<boolean> {
  return !!firstRow(
    await tx.execute(sql`
      SELECT cob.order_id
      FROM customer_order_bales cob
      JOIN customer_orders co ON co.id = cob.order_id
      WHERE cob.bale_id = ${baleId}
        AND cob.order_id <> ${orderId}
        AND co.status <> 'CANCELLED'
        AND co.deleted_at IS NULL
      LIMIT 1
    `)
  );
}
