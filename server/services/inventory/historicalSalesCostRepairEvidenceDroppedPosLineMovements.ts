// Extracted from ./historicalSalesCostRepairEvidence.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import {
  type HistoricalSalesRepairMovement,
  repairMoney,
  repairQuantity,
  repairRate,
} from "./historicalSalesCostRepairEngine";
import { CANONICAL_SALE_SOURCE_TYPES, d, RepairCheck, SaleRow } from "./historicalSalesCostRepairTypes";
import {
  COLLAPSED_ORIGINAL_POS_KEY,
  EDIT_LEG_REVISION_KEY,
  EDIT_REVERSAL_LINE_KEY,
  canonicalMovementNumericId,
  compareMovementMutationAscending,
  movementMutationTime,
  type CanonicalSaleEvidence,
} from "./proposalFromRecordedRate";

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
