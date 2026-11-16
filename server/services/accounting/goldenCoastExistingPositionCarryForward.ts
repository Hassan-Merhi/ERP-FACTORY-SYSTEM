import Decimal from "decimal.js";
import { GOLDEN_COAST_CUTOVER_DATE, GOLDEN_COAST_CUTOVER_FIFO_SOURCE } from "./goldenCoastCutoverFifo";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "./goldenCoastCutoverMarkers";

export interface ExistingPositionInventoryRow {
  inventoryId: number;
  locationId: number;
  stockItemId: number;
  articleCode: string;
  description?: string | null;
  quantity: string | number;
  averageRate: string | number;
  locationName?: string | null;
}

export interface ExistingPositionOtwContainerRow {
  containerId: number;
  containerNumber: string;
  valueUsd: string | number;
}

export interface ExistingPositionCarryForwardAccounts {
  stockInHandAccountId: number;
  stockOtwAccountId: number;
  openingBalanceClearingAccountId: number;
}

export interface ExistingPositionFifoMovement {
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

export interface ExistingPositionCarryForwardPlan {
  cutoverDate: string;
  companyId: number;
  voucherNumber: string;
  stockInHandUsd: string;
  stockOtwUsd: string;
  totalPositionUsd: string;
  inventoryRowCount: number;
  fifoMovementCount: number;
  locations: Array<{ locationId: number; locationName: string; quantity: string; valueUsd: string; rowCount: number }>;
  otwContainers: Array<{ containerId: number; containerNumber: string; valueUsd: string }>;
  journalEntries: Array<{
    ledgerAccountId: number;
    debitAmount: string;
    creditAmount: string;
    narration: string;
  }>;
  fifoMovements: ExistingPositionFifoMovement[];
}

export class GoldenCoastExistingPositionCarryForwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenCoastExistingPositionCarryForwardError";
  }
}

function positiveId(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GoldenCoastExistingPositionCarryForwardError(`${label} must be a positive integer`);
  }
  return value;
}

function decimal(value: string | number, label: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastExistingPositionCarryForwardError(`${label} must be numeric`);
  }
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function unitCost(value: Decimal): string {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
}

