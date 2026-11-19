// Extracted from ./historicalSalesCostRepairRewind.ts: a stage of historicalSalesCostRepairRewind.
import Decimal from "decimal.js";
import {
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { RewindAlternate, traceState } from "./historicalSalesCostRepairTypes";
import { movementKey } from "./historicalSalesCostRepairEvidence";
import type { RepairCheck } from "./historicalSalesCostRepairTypes";

export function historicalSalesCostRepairRewindStep({
  movementsAscending,
}: {
  movementsAscending: {
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
  }["movementsAscending"];
}) {
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

  return {
    rewindBoundaryReached,
    UNRECORDED_REVALUATION_MIN_JUMP,
    reanchorRequests,
    costMemoryResetByKey,
    REWIND_BRANCH_LIMIT,
    rewindAlternates,
    finishedAlternates,
    primaryHistoryByKey,
    branchOverflowKeys,
    legacyInverseAmbiguity,
    branchSignature,
    nextMovementAtKey,
    rewindSensitivity,
    REWIND_AMPLIFICATION_LIMIT,
    REANCHOR_MAX_CANDIDATES,
    rewindAmplification,
  };
}
