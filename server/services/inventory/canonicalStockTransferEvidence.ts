import Decimal from "decimal.js";
import { ConvergenceReconciliationError } from "../accounting/convergenceReconciliation";
import type { StockTransferMovementEvidence } from "./databaseStockTransferConvergenceAdapter";

export interface CanonicalStockTransferMovementRow {
  companyId: number;
  sourceType: string;
  sourceId: string;
  quantityDelta: string;
  unitCost: string;
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

function identity(sourceType: unknown, sourceId: unknown): string {
  const type = String(sourceType ?? "").trim();
  const id = String(sourceId ?? "").trim();
  if (!type || !id) {
    throw new ConvergenceReconciliationError(
      "CONVERGENCE_IDENTITY_INVALID",
      "Canonical stock transfer movement requires sourceType and sourceId"
    );
  }
  return `${type}:${id}`;
}

/**
 * Converts canonical stock movement rows into logical stock-transfer evidence.
 * Because a transfer has equal-and-opposite location legs, net aggregation would
 * incorrectly produce zero. We compare the positive receipt leg while requiring
 * the issue and receipt quantities and values to balance exactly.
 */
export function summarizeCanonicalStockTransferEvidence(input: {
  companyId: number;
  rows: CanonicalStockTransferMovementRow[];
}): StockTransferMovementEvidence[] {
  const companyId = positiveInteger(input.companyId, "companyId");
  const grouped = new Map<
    string,
    {
      sourceId: string;
      positiveQuantity: Decimal;
      negativeQuantity: Decimal;
      positiveValue: Decimal;
      negativeValue: Decimal;
      rowCount: number;
    }
  >();

  for (const row of input.rows) {
    if (positiveInteger(row.companyId, "movement.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Canonical movement ${row.sourceId} crossed the requested company boundary`
      );
    }

    const key = identity(row.sourceType, row.sourceId);
    if (String(row.sourceType).trim() !== "stock-transfer") {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_UNEXPECTED_STOCK_EVIDENCE",
        `Canonical movement ${key} is not stock-transfer evidence`
      );
    }

    const quantity = decimal(row.quantityDelta, "movement.quantityDelta");
    const unitCost = decimal(row.unitCost, "movement.unitCost");
    if (quantity.isZero() || unitCost.isNegative()) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_INVALID",
        `Canonical movement ${key} has an invalid transfer quantity or unit cost`
      );
    }

    let group = grouped.get(key);
    if (!group) {
      group = {
        sourceId: String(row.sourceId).trim(),
        positiveQuantity: new Decimal(0),
        negativeQuantity: new Decimal(0),
        positiveValue: new Decimal(0),
        negativeValue: new Decimal(0),
        rowCount: 0,
      };
      grouped.set(key, group);
    }

    const quantityAbs = quantity.abs();
    const valueAbs = quantityAbs.mul(unitCost);
    if (quantity.isPositive()) {
      group.positiveQuantity = group.positiveQuantity.plus(quantityAbs);
      group.positiveValue = group.positiveValue.plus(valueAbs);
    } else {
      group.negativeQuantity = group.negativeQuantity.plus(quantityAbs);
      group.negativeValue = group.negativeValue.plus(valueAbs);
    }
    group.rowCount += 1;
  }

  return Array.from(grouped.entries()).map(([key, group]) => {
    if (
      group.rowCount < 2 ||
      group.positiveQuantity.isZero() ||
      group.negativeQuantity.isZero() ||
      !group.positiveQuantity.eq(group.negativeQuantity) ||
      !group.positiveValue.eq(group.negativeValue)
    ) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_UNBALANCED",
        `Canonical transfer ${key} does not have exactly balanced issue/receipt evidence`
      );
    }

    return {
      sourceType: "stock-transfer",
      sourceId: group.sourceId,
      companyId,
      movementQuantity: group.positiveQuantity.toFixed(),
      movementValue: group.positiveValue.toFixed(),
    };
  });
}

/**
 * Revision-aware, signed evidence for reconciliation against the CURRENT
 * transfer document. A complete transfer edit first moves old stock back out
 * of the destination and then moves the replacement in. Immutable approval
 * revisions instead move only the changed quantity. Both workflows are
 * correctly reconciled by the NET stock delta at the document destination.
 *
 * Never sum absolute receipt legs: that counts reversals and past revisions as
 * new stock. Every batch must have one issue and one equal receipt. Old
 * destinations are checked for integrity but contribute zero to CURRENT stock.
 */
