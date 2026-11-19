// Extracted from ./historicalRateWithinEvidencedRange.ts
import Decimal from "decimal.js";

export type HistoricalInventoryState = {
  quantity: Decimal;
  averageRate: Decimal;
  totalValue: Decimal;
};

export type HistoricalForwardReplayState = {
  inventory: HistoricalInventoryState;
  negativeLayerQuantity: Decimal;
};

export type HistoricalSalesRepairMovement = {
  movementId: string;
  companyId: number;
  locationId: number;
  stockItemId: number;
  occurredAt: string;
  createdAt?: string;
  reversalOfMovementId?: number | null;
  sequence: number;
  quantityDelta: string;
  unitCost: string | null;
  exactValue?: string | null;
  valuationReset?: {
    beforeQuantity: string;
    beforeAverageRate: string;
    beforeTotalValue: string;
    afterQuantity: string;
    afterAverageRate: string;
    afterTotalValue: string;
  };
  sourceType: string;
  sourceId: string;
  evidence: "canonical" | "legacy";
  /**
   * Role of a canonical pos-sale row, derived from its immutable idempotency
   * key. Only "sale-issue" rows (lockAndDeductInventoryForSaleItem) journal the
   * locked live inventory average. Edit re-issues journal the preserved old
   * sale-line cost, and edit/delete reversals journal the old line cost while
   * production restored stock at the live stored rate.
   */
  canonicalPosRole?: CanonicalPosRole;
  idempotencyKey?: string | null;
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

/**
 * "dropped-line": a POS sale line that production issued at the live stored
 * rate but whose journal row was lost. From 2026-08-13 to 2026-09-26 the
 * original issue key was per stock item (pos-sale:V:rev0:ITEM), so a second
 * line of the same item collided and only the first line was journaled.
 * These rows are reconstructed by the dry-run, never loaded.
 */
export type CanonicalPosRole = "sale-issue" | "edit-issue" | "edit-reversal" | "dropped-line";

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
