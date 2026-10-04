/** Sale proposals, canonical sale evidence and source-evidence hashing for the historical sales-cost repair. */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";

import {
  historicalInventoryKey,
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  repairRate,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import {
  CANONICAL_SALE_SOURCE_TYPES,
  HISTORICAL_VALUATION_RESETS,
  HistoricalMergeRow,
  LegacyRow,
  OffloadValueEvidenceRow,
  RepairCheck,
  SaleRow,
  StockItemRow,
  ValuationCheckpoint,
  ValuationOverrideRow,
  d,
  hscrError,
  iso,
} from "./historicalSalesCostRepairTypes";
import {
  loadCanonicalMovements,
  loadCanonicalStart,
  loadHistoricalMerges,
  loadLegacyManualAdjustments,
  loadLegacyMovements,
  loadOffloadValueEvidence,
  loadSales,
  loadStockItems,
  loadValuationCheckpoint,
  loadValuationOverrides,
} from "./historicalSalesCostRepairLoaders";

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

const COLLAPSED_ORIGINAL_POS_KEY = /^pos-sale:(\d+):rev0:(\d+)$/;

const EDIT_REVERSAL_LINE_KEY = /^pos-sale:\d+:rev(\d+):reverse:\d+:line:(\d+)$/;

const EDIT_LEG_REVISION_KEY = /^pos-sale:\d+:rev(\d+):(?:reverse|issue):/;

/**
 * V41: restore POS sale lines whose canonical issue row was lost.
 *
 * From 2026-08-13 (123d9eedc) until 2026-09-26 (2e4d483fa) the original POS
 * issue key was per stock item (pos-sale:V:rev0:ITEM). A second line of the
 * same item collided with the first line's key, so the journal kept only the
 * first line while inventory was deducted for every line (production: all 812
 * unedited multi-line sales journal exactly the first line's quantity). The
 * lifecycle correction then added the missing quantity at the latest mutation,
 * days or weeks too late, which shifts the quantity chain between the sale and
 * that mutation.
 *
 * The original lines are proven only when
 *  (a) the voucher was never edited or deleted: the current sales lines are
 *      the original lines; or
 *  (b) the first edit of this voucher/item journals line-level reversal legs
 *      (from 2026-09-09): those legs reverse exactly the lines then on the sale.
 * In both cases the journaled quantity must equal the first line's quantity.
 * Each further line is restored at the original issue's instant as an
 * unpriced issue at the live stored rate, which is what production executed.
 */
export function droppedPosLineMovements(
  companyId: number,
  canonical: HistoricalSalesRepairMovement[],
  sales: SaleRow[]
): { movements: HistoricalSalesRepairMovement[]; checks: RepairCheck[] } {
  const movements: HistoricalSalesRepairMovement[] = [];
  const checks: RepairCheck[] = [];
  const posByVoucher = new Map<string, HistoricalSalesRepairMovement[]>();
  const deletedVouchers = new Set<string>();
  for (const movement of canonical) {
    if (movement.sourceType === "voucher_delete_pos_sale") deletedVouchers.add(String(movement.sourceId));
    if (movement.sourceType !== "pos-sale") continue;
    const rows = posByVoucher.get(String(movement.sourceId)) ?? [];
    rows.push(movement);
    posByVoucher.set(String(movement.sourceId), rows);
  }
  const linesByVoucherItem = new Map<string, SaleRow[]>();
  for (const sale of sales) {
    const key = `${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`;
    const rows = linesByVoucherItem.get(key) ?? [];
    rows.push(sale);
    linesByVoucherItem.set(key, rows);
  }

  for (const [voucherId, rows] of posByVoucher) {
    const voucherEdited = rows.some((row) => EDIT_LEG_REVISION_KEY.test(row.idempotencyKey ?? ""));
    for (const original of rows) {
      const match = COLLAPSED_ORIGINAL_POS_KEY.exec(original.idempotencyKey ?? "");
      if (!match || !d(original.quantityDelta).lt(0)) continue;
      const journaledQuantity = repairQuantity(d(original.quantityDelta).abs());
      const itemRows = rows
        .filter(
          (row) =>
            row !== original && row.stockItemId === original.stockItemId && row.locationId === original.locationId
        )
        .sort(compareMovementMutationAscending);

      let lineQuantities: Decimal[] | null = null;
      let basis = "";
      if (!voucherEdited && !deletedVouchers.has(voucherId) && itemRows.length === 0) {
        const lines = (linesByVoucherItem.get(`${voucherId}:${original.locationId}:${original.stockItemId}`) ?? [])
          .slice()
          .sort((a, b) => Number(a.sales_item_id) - Number(b.sales_item_id));
        if (lines.length > 1) {
          lineQuantities = lines.map((line) => repairQuantity(d(line.quantity).abs()));
          basis = "unedited sale lines " + lines.map((line) => line.sales_item_id).join(",");
        }
      } else if (itemRows.length > 0) {
        const firstRevision = EDIT_LEG_REVISION_KEY.exec(itemRows[0].idempotencyKey ?? "")?.[1];
        const firstEdit = firstRevision
          ? itemRows.filter((row) => EDIT_LEG_REVISION_KEY.exec(row.idempotencyKey ?? "")?.[1] === firstRevision)
          : [];
        const reversals = firstEdit.filter((row) => d(row.quantityDelta).gt(0));
        const lineLegs = reversals
          .map((row) => ({ row, line: EDIT_REVERSAL_LINE_KEY.exec(row.idempotencyKey ?? "") }))
          .filter((entry) => entry.line !== null);
        if (reversals.length > 1 && lineLegs.length === reversals.length) {
          lineLegs.sort((a, b) => Number(a.line![2]) - Number(b.line![2]));
          lineQuantities = lineLegs.map((entry) => repairQuantity(d(entry.row.quantityDelta).abs()));
          basis = `rev${firstRevision} line reversals ` + lineLegs.map((entry) => entry.line![2]).join(",");
        }
      }
      if (!lineQuantities) continue;

      const locationId = original.locationId;
      const stockItemId = original.stockItemId;
      if (!lineQuantities[0].eq(journaledQuantity)) {
        checks.push({
          companyId,
          locationId,
          stockItemId,
          code: "CANONICAL_POS_DROPPED_LINE_UNPROVEN",
          status: "warning",
          expected: journaledQuantity.toFixed(3),
          actual: lineQuantities.map((quantity) => quantity.toFixed(3)).join("+"),
          detail: `Voucher ${voucherId} journaled ${original.movementId} does not equal its first line (${basis}); dropped lines not restored`,
        });
        continue;
      }
      lineQuantities.slice(1).forEach((quantity, index) => {
        movements.push({
          movementId: `canonical-dropped-line:${canonicalMovementNumericId(original)}:${index + 2}`,
          companyId,
          locationId,
          stockItemId,
          occurredAt: original.occurredAt,
          createdAt: original.createdAt,
          sequence: original.sequence + (index + 1) / 100,
          quantityDelta: quantity.negated().toFixed(3),
          unitCost: null,
          sourceType: "pos-sale",
          sourceId: original.sourceId,
          evidence: "canonical",
          canonicalPosRole: "dropped-line",
        });
      });
      checks.push({
        companyId,
        locationId,
        stockItemId,
        code: "CANONICAL_POS_DROPPED_LINE_RESTORED",
        status: "pass",
        expected: lineQuantities.reduce((sum, quantity) => sum.plus(quantity), new Decimal(0)).toFixed(3),
        actual: journaledQuantity.toFixed(3),
        detail: `Voucher ${voucherId} ${original.movementId}: restored ${lineQuantities.length - 1} line(s) lost to the per-item rev0 key at the original issue instant (${basis})`,
      });
    }
  }
  return { movements, checks };
}

export function activeCanonicalSaleEvidence(
  movements: HistoricalSalesRepairMovement[]
): Map<string, CanonicalSaleEvidence> {
  const grouped = new Map<string, HistoricalSalesRepairMovement[]>();
  for (const movement of movements) {
    if (!CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType)) continue;
    const key = `${movement.sourceId}:${movement.locationId}:${movement.stockItemId}`;
    const rows = grouped.get(key) ?? [];
    rows.push(movement);
    grouped.set(key, rows);
  }

  const result = new Map<string, CanonicalSaleEvidence>();
  for (const [key, rows] of grouped) {
    const latestMutationAt = Math.max(...rows.map(movementMutationTime));
    const latestNegativeMovements = rows
      .filter((movement) => movementMutationTime(movement) === latestMutationAt && d(movement.quantityDelta).lt(0))
      .sort(compareMovementMutationAscending);
    const latestPositiveMovements = rows
      .filter((movement) => movementMutationTime(movement) === latestMutationAt && d(movement.quantityDelta).gt(0))
      .sort(compareMovementMutationAscending);
    const latestNegativeRates = new Set<string>();
    let latestNegativeQuantity = new Decimal(0);
    let latestNegativePricedQuantity = new Decimal(0);
    let latestNegativeValue = new Decimal(0);
    let hasMissingCost = false;
    for (const movement of latestNegativeMovements) {
      const quantity = d(movement.quantityDelta).abs();
      latestNegativeQuantity = repairQuantity(latestNegativeQuantity.plus(quantity));
      // A reconstructed dropped line has no journaled cost of its own; the
      // sale's recorded rate comes from the journaled line(s) only, so it
      // counts toward the issued quantity but not toward the rate.
      if (movement.canonicalPosRole === "dropped-line") continue;
      if (movement.unitCost === null || movement.unitCost === undefined) {
        hasMissingCost = true;
        continue;
      }
      latestNegativePricedQuantity = repairQuantity(latestNegativePricedQuantity.plus(quantity));
      latestNegativeRates.add(repairRate(movement.unitCost).toFixed(2));
      latestNegativeValue = latestNegativeValue.plus(quantity.times(d(movement.unitCost)));
    }
    const latestNegativeRate =
      !hasMissingCost && latestNegativePricedQuantity.gt(0)
        ? repairRate(latestNegativeValue.dividedBy(latestNegativePricedQuantity))
        : null;

    let latestPositiveQuantity = new Decimal(0);
    let latestPositiveValue = new Decimal(0);
    let hasMissingPositiveCost = false;
    for (const movement of latestPositiveMovements) {
      const quantity = d(movement.quantityDelta).abs();
      latestPositiveQuantity = repairQuantity(latestPositiveQuantity.plus(quantity));
      if (movement.unitCost === null || movement.unitCost === undefined) {
        hasMissingPositiveCost = true;
        continue;
      }
      latestPositiveValue = latestPositiveValue.plus(quantity.times(d(movement.unitCost)));
    }
    const latestPositiveRate =
      !hasMissingPositiveCost && latestPositiveQuantity.gt(0)
        ? repairRate(latestPositiveValue.dividedBy(latestPositiveQuantity))
        : null;
    const totalSignedQuantity = repairQuantity(
      rows.reduce((sum, movement) => sum.plus(d(movement.quantityDelta)), new Decimal(0))
    );
    const anchorCanonicalId = Math.max(...rows.map((movement) => canonicalMovementNumericId(movement) ?? 0));

    result.set(key, {
      movements: rows.sort(compareMovementMutationAscending),
      latestMutationAt,
      latestNegativeMovements,
      latestPositiveMovements,
      latestNegativeRates,
      latestNegativeQuantity,
      latestNegativeValue: repairMoney(latestNegativeValue),
      latestNegativeRate,
      latestPositiveRate,
      totalSignedQuantity,
      anchorCanonicalId,
    });
  }
  return result;
}

