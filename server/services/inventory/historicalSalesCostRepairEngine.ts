import Decimal from "decimal.js";

export const HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION = "2026-09-30-v2-checkpoint-rewind-merged";

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
  createdAt?: string;
  idempotencyKey?: string | null;
  reversalOfMovementId?: number | null;
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

export type CanonicalSalesRepairLine = {
  salesItemId: number;
  voucherId: number;
  locationId: number;
  stockItemId: number;
  quantity: string;
};

export type CanonicalSaleLineEvidence = {
  salesItemId: number;
  voucherId: number;
  locationId: number;
  stockItemId: number;
  unitCost: string;
  sourceType: string;
  sourceId: string;
  movementId: string;
};

export type CanonicalSaleEvidenceBlocker = {
  voucherId: number;
  locationId: number;
  stockItemId: number;
  code:
    | "CANONICAL_SALE_EVIDENCE_AMBIGUOUS"
    | "CANONICAL_SALE_EVIDENCE_QUANTITY_MISMATCH"
    | "CANONICAL_SALE_EVIDENCE_RATE_MISSING"
    | "CANONICAL_SALE_EVIDENCE_LINE_MISSING";
  expected?: string;
  actual?: string;
  detail: string;
};

type PosSaleCanonicalIdentity = {
  voucherId: number;
  revision: number;
  phase: "issue" | "reverse";
  stockItemId: number;
  lineOrdinal: number | null;
};

function parsePosSaleCanonicalIdentity(value: string | null | undefined): PosSaleCanonicalIdentity | null {
  const key = String(value ?? "");
  const match = key.match(/^pos-sale:(\d+):rev(\d+):(?:(issue|reverse):)?(\d+)(?::line:(\d+))?$/);
  if (!match) return null;
  return {
    voucherId: Number(match[1]),
    revision: Number(match[2]),
    phase: (match[3] as "issue" | "reverse" | undefined) ?? "issue",
    stockItemId: Number(match[4]),
    lineOrdinal: match[5] ? Number(match[5]) : null,
  };
}