export interface CanonicalStockTransferNetMovementRow extends CanonicalStockTransferMovementRow {
  idempotencyKey: string;
  stockItemId: number;
  locationId: number;
  destinationLocationId: number;
}

export function summarizeCanonicalStockTransferNetEvidence(input: {
  companyId: number;
  rows: CanonicalStockTransferNetMovementRow[];
}): StockTransferMovementEvidence[] {
  const companyId = positiveInteger(input.companyId, "companyId");
  const batches = new Map<
    string,
    {
      sourceId: string;
      destinationLocationId: number;
      rows: Array<{
        stockItemId: number;
        locationId: number;
        quantity: Decimal;
        unitCost: Decimal;
      }>;
    }
  >();

  for (const row of input.rows) {
    if (positiveInteger(row.companyId, "movement.companyId") !== companyId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_COMPANY_MISMATCH",
        `Canonical transfer ${row.sourceId} crossed the requested company boundary`
      );
    }
    if (row.sourceType !== "stock-transfer") {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_UNEXPECTED_STOCK_EVIDENCE",
        `Unexpected canonical movement source type ${row.sourceType}`
      );
    }
    const sourceId = String(row.sourceId ?? "").trim();
    const key = String(row.idempotencyKey ?? "").trim();
    if (!sourceId || !key) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_IDENTITY_INVALID",
        "Canonical transfer movement requires source and idempotency identities"
      );
    }

    const stockItemId = positiveInteger(row.stockItemId, "stockItemId");
    const locationId = positiveInteger(row.locationId, "locationId");
    const destinationLocationId = positiveInteger(row.destinationLocationId, "destinationLocationId");
    const quantity = decimal(row.quantityDelta, "movement.quantityDelta");
    const unitCost = decimal(row.unitCost, "movement.unitCost");
    if (quantity.isZero() || unitCost.isNegative()) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_INVALID",
        `Canonical transfer ${sourceId} contains an invalid quantity or cost`
      );
    }

    const batchKey = JSON.stringify([sourceId, key]);
    const existing = batches.get(batchKey);
    if (existing && existing.destinationLocationId !== destinationLocationId) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_INVALID",
        `Canonical transfer ${sourceId} has conflicting destination locations`
      );
    }
    const batch = existing ?? { sourceId, destinationLocationId, rows: [] };
    batch.rows.push({ stockItemId, locationId, quantity, unitCost });
    if (batch.rows.length > 2) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_INVALID",
        `Canonical transfer ${sourceId} has too many legs for one journal batch`
      );
    }
    batches.set(batchKey, batch);
  }

  const byTransfer = new Map<string, { quantity: Decimal; value: Decimal }>();
  for (const batch of batches.values()) {
    const [first, second] = batch.rows;
    if (
      batch.rows.length !== 2 ||
      first.stockItemId !== second.stockItemId ||
      first.locationId === second.locationId ||
      !first.quantity.eq(second.quantity.negated()) ||
      !first.unitCost.eq(second.unitCost)
    ) {
      throw new ConvergenceReconciliationError(
        "CONVERGENCE_STOCK_EVIDENCE_UNBALANCED",
        `Canonical transfer ${batch.sourceId} has invalid or unbalanced issue/receipt legs`
      );
    }
    // A transfer may have been edited to a NEW destination. Its historical
    // issue and reversal pairs remain in the append-only journal, but neither
    // leg contributes to the CURRENT destination. Validate the paired batch
    // above, then skip it if the old destination is no longer relevant.
    const destLeg =
      first.locationId === batch.destinationLocationId
        ? first
        : second.locationId === batch.destinationLocationId
          ? second
          : null;
    if (!destLeg) continue;
    const current = byTransfer.get(batch.sourceId) ?? {
      quantity: new Decimal(0),
      value: new Decimal(0),
    };
    current.quantity = current.quantity.plus(destLeg.quantity);
    current.value = current.value.plus(destLeg.quantity.mul(destLeg.unitCost));
    byTransfer.set(batch.sourceId, current);
  }
  return [...byTransfer.entries()].map(([sourceId, totals]) => ({
    sourceType: "stock-transfer",
    sourceId,
    companyId,
    movementQuantity: totals.quantity.toFixed(),
    movementValue: totals.value.toFixed(),
  }));
}
