import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import { ConvergenceReconciliationError, type StockConvergenceSnapshot } from "../accounting/convergenceReconciliation";
import type { db } from "../../db";
import { canonicalJournalStartedAt } from "./canonicalJournalStart";

/** The concrete drizzle transaction handle, inferred from the shared client. */
type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StockTransferDocumentSnapshot {
  sourceType: "stock-transfer";
  sourceId: string;
  transferId: number;
  voucherId: number;
  destinationLocationId?: number;
  companyId: number;
  inventoryApplied?: boolean | null;
  documentQuantity: string;
  documentValue: string;
}

export interface StockTransferMovementEvidence {
  sourceType: "stock-transfer";
  sourceId: string;
  companyId: number;
  movementQuantity: string;
  movementValue: string;
}

export type StockTransferMovementEvidenceLoader = (input: {
  tx: DrizzleTransaction;
  companyId: number;
  documents: StockTransferDocumentSnapshot[];
}) => Promise<StockTransferMovementEvidence[]>;

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConvergenceReconciliationError("CONVERGENCE_DATABASE_ROW_INVALID", `${field} must be a positive integer`);
  }
  return parsed;
}

function decimalString(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new ConvergenceReconciliationError("CONVERGENCE_DATABASE_ROW_INVALID", `${field} is required`);
  }
  return normalized;
}

function identity(sourceType: unknown, sourceId: unknown): string {
  const type = String(sourceType ?? "").trim();
  const id = String(sourceId ?? "").trim();
  if (!type || !id) {
    throw new ConvergenceReconciliationError(
      "CONVERGENCE_IDENTITY_INVALID",
      "Stock transfer convergence evidence requires sourceType and sourceId"
    );
  }
  return `${type}:${id}`;
}

/**
 * Reads all nonoptional, active stock-transfer documents created after the
 * canonical journal began. A stale inventoryApplied=false flag must not hide
 * a transfer that actually posted stock (for example an imported transfer).
 * Draft/optional/deleted and pre-journal historical transfers are excluded;
 * pre-journal evidence cannot be reconstructed from this append-only journal.
 */
export async function loadDatabaseStockTransferDocuments(input: {
  tx: DrizzleTransaction;
  companyId: number;
}): Promise<StockTransferDocumentSnapshot[]> {
  const { tx, companyId } = input;
  const journalStart = await canonicalJournalStartedAt(tx, companyId);
  if (!journalStart) return [];

  const rows = await tx
    .select({
      transferId: stockTransferVouchers.id,
      voucherId: stockTransferVouchers.voucherId,
      destinationLocationId: stockTransferVouchers.destinationLocationId,
      companyId: vouchers.companyId,
      inventoryApplied: stockTransferVouchers.inventoryApplied,
      itemCount: sql<number>`count(${stockTransferItems.id})`,
      documentQuantity: sql<string>`coalesce(sum(${stockTransferItems.quantity}), 0)`,
      documentValue: sql<string>`coalesce(sum(${stockTransferItems.totalAmount}), 0)`,
    })
    .from(stockTransferVouchers)
    .innerJoin(vouchers, eq(vouchers.id, stockTransferVouchers.voucherId))
    .leftJoin(stockTransferItems, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false),
        // Do not trust inventoryApplied as a completeness filter: the
        // canonical journal must prove whether stock was actually posted.
        gte(stockTransferVouchers.createdAt, journalStart),
        inArray(vouchers.voucherType, ["Stock Transfer", "StockTransfer", "Transfer"])
      )
    )
    .groupBy(
      stockTransferVouchers.id,
      stockTransferVouchers.voucherId,
      stockTransferVouchers.destinationLocationId,
      vouchers.companyId,
      stockTransferVouchers.inventoryApplied
    );

  return rows.map((row: Record<string, unknown>) => {
    const transferId = positiveInteger(row.transferId, "transferId");
    const voucherId = positiveInteger(row.voucherId, "voucherId");
    const rowCompanyId = positiveInteger(row.companyId, "companyId");
    if (rowCompanyId !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock transfer ${transferId} crossed the requested company boundary`
      );
    }

    const itemCount = Number(row.itemCount ?? 0);
    if (!Number.isInteger(itemCount) || itemCount <= 0) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_TRANSFER_EMPTY",
        `Posted stock transfer ${transferId} has no persisted items`
      );
    }

    return {
      sourceType: "stock-transfer" as const,
      sourceId: String(transferId),
      transferId,
      voucherId,
      destinationLocationId: positiveInteger(row.destinationLocationId, "destinationLocationId"),
      companyId: rowCompanyId,
      inventoryApplied: row.inventoryApplied === true ? true : row.inventoryApplied === false ? false : null,
      documentQuantity: decimalString(row.documentQuantity, "documentQuantity"),
      documentValue: decimalString(row.documentValue, "documentValue"),
    };
  });
}

/**
 * Joins authoritative stock-transfer documents to canonical movement evidence.
 * Missing, duplicate, cross-company, malformed, or unexpected movement evidence
 * fails closed so reconciliation cannot silently certify partial inventory data.
 */
export function mergeStockTransferConvergenceEvidence(input: {
  companyId: number;
  documents: StockTransferDocumentSnapshot[];
  evidence: StockTransferMovementEvidence[];
}): StockConvergenceSnapshot[] {
  const companyId = positiveInteger(input.companyId, "companyId");
  const documentsByIdentity = new Map<string, StockTransferDocumentSnapshot>();

  for (const document of input.documents) {
    if (positiveInteger(document.companyId, "document.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock transfer document ${document.sourceId} crossed the requested company boundary`
      );
    }
    const key = identity(document.sourceType, document.sourceId);
    if (documentsByIdentity.has(key)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_DUPLICATE_SNAPSHOT",
        `Duplicate stock transfer document ${key}`
      );
    }
    documentsByIdentity.set(key, document);
  }

  const evidenceByIdentity = new Map<string, StockTransferMovementEvidence>();
  for (const row of input.evidence) {
    if (positiveInteger(row.companyId, "evidence.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Stock transfer movement ${row.sourceId} crossed the requested company boundary`
      );
    }
    const key = identity(row.sourceType, row.sourceId);
    if (!documentsByIdentity.has(key)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_UNEXPECTED_STOCK_EVIDENCE",
        `Movement evidence ${key} has no authoritative stock transfer document`
      );
    }
    if (evidenceByIdentity.has(key)) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_DUPLICATE_SNAPSHOT",
        `Duplicate stock transfer movement evidence ${key}`
      );
    }
    evidenceByIdentity.set(key, row);
  }

  return Array.from(documentsByIdentity.entries()).map(([key, document]) => {
    const movement = evidenceByIdentity.get(key);
    if (!movement) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_MISSING",
        `Posted stock transfer ${key} has no canonical movement evidence`
      );
    }
    return {
      sourceType: document.sourceType,
      sourceId: document.sourceId,
      companyId,
      inventoryApplied: document.inventoryApplied,
      documentQuantity: decimalString(document.documentQuantity, "documentQuantity"),
      movementQuantity: decimalString(movement.movementQuantity, "movementQuantity"),
      documentValue: decimalString(document.documentValue, "documentValue"),
      movementValue: decimalString(movement.movementValue, "movementValue"),
    };
  });
}
