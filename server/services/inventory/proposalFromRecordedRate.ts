// Extracted from ./historicalSalesCostRepairEvidence.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import {
  historicalInventoryKey,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
  posJournalCostIsNotInventoryRate,
  repairMoney,
  repairQuantity,
  repairRate,
} from "./historicalSalesCostRepairEngine";
import { d, hscrError, iso, SaleRow } from "./historicalSalesCostRepairTypes";

export function proposalFromRecordedRate(
  companyId: number,
  sale: SaleRow,
  proposedRate: Decimal.Value,
  sourceType: string,
  sourceId: string,
  evidence: "canonical" | "legacy"
): HistoricalSalesRepairProposal {
  if (!sale.location_id) throw hscrError("HSCR_SALE_LOCATION_REQUIRED_FOR_PROPOSAL");
  const originalCostPrice = repairRate(sale.cost_price);
  const originalTotalCost = repairMoney(sale.total_cost);
  const originalProfit = repairMoney(sale.profit);
  const proposedCostPrice = repairRate(proposedRate);
  const proposedTotalCost = repairMoney(repairQuantity(sale.quantity).abs().times(proposedCostPrice));
  const proposedProfit = repairMoney(d(sale.total_sales).minus(proposedTotalCost));
  return {
    salesItemId: Number(sale.sales_item_id),
    voucherId: Number(sale.voucher_id),
    companyId,
    locationId: Number(sale.location_id),
    stockItemId: Number(sale.stock_item_id),
    occurredAt: iso(sale.created_at),
    sourceType,
    sourceId,
    evidence,
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
  };
}

export function originalProposalForSale(companyId: number, sale: SaleRow): HistoricalSalesRepairProposal {
  if (!sale.location_id) throw hscrError("HSCR_SALE_LOCATION_REQUIRED_FOR_PROPOSAL");
  const originalCostPrice = repairRate(sale.cost_price);
  const originalTotalCost = repairMoney(sale.total_cost);
  const originalProfit = repairMoney(sale.profit);
  return {
    salesItemId: Number(sale.sales_item_id),
    voucherId: Number(sale.voucher_id),
    companyId,
    locationId: Number(sale.location_id),
    stockItemId: Number(sale.stock_item_id),
    occurredAt: iso(sale.created_at),
    sourceType: "legacy-sale",
    sourceId: String(sale.voucher_id),
    evidence: "legacy",
    originalCostPrice: originalCostPrice.toFixed(2),
    originalTotalCost: originalTotalCost.toFixed(2),
    originalProfit: originalProfit.toFixed(2),
    proposedCostPrice: originalCostPrice.toFixed(2),
    proposedTotalCost: originalTotalCost.toFixed(2),
    proposedProfit: originalProfit.toFixed(2),
    changed: false,
  };
}

export function movementKey(
  movement: Pick<HistoricalSalesRepairMovement, "companyId" | "locationId" | "stockItemId">
): string {
  return historicalInventoryKey(movement.companyId, movement.locationId, movement.stockItemId);
}

export function movementMutationTime(movement: HistoricalSalesRepairMovement): number {
  return Date.parse(movement.createdAt ?? movement.occurredAt);
}

export function compareMovementMutationAscending(
  a: HistoricalSalesRepairMovement,
  b: HistoricalSalesRepairMovement
): number {
  const time = movementMutationTime(a) - movementMutationTime(b);
  if (time !== 0) return time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.movementId.localeCompare(b.movementId);
}

export function compareMovementMutationDescending(
  a: HistoricalSalesRepairMovement,
  b: HistoricalSalesRepairMovement
): number {
  return -compareMovementMutationAscending(a, b);
}

export function canonicalMovementNumericId(movement: HistoricalSalesRepairMovement): number | null {
  // Derived rows carry the journal id they were reconstructed from, so the
  // checkpoint cutoff places them on the same side as that journal row.
  if (
    movement.movementId.startsWith("canonical-correction:") ||
    movement.movementId.startsWith("canonical-dropped-line:")
  ) {
    const id = Number(movement.movementId.split(":")[1]);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  if (!movement.movementId.startsWith("canonical:")) return null;
  const id = Number(movement.movementId.slice("canonical:".length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function buildPriorCanonicalCostMemoryRateHints(
  movements: HistoricalSalesRepairMovement[]
): Map<string, string> {
  const hints = new Map<string, string>();
  const knownRateByKey = new Map<string, Decimal>();

  for (const movement of [...movements].sort(compareMovementMutationAscending)) {
    const key = movementKey(movement);
    const knownRate = knownRateByKey.get(key);
    if (knownRate) hints.set(movement.movementId, knownRate.toFixed(2));

    const delta = d(movement.quantityDelta);
    // V31: POS edit legs journal the old sale-line cost, not the live rate
    // production used. They neither pin nor invalidate cost memory: the live
    // rate is preserved by an unchanged edit, so the prior hint stays valid.
    if (posJournalCostIsNotInventoryRate(movement)) continue;
    if (
      delta.lt(0) &&
      movement.evidence === "canonical" &&
      movement.unitCost !== null &&
      movement.unitCost !== undefined
    ) {
      knownRateByKey.set(key, repairRate(movement.unitCost));
      continue;
    }

    if (delta.gt(0) && movement.unitCost !== null && movement.unitCost !== undefined) {
      const incomingRate = repairRate(movement.unitCost);
      if (!knownRate || !incomingRate.eq(knownRate)) {
        knownRateByKey.delete(key);
      }
    }
  }

  return hints;
}

export type CanonicalSaleEvidence = {
  movements: HistoricalSalesRepairMovement[];
  latestMutationAt: number;
  latestNegativeMovements: HistoricalSalesRepairMovement[];
  latestPositiveMovements: HistoricalSalesRepairMovement[];
  latestNegativeRates: Set<string>;
  latestNegativeQuantity: Decimal;
  latestNegativeValue: Decimal;
  latestNegativeRate: Decimal | null;
  latestPositiveRate: Decimal | null;
  totalSignedQuantity: Decimal;
  anchorCanonicalId: number;
};

export const COLLAPSED_ORIGINAL_POS_KEY = /^pos-sale:(\d+):rev0:(\d+)$/;

export const EDIT_REVERSAL_LINE_KEY = /^pos-sale:\d+:rev(\d+):reverse:\d+:line:(\d+)$/;

export const EDIT_LEG_REVISION_KEY = /^pos-sale:\d+:rev(\d+):(?:reverse|issue):/;
