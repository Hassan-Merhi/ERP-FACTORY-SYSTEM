/**
 * A posted ERP supplier return preserves its original offload and line IDs.
 * Removing either source would orphan the immutable return audit and its
 * supplier-credit/accounting evidence.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";

export class OffloadLinkedSupplierReturnError extends Error {
  readonly code = "OFFLOAD_HAS_SUPPLIER_RETURNS";
  readonly status = 409;

  constructor(batchIds: number[]) {
    const batchLabels = batchIds.map((id) => `#${id}`).join(", ");
    const plural = batchIds.length === 1 ? "" : "es";
    const verb = batchIds.length === 1 ? "references" : "reference";
    super(
      `Cannot reverse this offload because supplier return batch${plural} ${batchLabels} ${verb} its stock. Review Supplier Returns history and arrange an accounting-safe correction before reversing; no inventory or vouchers were changed.`
    );
    this.name = "OffloadLinkedSupplierReturnError";
  }
}

/**
 * Lock the source lines before checking for posted returns. The ERP return
 * writer also locks these lines, preventing a return from racing a reversal.
 * The controlled supplier-return migration may not exist in all environments.
 */
export async function assertNoLinkedSupplierReturnsTx(
  tx: DbTransaction,
  companyId: number,
  offloadId: number
): Promise<void> {
  await tx.execute(sql`
    SELECT id FROM container_offload_items
    WHERE offload_id = ${offloadId} ORDER BY id FOR UPDATE
  `);
  const [table] = resultRows<{ tableName: string | null }>(
    await tx.execute(sql`SELECT to_regclass('public.erp_supplier_return_lines')::text AS "tableName"`)
  );
  if (!table?.tableName) return;

  const batches = resultRows<{ batchId: number }>(
    await tx.execute(sql`
      SELECT DISTINCT batch_id::integer AS "batchId"
      FROM erp_supplier_return_lines
      WHERE company_id = ${companyId} AND offload_id = ${offloadId}
      ORDER BY "batchId" LIMIT 5
    `)
  );
  if (batches.length) throw new OffloadLinkedSupplierReturnError(batches.map((row) => row.batchId));
}