export function historicalSalesCompanyEvidenceHash(input: {
  companyId: number;
  canonicalStart: Date | null;
  checkpoint: ValuationCheckpoint | null;
  canonical: HistoricalSalesRepairMovement[];
  legacy: LegacyRow[];
  manual: { movements: LegacyRow[]; checks: RepairCheck[] };
  sales: SaleRow[];
  stockItems: StockItemRow[];
  offloadEvidence: OffloadValueEvidenceRow[];
  historicalMerges: HistoricalMergeRow[];
  valuationOverrides: ValuationOverrideRow[];
}): string {
  const payload = {
    companyId: input.companyId,
    canonicalStart: input.canonicalStart ? input.canonicalStart.toISOString() : null,
    checkpoint: input.checkpoint
      ? {
          movementCutoffId: input.checkpoint.movementCutoffId,
          createdAt: input.checkpoint.createdAt.toISOString(),
          rows: input.checkpoint.rows.map((row) => ({
            locationId: Number(row.location_id),
            stockItemId: Number(row.stock_item_id),
            quantity: String(row.quantity),
            averageRate: String(row.average_rate),
            totalValue: String(row.total_value),
          })),
        }
      : null,
    canonical: input.canonical.map((movement) => ({
      movementId: movement.movementId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      occurredAt: movement.occurredAt,
      createdAt: movement.createdAt ?? null,
      reversalOfMovementId: movement.reversalOfMovementId ?? null,
      sequence: movement.sequence,
      quantityDelta: movement.quantityDelta,
      unitCost: movement.unitCost,
      sourceType: movement.sourceType,
      sourceId: movement.sourceId,
      canonicalPosRole: movement.canonicalPosRole ?? null,
    })),
    legacy: input.legacy.map((row) => ({
      movementId: row.movement_id,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      occurredAt: iso(row.occurred_at),
      mutationAt: row.mutation_at ? iso(row.mutation_at) : null,
      sequence: Number(row.sequence),
      sourceType: row.source_type,
      sourceId: row.source_id,
    })),
    manualMovements: input.manual.movements.map((row) => ({
      movementId: row.movement_id,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      sourceType: row.source_type,
      sourceId: row.source_id,
    })),
    manualChecks: [...input.manual.checks].sort((a, b) =>
      [a.locationId ?? 0, a.stockItemId ?? 0, a.salesItemId ?? 0, a.code, a.detail ?? ""]
        .join(":")
        .localeCompare([b.locationId ?? 0, b.stockItemId ?? 0, b.salesItemId ?? 0, b.code, b.detail ?? ""].join(":"))
    ),
    sales: input.sales.map((sale) => ({
      salesItemId: Number(sale.sales_item_id),
      voucherId: Number(sale.voucher_id),
      locationId: sale.location_id === null ? null : Number(sale.location_id),
      stockItemId: Number(sale.stock_item_id),
      quantity: String(sale.quantity),
      totalSales: String(sale.total_sales),
      costPrice: String(sale.cost_price),
      totalCost: String(sale.total_cost),
      profit: String(sale.profit),
      createdAt: iso(sale.created_at),
    })),
    stockItems: input.stockItems.map((item) => ({
      id: Number(item.id),
      code: item.code,
      openingQty: String(item.opening_qty),
      openingRate: String(item.opening_rate),
      openingValue: String(item.opening_value),
      active: Boolean(item.active),
      deletedAt: item.deleted_at ? iso(item.deleted_at) : null,
      createdAt: iso(item.created_at),
    })),
    offloadEvidence: input.offloadEvidence.map((row) => ({
      offloadId: Number(row.offload_id),
      stockItemId: Number(row.stock_item_id),
      quantity: String(row.quantity),
      rate: String(row.rate),
      totalValue: String(row.total_value),
      offloadedAt: iso(row.offloaded_at),
    })),
    valuationResets: HISTORICAL_VALUATION_RESETS.filter((reset) => reset.companyId === input.companyId).map(
      (reset) => ({ ...reset })
    ),
    valuationOverrides: input.valuationOverrides.map((row) => ({
      id: Number(row.id),
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      sourceType: row.source_type,
      before: [row.before_quantity, row.before_average_rate, row.before_total_value].map(String),
      after: [row.after_quantity, row.after_average_rate, row.after_total_value].map(String),
      createdAt: iso(row.created_at),
    })),
    historicalMerges: input.historicalMerges.map((merge) => ({
      aliasId: Number(merge.alias_id),
      aliasCode: merge.alias_code,
      aliasCreatedAt: iso(merge.alias_created_at),
      sourceItemId: Number(merge.source_item_id),
      sourceCode: merge.source_code,
      sourceOpeningQty: String(merge.source_opening_qty),
      sourceOpeningRate: String(merge.source_opening_rate),
      sourceOpeningValue: String(merge.source_opening_value),
      sourceDeletedAt: merge.source_deleted_at ? iso(merge.source_deleted_at) : null,
      keptItemId: Number(merge.kept_item_id),
      keptCode: merge.kept_code,
      keptOpeningQty: String(merge.kept_opening_qty),
      keptOpeningRate: String(merge.kept_opening_rate),
      keptOpeningValue: String(merge.kept_opening_value),
      mergeAt: iso(merge.merge_at),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * A direct location inventory update journals its quantity change as a
 * location_inventory_update movement in the same transaction as its valuation
 * override. The override reset carries that quantity change together with the
 * exact valuation, so the journal row is replaced by it rather than applied
 * twice. Shared by the dry-run and the apply-time evidence hash.
 */
export function journalWithoutOverriddenLocationUpdates(
  loaded: HistoricalSalesRepairMovement[],
  valuationOverrides: ValuationOverrideRow[]
): HistoricalSalesRepairMovement[] {
  const overrideTransactionKeys = new Set(
    valuationOverrides.map((row) => `${Number(row.location_id)}:${Number(row.stock_item_id)}:${iso(row.created_at)}`)
  );
  return loaded.filter(
    (movement) =>
      !(
        movement.sourceType === "location_inventory_update" &&
        overrideTransactionKeys.has(
          `${movement.locationId}:${movement.stockItemId}:${movement.createdAt ?? movement.occurredAt}`
        )
      )
  );
}

export async function recomputeHistoricalSalesCompanyEvidenceHash(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<string> {
  const [canonicalStart, sales, stockItems, checkpoint, offloadEvidence, historicalMerges] = await Promise.all([
    loadCanonicalStart(client, companyId, sourceCutoff),
    loadSales(client, companyId, sourceCutoff),
    loadStockItems(client, companyId),
    loadValuationCheckpoint(client, companyId),
    loadOffloadValueEvidence(client, companyId, sourceCutoff),
    loadHistoricalMerges(client, companyId),
  ]);
  const [loadedCanonical, legacy, manual, valuationOverrides] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
    loadValuationOverrides(client, companyId, sourceCutoff),
  ]);
  return historicalSalesCompanyEvidenceHash({
    companyId,
    canonicalStart,
    checkpoint,
    canonical: journalWithoutOverriddenLocationUpdates(loadedCanonical, valuationOverrides),
    legacy,
    manual,
    sales,
    stockItems,
    offloadEvidence,
    historicalMerges,
    valuationOverrides,
  });
}

export async function inventoryEvidenceFingerprint(
  client: PoolClient,
  companyIds: number[]
): Promise<{ hash: string; rowCount: number }> {
  const result = await client.query<{
    company_id: number;
    location_id: number;
    stock_item_id: number;
    quantity: string;
    average_rate: string;
    total_value: string;
  }>(
    `SELECT company_id,location_id,stock_item_id,
            quantity::text,average_rate::text,total_value::text
       FROM inventory
      WHERE company_id = ANY($1::int[])
      ORDER BY company_id,location_id,stock_item_id`,
    [companyIds]
  );
  const hash = createHash("sha256");
  for (const row of result.rows) {
    hash.update(
      `${row.company_id}|${row.location_id}|${row.stock_item_id}|${row.quantity}|${row.average_rate}|${row.total_value}\n`
    );
  }
  return { hash: hash.digest("hex"), rowCount: result.rows.length };
}

export async function assertSalesItemsUpdateHasNoSideEffectTriggers(client: PoolClient): Promise<void> {
  const triggers = await client.query<{ trigger_name: string }>(
    `SELECT tg.tgname AS trigger_name
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid=tg.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relname='sales_items'
        AND NOT tg.tgisinternal
      ORDER BY tg.tgname`
  );
  if (triggers.rows.length > 0) {
    throw new Error(
      `Historical sales cost repair refused because sales_items has unreviewed side-effect trigger(s): ${triggers.rows
        .map((row) => row.trigger_name)
        .join(", ")}`
    );
  }
}