function quantity(value: Decimal): string {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

export function buildGoldenCoastExistingPositionCarryForwardPlan(input: {
  companyId: number;
  accounts: ExistingPositionCarryForwardAccounts;
  inventory: readonly ExistingPositionInventoryRow[];
  otwContainers: readonly ExistingPositionOtwContainerRow[];
}): ExistingPositionCarryForwardPlan {
  const companyId = positiveId(input.companyId, "companyId");
  const accountIds = Object.entries(input.accounts).map(([label, value]) => positiveId(value, label));
  if (new Set(accountIds).size !== accountIds.length) {
    throw new GoldenCoastExistingPositionCarryForwardError(
      "Stock in Hand, Stock OTW, and Opening Balance Clearing must be distinct accounts"
    );
  }

  const seenInventoryIds = new Set<number>();
  const seenItemLocations = new Set<string>();
  const locationTotals = new Map<
    number,
    { locationName: string; quantity: Decimal; value: Decimal; rowCount: number }
  >();
  const fifoMovements: ExistingPositionFifoMovement[] = [];
  let stockInHand = new Decimal(0);

  for (const row of input.inventory) {
    const inventoryId = positiveId(row.inventoryId, "inventoryId");
    const locationId = positiveId(row.locationId, `inventory ${inventoryId} locationId`);
    const stockItemId = positiveId(row.stockItemId, `inventory ${inventoryId} stockItemId`);
    const articleCode = String(row.articleCode ?? "").trim();
    if (!articleCode) {
      throw new GoldenCoastExistingPositionCarryForwardError(`inventory ${inventoryId} is missing an article code`);
    }
    if (seenInventoryIds.has(inventoryId)) {
      throw new GoldenCoastExistingPositionCarryForwardError(`duplicate inventory row ${inventoryId}`);
    }
    const itemLocationKey = `${stockItemId}:${locationId}`;
    if (seenItemLocations.has(itemLocationKey)) {
      throw new GoldenCoastExistingPositionCarryForwardError(
        `duplicate stock item/location snapshot ${itemLocationKey}`
      );
    }
    seenInventoryIds.add(inventoryId);
    seenItemLocations.add(itemLocationKey);

    const rowQuantity = decimal(row.quantity, `inventory ${inventoryId} quantity`);
    const rate = decimal(row.averageRate, `inventory ${inventoryId} averageRate`);
    if (rowQuantity.isNegative() || rate.isNegative()) {
      throw new GoldenCoastExistingPositionCarryForwardError(
        `inventory ${inventoryId} quantity and average rate cannot be negative`
      );
    }

    const location = locationTotals.get(locationId) ?? {
      locationName: String(row.locationName ?? `Location #${locationId}`),
      quantity: new Decimal(0),
      value: new Decimal(0),
      rowCount: 0,
    };
    location.quantity = location.quantity.plus(rowQuantity);
    location.value = location.value.plus(rowQuantity.times(rate));
    location.rowCount += 1;
    locationTotals.set(locationId, location);

    if (rowQuantity.isZero()) continue;
    if (rate.isZero()) {
      throw new GoldenCoastExistingPositionCarryForwardError(
        `inventory ${inventoryId} has positive quantity with zero average rate`
      );
    }

    const rowValue = rowQuantity.times(rate);
    stockInHand = stockInHand.plus(rowValue);
    const finalUnitCost = unitCost(rate);
    fifoMovements.push({
      companyId,
      sourceType: GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
      articleCode,
      description: `Golden Coast ${GOLDEN_COAST_CUTOVER_DATE} existing-position FIFO snapshot from ERP inventory #${inventoryId}`,
      stockItemId,
      locationId,
      qtyIn: quantity(rowQuantity),
      qtyRemaining: quantity(rowQuantity),
      baseUnitCostUsd: finalUnitCost,
      landedUnitCostUsd: finalUnitCost,
      finalUnitCostUsd: finalUnitCost,
    });
  }

  const seenContainerIds = new Set<number>();
  const otwContainers = input.otwContainers.map((container) => {
    const containerId = positiveId(container.containerId, "containerId");
    if (seenContainerIds.has(containerId)) {
      throw new GoldenCoastExistingPositionCarryForwardError(`duplicate OTW container ${containerId}`);
    }
    seenContainerIds.add(containerId);
    const valueUsd = decimal(container.valueUsd, `container ${containerId} valueUsd`);
    if (valueUsd.isNegative()) {
      throw new GoldenCoastExistingPositionCarryForwardError(`container ${containerId} valueUsd cannot be negative`);
    }
    const containerNumber = String(container.containerNumber ?? "").trim();
    if (!containerNumber) {
      throw new GoldenCoastExistingPositionCarryForwardError(`container ${containerId} is missing a container number`);
    }
    return { containerId, containerNumber, valueUsd: money(valueUsd) };
  });
  const stockOtw = otwContainers.reduce((sum, container) => sum.plus(container.valueUsd), new Decimal(0));
  const totalPosition = stockInHand.plus(stockOtw);
  if (totalPosition.lte(0)) {
    throw new GoldenCoastExistingPositionCarryForwardError(
      "The existing Stock in Hand and Stock OTW position is empty; there is nothing to carry forward"
    );
  }

  const description = `Golden Coast existing position carry-forward — ${GOLDEN_COAST_CUTOVER_DATE}`;
  const journalEntries: ExistingPositionCarryForwardPlan["journalEntries"] = [];
  if (stockInHand.gt(0)) {
    journalEntries.push({
      ledgerAccountId: input.accounts.stockInHandAccountId,
      debitAmount: money(stockInHand),
      creditAmount: "0.00",
      narration: `${description} — Stock in Hand from existing ERP inventory`,
    });
  }
  if (stockOtw.gt(0)) {
    journalEntries.push({
      ledgerAccountId: input.accounts.stockOtwAccountId,
      debitAmount: money(stockOtw),
      creditAmount: "0.00",
      narration: `${description} — Stock OTW from existing active containers`,
    });
  }
  journalEntries.push({
    ledgerAccountId: input.accounts.openingBalanceClearingAccountId,
    debitAmount: "0.00",
    creditAmount: money(totalPosition),
    narration: `${description} — existing jointly owned position clearing`,
  });

  return {
    cutoverDate: GOLDEN_COAST_CUTOVER_DATE,
    companyId,
    voucherNumber: goldenCoastExistingPositionCarryForwardVoucherNumber(companyId),
    stockInHandUsd: money(stockInHand),
    stockOtwUsd: money(stockOtw),
    totalPositionUsd: money(totalPosition),
    inventoryRowCount: input.inventory.length,
    fifoMovementCount: fifoMovements.length,
    locations: [...locationTotals.entries()]
      .sort(([left], [right]) => left - right)
      .map(([locationId, value]) => ({
        locationId,
        locationName: value.locationName,
        quantity: quantity(value.quantity),
        valueUsd: money(value.value),
        rowCount: value.rowCount,
      })),
    otwContainers,
    journalEntries,
    fifoMovements,
  };
}
