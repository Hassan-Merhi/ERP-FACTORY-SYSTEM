/** Closed zero-stock era proofs and rewind coverage diagnostics for the historical sales-cost repair dry run. */
import Decimal from "decimal.js";

import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  isExactValuationReset,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  historicalSaleProposalFromState,
  isRecordedLiveRateObservation,
} from "./historicalSalesCostRepairEngineReplay";
import { RepairCheck, RewindAmplification, SaleRow } from "./historicalSalesCostRepairTypes";
import { originalProposalForSale } from "./historicalSalesCostRepairEvidence";
import { MergedRecoveryResult } from "./historicalSalesCostRepairRecovery";

/** Replaces rewind-failure blocks with forward proofs inside closed zero-stock eras. */
export function proveClosedZeroStockEras({
  companyId,
  checks,
  proposalsBySaleId,
  closedEraProvenSaleIds,
  evidencedOpeningStates,
  checkpointStates,
  forwardReplayResolvedKeys,
  movementsByTargetKey,
}: {
  companyId: number;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  closedEraProvenSaleIds: Set<number>;
  evidencedOpeningStates: Map<string, HistoricalInventoryState>;
  checkpointStates: Map<string, HistoricalInventoryState>;
  forwardReplayResolvedKeys: Set<string>;
  movementsByTargetKey: Map<string, HistoricalSalesRepairMovement[]>;
}): {
  REWIND_FAILURE_BLOCKS: RegExp;
  blockedSaleCodes: Map<number, RepairCheck[]>;
  eraProvenSales: number;
  eraConflictSales: number;
} {
  // V47: closed zero-stock eras. A priced receipt into exactly empty stock
  // fixes quantity, value and rate from the receipt alone, whatever came
  // before; when stock later returns to exactly zero, every sale in between
  // depends only on movements inside that era. The checkpoint rewind can
  // only reach such an era by guessing the erased cost memory at the zero,
  // so a forward replay inside the closed era replaces rewind-failure blocks
  // for its sales. The era is rejected if stock goes negative inside it or a
  // recorded live rate inside it disagrees; a sale the rewind already priced
  // differently is blocked rather than repriced.
  const REWIND_FAILURE_BLOCKS =
    /^(LEGACY_REWIND_|CHECKPOINT_REWIND_|CANONICAL_SALE_COST_EVIDENCE_MISMATCH$|LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED$|LEGACY_SALE_INVERSE_NOT_UNIQUE$)/;
  const blockedSaleCodes = new Map<number, RepairCheck[]>();
  for (const check of checks) {
    if (check.status !== "block" || !check.salesItemId) continue;
    const list = blockedSaleCodes.get(check.salesItemId) ?? [];
    list.push(check);
    blockedSaleCodes.set(check.salesItemId, list);
  }
  let eraProvenSales = 0;
  let eraConflictSales = 0;
  for (const [key, movements] of movementsByTargetKey) {
    if (forwardReplayResolvedKeys.has(key)) continue;
    const checkpointState = checkpointStates.get(key);
    if (!checkpointState) continue;
    const quantityBefore = new Array<Decimal>(movements.length);
    let quantityAfter = repairQuantity(checkpointState.quantity);
    for (let index = movements.length - 1; index >= 0; index -= 1) {
      quantityBefore[index] = repairQuantity(quantityAfter.minus(repairQuantity(movements[index].quantityDelta)));
      quantityAfter = quantityBefore[index];
    }
    // V53: the opening era. An evidenced location opening (see
    // evidencedOpeningStates) is a determined start just like a receipt into
    // empty stock: forward from it until stock first reaches zero or goes
    // short (closed), or, if it never does before the canonical journal,
    // until it reproduces the first two recorded live rates (observed).
    const acceptEra = (eraProposals: HistoricalSalesRepairProposal[], label: string, code: string) => {
      let proven = 0;
      let conflicts = 0;
      for (const proposal of eraProposals) {
        const blocks = (blockedSaleCodes.get(proposal.salesItemId) ?? []).filter((block) => block.status === "block");
        const existing = proposalsBySaleId.get(proposal.salesItemId);
        if (blocks.length === 0) {
          if (existing && existing.proposedCostPrice !== proposal.proposedCostPrice) {
            conflicts += 1;
            checks.push({
              companyId,
              locationId: proposal.locationId,
              stockItemId: proposal.stockItemId,
              salesItemId: proposal.salesItemId,
              code: "OPENING_ERA_FORWARD_DISAGREES",
              status: "block",
              expected: proposal.proposedCostPrice,
              actual: existing.proposedCostPrice,
              detail: `Sales item ${proposal.salesItemId}: ${label} gives a different cost than the checkpoint rewind`,
            });
          }
          continue;
        }
        if (!blocks.every((block) => REWIND_FAILURE_BLOCKS.test(block.code))) continue;
        for (const block of blocks) {
          block.status = "warning";
          block.detail = `${block.detail ?? ""} (superseded: ${label})`;
        }
        proposalsBySaleId.set(proposal.salesItemId, proposal);
        closedEraProvenSaleIds.add(proposal.salesItemId);
        proven += 1;
      }
      eraProvenSales += proven;
      eraConflictSales += conflicts;
      if (proven > 0 || conflicts > 0) {
        const [, locationIdText, stockItemIdText] = key.split(":");
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code,
          status: "pass",
          expected: String(eraProposals.length),
          actual: String(proven),
          detail: `${label}; ${proven} blocked sale(s) priced by forward replay, ${conflicts} conflict(s) with the checkpoint rewind`,
        });
      }
    };
    let openingEraEnd = -1;
    const opening = evidencedOpeningStates.get(key);
    if (opening && movements.length > 0 && quantityBefore[0].eq(repairQuantity(opening.quantity))) {
      let state = opening;
      const eraProposals: HistoricalSalesRepairProposal[] = [];
      let matched = 0;
      let rejected = false;
      let closedAt = -1;
      let sawObservation = false;
      for (let cursor = 0; cursor < movements.length; cursor += 1) {
        const movement = movements[cursor];
        if (isRecordedLiveRateObservation(movement)) {
          sawObservation = true;
          if (!repairRate(movement.unitCost!).eq(repairRate(state.averageRate))) {
            rejected = true;
            break;
          }
          matched += 1;
          if (matched >= 2) break;
        } else if (movement.sale && !sawObservation) {
          eraProposals.push(historicalSaleProposalFromState(movement, state));
        }
        state = applyHistoricalSalesRepairMovement(state, movement);
        if (!sawObservation && state.quantity.lte(0)) {
          closedAt = cursor;
          break;
        }
      }
      if (!rejected && closedAt >= 0) {
        // V54: an opening era validated only by stock running out is not
        // evidence. Run #60 compared it with checkpoint-proven sales: 765
        // disagreed and 78 agreed, so the assumption that each location
        // opened at the pinned item rate does not hold. Recorded as a
        // diagnostic only; later eras still start after its close.
        const [, locationIdText, stockItemIdText] = key.split(":");
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "OPENING_ERA_UNVALIDATED",
          status: "warning",
          expected: String(eraProposals.length),
          detail: `Opening era closed at ${movements[closedAt].movementId} without a recorded live rate; not used as evidence`,
        });
        openingEraEnd = closedAt;
      } else if (!rejected && matched >= 2) {
        acceptEra(
          eraProposals,
          `opening era ${key} validated by two recorded live rates`,
          "OPENING_ERA_OBSERVED_PROVEN"
        );
      }
    }

    let index = openingEraEnd + 1;
    while (index < movements.length) {
      const anchor = movements[index];
      const delta = repairQuantity(anchor.quantityDelta);
      const priced =
        (anchor.exactValue !== null && anchor.exactValue !== undefined) ||
        (anchor.unitCost !== null && anchor.unitCost !== undefined && !posJournalCostIsNotInventoryRate(anchor));
      if (!delta.gt(0) || !priced || !quantityBefore[index].isZero() || isExactValuationReset(anchor)) {
        index += 1;
        continue;
      }
      let state = applyHistoricalSalesRepairMovement(createHistoricalInventoryStateFromSnapshot("0", "0", "0"), anchor);
      const eraProposals: HistoricalSalesRepairProposal[] = [];
      let closedAt = -1;
      let rejected = false;
      for (let cursor = index + 1; cursor < movements.length; cursor += 1) {
        const movement = movements[cursor];
        if (
          isRecordedLiveRateObservation(movement) &&
          !repairRate(movement.unitCost!).eq(repairRate(state.averageRate))
        ) {
          rejected = true;
          break;
        }
        if (movement.sale) eraProposals.push(historicalSaleProposalFromState(movement, state));
        state = applyHistoricalSalesRepairMovement(state, movement);
        // V52: the era closes when stock reaches zero or goes short; every
        // sale up to that point was priced from a determined state.
        if (state.quantity.lte(0)) {
          closedAt = cursor;
          break;
        }
      }
      if (rejected || closedAt < 0) {
        index += 1;
        continue;
      }
      let proven = 0;
      let conflicts = 0;
      for (const proposal of eraProposals) {
        const blocks = blockedSaleCodes.get(proposal.salesItemId) ?? [];
        const existing = proposalsBySaleId.get(proposal.salesItemId);
        if (blocks.length === 0) {
          if (existing && existing.proposedCostPrice !== proposal.proposedCostPrice) {
            conflicts += 1;
            checks.push({
              companyId,
              locationId: proposal.locationId,
              stockItemId: proposal.stockItemId,
              salesItemId: proposal.salesItemId,
              code: "CLOSED_ERA_FORWARD_DISAGREES",
              status: "block",
              expected: proposal.proposedCostPrice,
              actual: existing.proposedCostPrice,
              detail: `Sales item ${proposal.salesItemId}: closed zero-stock era from ${anchor.movementId} gives a different cost than the checkpoint rewind`,
            });
          }
          continue;
        }
        if (!blocks.every((block) => REWIND_FAILURE_BLOCKS.test(block.code))) continue;
        for (const block of blocks) {
          block.status = "warning";
          block.detail = `${block.detail ?? ""} (superseded: closed zero-stock era ${anchor.movementId}..${movements[closedAt].movementId})`;
        }
        proposalsBySaleId.set(proposal.salesItemId, proposal);
        closedEraProvenSaleIds.add(proposal.salesItemId);
        proven += 1;
      }
      eraProvenSales += proven;
      eraConflictSales += conflicts;
      if (proven > 0 || conflicts > 0) {
        checks.push({
          companyId,
          locationId: anchor.locationId,
          stockItemId: anchor.stockItemId,
          code: "CLOSED_ZERO_STOCK_ERA_PROVEN",
          status: "pass",
          expected: String(eraProposals.length),
          actual: String(proven),
          detail: `Era ${anchor.movementId}..${movements[closedAt].movementId} opens with a priced receipt into empty stock and closes at zero stock; ${proven} blocked sale(s) priced by forward replay, ${conflicts} conflict(s) with the checkpoint rewind`,
        });
      }
      index = closedAt + 1;
    }

    // V51: the open era before the canonical journal. From the last priced
    // receipt into exactly empty stock before the first recorded live rate,
    // a forward replay is exact if the movement model is; it is accepted
    // only when it reproduces the first two recorded live rates exactly
    // (observation-validated era), and then prices the legacy sales before
    // the first observation, replacing their rewind-failure blocks.
    const observationIndexes = movements
      .map((movement, position) => (isRecordedLiveRateObservation(movement) ? position : -1))
      .filter((position) => position >= 0);
    if (observationIndexes.length >= 2) {
      const firstObservation = observationIndexes[0];
      let start = -1;
      for (let position = firstObservation - 1; position >= 0; position -= 1) {
        const candidate = movements[position];
        const candidatePriced =
          (candidate.exactValue !== null && candidate.exactValue !== undefined) ||
          (candidate.unitCost !== null &&
            candidate.unitCost !== undefined &&
            !posJournalCostIsNotInventoryRate(candidate));
        if (
          repairQuantity(candidate.quantityDelta).gt(0) &&
          candidatePriced &&
          quantityBefore[position].isZero() &&
          !isExactValuationReset(candidate)
        ) {
          start = position;
          break;
        }
      }
      if (start >= 0) {
        let state = applyHistoricalSalesRepairMovement(
          createHistoricalInventoryStateFromSnapshot("0", "0", "0"),
          movements[start]
        );
        const openProposals: HistoricalSalesRepairProposal[] = [];
        let matched = 0;
        let failed = false;
        for (let cursor = start + 1; cursor < movements.length && matched < 2; cursor += 1) {
          const movement = movements[cursor];
          if (isRecordedLiveRateObservation(movement)) {
            if (!repairRate(movement.unitCost!).eq(repairRate(state.averageRate))) {
              failed = true;
              break;
            }
            matched += 1;
          } else if (movement.sale && cursor < firstObservation) {
            openProposals.push(historicalSaleProposalFromState(movement, state));
          }
          state = applyHistoricalSalesRepairMovement(state, movement);
          if (state.quantity.lt(0)) {
            failed = true;
            break;
          }
        }
        if (!failed && matched === 2 && openProposals.length > 0) {
          let proven = 0;
          let conflicts = 0;
          for (const proposal of openProposals) {
            const blocks = (blockedSaleCodes.get(proposal.salesItemId) ?? []).filter(
              (block) => block.status === "block"
            );
            const existing = proposalsBySaleId.get(proposal.salesItemId);
            if (blocks.length === 0) {
              if (existing && existing.proposedCostPrice !== proposal.proposedCostPrice) {
                conflicts += 1;
                checks.push({
                  companyId,
                  locationId: proposal.locationId,
                  stockItemId: proposal.stockItemId,
                  salesItemId: proposal.salesItemId,
                  code: "OBSERVED_ERA_FORWARD_DISAGREES",
                  status: "block",
                  expected: proposal.proposedCostPrice,
                  actual: existing.proposedCostPrice,
                  detail: `Sales item ${proposal.salesItemId}: the observation-validated era from ${movements[start].movementId} gives a different cost than the checkpoint rewind`,
                });
              }
              continue;
            }
            if (!blocks.every((block) => REWIND_FAILURE_BLOCKS.test(block.code))) continue;
            for (const block of blocks) {
              block.status = "warning";
              block.detail = `${block.detail ?? ""} (superseded: observation-validated era ${movements[start].movementId}..${movements[firstObservation].movementId})`;
            }
            proposalsBySaleId.set(proposal.salesItemId, proposal);
            closedEraProvenSaleIds.add(proposal.salesItemId);
            proven += 1;
          }
          eraProvenSales += proven;
          eraConflictSales += conflicts;
          if (proven > 0 || conflicts > 0) {
            checks.push({
              companyId,
              locationId: movements[start].locationId,
              stockItemId: movements[start].stockItemId,
              code: "OBSERVED_ERA_FORWARD_PROVEN",
              status: "pass",
              expected: String(openProposals.length),
              actual: String(proven),
              detail: `Era from ${movements[start].movementId} (priced receipt into empty stock) replays exactly to the recorded live rates at ${movements[observationIndexes[0]].movementId} and ${movements[observationIndexes[1]].movementId}; ${proven} blocked sale(s) priced, ${conflicts} conflict(s)`,
            });
          }
        }
      }
    }
  }
  return { REWIND_FAILURE_BLOCKS, blockedSaleCodes, eraProvenSales, eraConflictSales };
}

