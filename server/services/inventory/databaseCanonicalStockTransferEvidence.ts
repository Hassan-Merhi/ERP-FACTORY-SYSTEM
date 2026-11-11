import { sql } from "drizzle-orm";
import { ConvergenceReconciliationError } from "../accounting/convergenceReconciliation";
import { summarizeCanonicalStockTransferEvidence } from "./canonicalStockTransferEvidence";
import type {
  StockTransferDocumentSnapshot,
  StockTransferMovementEvidence,
  StockTransferMovementEvidenceLoader,
} from "./databaseStockTransferConvergenceAdapter";

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConvergenceReconciliationError("CONVERGENCE_DATABASE_ROW_INVALID", `${field} must be a positive integer`);
  }
  return parsed;
}

/**
 * Drivers differ: some return `{ rows }`, others the row array itself. Anything
 * that is neither is handed back untouched so the caller's array check fails it.
 */
function resultRows(result: unknown): unknown {
  if (typeof result === "object" && result !== null && "rows" in result) {
    return result.rows;
  }
  return result ?? [];
}

function sourceIds(documents: StockTransferDocumentSnapshot[]): string[] {
  const seen = new Set<string>();
  for (const document of documents) {
    const id = String(document.sourceId ?? "").trim();
    if (!id) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_IDENTITY_INVALID",
        "Stock transfer document requires sourceId"
      );
    }
    if (seen.has(id)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_DUPLICATE_SNAPSHOT",
        `Duplicate stock transfer document stock-transfer:${id}`
      );
    }
    seen.add(id);
  }
  return [...seen];
}

/**
 * Reads canonical movement evidence only for the authoritative stock-transfer
 * documents supplied by the database document adapter. Ordinary writes are
 * keyed by transfer ID while both Excel-import writers are keyed by voucher ID.
 * The explicit requested (transfer, voucher) pairs prevent a cross-document
 * match and normalize every movement to the transfer document's identity.
 */
export const loadDatabaseCanonicalStockTransferEvidence: StockTransferMovementEvidenceLoader = async ({
  tx,
  companyId,
  documents,
}): Promise<StockTransferMovementEvidence[]> => {
  const scopedCompanyId = positiveInteger(companyId, "companyId");
  if (documents.length === 0) return [];

  for (const document of documents) {
    if (positiveInteger(document.companyId, "document.companyId") !== scopedCompanyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock transfer ${document.sourceId} crossed the requested company boundary`
      );
    }
  }

  const ids = sourceIds(documents);
  // The ordinary transfer writer identifies evidence by transfer ID; the two
  // Excel-import writers identify the same transfer by its voucher ID and a
  // distinct source type. Normalize all three to the authoritative document's
  // transfer ID before the balanced-leg summarizer evaluates them.
  const pairs = sql.join(
    documents.map((document) =>
      sql`(${String(positiveInteger(document.transferId, "document.transferId"))}, ${String(positiveInteger(document.voucherId, "document.voucherId"))})`
    ),
    sql`, `
  );
  const result = await tx.execute(sql`
    WITH requested(transfer_id, voucher_id) AS (VALUES ${pairs})
    SELECT
      movement.company_id AS "companyId",
      'stock-transfer'::text AS "sourceType",
      requested.transfer_id AS "sourceId",
      movement.source_type AS "originalSourceType",
      movement.quantity_delta AS "quantityDelta",
      movement.unit_cost AS "unitCost"
    FROM requested
    INNER JOIN canonical_stock_movements movement
      ON movement.company_id = ${scopedCompanyId}
     AND (
       (movement.source_type = 'stock-transfer'
        AND movement.source_id = requested.transfer_id)
       OR
       (movement.source_type IN ('stock-transfer-import', 'stock-transfer-import-multi-source')
        AND movement.source_id = requested.voucher_id)
     )
    ORDER BY requested.transfer_id, movement.id
  `);

  const rows = resultRows(result);
  if (!Array.isArray(rows)) {
    throw new ConvergenceReconciliationError(
      "CONVERGENCE_ADAPTER_INVALID",
      "Canonical stock movement database query must return rows"
    );
  }

  const requested = new Set(ids);
  for (const row of rows) {
    const rowCompanyId = positiveInteger(row.companyId, "movement.companyId");
    const rowSourceType = String(row.sourceType ?? "").trim();
    const rowSourceId = String(row.sourceId ?? "").trim();
    if (rowCompanyId !== scopedCompanyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Canonical movement ${rowSourceId} crossed the requested company boundary`
      );
    }
    if (rowSourceType !== "stock-transfer" || !requested.has(rowSourceId)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_UNEXPECTED_STOCK_EVIDENCE",
        `Canonical movement ${rowSourceType}:${rowSourceId} was not requested`
      );
    }
  }

  return summarizeCanonicalStockTransferEvidence({
    companyId: scopedCompanyId,
    rows: rows.map((row: Record<string, unknown>) => ({
      // Each row was validated in the loop above; these repeat the same
      // normalisation so the summariser receives the declared row types.
      companyId: positiveInteger(row.companyId, "movement.companyId"),
      sourceType: String(row.sourceType ?? "").trim(),
      sourceId: String(row.sourceId ?? "").trim(),
      quantityDelta: String(row.quantityDelta),
      unitCost: String(row.unitCost),
    })),
  });
};
