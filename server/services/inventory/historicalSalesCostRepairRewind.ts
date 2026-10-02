/** Checkpoint rewind for the historical sales-cost repair dry run. */
import Decimal from "decimal.js";

import {
  applyHistoricalSalesRepairMovement,
  createHistoricalInventoryStateFromSnapshot,
  historicalSaleProposalFromState,
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  isExactValuationReset,
  historicalIssueInverseCandidates,
  isLiveRateIssueWithUnpinnedRate,
  isRecordedLiveRateObservation,
  repairRate,
  reverseHistoricalSalesRepairMovement,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  CANONICAL_SALE_SOURCE_TYPES,
  LegacyInverseAmbiguity,
  ReanchorRequest,
  RepairCheck,
  RewindAlternate,
  RewindAmplification,
  d,
  legacyInverseNotUniqueBlock,
  traceState,
} from "./historicalSalesCostRepairTypes";
import { compareMovementMutationAscending, movementKey } from "./historicalSalesCostRepairEvidence";
import { historicalInventoryStatesEqual } from "./historicalSalesCostRepairRecovery";

/** Rewinds the immutable checkpoint through every durable movement to price legacy sales, tracking alternate branches. */
export function rewindCheckpointToLegacySales({
  companyId,
  traceRewind,
  checks,
  proposalsBySaleId,
  unavailableKeys,
  checkpointTargetKeys,
  rewindStates,
  movementsInCheckpoint,
  priorCostMemoryRateHints,
  targetLegacySaleMovementsByKey,
  forwardReplayResolvedKeys,
  movementsAscending,
  forwardResetProvenSaleIds,
}: {
  companyId: number;
  traceRewind: (key: string, line: string) => void;
  checks: RepairCheck[];
  proposalsBySaleId: Map<number, HistoricalSalesRepairProposal>;
  unavailableKeys: Set<string>;
  checkpointTargetKeys: Set<string>;
  rewindStates: Map<string, HistoricalInventoryState>;
  movementsInCheckpoint: HistoricalSalesRepairMovement[];
  priorCostMemoryRateHints: Map<string, string>;
  targetLegacySaleMovementsByKey: Map<string, HistoricalSalesRepairMovement[]>;
  forwardReplayResolvedKeys: Set<string>;
  movementsAscending: HistoricalSalesRepairMovement[];
  forwardResetProvenSaleIds: Set<number>;
}): {
  reanchorRequests: ReanchorRequest[];
  rewindAlternates: Map<string, RewindAlternate[]>;
  finishedAlternates: Map<string, RewindAlternate[]>;
  primaryHistoryByKey: Map<string, Map<number, HistoricalSalesRepairProposal>>;
  branchOverflowKeys: Set<string>;
  legacyInverseAmbiguity: Map<string, LegacyInverseAmbiguity>;
  REWIND_AMPLIFICATION_LIMIT: Decimal;
  REANCHOR_MAX_CANDIDATES: Decimal;
  rewindAmplification: Map<string, RewindAmplification>;
} {
  const rewindBoundaryReached = new Set<string>();
  const UNRECORDED_REVALUATION_MIN_JUMP = new Decimal("0.02");
  const reanchorRequests: Array<{
    key: string;
    anchor: HistoricalSalesRepairMovement;
    beforeQuantity: Decimal;
    recorded: Decimal;
    inferred: Decimal;
    unresolvedSales: HistoricalSalesRepairMovement[];
    transition: "UNRECORDED_REVALUATION" | "COST_MEMORY_RESET" | "COLLAPSED_POS_LINES";
    transitionMovementId: string;
  }> = [];
  // V41: the newest-in-rewind movement at each key that erased cost memory
  // between the checkpoint and the current rewind position: a priced receipt
  // into zero or negative stock (production sets the rate from the receipt
  // alone) or a pinned valuation reset. Above such a boundary the checkpoint
  // holds no information about the earlier rate, so a canonical sale's
  // recorded live rate below it is the only evidence of that rate.
  const costMemoryResetByKey = new Map<string, HistoricalSalesRepairMovement>();
  // V45 branching rewind: alternate pre-states (each with the sale proposals
  // it implies) where an issue at an unpinned live rate has several exact
  // inverses. The primary path (rewindStates) drives every existing check;
  // recorded live rates and exact inverses prune the alternates or promote
  // one over a contradicted primary, and legacy sales are priced only when
  // every surviving branch agrees.
  const REWIND_BRANCH_LIMIT = 32;
  const rewindAlternates = new Map<string, RewindAlternate[]>();
  const finishedAlternates = new Map<string, RewindAlternate[]>();
  const primaryHistoryByKey = new Map<string, Map<number, HistoricalSalesRepairProposal>>();
  const branchOverflowKeys = new Set<string>();
  const legacyInverseAmbiguity = new Map<string, { sales: number; maxSpread: Decimal }>();
  const branchSignature = (state: HistoricalInventoryState, history: Map<number, HistoricalSalesRepairProposal>) =>
    traceState(state) +
    "|" +
    [...history.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([salesItemId, proposal]) => `${salesItemId}=${proposal.proposedCostPrice}`)
      .join(",");
  let movementsAscendingByKey: Map<string, HistoricalSalesRepairMovement[]> | null = null;
  const nextMovementAtKey = (
    key: string,
    movement: HistoricalSalesRepairMovement
  ): HistoricalSalesRepairMovement | undefined => {
    if (!movementsAscendingByKey) {
      movementsAscendingByKey = new Map();
      for (const candidate of movementsAscending) {
        const rows = movementsAscendingByKey.get(movementKey(candidate)) ?? [];
        rows.push(candidate);
        movementsAscendingByKey.set(movementKey(candidate), rows);
      }
    }
    const rows = movementsAscendingByKey.get(key) ?? [];
    const index = rows.findIndex((candidate) => candidate.movementId === movement.movementId);
    return index >= 0 ? rows[index + 1] : undefined;
  };
  // V34 diagnostic: rewinding a receipt divides any value error by the
  // smaller pre-receipt quantity, so the reconstructed rate's sensitivity to
  // a one-cent model error at the checkpoint grows by Q_after/Q_before at
  // every rewound receipt (issues leave it unchanged). Low-stock keys that
  // never reach zero (company 1, location 134, item 702 hovered at one unit
  // for nine months) amplify a 2-cent drift into 536M/unit. Recorded as a
  // warning to measure before any threshold becomes a blocker.
  const rewindSensitivity = new Map<string, Decimal>();
  const REWIND_AMPLIFICATION_LIMIT = new Decimal(100);
  const REANCHOR_MAX_CANDIDATES = new Decimal(20000);
  const rewindAmplification = new Map<
    string,
    { max: Decimal; maxSalesItemId: number; proposals: number; over10: number; over100: number }
  >();

  for (const movement of movementsInCheckpoint) {
    const key = movementKey(movement);
    if (
      !checkpointTargetKeys.has(key) ||
      unavailableKeys.has(key) ||
      forwardReplayResolvedKeys.has(key) ||
      rewindBoundaryReached.has(key)
    ) {
      continue;
    }
    const stateAfter = rewindStates.get(key);
    if (!stateAfter) continue;
    let reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
      priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
    });

    // V49 measurement: a legacy sale whose own inverse has several exact
    // pre-issue rates is priced on the primary choice (rate unchanged across
    // the issue); count them so the residual uncertainty is reported.
    if (
      movement.evidence === "legacy" &&
      movement.sale &&
      reversed.reversible &&
      isLiveRateIssueWithUnpinnedRate(movement)
    ) {
      const primaryBefore = reversed.stateBefore;
      const alternatives = historicalIssueInverseCandidates(stateAfter, movement).filter(
        (candidate) => !historicalInventoryStatesEqual(candidate, primaryBefore)
      );
      if (alternatives.length > 0) {
        const spread = Decimal.max(
          ...alternatives.map((candidate) =>
            repairRate(candidate.averageRate).minus(repairRate(primaryBefore.averageRate)).abs()
          )
        );
        const entry = legacyInverseAmbiguity.get(key) ?? { sales: 0, maxSpread: new Decimal(0) };
        entry.sales += 1;
        if (spread.gt(entry.maxSpread)) entry.maxSpread = spread;
        legacyInverseAmbiguity.set(key, entry);
        // V50 strict proof: the sale's own cost is not uniquely determined.
        if (!forwardResetProvenSaleIds.has(movement.sale.salesItemId)) {
          checks.push(
            legacyInverseNotUniqueBlock(companyId, movement, primaryBefore, alternatives, "checkpoint rewind")
          );
        }
      }
    }

    // V45: advance and branch the alternates, then let recorded evidence
    // prune them or replace a contradicted primary.
    const branchable = movement.evidence === "canonical" && isLiveRateIssueWithUnpinnedRate(movement);
    const currentAlternates = rewindAlternates.get(key) ?? [];
    if ((branchable || currentAlternates.length > 0) && !branchOverflowKeys.has(key)) {
      const primaryHistory = primaryHistoryByKey.get(key) ?? new Map<number, HistoricalSalesRepairProposal>();
      const withSale = (history: Map<number, HistoricalSalesRepairProposal>, state: HistoricalInventoryState) => {
        if (!movement.sale || forwardResetProvenSaleIds.has(movement.sale.salesItemId)) return history;
        const copy = new Map(history);
        copy.set(movement.sale.salesItemId, historicalSaleProposalFromState(movement, state));
        return copy;
      };
      const next: RewindAlternate[] = [];
      const finished = finishedAlternates.get(key) ?? [];
      if (branchable) {
        for (const candidate of historicalIssueInverseCandidates(stateAfter, movement)) {
          if (reversed.reversible && historicalInventoryStatesEqual(candidate, reversed.stateBefore)) continue;
          next.push({ state: candidate, history: withSale(primaryHistory, candidate) });
        }
      }
      for (const alternate of currentAlternates) {
        const alternateReversed = reverseHistoricalSalesRepairMovement(alternate.state, movement, {
          priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
        });
        const befores: HistoricalInventoryState[] = [];
        if (alternateReversed.reversible) befores.push(alternateReversed.stateBefore);
        else if (alternateReversed.reason === "COST_MEMORY_IRREVERSIBLE") finished.push(alternate);
        if (branchable) {
          for (const candidate of historicalIssueInverseCandidates(alternate.state, movement)) {
            if (!befores.some((before) => historicalInventoryStatesEqual(before, candidate))) befores.push(candidate);
          }
        }
        for (const before of befores) next.push({ state: before, history: withSale(alternate.history, before) });
      }

      let surviving = next;
      let promotedBy: string | null = null;
      if (isRecordedLiveRateObservation(movement)) {
        const recorded = repairRate(movement.unitCost!);
        surviving = next.filter((alternate) => repairRate(alternate.state.averageRate).eq(recorded));
        const primaryAgrees = reversed.reversible && repairRate(reversed.stateBefore.averageRate).eq(recorded);
        if (!primaryAgrees && surviving.length > 0) promotedBy = "recorded live rate " + recorded.toFixed(2);
      } else if (!reversed.reversible && reversed.reason === "MOVEMENT_INVERSE_INVALID" && surviving.length > 0) {
        promotedBy = "exact inverse";
      }
      if (promotedBy) {
        const promoted = surviving.shift()!;
        reversed = { reversible: true, stateBefore: promoted.state };
        const promotedHistory = new Map(promoted.history);
        if (movement.sale) promotedHistory.delete(movement.sale.salesItemId);
        for (const [salesItemId, proposal] of promotedHistory) proposalsBySaleId.set(salesItemId, proposal);
        primaryHistoryByKey.set(key, promotedHistory);
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "REWIND_BRANCH_PROMOTED",
          status: "pass",
          actual: traceState(promoted.state),
          detail: `At ${movement.movementId} the ${promotedBy} contradicts the primary rewind; an alternate exact inverse that agrees replaces it`,
        });
      }

      const primaryNow = primaryHistoryByKey.get(key) ?? primaryHistory;
      const primarySignature = reversed.reversible
        ? branchSignature(reversed.stateBefore, withSale(primaryNow, reversed.stateBefore))
        : null;
      const seen = new Set<string>(primarySignature ? [primarySignature] : []);
      const deduped: RewindAlternate[] = [];
      for (const alternate of surviving) {
        const signature = branchSignature(alternate.state, alternate.history);
        if (seen.has(signature)) continue;
        seen.add(signature);
        deduped.push(alternate);
      }
      if (deduped.length > REWIND_BRANCH_LIMIT) {
        branchOverflowKeys.add(key);
        rewindAlternates.set(key, []);
      } else {
        rewindAlternates.set(key, deduped);
      }
      finishedAlternates.set(key, finished);
    }
    traceRewind(
      key,
      [
        movement.createdAt ?? movement.occurredAt,
        movement.movementId,
        movement.sourceType + (movement.canonicalPosRole ? "/" + movement.canonicalPosRole : ""),
        "dq=" + repairQuantity(movement.quantityDelta).toFixed(3),
        "uc=" + (movement.unitCost == null ? "-" : String(movement.unitCost)),
        "ev=" + (movement.exactValue == null ? "-" : String(movement.exactValue)),
        "after=" + traceState(stateAfter),
        reversed.reversible
          ? "before=" + traceState(reversed.stateBefore) + (reversed.recovery ? " via " + reversed.recovery : "")
          : "IRREVERSIBLE " + reversed.reason,
        movement.sale ? "sale=" + movement.sale.salesItemId : "",
        (rewindAlternates.get(key)?.length ?? 0) > 0 ? "alts=" + rewindAlternates.get(key)!.length : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (!reversed.reversible) {
      const priorRateHint = priorCostMemoryRateHints.get(movement.movementId) ?? null;
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "REWIND_BOUNDARY_DIAGNOSTIC",
        status: "warning",
        expected:
          repairQuantity(stateAfter.quantity).toFixed(3) +
          "|" +
          repairRate(stateAfter.averageRate).toFixed(2) +
          "|" +
          repairMoney(stateAfter.totalValue).toFixed(2),
        actual:
          repairQuantity(movement.quantityDelta).toFixed(3) +
          "|" +
          (movement.unitCost == null ? "null" : String(movement.unitCost)) +
          "|" +
          (priorRateHint == null ? "null" : repairRate(priorRateHint).toFixed(2)),
        detail:
          "reason=" +
          reversed.reason +
          " boundary=" +
          movement.movementId +
          " sourceType=" +
          movement.sourceType +
          " evidence=" +
          movement.evidence +
          " stateAfter=qty|rate|value delta|unitCost|priorRateHint occurredAt=" +
          movement.occurredAt,
      });
      const unresolvedSales = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
        (saleMovement) =>
          compareMovementMutationAscending(saleMovement, movement) <= 0 &&
          !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
      );
      rewindBoundaryReached.add(key);

      if (reversed.reason === "MOVEMENT_INVERSE_INVALID") {
        // V43: an impossible inverse proves the rewound state above this
        // movement inconsistent with the evidence below it, yet the legacy
        // sales between it and the checkpoint were already priced from that
        // state. The error is somewhere between the checkpoint and here, so
        // a sale's rewound cost is kept only when it is independent of where
        // the error lies: a priced receipt into exactly empty stock fixes
        // the state after it whatever came before, and a forward replay from
        // that state must reach the same cost for the sale. Otherwise the
        // sale is blocked.
        const pricedAbove = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
          (saleMovement) =>
            compareMovementMutationAscending(saleMovement, movement) > 0 &&
            proposalsBySaleId.has(saleMovement.sale!.salesItemId) &&
            !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
        );
        if (pricedAbove.length > 0) {
          const delta = repairQuantity(movement.quantityDelta);
          const determined =
            delta.gt(0) &&
            movement.unitCost !== null &&
            movement.unitCost !== undefined &&
            !posJournalCostIsNotInventoryRate(movement) &&
            repairQuantity(stateAfter.quantity).minus(delta).isZero();
          const forwardCost = new Map<number, string>();
          if (determined) {
            let forward = applyHistoricalSalesRepairMovement(
              createHistoricalInventoryStateFromSnapshot("0", "0", "0"),
              movement
            );
            const later = movementsInCheckpoint
              .filter(
                (candidate) =>
                  movementKey(candidate) === key && compareMovementMutationAscending(candidate, movement) > 0
              )
              .sort(compareMovementMutationAscending);
            for (const laterMovement of later) {
              if (laterMovement.sale) {
                forwardCost.set(
                  laterMovement.sale.salesItemId,
                  historicalSaleProposalFromState(laterMovement, forward).proposedCostPrice
                );
              }
              forward = applyHistoricalSalesRepairMovement(forward, laterMovement);
            }
          }
          let agreed = 0;
          for (const saleMovement of pricedAbove) {
            const salesItemId = saleMovement.sale!.salesItemId;
            const rewound = proposalsBySaleId.get(salesItemId)!.proposedCostPrice;
            const forward = forwardCost.get(salesItemId);
            if (forward !== undefined && forward === rewound) {
              agreed += 1;
              continue;
            }
            checks.push({
              companyId,
              locationId: saleMovement.locationId,
              stockItemId: saleMovement.stockItemId,
              salesItemId,
              code: "CHECKPOINT_REWIND_CONTRADICTED_BELOW",
              status: "block",
              expected: rewound,
              actual: forward ?? "undetermined",
              detail: `Sales item ${salesItemId} was rewound from a state contradicted by ${movement.movementId} (${
                determined ? "forward replay from the empty-stock receipt disagrees" : "no fully determined state below"
              })`,
            });
          }
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "REWIND_CONTRADICTION_TWO_SIDED",
            status: "warning",
            expected: String(pricedAbove.length),
            actual: String(agreed),
            detail: `${agreed} of ${pricedAbove.length} legacy sales above impossible inverse ${movement.movementId} have the same cost from the checkpoint rewind and from ${
              determined ? "a forward replay of the empty-stock receipt" : "no independent forward state"
            }`,
          });
        }
      }

      if (unresolvedSales.length === 0) {
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "REWIND_RESET_BOUNDARY_REACHED",
          status: "pass",
          detail: `Stopped safely at ${movement.movementId} because no target historical sale exists before the irreversible valuation boundary`,
        });
        continue;
      }

      for (const saleMovement of unresolvedSales) {
        checks.push({
          companyId,
          locationId: saleMovement.locationId,
          stockItemId: saleMovement.stockItemId,
          salesItemId: saleMovement.sale!.salesItemId,
          code: `${movement.evidence === "canonical" ? "CHECKPOINT" : "LEGACY"}_REWIND_${reversed.reason}`,
          status: "block",
          detail: `Sales item ${saleMovement.sale!.salesItemId} predates irreversible valuation boundary ${movement.movementId}`,
        });
      }
      continue;
    }

    if (reversed.recovery === "CANONICAL_RATE_ONLY") {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "CANONICAL_REWIND_RATE_ONLY_RECOVERED",
        status: "pass",
        expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        detail:
          "Canonical boundary " +
          movement.movementId +
          " recovered because forward replay reproduced quantity and total value exactly; only the reconstructed intermediate average-rate field disagreed. Prior rate=" +
          repairRate(reversed.stateBefore.averageRate).toFixed(2),
      });
    }

    if (reversed.recovery === "LEGACY_ISSUE_RATE_ONLY") {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "LEGACY_REWIND_RATE_ONLY_RECOVERED",
        status: "pass",
        expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        detail:
          "Legacy sale boundary " +
          movement.movementId +
          " recovered from the unique self-consistent pre-issue rate because replay reproduced quantity and total value exactly; no ambiguous rate candidate was accepted. Prior rate=" +
          repairRate(reversed.stateBefore.averageRate).toFixed(2),
      });
    }

    if (reversed.recovery === "CANONICAL_RECORDED_ISSUE_RATE") {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "CANONICAL_RECORDED_SALE_RATE_RECOVERED",
        status: "pass",
        expected: repairRate(movement.unitCost ?? "0").toFixed(2),
        actual: repairRate(reversed.stateBefore.averageRate).toFixed(2),
        detail:
          "Canonical sale boundary " +
          movement.movementId +
          " used its recorded transaction-time issue rate because that rate replayed quantity and total value exactly and the generic inverse selected a conflicting rate.",
      });
    }

    if (reversed.recovery === "CANONICAL_ADJUSTMENT_EDIT_VALUE") {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "CANONICAL_ADJUSTMENT_EDIT_VALUE_RECOVERED",
        status: "pass",
        expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        detail:
          "Canonical stock-adjustment edit apply boundary " +
          movement.movementId +
          " recovered by adding back its persisted line value and replaying the source-specific consumption semantics exactly. Prior rate=" +
          repairRate(reversed.stateBefore.averageRate).toFixed(2),
      });
    }

    if (reversed.recovery === "LEGACY_RECEIPT_RATE_ONLY") {
      checks.push({
        companyId,
        locationId: movement.locationId,
        stockItemId: movement.stockItemId,
        code: "LEGACY_RECEIPT_RATE_ONLY_RECOVERED",
        status: "pass",
        expected: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        actual: repairQuantity(stateAfter.quantity).toFixed(3) + "|" + repairMoney(stateAfter.totalValue).toFixed(2),
        detail:
          "Legacy offload boundary " +
          movement.movementId +
          " recovered from the exact stored offload total_value because replay reproduced quantity and total value exactly; only the reconstructed intermediate average-rate field disagreed. Prior rate=" +
          repairRate(reversed.stateBefore.averageRate).toFixed(2),
      });
    }

    // V33: only an original POS sale issue journals the locked live rate. An
    // edit re-issue journals the preserved old sale-line cost, so it is not
    // evidence about the inventory rate and must not be compared with it.
    if (
      movement.evidence === "canonical" &&
      CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType) &&
      !posJournalCostIsNotInventoryRate(movement) &&
      d(movement.quantityDelta).lt(0)
    ) {
      const recorded = repairRate(movement.unitCost ?? "0");
      const inferred = repairRate(reversed.stateBefore.averageRate);
      if (!recorded.eq(inferred)) {
        // V37 diagnostic: issues never move the average beyond rounding, so
        // when the very next movement at this key is another original sale
        // issue journaling a materially different locked live rate, the
        // inventory was revalued in between by a writer that left no
        // movement (cost-price import, direct location import). That
        // boundary cannot be crossed without evidence of the revaluation.
        // V47: outbound movements between two recorded live rates move the
        // stored rate by at most one cent of rounding each, so a larger gap
        // than 0.02 plus a cent per intervening issue cannot come from them.
        let nextMovement: HistoricalSalesRepairMovement | undefined = nextMovementAtKey(key, movement);
        let issuesBetween = 0;
        while (
          nextMovement &&
          !isRecordedLiveRateObservation(nextMovement) &&
          d(nextMovement.quantityDelta).lt(0) &&
          (nextMovement.exactValue === null || nextMovement.exactValue === undefined) &&
          !isExactValuationReset(nextMovement)
        ) {
          issuesBetween += 1;
          nextMovement = nextMovementAtKey(key, nextMovement);
        }
        let unrecordedRevaluation = false;
        if (
          nextMovement &&
          isRecordedLiveRateObservation(nextMovement) &&
          repairRate(nextMovement.unitCost!)
            .minus(recorded)
            .abs()
            .gt(UNRECORDED_REVALUATION_MIN_JUMP.plus(new Decimal(issuesBetween).times("0.01")))
        ) {
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "UNRECORDED_REVALUATION_DETECTED",
            status: "warning",
            expected: recorded.toFixed(2),
            actual: repairRate(nextMovement.unitCost!).toFixed(2),
            detail: `Locked live rate moved from ${recorded.toFixed(2)} (${movement.movementId}, ${
              movement.createdAt ?? movement.occurredAt
            }) to ${repairRate(nextMovement.unitCost!).toFixed(2)} (${nextMovement.movementId}, ${
              nextMovement.createdAt ?? nextMovement.occurredAt
            }) with ${issuesBetween ? issuesBetween + " outbound movement(s)" : "no stock movement"} between them`,
          });
          unrecordedRevaluation = true;
        }
        const unresolvedSales = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
          (saleMovement) =>
            compareMovementMutationAscending(saleMovement, movement) < 0 &&
            !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
        );
        rewindBoundaryReached.add(key);
        const costMemoryReset = costMemoryResetByKey.get(key);
        if ((unrecordedRevaluation || costMemoryReset) && unresolvedSales.length > 0) {
          // V39: try to re-anchor below the revaluation instead of blocking
          // outright; the blocks are emitted after the attempt if it fails.
          // V41: the same proof applies below a cost-memory reset, where the
          // disagreement is the rewind's guess of an erased rate, not a
          // contradiction between independent evidence.
          reanchorRequests.push({
            key,
            anchor: movement,
            beforeQuantity: repairQuantity(reversed.stateBefore.quantity),
            recorded,
            inferred,
            unresolvedSales,
            transition: unrecordedRevaluation ? "UNRECORDED_REVALUATION" : "COST_MEMORY_RESET",
            transitionMovementId: unrecordedRevaluation
              ? (nextMovement?.movementId ?? movement.movementId)
              : costMemoryReset!.movementId,
          });
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "VALUATION_ERA_BOUNDARY",
            status: "warning",
            expected: recorded.toFixed(2),
            actual: inferred.toFixed(2),
            detail: `transition=${unrecordedRevaluation ? "UNRECORDED_REVALUATION" : "COST_MEMORY_RESET"} at ${
              unrecordedRevaluation ? (nextMovement?.movementId ?? movement.movementId) : costMemoryReset!.movementId
            }; anchor=${movement.movementId} recorded live rate ${recorded.toFixed(2)}, checkpoint rewind inferred ${inferred.toFixed(2)}`,
          });
        } else if (unresolvedSales.length === 0) {
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
            status: "warning",
            expected: recorded.toFixed(2),
            actual: inferred.toFixed(2),
            detail: `Canonical movement ${movement.movementId} disagrees with checkpoint rewind after all target legacy sales were already reconstructed`,
          });
        } else {
          for (const saleMovement of unresolvedSales) {
            checks.push({
              companyId,
              locationId: saleMovement.locationId,
              stockItemId: saleMovement.stockItemId,
              salesItemId: saleMovement.sale!.salesItemId,
              code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
              status: "block",
              expected: recorded.toFixed(2),
              actual: inferred.toFixed(2),
              detail: `Sales item ${saleMovement.sale!.salesItemId} predates canonical cost boundary ${movement.movementId}`,
            });
          }
        }
        continue;
      }
    }

    const afterQty = repairQuantity(stateAfter.quantity);
    const beforeQty = repairQuantity(reversed.stateBefore.quantity);
    let sensitivity =
      rewindSensitivity.get(key) ?? (afterQty.gt(0) ? new Decimal(1).dividedBy(afterQty) : new Decimal(1));
    if (d(movement.quantityDelta).gt(0) && afterQty.gt(0) && beforeQty.gt(0)) {
      sensitivity = Decimal.min(sensitivity.times(afterQty).dividedBy(beforeQty), new Decimal("1e15"));
    }
    rewindSensitivity.set(key, sensitivity);

    if (movement.sale && !forwardResetProvenSaleIds.has(movement.sale.salesItemId)) {
      const primaryProposal = historicalSaleProposalFromState(movement, reversed.stateBefore);
      proposalsBySaleId.set(movement.sale.salesItemId, primaryProposal);
      const primaryHistory = primaryHistoryByKey.get(key) ?? new Map<number, HistoricalSalesRepairProposal>();
      primaryHistory.set(movement.sale.salesItemId, primaryProposal);
      primaryHistoryByKey.set(key, primaryHistory);
      const amplification = rewindAmplification.get(key) ?? {
        max: new Decimal(0),
        maxSalesItemId: movement.sale.salesItemId,
        proposals: 0,
        over10: 0,
        over100: 0,
      };
      amplification.proposals += 1;
      if (sensitivity.gt(REWIND_AMPLIFICATION_LIMIT)) {
        // V35: a reconstruction this ill-conditioned is not proven even when
        // every local inverse replays exactly: one cent of model drift near
        // the checkpoint moves this sale's cost by more than a dollar.
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          salesItemId: movement.sale.salesItemId,
          code: "LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED",
          status: "block",
          expected: `<=${REWIND_AMPLIFICATION_LIMIT.toFixed(0)}`,
          actual: sensitivity.toFixed(2),
          detail: `Sales item ${movement.sale.salesItemId} rewound cost moves ${sensitivity.toFixed(
            2
          )} cents per cent of checkpoint-side model error`,
        });
      }
      if (sensitivity.gt(10)) amplification.over10 += 1;
      if (sensitivity.gt(100)) amplification.over100 += 1;
      if (sensitivity.gt(amplification.max)) {
        amplification.max = sensitivity;
        amplification.maxSalesItemId = movement.sale.salesItemId;
      }
      rewindAmplification.set(key, amplification);
    }
    if (
      isExactValuationReset(movement) ||
      (d(movement.quantityDelta).gt(0) &&
        movement.unitCost !== null &&
        movement.unitCost !== undefined &&
        !posJournalCostIsNotInventoryRate(movement) &&
        repairQuantity(reversed.stateBefore.quantity).lte(0))
    ) {
      costMemoryResetByKey.set(key, movement);
    }
    rewindStates.set(key, reversed.stateBefore);
  }
  return {
    reanchorRequests,
    rewindAlternates,
    finishedAlternates,
    primaryHistoryByKey,
    branchOverflowKeys,
    legacyInverseAmbiguity,
    REWIND_AMPLIFICATION_LIMIT,
    REANCHOR_MAX_CANDIDATES,
    rewindAmplification,
  };
}
