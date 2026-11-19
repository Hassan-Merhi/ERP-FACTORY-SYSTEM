/** Opening-balance forward replay proof for the historical sales-cost repair dry run. */

import {
  repairMoney,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { RepairCheck, StockItemRow, ValuationCheckpoint } from "./historicalSalesCostRepairTypes";
import { historicalSalesCostRepairForwardReplayStep } from "./historicalSalesCostRepairForwardReplayStep";
import { historicalSalesCostRepairForwardReplayStep3 } from "./historicalSalesCostRepairForwardReplayStep3";
import { historicalSalesCostRepairForwardReplayStep4 } from "./historicalSalesCostRepairForwardReplayStep4";

/** Proves legacy sales by replaying each stock item forward from its pinned opening balance to the checkpoint. */
export function proveOpeningForwardReplay({
  companyId,
  checkpoint,
  checks,
  proposalsBySaleId,
  evidencedOpeningStates,
  checkpointStates,
  checkpointTargetKeys,
  normalizedMovementsAscending,
  fallbackMovementsInCheckpoint,
  legacyTransferFallbackItemIds,
  forwardReplayResolvedKeys,
  fallbackProvenItemIds,
  movementsAscending,
  stockItemById,
  targetKeysByItem,
}: {
  companyId: number;
  checkpoint: ValuationCheckpoint;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  evidencedOpeningStates: Map<string, HistoricalInventoryState>;
  checkpointStates: Map<string, HistoricalInventoryState>;
  checkpointTargetKeys: Set<string>;
  normalizedMovementsAscending: HistoricalSalesRepairMovement[];
  fallbackMovementsInCheckpoint: HistoricalSalesRepairMovement[];
  legacyTransferFallbackItemIds: Set<number>;
  forwardReplayResolvedKeys: Set<string>;
  fallbackProvenItemIds: Set<number>;
  movementsAscending: HistoricalSalesRepairMovement[];
  stockItemById: Map<number, StockItemRow>;
  targetKeysByItem: Map<number, string[]>;
}): void {
  const replayTargetItem = (stockItemId: number, itemTargetKeys: string[]): void => {
    const hfr1 = historicalSalesCostRepairForwardReplayStep({
      stockItemById,
      stockItemId,
      checks,
      itemTargetKeys,
      companyId,
      movementsAscending,
      normalizedMovementsAscending,
      fallbackMovementsInCheckpoint,
    });
    if (hfr1.done) return hfr1.value;
    const { openingQty, openingRate, openingValue } = hfr1;
    const hfr3 = historicalSalesCostRepairForwardReplayStep3({
      hfr1,
      checkpoint,
      stockItemId,
      checkpointStates,
      companyId,
      checkpointTargetKeys,
      evidencedOpeningStates,
      checks,
    });
    if (hfr3.done) return hfr3.value;
    const hfr4 = historicalSalesCostRepairForwardReplayStep4({
      hfr3,
      hfr1,
      checks,
      companyId,
      stockItemId,
      checkpointTargetKeys,
      checkpointStates,
      fallbackProvenItemIds,
    });
    if (hfr4.done) return hfr4.value;
    const { acceptedReplay, proofMode } = hfr4;
    // Step 4 can update these on hfr3, so read them after it.
    const { openingProofBasis, inferredOpeningTotal } = hfr3;

    if (openingProofBasis === "location-import-inferred") {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_LOCATION_IMPORT_RECONCILED",
        status: "pass",
        expected: openingQty.toFixed(3) + "@" + openingRate.toFixed(2),
        actual: inferredOpeningTotal.toFixed(3) + "@" + openingRate.toFixed(2),
        detail:
          "Checkpoint-implied per-location opening quantities seeded at the separately pinned item opening rate replay exactly to the immutable Phase 3 checkpoint, consistent with the historical direct location-inventory import path.",
      });
    }

    if (acceptedReplay.peakNegativeLayerQuantity.gt(0)) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_EPOCH_LAYER_REPLAY",
        status: "pass",
        actual: acceptedReplay.peakNegativeLayerQuantity.toFixed(3),
        detail:
          "Forward proof reproduced the checkpoint while simulating the historical negative-layer engine and its production epoch boundaries.",
      });
    }

    if (proofMode === "normalized-pos-lifecycle") {
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "OPENING_FORWARD_POS_LIFECYCLE_NORMALIZED",
        status: "pass",
        detail:
          "Raw POS edit/delete valuation history missed the checkpoint, but the final-active-sale normalization reproduced the immutable Phase 3 checkpoint exactly.",
      });
    }

    for (const key of itemTargetKeys) {
      forwardReplayResolvedKeys.add(key);
      const locationId = Number(key.split(":")[1]);
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: "OPENING_FORWARD_REPLAY_PROVEN",
        status: "pass",
        expected: openingQty.toFixed(3) + "|" + openingValue.toFixed(2),
        actual:
          inferredOpeningTotal.toFixed(3) +
          "|" +
          (openingProofBasis === "location-import-inferred" || openingProofBasis === "signed-location-import-inferred"
            ? repairMoney(inferredOpeningTotal.times(openingRate)).toFixed(2)
            : openingValue.toFixed(2)),
        detail:
          openingProofBasis === "signed-location-import-inferred"
            ? "Checkpoint-implied signed location openings at the pinned item rate and all durable movements replay exactly to the immutable Phase 3 checkpoint"
            : openingProofBasis === "location-import-inferred"
              ? "Checkpoint-implied location openings at the pinned item rate and all durable movements replay exactly to the immutable Phase 3 checkpoint"
              : proofMode === "normalized-pos-lifecycle"
                ? "Pinned stock opening balance and normalized final POS lifecycle replay exactly to the immutable Phase 3 checkpoint"
                : "Pinned stock opening balance and all durable movements replay exactly to the immutable Phase 3 checkpoint",
      });
    }
    for (const proposal of acceptedReplay.replayProposals.values()) {
      proposalsBySaleId.set(proposal.salesItemId, proposal);
    }
  };
  for (const [stockItemId, itemTargetKeys] of targetKeysByItem) replayTargetItem(stockItemId, itemTargetKeys);

  for (const stockItemId of legacyTransferFallbackItemIds) {
    const itemKeys = targetKeysByItem.get(stockItemId) ?? [];
    if (itemKeys.length === 0 || fallbackProvenItemIds.has(stockItemId)) continue;
    checks.push({
      companyId,
      locationId: null,
      stockItemId,
      code: "LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED",
      status: "warning",
      actual: String(itemKeys.length),
      detail:
        "False inventory_applied legacy transfer rows did not reproduce the immutable checkpoint, so V17 ignores them and retains the trusted V15 movement history for this item.",
    });
  }
}
