import Decimal from "decimal.js";
import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { stockAdjustmentItems, stockAdjustmentVouchers, vouchers } from "@shared/schema";
import type { db } from "../../db";
import { ConvergenceReconciliationError, type StockConvergenceSnapshot } from "../accounting/convergenceReconciliation";
import { canonicalJournalStartedAt } from "./canonicalJournalStart";

/** The concrete drizzle transaction handle, inferred from the shared client. */
type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StockAdjustmentDocumentSnapshot {
  sourceType: "stock-adjustment";
  sourceId: string;
  adjustmentId: number;
  voucherId: number;
  companyId: number;
  documentQuantity: string;
  documentValue: string;
}

export interface StockAdjustmentMovementEvidence {
  sourceType: "stock-adjustment";
  sourceId: string;
  companyId: number;
  movementQuantity: string;
  movementValue: string;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConvergenceReconciliationError("CONVERGENCE_DATABASE_ROW_INVALID", `${field} must be a positive integer`);
  }
  return parsed;
}

function decimal(value: unknown, field: string): Decimal {
  const normalized = String(value ?? "").trim();
  try {
    const parsed = new Decimal(normalized);
    if (!normalized || !parsed.isFinite()) throw new Error("invalid");
    return parsed;
  } catch {
    throw new ConvergenceReconciliationError("CONVERGENCE_DATABASE_ROW_INVALID", `${field} must be a finite decimal`);
  }
}

/**
 * Reads the authoritative, inventory-applied stock adjustment documents for one
 * company.
 *
 * Optional (draft) and deleted vouchers are excluded because they never applied
 * stock, and documents that predate the canonical journal are excluded because
 * no evidence exists or ever will for them.
 *
 * An adjustment line is signed on the document — production is positive,
 * consumption negative — while the journal records a receipt or an issue with
 * the magnitude. The document total therefore sums absolute quantities, so both
 * sides describe the same movement.
 */
