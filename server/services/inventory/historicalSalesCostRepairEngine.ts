import Decimal from "decimal.js";

export const HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION = "2026-09-30-v1";

const ZERO = new Decimal(0);

function hscrEngineError(code: string): Error {
  const error = new Error();
  error.message = code;
  return error;
}

function decimal(value: Decimal.Value | null | undefined, field: string): Decimal {
  try {
    const parsed = new Decimal(value ?? 0);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw hscrEngineError(`HSCR_NON_FINITE_DECIMAL:${field}`);
  }
}

export function repairQuantity(value: Decimal.Value): Decimal {
  return new Decimal(decimal(value, "quantity").toFixed(3));
}

export function repairMoney(value: Decimal.Value): Decimal {
  return new Decimal(decimal(value, "money").toFixed(2));
}

export function repairRate(value: Decimal.Value): Decimal {
  return new Decimal(decimal(value, "rate").toFixed(2));
}

export type HistoricalInventoryState = {
  quantity: Decimal;
  averageRate: Decimal;
  totalValue: Decimal;
};

export type HistoricalSalesRepairMovement = {
  movementId: string;
  companyId: number;
  locationId: number;
  stockItemId: number;
  occurredAt: string;
  sequence: number;
  quantityDelta: string;
  unitCost: string | null;
  sourceType: string;
  sourceId: string;
  evidence: "canonical" | "legacy";
  sale?: {
    salesItemId: number;
    voucherId: number;
    quantity: string;
    totalSales: string;
    originalCostPrice: string;
    originalTotalCost: string;
    originalProfit: string;
  };
};

export type HistoricalSalesRepairOpening = {
  companyId: number;
  locationId: number;
  stockItemId: number;
  quantity: string;
  averageRate: string;
};

export type HistoricalSalesRepairProposal = {
  salesItemId: number;
  voucherId: number;
  companyId: number;
  locationId: number;
  stockItemId: number;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  evidence: "canonical" | "legacy";
  originalCostPrice: string;
  originalTotalCost: string;
  originalProfit: string;
  proposedCostPrice: string;
  proposedTotalCost: string;
  proposedProfit: string;
  changed: boolean;
};

export type HistoricalSalesRepairReplayResult = {
  proposals: HistoricalSalesRepairProposal[];
  closingStates: Map<string, HistoricalInventoryState>;
};

export function historicalInventoryKey(companyId: number, locationId: number, stockItemId: number): string {
  return `${companyId}:${locationId}:${stockItemId}`;
}

export function createHistoricalInventoryState(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value
): HistoricalInventoryState {
  const quantity = repairQuantity(quantityValue);
  const averageRate = repairRate(Decimal.max(decimal(rateValue, "opening rate"), ZERO));
  const totalValue = quantity.gt(ZERO) ? repairMoney(quantity.times(averageRate)) : ZERO;
  return { quantity, averageRate, totalValue };
}

/**
 * Replays the inventory value rules used by the production inventory valuation path:
 * - receipts into positive stock are weighted average,
 * - a receipt first fills a negative shortage before carrying asset value,
 * - issues leave the average rate unchanged and consume at the pre-issue rate,
 * - negative/zero on-hand carries zero asset value but keeps cost memory.
 *
 * When unitCost is null (legacy manual add / credit-note stock return), the
 * existing average is used, matching the production valuation behavior when no incoming rate
 * was supplied.
 */