/** Records the era-gap, amplification and rewind-coverage diagnostics for the company. */
export function reportCheckpointRewindCoverage({
  companyId,
  checks,
  legacySales,
  proposalsBySaleId,
  targetKeys,
  checkpointStates,
  mergedRecovery,
  unavailableKeys,
  checkpointTargetKeys,
  forwardReplayResolvedKeys,
  movementsByTargetKey,
  rewindAmplification,
  REWIND_FAILURE_BLOCKS,
  blockedSaleCodes,
  eraProvenSales,
  eraConflictSales,
}: {
  companyId: number;
  checks: RepairCheck[];
  legacySales: SaleRow[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  targetKeys: Set<string>;
  checkpointStates: Map<string, HistoricalInventoryState>;
  mergedRecovery: MergedRecoveryResult;
  unavailableKeys: Set<string>;
  checkpointTargetKeys: Set<string>;
  forwardReplayResolvedKeys: Set<string>;
  movementsByTargetKey: Map<string, HistoricalSalesRepairMovement[]>;
  rewindAmplification: Map<string, RewindAmplification>;
  REWIND_FAILURE_BLOCKS: RegExp;
  blockedSaleCodes: Map<number, RepairCheck[]>;
  eraProvenSales: number;
  eraConflictSales: number;
}): void {
  // V52 diagnostic: why each remaining rewind-failure sale is not in an era.
  const eraGap = { noDeterminedStartBefore: 0, eraNeverCloses: 0, other: 0 };
  for (const [key, movements] of movementsByTargetKey) {
    if (forwardReplayResolvedKeys.has(key)) continue;
    const checkpointState = checkpointStates.get(key);
    if (!checkpointState) continue;
    let quantityAfterGap = repairQuantity(checkpointState.quantity);
    const startIndexes: number[] = [];
    for (let position = movements.length - 1; position >= 0; position -= 1) {
      const before = repairQuantity(quantityAfterGap.minus(repairQuantity(movements[position].quantityDelta)));
      if (repairQuantity(movements[position].quantityDelta).gt(0) && before.isZero()) startIndexes.push(position);
      quantityAfterGap = before;
    }
    movements.forEach((movement, position) => {
      if (!movement.sale) return;
      const blocks = (blockedSaleCodes.get(movement.sale.salesItemId) ?? []).filter(
        (block) => block.status === "block"
      );
      if (blocks.length === 0 || !blocks.every((block) => REWIND_FAILURE_BLOCKS.test(block.code))) return;
      if (!startIndexes.some((startIndex) => startIndex < position)) eraGap.noDeterminedStartBefore += 1;
      else if (!startIndexes.some((startIndex) => startIndex > position)) eraGap.eraNeverCloses += 1;
      else eraGap.other += 1;
    });
  }
  checks.push({
    companyId,
    locationId: null,
    stockItemId: null,
    code: "ERA_COVERAGE_GAP_DIAGNOSTIC",
    status: "warning",
    actual: JSON.stringify(eraGap),
    detail:
      "Remaining rewind-failure sales: no receipt into empty stock before them / no later return to empty stock / other (era rejected by a recorded rate or unpriced start)",
  });
  checks.push({
    companyId,
    locationId: null,
    stockItemId: null,
    code: "CLOSED_ZERO_STOCK_ERAS",
    status: "pass",
    expected: String(eraProvenSales),
    actual: String(eraConflictSales),
    detail:
      "Sales priced by closed zero-stock era forward replay (expected) and sales blocked for disagreeing with the checkpoint rewind (actual)",
  });

  for (const [key, amplification] of rewindAmplification) {
    if (!amplification.max.gt(1)) continue;
    const [, locationIdText, stockItemIdText] = key.split(":");
    checks.push({
      companyId,
      locationId: Number(locationIdText),
      stockItemId: Number(stockItemIdText),
      code: "REWIND_ERROR_AMPLIFICATION",
      status: "warning",
      expected: "<=1.00",
      actual: amplification.max.toFixed(2),
      detail: `Rewound rate moves up to ${amplification.max.toFixed(
        2
      )} cents per cent of checkpoint-side model error (worst: sales item ${amplification.maxSalesItemId}); ${
        amplification.proposals
      } rewound proposals, ${amplification.over10} above 10x, ${amplification.over100} above 100x`,
    });
  }

  for (const sale of legacySales) {
    if (!sale.location_id) continue;
    if (!proposalsBySaleId.has(Number(sale.sales_item_id))) {
      proposalsBySaleId.set(Number(sale.sales_item_id), originalProposalForSale(companyId, sale));
    }
  }

  const rewindReadyKeys =
    [...checkpointTargetKeys].filter((key) => !unavailableKeys.has(key)).length + mergedRecovery.recoveredKeys.size;
  checks.push({
    companyId,
    locationId: null,
    stockItemId: null,
    code: "CHECKPOINT_REWIND_COVERAGE",
    status: rewindReadyKeys === targetKeys.size ? "pass" : "warning",
    expected: String(targetKeys.size),
    actual: String(rewindReadyKeys),
    detail: "Legacy sale item/location keys with a fully provable checkpoint rewind",
  });
}