export async function loadDatabaseStockAdjustmentDocuments(input: {
  tx: DrizzleTransaction;
  companyId: number;
}): Promise<StockAdjustmentDocumentSnapshot[]> {
  const { tx, companyId } = input;
  const journalStart = await canonicalJournalStartedAt(tx, companyId);
  if (!journalStart) return [];

  const rows = await tx
    .select({
      adjustmentId: stockAdjustmentVouchers.id,
      voucherId: stockAdjustmentVouchers.voucherId,
      companyId: vouchers.companyId,
      documentQuantity: sql<string>`coalesce(sum(abs(${stockAdjustmentItems.quantity})), 0)`,
      documentValue: sql<string>`coalesce(sum(abs(${stockAdjustmentItems.totalAmount})), 0)`,
    })
    .from(stockAdjustmentVouchers)
    .innerJoin(vouchers, eq(vouchers.id, stockAdjustmentVouchers.voucherId))
    .leftJoin(stockAdjustmentItems, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
        gte(stockAdjustmentVouchers.createdAt, journalStart)
      )
    )
    .groupBy(stockAdjustmentVouchers.id, stockAdjustmentVouchers.voucherId, vouchers.companyId);

  const documents: StockAdjustmentDocumentSnapshot[] = [];
  for (const row of rows) {
    const adjustmentId = positiveInteger(row.adjustmentId, "adjustmentId");
    const rowCompanyId = positiveInteger(row.companyId, "companyId");
    if (rowCompanyId !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock adjustment ${adjustmentId} crossed the requested company boundary`
      );
    }

    const documentQuantity = decimal(row.documentQuantity, "documentQuantity");
    // A document whose lines all cancel to nothing moved no stock and the
    // journal correctly holds no row for it.
    if (documentQuantity.isZero()) continue;

    documents.push({
      sourceType: "stock-adjustment",
      sourceId: String(adjustmentId),
      adjustmentId,
      voucherId: positiveInteger(row.voucherId, "voucherId"),
      companyId: rowCompanyId,
      documentQuantity: documentQuantity.toFixed(),
      documentValue: decimal(row.documentValue, "documentValue").toFixed(),
    });
  }
  return documents;
}

/**
 * Reads canonical movement evidence for the supplied adjustment documents only.
 *
 * Unlike a transfer, an adjustment has no equal-and-opposite pair: production is
 * a receipt and consumption an issue, each standing alone. The magnitudes are
 * summed per document.
 */
export async function loadDatabaseCanonicalStockAdjustmentEvidence(input: {
  tx: DrizzleTransaction;
  companyId: number;
  documents: StockAdjustmentDocumentSnapshot[];
}): Promise<StockAdjustmentMovementEvidence[]> {
  const { tx, companyId, documents } = input;
  if (documents.length === 0) return [];

  const requested = new Set<string>();
  for (const document of documents) {
    if (positiveInteger(document.companyId, "document.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock adjustment ${document.sourceId} crossed the requested company boundary`
      );
    }
    if (requested.has(document.sourceId)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_DUPLICATE_SNAPSHOT",
        `Duplicate stock adjustment document stock-adjustment:${document.sourceId}`
      );
    }
    requested.add(document.sourceId);
  }

  // Edit movements use the voucher ID, while original movements use the
  // adjustment ID. Each edit reverses the previous version and applies a new
  // set of lines in one transaction. Compare the current document with the
  // most recent applied edit, NOT the sum of all historical apply batches.
  //
  // Preserve the original-evidence requirement: edits may not manufacture a
  // clean reconciliation for a document whose initial stock evidence is absent.
  const documentPairs = sql.join(
    documents.map((document) => sql`(${String(document.adjustmentId)}::text, ${String(document.voucherId)}::text)`),
    sql`, `
  );
  const result = await tx.execute(sql`
    WITH requested(adjustment_id, voucher_id) AS (
      VALUES ${documentPairs}
    ),
    latest AS (
      SELECT
        r.adjustment_id,
        r.voucher_id,
        (
          SELECT max(e.created_at)
          FROM canonical_stock_movements e
          WHERE e.company_id = ${companyId}
            AND e.source_type = 'stock_adjustment_edit_apply'
            AND e.source_id = r.voucher_id
        ) AS last_apply_at
      FROM requested r
    )
    SELECT
      r.adjustment_id AS "sourceId",
      ${companyId}::integer AS "companyId",
      sum(abs(m.quantity_delta)) AS "movementQuantity",
      sum(abs(m.quantity_delta) * m.unit_cost) AS "movementValue"
    FROM latest r
    JOIN canonical_stock_movements m
      ON m.company_id = ${companyId}
     AND (
       (r.last_apply_at IS NOT NULL
        AND m.source_type = 'stock_adjustment_edit_apply'
        AND m.source_id = r.voucher_id
        AND m.created_at = r.last_apply_at)
       OR
       (r.last_apply_at IS NULL
        AND m.source_type = 'stock-adjustment'
        AND m.source_id = r.adjustment_id)
     )
    WHERE EXISTS (
      SELECT 1 FROM canonical_stock_movements initial
      WHERE initial.company_id = ${companyId}
        AND initial.source_type = 'stock-adjustment'
        AND initial.source_id = r.adjustment_id
    )
    AND (
      r.last_apply_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM canonical_stock_movements reversal
        WHERE reversal.company_id = ${companyId}
          AND reversal.source_type = 'stock_adjustment_edit_reverse'
          AND reversal.source_id = r.voucher_id
      )
    )
    GROUP BY r.adjustment_id
  `);

  const rows =
    typeof result === "object" && result !== null && "rows" in result && Array.isArray(result.rows) ? result.rows : [];

  return (rows as Record<string, unknown>[]).map((row) => {
    const sourceId = String(row.sourceId ?? "").trim();
    if (!requested.has(sourceId)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_UNEXPECTED_STOCK_EVIDENCE",
        `Canonical movement stock-adjustment:${sourceId} was not requested`
      );
    }
    if (positiveInteger(row.companyId, "movement.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Canonical movement ${sourceId} crossed the requested company boundary`
      );
    }
    return {
      sourceType: "stock-adjustment" as const,
      sourceId,
      companyId,
      movementQuantity: decimal(row.movementQuantity, "movementQuantity").toFixed(),
      movementValue: decimal(row.movementValue, "movementValue").toFixed(),
    };
  });
}

/**
 * Pairs each applied adjustment document with its canonical evidence. A document
 * with no evidence fails closed: it applied stock without recording that it did.
 */
export function mergeStockAdjustmentConvergenceEvidence(input: {
  companyId: number;
  documents: StockAdjustmentDocumentSnapshot[];
  evidence: StockAdjustmentMovementEvidence[];
}): StockConvergenceSnapshot[] {
  const companyId = positiveInteger(input.companyId, "companyId");
  const evidenceBySource = new Map<string, StockAdjustmentMovementEvidence>();
  for (const entry of input.evidence) {
    if (evidenceBySource.has(entry.sourceId)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_DUPLICATE_SNAPSHOT",
        `Duplicate canonical evidence for stock-adjustment:${entry.sourceId}`
      );
    }
    evidenceBySource.set(entry.sourceId, entry);
  }

  return input.documents.map((document) => {
    const evidence = evidenceBySource.get(document.sourceId);
    if (!evidence) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_MISSING",
        `Posted stock adjustment stock-adjustment:${document.sourceId} has no canonical movement evidence`
      );
    }
    return {
      sourceType: "stock-adjustment",
      sourceId: document.sourceId,
      companyId,
      documentQuantity: document.documentQuantity,
      documentValue: document.documentValue,
      movementQuantity: evidence.movementQuantity,
      movementValue: evidence.movementValue,
    };
  });
}
