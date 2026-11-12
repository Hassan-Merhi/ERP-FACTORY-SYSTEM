import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { firstRow } from "../../lib/queryResult";

/**
 * A false inventory_applied flag is not proof that the stock never moved.
 * A stale flag on an imported transfer can coexist with real, balanced
 * canonical movement pairs; reposting from that flag alone duplicates stock.
 *
 * Count SIGNED movements by item and location across every known writer for
 * this transfer. A fully reversed transfer has zero at each location and can
 * legitimately be reposted, while any outstanding position fails closed.
 *
 * Caller must lock the transfer row and establish company transaction scope.
 * This guard is read-only and never "repairs" the historic metadata.
 */
export async function assertTransferNotAlreadyPostedTx(
  tx: DbTransaction,
  input: { companyId: number; transferId: number; voucherId: number }
): Promise<void> {
  const { companyId, transferId, voucherId } = input;
  if (![companyId, transferId, voucherId].every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("STOCK_TRANSFER_POST_IDENTITY_INVALID");
  }

  const row = firstRow(
    await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM canonical_stock_movements movement
        WHERE movement.company_id = ${companyId}
          AND (
            (movement.source_type = 'stock-transfer' AND movement.source_id = ${String(transferId)})
            OR (
              movement.source_type IN (
                'stock-transfer-import',
                'stock-transfer-import-multi-source',
                'voucher_stock_transfer_edit_reverse',
                'voucher_stock_transfer_edit_apply'
              )
              AND movement.source_id = ${String(voucherId)}
            )
          )
        GROUP BY movement.stock_item_id, movement.location_id
        HAVING SUM(movement.quantity_delta) <> 0
      ) AS "hasOpenMovement"
    `)
  );

  if (row?.hasOpenMovement === true) {
    throw new Error(
      "STOCK_TRANSFER_ALREADY_APPLIED_CANONICAL: stock already moved; inspect the transfer applied flag before posting"
    );
  }
  if (!row || row.hasOpenMovement !== false) {
    // Unknown read result must not permit an irreversible double-post.
    throw new Error(
      "STOCK_TRANSFER_CANONICAL_EVIDENCE_UNVERIFIED: cannot verify whether this transfer already moved stock"
    );
  }
}