function canonicalMovementNumericId(movement: HistoricalSalesRepairMovement): number | null {
  const match = movement.movementId.match(/^canonical:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function canonicalSaleGroupKey(voucherId: number, locationId: number, stockItemId: number): string {
  return `${voucherId}:${locationId}:${stockItemId}`;
}

function importSaleItemId(
  sourceType: string,
  idempotencyKey: string | null | undefined,
  voucherId: number
): number | null {
  if (sourceType !== "pos-import" && sourceType !== "credit-sales-import") return null;
  const prefix = sourceType === "pos-import" ? "pos-import" : "credit-sales-import";
  const match = String(idempotencyKey ?? "").match(new RegExp(`^${prefix}:(\\d+):(\\d+)import Decimal from "decimal.js";

export const HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION = "2026-09-30-v2-checkpoint-rewind-merged";

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
  createdAt?: string;
  idempotencyKey?: string | null;
  reversalOfMovementId?: number | null;
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

));
  if (!match || Number(match[1]) !== voucherId) return null;
  return Number(match[2]);
}

export function resolveCanonicalSaleCostEvidence(input: {
  sales: CanonicalSalesRepairLine[];
  movements: HistoricalSalesRepairMovement[];
}): {
  evidenceBySalesItemId: Map<number, CanonicalSaleLineEvidence>;
  blockers: CanonicalSaleEvidenceBlocker[];
} {
  const evidenceBySalesItemId = new Map<number, CanonicalSaleLineEvidence>();
  const blockers: CanonicalSaleEvidenceBlocker[] = [];
  const reversedIds = new Set<number>();

  for (const movement of input.movements) {
    if (typeof movement.reversalOfMovementId === "number" && movement.reversalOfMovementId > 0) {
      reversedIds.add(movement.reversalOfMovementId);
    }
  }

  const activeMovements = input.movements.filter((movement) => {
    const id = canonicalMovementNumericId(movement);
    return id === null || !reversedIds.has(id);
  });

  const salesByGroup = new Map<string, CanonicalSalesRepairLine[]>();
  for (const sale of input.sales) {
    const key = canonicalSaleGroupKey(sale.voucherId, sale.locationId, sale.stockItemId);
    const group = salesByGroup.get(key) ?? [];
    group.push(sale);
    salesByGroup.set(key, group);
  }

  for (const [key, sales] of salesByGroup) {
    sales.sort((a, b) => a.salesItemId - b.salesItemId);
    const [voucherIdText, locationIdText, stockItemIdText] = key.split(":");
    const voucherId = Number(voucherIdText);
    const locationId = Number(locationIdText);
    const stockItemId = Number(stockItemIdText);
    const movements = activeMovements.filter(
      (movement) =>
        movement.sourceId === String(voucherId) &&
        movement.locationId === locationId &&
        movement.stockItemId === stockItemId &&
        (movement.sourceType === "pos-sale" ||
          movement.sourceType === "pos-import" ||
          movement.sourceType === "credit-sales-import")
    );
    if (movements.length === 0) continue;

    const posSaleMovements = movements.filter((movement) => movement.sourceType === "pos-sale");
    const staged = new Map<number, CanonicalSaleLineEvidence>();
    let blocker: CanonicalSaleEvidenceBlocker | null = null;

    if (posSaleMovements.length > 0) {
      const parsed = posSaleMovements.map((movement) => ({
        movement,
        identity: parsePosSaleCanonicalIdentity(movement.idempotencyKey),
      }));
      if (parsed.some(({ identity }) => identity === null)) {
        blocker = {
          voucherId,
          locationId,
          stockItemId,
          code: "CANONICAL_SALE_EVIDENCE_AMBIGUOUS",
          detail: "POS canonical movement identity is not parseable as a revisioned sale movement",
        };
      } else {
        const maxRevision = Math.max(...parsed.map(({ identity }) => identity!.revision));
        const issues = parsed.filter(
          ({ movement, identity }) =>
            identity!.revision === maxRevision &&
            identity!.phase === "issue" &&
            repairQuantity(movement.quantityDelta).lt(ZERO)
        );

        if (issues.length === 0) {
          blocker = {
            voucherId,
            locationId,
            stockItemId,
            code: "CANONICAL_SALE_EVIDENCE_LINE_MISSING",
            detail: `POS sale revision ${maxRevision} has no active issue evidence for the current sale lines`,
          };
        } else {
          const lineSpecific = issues.every(({ identity }) => identity!.lineOrdinal !== null);
          const aggregate = issues.length === 1 && issues[0].identity!.lineOrdinal === null;

          if (lineSpecific) {
            const ordered = [...issues].sort(
              (a, b) => a.identity!.lineOrdinal! - b.identity!.lineOrdinal!
            );
            const ordinals = ordered.map(({ identity }) => identity!.lineOrdinal!);
            const expectedOrdinals = sales.map((_, index) => index + 1);
            if (
              ordered.length !== sales.length ||
              ordinals.some((ordinal, index) => ordinal !== expectedOrdinals[index])
            ) {
              blocker = {
                voucherId,
                locationId,
                stockItemId,
                code: "CANONICAL_SALE_EVIDENCE_LINE_MISSING",
                expected: expectedOrdinals.join(","),
                actual: ordinals.join(","),
                detail: `POS sale revision ${maxRevision} line ordinals do not match the current sale rows`,
              };
            } else {
              for (let index = 0; index < sales.length; index += 1) {
                const sale = sales[index];
                const movement = ordered[index].movement;
                const expectedQty = repairQuantity(sale.quantity).abs();
                const actualQty = repairQuantity(movement.quantityDelta).abs();
                if (!expectedQty.eq(actualQty)) {
                  blocker = {
                    voucherId,
                    locationId,
                    stockItemId,
                    code: "CANONICAL_SALE_EVIDENCE_QUANTITY_MISMATCH",
                    expected: expectedQty.toFixed(3),
                    actual: actualQty.toFixed(3),
                    detail: `POS sale revision ${maxRevision} line ${index + 1} quantity does not match sales item ${sale.salesItemId}`,
                  };
                  break;
                }
                if (movement.unitCost === null || movement.unitCost === undefined) {
                  blocker = {
                    voucherId,
                    locationId,
                    stockItemId,
                    code: "CANONICAL_SALE_EVIDENCE_RATE_MISSING",
                    detail: `POS sale revision ${maxRevision} line ${index + 1} has no canonical unit cost`,
                  };
                  break;
                }
                staged.set(sale.salesItemId, {
                  salesItemId: sale.salesItemId,
                  voucherId,
                  locationId,
                  stockItemId,
                  unitCost: repairRate(movement.unitCost).toFixed(2),
                  sourceType: movement.sourceType,
                  sourceId: movement.sourceId,
                  movementId: movement.movementId,
                });
              }
            }
          } else if (aggregate) {
            const movement = issues[0].movement;
            const expectedQty = sales.reduce(
              (sum, sale) => repairQuantity(sum.plus(repairQuantity(sale.quantity).abs())),
              ZERO
            );
            const actualQty = repairQuantity(movement.quantityDelta).abs();
            if (!expectedQty.eq(actualQty)) {
              blocker = {
                voucherId,
                locationId,
                stockItemId,
                code: "CANONICAL_SALE_EVIDENCE_QUANTITY_MISMATCH",
                expected: expectedQty.toFixed(3),
                actual: actualQty.toFixed(3),
                detail: `POS sale revision ${maxRevision} aggregate quantity does not match current sale rows`,
              };
            } else if (movement.unitCost === null || movement.unitCost === undefined) {
              blocker = {
                voucherId,
                locationId,
                stockItemId,
                code: "CANONICAL_SALE_EVIDENCE_RATE_MISSING",
                detail: `POS sale revision ${maxRevision} aggregate issue has no canonical unit cost`,
              };
            } else {
              for (const sale of sales) {
                staged.set(sale.salesItemId, {
                  salesItemId: sale.salesItemId,
                  voucherId,
                  locationId,
                  stockItemId,
                  unitCost: repairRate(movement.unitCost).toFixed(2),
                  sourceType: movement.sourceType,
                  sourceId: movement.sourceId,
                  movementId: movement.movementId,
                });
              }
            }
          } else {
            blocker = {
              voucherId,
              locationId,
              stockItemId,
              code: "CANONICAL_SALE_EVIDENCE_AMBIGUOUS",
              detail: `POS sale revision ${maxRevision} mixes aggregate and line-specific issue evidence`,
            };
          }
        }
      }
    } else {
      const importIssues = movements.filter((movement) => repairQuantity(movement.quantityDelta).lt(ZERO));
      const bySalesItemId = new Map<number, HistoricalSalesRepairMovement[]>();
      for (const movement of importIssues) {
        const salesItemId = importSaleItemId(movement.sourceType, movement.idempotencyKey, voucherId);
        if (salesItemId === null) {
          blocker = {
            voucherId,
            locationId,
            stockItemId,
            code: "CANONICAL_SALE_EVIDENCE_AMBIGUOUS",
            detail: "Import canonical movement does not identify an exact sales item",
          };
          break;
        }
        const list = bySalesItemId.get(salesItemId) ?? [];
        list.push(movement);
        bySalesItemId.set(salesItemId, list);
      }

      if (!blocker) {
        for (const sale of sales) {
          const matches = bySalesItemId.get(sale.salesItemId) ?? [];
          if (matches.length !== 1) {
            blocker = {
              voucherId,
              locationId,
              stockItemId,
              code: "CANONICAL_SALE_EVIDENCE_LINE_MISSING",
              expected: "1",
              actual: String(matches.length),
              detail: `Import canonical evidence did not resolve exactly one movement for sales item ${sale.salesItemId}`,
            };
            break;
          }
          const movement = matches[0];
          const expectedQty = repairQuantity(sale.quantity).abs();
          const actualQty = repairQuantity(movement.quantityDelta).abs();
          if (!expectedQty.eq(actualQty)) {
            blocker = {
              voucherId,
              locationId,
              stockItemId,
              code: "CANONICAL_SALE_EVIDENCE_QUANTITY_MISMATCH",
              expected: expectedQty.toFixed(3),
              actual: actualQty.toFixed(3),
              detail: `Import canonical quantity does not match sales item ${sale.salesItemId}`,
            };
            break;
          }
          if (movement.unitCost === null || movement.unitCost === undefined) {
            blocker = {
              voucherId,
              locationId,
              stockItemId,
              code: "CANONICAL_SALE_EVIDENCE_RATE_MISSING",
              detail: `Import canonical movement for sales item ${sale.salesItemId} has no unit cost`,
            };
            break;
          }
          staged.set(sale.salesItemId, {
            salesItemId: sale.salesItemId,
            voucherId,
            locationId,
            stockItemId,
            unitCost: repairRate(movement.unitCost).toFixed(2),
            sourceType: movement.sourceType,
            sourceId: movement.sourceId,
            movementId: movement.movementId,
          });
        }
      }
    }

    if (blocker) {
      blockers.push(blocker);
      continue;
    }
    for (const [salesItemId, evidence] of staged) evidenceBySalesItemId.set(salesItemId, evidence);
  }

  return { evidenceBySalesItemId, blockers };
}

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

export function createHistoricalInventoryStateFromSnapshot(
  quantityValue: Decimal.Value,
  rateValue: Decimal.Value,
  totalValueInput: Decimal.Value
): HistoricalInventoryState {
  const quantity = repairQuantity(quantityValue);
  const averageRate = repairRate(Decimal.max(decimal(rateValue, "snapshot rate"), ZERO));
  const totalValue = quantity.gt(ZERO)
    ? repairMoney(Decimal.max(decimal(totalValueInput, "snapshot total value"), ZERO))
    : ZERO;
  return { quantity, averageRate, totalValue };
}

function statesEqual(left: HistoricalInventoryState, right: HistoricalInventoryState): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairRate(left.averageRate).eq(repairRate(right.averageRate)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

function candidateRatesAround(rate: Decimal): Decimal[] {
  const center = repairRate(Decimal.max(rate, ZERO));
  const values: Decimal[] = [];
  for (let cents = -10; cents <= 10; cents += 1) {
    const candidate = center.plus(new Decimal(cents).dividedBy(100));
    if (candidate.gte(ZERO)) values.push(repairRate(candidate));
  }
  return values;
}

export type HistoricalInventoryReverseResult =
  | { reversible: true; stateBefore: HistoricalInventoryState }
  | {
      reversible: false;
      reason: "COST_MEMORY_IRREVERSIBLE" | "MOVEMENT_INVERSE_NOT_UNIQUE" | "MOVEMENT_INVERSE_INVALID";
    };

/**
 * Inverts one inventory movement using the same rounded quantity/value/rate
 * semantics as applyHistoricalInventoryMovement().
 *
 * A priced receipt that starts at zero/negative stock overwrites the previous
 * cost-memory rate. That earlier rate is mathematically unrecoverable from the
 * post-receipt state alone, so callers must quarantine the key instead of
 * guessing.
 */
export function reverseHistoricalInventoryMovement(
  stateAfterInput: HistoricalInventoryState,
  input: { quantityDelta: Decimal.Value; unitCost?: Decimal.Value | null }
): HistoricalInventoryReverseResult {
  const stateAfter = createHistoricalInventoryStateFromSnapshot(
    stateAfterInput.quantity,
    stateAfterInput.averageRate,
    stateAfterInput.totalValue
  );
  const delta = repairQuantity(input.quantityDelta);
  const previousQty = repairQuantity(stateAfter.quantity.minus(delta));

  if (delta.isZero()) {
    return { reversible: true, stateBefore: stateAfter };
  }

  if (delta.gt(ZERO)) {
    if (input.unitCost !== null && input.unitCost !== undefined && previousQty.lte(ZERO)) {
      return { reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" };
    }

    if (input.unitCost !== null && input.unitCost !== undefined) {
      const incomingRate = repairRate(Decimal.max(decimal(input.unitCost, "movement unit cost"), ZERO));
      if (previousQty.lte(ZERO)) {
        return { reversible: false, reason: "COST_MEMORY_IRREVERSIBLE" };
      }
      const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(incomingRate)));
      if (beforeValue.lt(ZERO)) {
        return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
      }
      const beforeRate = repairRate(beforeValue.dividedBy(previousQty));
      const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, beforeRate, beforeValue);
      const replayed = applyHistoricalInventoryMovement(stateBefore, {
        quantityDelta: delta,
        unitCost: incomingRate,
      });
      return statesEqual(replayed, stateAfter)
        ? { reversible: true, stateBefore }
        : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }

    if (previousQty.lte(ZERO)) {
      const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, stateAfter.averageRate, ZERO);
      const replayed = applyHistoricalInventoryMovement(stateBefore, { quantityDelta: delta, unitCost: null });
      return statesEqual(replayed, stateAfter)
        ? { reversible: true, stateBefore }
        : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
    }

    const candidates: HistoricalInventoryState[] = [];
    for (const candidateRate of candidateRatesAround(stateAfter.averageRate)) {
      const beforeValue = repairMoney(stateAfter.totalValue.minus(delta.times(candidateRate)));
      if (beforeValue.lt(ZERO)) continue;
      const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, candidateRate, beforeValue);
      if (!repairRate(stateBefore.totalValue.dividedBy(previousQty)).eq(candidateRate)) continue;
      const replayed = applyHistoricalInventoryMovement(stateBefore, { quantityDelta: delta, unitCost: null });
      if (statesEqual(replayed, stateAfter)) candidates.push(stateBefore);
    }
    return candidates.length === 1
      ? { reversible: true, stateBefore: candidates[0] }
      : {
          reversible: false,
          reason: candidates.length === 0 ? "MOVEMENT_INVERSE_INVALID" : "MOVEMENT_INVERSE_NOT_UNIQUE",
        };
  }

  const issueQty = delta.abs();
  if (previousQty.lte(ZERO)) {
    return { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
  }

  if (stateAfter.quantity.lte(ZERO)) {
    const stateBefore = createHistoricalInventoryState(previousQty, stateAfter.averageRate);
    const replayed = applyHistoricalInventoryMovement(stateBefore, {
      quantityDelta: delta,
      unitCost: input.unitCost,
    });
    return statesEqual(replayed, stateAfter)
      ? { reversible: true, stateBefore }
      : { reversible: false, reason: "MOVEMENT_INVERSE_INVALID" };
  }

  const candidates: HistoricalInventoryState[] = [];
  for (const candidateRate of candidateRatesAround(stateAfter.averageRate)) {
    const beforeValue = repairMoney(stateAfter.totalValue.plus(issueQty.times(candidateRate)));
    const stateBefore = createHistoricalInventoryStateFromSnapshot(previousQty, candidateRate, beforeValue);
    if (!repairRate(stateBefore.totalValue.dividedBy(previousQty)).eq(candidateRate)) continue;
    const replayed = applyHistoricalInventoryMovement(stateBefore, {
      quantityDelta: delta,
      unitCost: input.unitCost,
    });
    if (statesEqual(replayed, stateAfter)) candidates.push(stateBefore);
  }

  return candidates.length === 1
    ? { reversible: true, stateBefore: candidates[0] }
    : {
        reversible: false,
        reason: candidates.length === 0 ? "MOVEMENT_INVERSE_INVALID" : "MOVEMENT_INVERSE_NOT_UNIQUE",
      };
}

export function historicalSaleProposalFromState(
  movement: HistoricalSalesRepairMovement,
  stateBefore: HistoricalInventoryState
): HistoricalSalesRepairProposal {
  if (!movement.sale) throw hscrEngineError("HSCR_SALE_PROPOSAL_REQUIRES_SALE_MOVEMENT");
  const saleQty = repairQuantity(movement.sale.quantity).abs();
  const proposedCostPrice = repairRate(stateBefore.averageRate);
  const proposedTotalCost = repairMoney(saleQty.times(proposedCostPrice));
  const proposedProfit = repairMoney(decimal(movement.sale.totalSales, "sale total").minus(proposedTotalCost));
  const originalCostPrice = repairRate(movement.sale.originalCostPrice);
  const originalTotalCost = repairMoney(movement.sale.originalTotalCost);
  const originalProfit = repairMoney(movement.sale.originalProfit);

  return {
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
  };
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
