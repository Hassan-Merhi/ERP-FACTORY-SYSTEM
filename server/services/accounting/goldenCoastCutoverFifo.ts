import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";

export const GOLDEN_COAST_CUTOVER_DATE = "2026-09-01";
export const GOLDEN_COAST_CUTOVER_FIFO_SOURCE = "golden_coast_cutover";

export class GoldenCoastPhase4CutoverError extends Error {
  constructor(message: string) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase4CutoverError";
  }
}

export interface GoldenCoastInventorySnapshotRow {
  inventoryId: number;
  locationId: number;
  stockItemId: number;
  articleCode: string;
  description?: string | null;
  quantity: string | number;
  averageRate: string | number;
}

export interface GoldenCoastCutoverFifoMovement {
  companyId: number;
  sourceType: typeof GOLDEN_COAST_CUTOVER_FIFO_SOURCE;
  articleCode: string;
  description: string;
  stockItemId: number;
  locationId: number;
  qtyIn: string;
  qtyRemaining: string;
  baseUnitCostUsd: string;
  landedUnitCostUsd: string;
  finalUnitCostUsd: string;
}

function positiveId(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GoldenCoastPhase4CutoverError(`${label} must be a positive integer`);
  }
  return value;
}

function decimal(value: string | number, label: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase4CutoverError(`${label} must be numeric`);
  }
}

export function buildGoldenCoastCutoverFifoPlan(input: {
  companyId: number;
  stockInHandOpeningUsd: string | number;
  inventory: readonly GoldenCoastInventorySnapshotRow[];
}) {
  const companyId = positiveId(input.companyId, "companyId");
  const opening = decimal(input.stockInHandOpeningUsd, "stockInHandOpeningUsd");
  if (opening.isNegative()) {
    throw new GoldenCoastPhase4CutoverError("stockInHandOpeningUsd cannot be negative");
  }

  const seenInventoryIds = new Set<number>();
  const seenItemLocations = new Set<string>();
  const movements: GoldenCoastCutoverFifoMovement[] = [];
  let snapshotValue = new Decimal(0);

  for (const row of input.inventory) {
    const inventoryId = positiveId(row.inventoryId, "inventoryId");
    const locationId = positiveId(row.locationId, `inventory ${inventoryId} locationId`);
    const stockItemId = positiveId(row.stockItemId, `inventory ${inventoryId} stockItemId`);
    const articleCode = String(row.articleCode ?? "").trim();
    if (!articleCode) {
      throw new GoldenCoastPhase4CutoverError(`inventory ${inventoryId} is missing an article code`);
    }
    if (seenInventoryIds.has(inventoryId)) {
      throw new GoldenCoastPhase4CutoverError(`duplicate inventory row ${inventoryId}`);
    }
    const itemLocationKey = `${stockItemId}:${locationId}`;
    if (seenItemLocations.has(itemLocationKey)) {
      throw new GoldenCoastPhase4CutoverError(`duplicate stock item/location snapshot ${itemLocationKey}`);
    }
    seenInventoryIds.add(inventoryId);
    seenItemLocations.add(itemLocationKey);

    const quantity = decimal(row.quantity, `inventory ${inventoryId} quantity`);
    const rate = decimal(row.averageRate, `inventory ${inventoryId} averageRate`);
    if (quantity.isNegative() || rate.isNegative()) {
      throw new GoldenCoastPhase4CutoverError(`inventory ${inventoryId} quantity and average rate cannot be negative`);
    }
    if (quantity.isZero()) continue;
    if (rate.isZero()) {
      throw new GoldenCoastPhase4CutoverError(`inventory ${inventoryId} has positive quantity with zero average rate`);
    }

    snapshotValue = snapshotValue.plus(quantity.times(rate));
    const unitCost = rate.toDecimalPlaces(6).toFixed(6);
    const descriptionSuffix = row.description ? ` — ${row.description}` : "";
    movements.push({
      companyId,
      sourceType: GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
      articleCode,
      description: releaseDebtEnglish(
        `Golden Coast ${GOLDEN_COAST_CUTOVER_DATE} opening FIFO snapshot ` +
          `from ERP inventory #${inventoryId}${descriptionSuffix}`
      ),
      stockItemId,
      locationId,
      qtyIn: quantity.toDecimalPlaces(4).toFixed(4),
      qtyRemaining: quantity.toDecimalPlaces(4).toFixed(4),
      baseUnitCostUsd: unitCost,
      landedUnitCostUsd: unitCost,
      finalUnitCostUsd: unitCost,
    });
  }

  const roundedSnapshot = snapshotValue.toDecimalPlaces(2);
  const roundedOpening = opening.toDecimalPlaces(2);
  const difference = roundedSnapshot.minus(roundedOpening);
  if (!difference.isZero()) {
    throw new GoldenCoastPhase4CutoverError(
      `ERP inventory snapshot value ${roundedSnapshot.toFixed(2)} does not reconcile to ` +
        `Phase 3 Stock in Hand opening ${roundedOpening.toFixed(2)} (difference ${difference.toFixed(2)})`
    );
  }

  return {
    cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
    companyId,
    rowCount: movements.length,
    totalValueUsd: roundedSnapshot.toFixed(2),
    movements,
  };
}