export function applyHistoricalInventoryMovement(
  state: HistoricalInventoryState,
  input: { quantityDelta: Decimal.Value; unitCost?: Decimal.Value | null }
): HistoricalInventoryState {
  const delta = repairQuantity(input.quantityDelta);
  const previousQty = repairQuantity(state.quantity);
  const previousRate = repairRate(Decimal.max(state.averageRate, ZERO));
  const previousValue = repairMoney(Decimal.max(state.totalValue, ZERO));
  const incomingRate =
    input.unitCost === null || input.unitCost === undefined
      ? previousRate
      : repairRate(Decimal.max(decimal(input.unitCost, "movement unit cost"), ZERO));
  const newQty = repairQuantity(previousQty.plus(delta));

  if (delta.gt(ZERO)) {
    const valueBearingQty = previousQty.isNegative() ? Decimal.max(delta.minus(previousQty.abs()), ZERO) : delta;
    if (newQty.lte(ZERO)) {
      return {
        quantity: newQty,
        averageRate: incomingRate,
        totalValue: ZERO,
      };
    }

    const newValue = repairMoney(Decimal.max(previousValue.plus(valueBearingQty.times(incomingRate)), ZERO));
    return {
      quantity: newQty,
      averageRate: repairRate(newValue.dividedBy(newQty)),
      totalValue: newValue,
    };
  }

  if (delta.lt(ZERO)) {
    if (newQty.gt(ZERO)) {
      const newValue = repairMoney(Decimal.max(previousValue.minus(delta.abs().times(previousRate)), ZERO));
      return {
        quantity: newQty,
        averageRate: repairRate(newValue.dividedBy(newQty)),
        totalValue: newValue,
      };
    }

    return {
      quantity: newQty,
      averageRate: previousRate,
      totalValue: ZERO,
    };
  }

  return {
    quantity: previousQty,
    averageRate: previousRate,
    totalValue: previousValue,
  };
}

function compareMovements(a: HistoricalSalesRepairMovement, b: HistoricalSalesRepairMovement): number {
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time !== 0) return time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.movementId.localeCompare(b.movementId);
}

export function replayHistoricalSalesCosts(input: {
  openings: HistoricalSalesRepairOpening[];
  movements: HistoricalSalesRepairMovement[];
}): HistoricalSalesRepairReplayResult {
  const states = new Map<string, HistoricalInventoryState>();
  for (const opening of input.openings) {
    states.set(
      historicalInventoryKey(opening.companyId, opening.locationId, opening.stockItemId),
      createHistoricalInventoryState(opening.quantity, opening.averageRate)
    );
  }

  const proposals: HistoricalSalesRepairProposal[] = [];
  const movements = [...input.movements].sort(compareMovements);

  for (const movement of movements) {
    const key = historicalInventoryKey(movement.companyId, movement.locationId, movement.stockItemId);
    const current =
      states.get(key) ??
      createHistoricalInventoryState("0", movement.unitCost === null ? "0" : (movement.unitCost ?? "0"));

    if (movement.sale) {
      const saleQty = repairQuantity(movement.sale.quantity).abs();
      const proposedCostPrice = repairRate(current.averageRate);
      const proposedTotalCost = repairMoney(saleQty.times(proposedCostPrice));
      const proposedProfit = repairMoney(decimal(movement.sale.totalSales, "sale total").minus(proposedTotalCost));

      const originalCostPrice = repairRate(movement.sale.originalCostPrice);
      const originalTotalCost = repairMoney(movement.sale.originalTotalCost);
      const originalProfit = repairMoney(movement.sale.originalProfit);

      proposals.push({
        salesItemId: movement.sale.salesItemId,
        voucherId: movement.sale.voucherId,
        companyId: movement.companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        occurredAt: movement.occurredAt,
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
        evidence: movement.evidence,
        originalCostPrice: originalCostPrice.toFixed(2),
        originalTotalCost: originalTotalCost.toFixed(2),
        originalProfit: originalProfit.toFixed(2),
        proposedCostPrice: proposedCostPrice.toFixed(2),
        proposedTotalCost: proposedTotalCost.toFixed(2),
        proposedProfit: proposedProfit.toFixed(2),
        changed:
          !originalCostPrice.eq(proposedCostPrice) ||
          !originalTotalCost.eq(proposedTotalCost) ||
          !originalProfit.eq(proposedProfit),
      });
    }

    states.set(
      key,
      applyHistoricalInventoryMovement(current, {
        quantityDelta: movement.quantityDelta,
        unitCost: movement.unitCost,
      })
    );
  }

  return { proposals, closingStates: states };
}
