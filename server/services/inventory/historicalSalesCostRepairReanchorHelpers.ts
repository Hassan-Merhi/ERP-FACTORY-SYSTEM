// Extracted from ./historicalSalesCostRepairReanchor.ts
import Decimal from "decimal.js";
import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { historicalSaleProposalFromState } from "./historicalSalesCostRepairEngineReplay";
import { RepairCheck } from "./historicalSalesCostRepairTypes";
import { movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual } from "./historicalSalesCostRepairRecovery";

/** Proves legacy sales after a priced receipt into empty or negative stock by replaying forward to the checkpoint. */
export function proveForwardCostMemoryResets({
  companyId,
  checks,
  proposalsBySaleId,
  checkpointStates,
  unavailableKeys,
  checkpointTargetKeys,
  forwardReplayResolvedKeys,
  movementsAscending,
}: {
  companyId: number;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  checkpointStates: Map<string, HistoricalInventoryState>;
  unavailableKeys: Set<string>;
  checkpointTargetKeys: Set<string>;
  forwardReplayResolvedKeys: Set<string>;
  movementsAscending: HistoricalSalesRepairMovement[];
}): { forwardResetProvenSaleIds: Set<number>; movementsByTargetKey: Map<string, HistoricalSalesRepairMovement[]> } {
  // A priced receipt that crosses an item/location from zero or negative
  // quantity to positive quantity resets cost memory: the post-receipt
  // valuation is determined entirely by the receipt rate and the positive
  // remainder. Derive quantities backwards from the immutable checkpoint,
  // then replay forward from each reset candidate. Accept the earliest
  // candidate that reproduces the checkpoint exactly, which proves every
  // target legacy sale after that reset without needing older cost memory.
  const forwardResetProvenSaleIds = new Set<number>();
  const movementsByTargetKey = new Map<string, HistoricalSalesRepairMovement[]>();
  for (const movement of movementsAscending) {
    const key = movementKey(movement);
    if (!checkpointTargetKeys.has(key) || unavailableKeys.has(key)) continue;
    const rows = movementsByTargetKey.get(key) ?? [];
    rows.push(movement);
    movementsByTargetKey.set(key, rows);
  }

  for (const key of checkpointTargetKeys) {
    if (unavailableKeys.has(key) || forwardReplayResolvedKeys.has(key)) continue;
    const checkpointState = checkpointStates.get(key);
    if (!checkpointState) continue;
    const movements = movementsByTargetKey.get(key) ?? [];
    if (movements.length === 0) continue;

    const quantityBefore = new Array<Decimal>(movements.length);
    let quantityAfter = repairQuantity(checkpointState.quantity);
    for (let index = movements.length - 1; index >= 0; index -= 1) {
      const delta = repairQuantity(movements[index].quantityDelta);
      const before = repairQuantity(quantityAfter.minus(delta));
      quantityBefore[index] = before;
      quantityAfter = before;
    }

    let accepted:
      | {
          anchor: HistoricalSalesRepairMovement;
          stateAtCheckpoint: HistoricalInventoryState;
          proposals: HistoricalSalesRepairProposal[];
        }
      | undefined;

    for (let anchorIndex = 0; anchorIndex < movements.length; anchorIndex += 1) {
      const anchor = movements[anchorIndex];
      const delta = repairQuantity(anchor.quantityDelta);
      const beforeQty = quantityBefore[anchorIndex];
      const afterQty = repairQuantity(beforeQty.plus(delta));
      if (
        !delta.gt(0) ||
        anchor.unitCost === null ||
        anchor.unitCost === undefined ||
        posJournalCostIsNotInventoryRate(anchor) ||
        beforeQty.gt(0) ||
        !afterQty.gt(0)
      ) {
        continue;
      }

      let state = applyHistoricalSalesRepairMovement(
        createHistoricalInventoryStateFromSnapshot(beforeQty, "0", "0"),
        anchor
      );
      const candidateProposals: HistoricalSalesRepairProposal[] = [];
      for (let index = anchorIndex + 1; index < movements.length; index += 1) {
        const movement = movements[index];
        if (movement.sale) {
          candidateProposals.push(historicalSaleProposalFromState(movement, state));
        }
        state = applyHistoricalSalesRepairMovement(state, movement);
      }

      if (!historicalInventoryStatesEqual(state, checkpointState)) continue;
      if (candidateProposals.length === 0) continue;

      accepted = {
        anchor,
        stateAtCheckpoint: state,
        proposals: candidateProposals,
      };
      break;
    }

    if (!accepted) continue;

    let provenCount = 0;
    for (const proposal of accepted.proposals) {
      proposalsBySaleId.set(proposal.salesItemId, proposal);
      forwardResetProvenSaleIds.add(proposal.salesItemId);
      provenCount += 1;
    }
    const [, locationIdText, stockItemIdText] = key.split(":");
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "FORWARD_RESET_SEGMENT_PROVEN",
      status: "pass",
      expected: `${repairQuantity(checkpointState.quantity).toFixed(3)}|${repairMoney(
        checkpointState.totalValue
      ).toFixed(2)}|${repairRate(checkpointState.averageRate).toFixed(2)}`,
      actual: `${repairQuantity(accepted.stateAtCheckpoint.quantity).toFixed(3)}|${repairMoney(
        accepted.stateAtCheckpoint.totalValue
      ).toFixed(2)}|${repairRate(accepted.stateAtCheckpoint.averageRate).toFixed(2)}`,
      detail: `Reset anchor ${accepted.anchor.movementId} proves ${provenCount} later legacy sale(s) by exact checkpoint replay`,
    });
  }
  return { forwardResetProvenSaleIds, movementsByTargetKey };
}
