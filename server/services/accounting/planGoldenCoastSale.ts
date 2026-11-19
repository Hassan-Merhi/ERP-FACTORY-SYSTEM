// Extracted from ./goldenCoastPosSale.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import {
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  GoldenCoastPhase5SaleError,
  MONEY_SCALE,
  QUANTITY_SCALE,
  UNIT_COST_SCALE,
  decimalOf,
  positiveId,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5Allocation,
  type GoldenCoastPhase5PlannedLine,
  type GoldenCoastPhase5SaleInput,
  type GoldenCoastPhase5SalePlan,
} from "./goldenCoastPosSaleDecimalOf";
import { orderLots } from "./parseGoldenCoastSaleInput";

/**
 * Consumes FIFO lots for one sale and derives the exact cost of the units sold.
 *
 * Fail-closed conditions: a lot from another company or location, a lot that is
 * not a canonical post-cutover movement row, a non-numeric/negative/zero unit
 * cost on a consumed lot, and any line whose requested quantity exceeds the
 * quantity actually remaining. There is no quantity tolerance: a sale either
 * has the stock behind it or it does not post.
 */
export function planGoldenCoastPhase5Sale(input: {
  sale: GoldenCoastPhase5SaleInput;
  lots: readonly GoldenCoastFifoLot[];
}): GoldenCoastPhase5SalePlan {
  const { sale } = input;
  const companyId = positiveId(sale.companyId, "companyId");
  const locationId = positiveId(sale.locationId, "locationId");

  const seenLotIds = new Set<number>();
  const lotsByStockItem = new Map<number, GoldenCoastFifoLot[]>();
  for (const lot of input.lots ?? []) {
    const lotId = positiveId(lot.id, "lot id");
    if (seenLotIds.has(lotId)) {
      throw new GoldenCoastPhase5SaleError(`FIFO lot #${lotId} was supplied more than once`);
    }
    seenLotIds.add(lotId);

    if (Number(lot.companyId) !== companyId) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} belongs to company ${lot.companyId}, not company ${companyId}`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }
    if (lot.locationId == null || Number(lot.locationId) !== locationId) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} is not held at location ${locationId}`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }
    if (lot.stockItemId == null || !Number.isInteger(Number(lot.stockItemId)) || Number(lot.stockItemId) <= 0) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} is not linked to a stock item and cannot be sold`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }
    if (!GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES.includes(String(lot.sourceType ?? ""))) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} is a ${lot.sourceType ?? "untyped"} movement, not a canonical Golden Coast ` +
          `post-cutover lot, and cannot back a sale`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }

    const stockItemId = Number(lot.stockItemId);
    const bucket = lotsByStockItem.get(stockItemId);
    if (bucket) bucket.push(lot);
    else lotsByStockItem.set(stockItemId, [lot]);
  }

  let revenueTotal = new Decimal(0);
  let cogsTotal = new Decimal(0);
  let qtyTotal = new Decimal(0);
  const allAllocations: GoldenCoastPhase5Allocation[] = [];

  const lines: GoldenCoastPhase5PlannedLine[] = sale.lines.map((line) => {
    const stockItemId = positiveId(line.stockItemId, "line.stockItemId");
    const qty = decimalOf(line.qty, `line ${stockItemId} qty`, "GC_PHASE5_INPUT_INVALID");
    const unitPrice = decimalOf(line.unitPriceUsd, `line ${stockItemId} unitPriceUsd`, "GC_PHASE5_INPUT_INVALID");
    const candidates = orderLots(lotsByStockItem.get(stockItemId) ?? []);

    let available = new Decimal(0);
    for (const lot of candidates) {
      const remaining = decimalOf(lot.qtyRemaining, `FIFO lot #${lot.id} qtyRemaining`, "GC_PHASE5_FIFO_COST_INVALID");
      if (remaining.lessThan(0)) {
        throw new GoldenCoastPhase5SaleError(
          `FIFO lot #${lot.id} has a negative remaining quantity`,
          "GC_PHASE5_FIFO_COST_INVALID"
        );
      }
      available = available.plus(remaining);
    }
    if (available.lessThan(qty)) {
      throw new GoldenCoastPhase5SaleError(
        `Insufficient Golden Coast FIFO stock for stock item #${stockItemId} at location ${locationId}: ` +
          `available ${available.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE)}, ` +
          `requested ${qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE)}`,
        "GC_PHASE5_FIFO_INSUFFICIENT"
      );
    }

    const allocations: GoldenCoastPhase5Allocation[] = [];
    let outstanding = qty;
    let lineCost = new Decimal(0);

    for (const lot of candidates) {
      if (!outstanding.greaterThan(0)) break;
      const remaining = decimalOf(lot.qtyRemaining, `FIFO lot #${lot.id} qtyRemaining`, "GC_PHASE5_FIFO_COST_INVALID");
      if (!remaining.greaterThan(0)) continue;

      const unitCost = decimalOf(
        lot.finalUnitCostUsd,
        `FIFO lot #${lot.id} finalUnitCostUsd`,
        "GC_PHASE5_FIFO_COST_INVALID"
      );
      if (!unitCost.greaterThan(0)) {
        throw new GoldenCoastPhase5SaleError(
          `FIFO lot #${lot.id} has a non-positive unit cost and cannot back a Golden Coast sale`,
          "GC_PHASE5_FIFO_COST_INVALID"
        );
      }

      const consumed = Decimal.min(outstanding, remaining);
      const cost = consumed.times(unitCost);
      outstanding = outstanding.minus(consumed);
      lineCost = lineCost.plus(cost);

      const allocation: GoldenCoastPhase5Allocation = {
        lotId: Number(lot.id),
        stockItemId,
        locationId,
        articleCode: String(lot.articleCode ?? "").trim(),
        description: lot.description == null ? null : String(lot.description),
        qty: consumed.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
        unitCostUsd: unitCost.toDecimalPlaces(UNIT_COST_SCALE).toFixed(UNIT_COST_SCALE),
        costUsd: cost.toDecimalPlaces(MONEY_SCALE).toFixed(MONEY_SCALE),
        qtyRemainingBefore: remaining.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
        qtyRemainingAfter: remaining.minus(consumed).toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
      };
      allocations.push(allocation);
      allAllocations.push(allocation);
    }

    if (outstanding.greaterThan(0)) {
      // Unreachable while the availability check above holds; kept so a future
      // change to lot filtering can never post a partially covered sale line.
      throw new GoldenCoastPhase5SaleError(
        `Golden Coast FIFO consumption for stock item #${stockItemId} did not cover the full quantity`,
        "GC_PHASE5_FIFO_INSUFFICIENT"
      );
    }

    const lineRevenue = qty.times(unitPrice).toDecimalPlaces(MONEY_SCALE);
    const roundedLineCost = lineCost.toDecimalPlaces(MONEY_SCALE);
    revenueTotal = revenueTotal.plus(lineRevenue);
    cogsTotal = cogsTotal.plus(roundedLineCost);
    qtyTotal = qtyTotal.plus(qty);

    return {
      stockItemId,
      qty: qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
      unitPriceUsd: unitPrice.toDecimalPlaces(MONEY_SCALE).toFixed(MONEY_SCALE),
      revenueUsd: lineRevenue.toFixed(MONEY_SCALE),
      cogsUsd: roundedLineCost.toFixed(MONEY_SCALE),
      grossProfitUsd: lineRevenue.minus(roundedLineCost).toFixed(MONEY_SCALE),
      allocations,
    };
  });

  if (!revenueTotal.greaterThan(0)) {
    throw new GoldenCoastPhase5SaleError("A Golden Coast sale must post a positive revenue amount");
  }
  if (!cogsTotal.greaterThan(0)) {
    throw new GoldenCoastPhase5SaleError(
      "Golden Coast FIFO consumption produced no cost of goods sold",
      "GC_PHASE5_FIFO_COST_INVALID"
    );
  }

  return {
    companyId,
    locationId,
    saleDate: sale.saleDate,
    customerName: sale.customerName,
    clientRequestId: sale.clientRequestId,
    revenueUsd: revenueTotal.toFixed(MONEY_SCALE),
    cogsUsd: cogsTotal.toFixed(MONEY_SCALE),
    grossProfitUsd: revenueTotal.minus(cogsTotal).toFixed(MONEY_SCALE),
    totalQty: qtyTotal.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
    lines,
    allocations: allAllocations,
  };
}
