// Extracted from ./execute.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import * as schema from "@shared/schema";
import { postChargeVouchers } from "./charge-vouchers";
import { reverseExistingOffload } from "./reverse";
import { offloadEconomicBasisChanged } from "./offloadCostBasisGuard";
import { nextCanonicalSourceRevision } from "../../inventory/canonicalSourceRevision";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";
import { postSupplierPartnerJournals } from "./sp-journals";
import { amount, ContainerOffloadLifecycleError, ContainerOffloadLifecycleInput, positiveIds } from "./types";
import { firstRow } from "../../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { adjustInventory, receiveInventoryAtValue } from "../../../inventoryHelper";
import { postInventoryMovementJournalTx } from "../../accounting/perpetualInventory/inventoryMovementJournal";
import {
  isPreCutoverOffloadChangeTx,
  postPreCutoverOffloadMovementTx,
  syncContainerStockInTx,
} from "../../accounting/perpetualInventory/stockReceipts";
import {
  OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE,
  OFFLOAD_COST_CORRECTION_FORBIDDEN_MESSAGE,
  OFFLOAD_COST_CORRECTION_ROLES,
  canonicalStockMovementAdapter,
  type InventoryLockRow,
  type OffloadCostCorrectionApprover,
} from "./assertOffloadCurrencyValuedTx";
import { executeContainerOffloadLifecycleTxStep1 } from "./executeContainerOffloadLifecycleTxStep1";

export async function executeContainerOffloadLifecycleTxStep2(
  {
    additionalCostPerBale,
    container,
    correctionLines,
    entries,
    existingOffload,
    lineItems,
    previousBeforeCutover,
    previousOffloadDate,
    purchaseOrders,
    requestsCorrection,
    roundingDifference,
    storedItems,
    totalBales,
    totalCharges,
    validCorrectionIds,
  }: Pick<
    Awaited<ReturnType<typeof executeContainerOffloadLifecycleTxStep1>>,
    | "additionalCostPerBale"
    | "container"
    | "correctionLines"
    | "entries"
    | "existingOffload"
    | "lineItems"
    | "previousBeforeCutover"
    | "previousOffloadDate"
    | "purchaseOrders"
    | "requestsCorrection"
    | "roundingDifference"
    | "storedItems"
    | "totalBales"
    | "totalCharges"
    | "validCorrectionIds"
  >,
  tx: DbTransaction,
  input: ContainerOffloadLifecycleInput & OffloadCostCorrectionApprover
) {
  // A legacy offload edit can reverse and re-receive the goods after they were
  // already sold, mixed, returned, or transferred. The new source value must
  // not silently diverge from historical relief and destination stock values.
  // All checks are performed BEFORE reverseExistingOffload mutates inventory.
  if (existingOffload) {
    const previousItems = await tx
      .select({
        stockItemId: schema.containerOffloadItems.stockItemId,
        quantity: schema.containerOffloadItems.quantity,
        totalValue: schema.containerOffloadItems.totalValue,
      })
      .from(schema.containerOffloadItems)
      .where(eq(schema.containerOffloadItems.offloadId, existingOffload.id));

    const proposedItems = entries.map(([stockItemId, item], index) => {
      let newValue = item.weightedRateSum.plus(item.totalQuantity.times(additionalCostPerBale)).toDecimalPlaces(2);
      if (index === entries.length - 1 && !roundingDifference.isZero()) {
        newValue = newValue.plus(roundingDifference);
      }
      return {
        stockItemId,
        quantity: item.totalQuantity.toFixed(3),
        totalValue: newValue.toFixed(2),
      };
    });
    const basisChanged =
      requestsCorrection ||
      previousItems.length === 0 ||
      offloadEconomicBasisChanged(previousItems, proposedItems, existingOffload.locationId, input.locationId);

    // Reversing/reposting a receipt can alter stock relief even when total
    // posted value appears unchanged. Never replay after downstream usage.
    const affectedItemIds = positiveIds([...previousItems, ...proposedItems].map((item) => item.stockItemId));
    if (affectedItemIds.length > 0) {
      const [salesAfterReceipt, transfersAfterReceipt, canonicalAfterReceipt] = await Promise.all([
        tx
          .select({ id: schema.salesItems.id })
          .from(schema.salesItems)
          .innerJoin(schema.vouchers, eq(schema.vouchers.id, schema.salesItems.voucherId))
          .where(
            and(
              eq(schema.vouchers.companyId, input.companyId),
              eq(schema.vouchers.optional, false),
              isNull(schema.vouchers.deletedAt),
              inArray(schema.salesItems.stockItemId, affectedItemIds)
            )
          )
          .limit(1),
        tx
          .select({ id: schema.stockTransferItems.id })
          .from(schema.stockTransferItems)
          .innerJoin(
            schema.stockTransferVouchers,
            eq(schema.stockTransferVouchers.id, schema.stockTransferItems.transferId)
          )
          .innerJoin(schema.vouchers, eq(schema.vouchers.id, schema.stockTransferVouchers.voucherId))
          .where(
            and(
              eq(schema.vouchers.companyId, input.companyId),
              eq(schema.vouchers.optional, false),
              isNull(schema.vouchers.deletedAt),
              eq(schema.stockTransferVouchers.inventoryApplied, true),
              inArray(schema.stockTransferItems.stockItemId, affectedItemIds)
            )
          )
          .limit(1),
        tx
          .select({ id: schema.canonicalStockMovements.id })
          .from(schema.canonicalStockMovements)
          .where(
            and(
              eq(schema.canonicalStockMovements.companyId, input.companyId),
              inArray(schema.canonicalStockMovements.stockItemId, affectedItemIds),
              notInArray(schema.canonicalStockMovements.sourceType, [
                "container-offload",
                "container-reverse-offload",
                "container_offload_reverse",
                "container_offload_reverse_legacy",
              ])
            )
          )
          .limit(1),
      ]);
      if (salesAfterReceipt.length || transfersAfterReceipt.length || canonicalAfterReceipt.length) {
        throw new ContainerOffloadLifecycleError(
          basisChanged
            ? "Stock from this container has sale, transfer, or adjustment history. Offload costs cannot be rewritten without an audited inventory-and-COGS correction."
            : "Stock from this container has downstream transactions. The receipt cannot be reversed and replayed; use an audited correction workflow.",
          409,
          "CONTAINER_OFFLOAD_DOWNSTREAM_COST_LOCKED"
        );
      }
    }
  }

  if (requestsCorrection && !OFFLOAD_COST_CORRECTION_ROLES.has(String(input.actorRole ?? ""))) {
    throw new ContainerOffloadLifecycleError(
      OFFLOAD_COST_CORRECTION_FORBIDDEN_MESSAGE,
      403,
      OFFLOAD_COST_CORRECTION_FORBIDDEN_CODE
    );
  }

  let reversalDelta: Decimal = new MoneyDecimal(0);
  if (existingOffload) {
    reversalDelta = await reverseExistingOffload(tx, container, existingOffload, lineItems);
  }
  for (const correction of input.inventoryCostCorrections ?? []) {
    if (!(correction.correctRate > 0) || !validCorrectionIds.has(correction.stockItemId)) continue;
    const correctionRows = await tx.execute(
      sql`SELECT * FROM inventory WHERE location_id = ${input.locationId} AND stock_item_id = ${correction.stockItemId} FOR UPDATE`
    );
    const row = firstRow<InventoryLockRow>(correctionRows);
    if (!row) continue;
    const existingQuantity = toMoney(row.quantity);
    if (!existingQuantity.gt(0)) continue;
    const correctRate = toMoney(correction.correctRate);
    const correctedValue = existingQuantity.times(correctRate).toDecimalPlaces(2);
    const valueDelta = correctedValue.minus(toMoney(row.total_value));
    await tx
      .update(schema.inventory)
      .set({
        averageRate: correctRate.toFixed(7),
        totalValue: correctedValue.toFixed(2),
        lastUpdated: new Date(),
      })
      .where(eq(schema.inventory.id, row.id));
    correctionLines.push({
      stockItemId: correction.stockItemId,
      locationId: input.locationId,
      valueDelta: valueDelta.toFixed(2),
    });
  }

  for (let index = 0; index < entries.length; index += 1) {
    const [stockItemId, item] = entries[index];
    if (item.totalQuantity.isZero()) continue;
    let offloadValue = item.weightedRateSum.plus(item.totalQuantity.times(additionalCostPerBale)).toDecimalPlaces(2);
    if (index === entries.length - 1 && !roundingDifference.isZero()) {
      offloadValue = offloadValue.plus(roundingDifference);
    }
    const adjustedRate = offloadValue.dividedBy(item.totalQuantity);
    if (!adjustedRate.isFinite()) {
      throw new ContainerOffloadLifecycleError(
        `Calculated rate is invalid for stock item ${stockItemId}.`,
        409,
        "CONTAINER_OFFLOAD_RATE_INVALID"
      );
    }

    if (item.totalQuantity.isNegative()) {
      // A net-negative PO line returns stock: issued at the row's cost.
      const issued = await adjustInventory(
        tx,
        input.locationId,
        stockItemId,
        item.totalQuantity.toNumber(),
        input.companyId,
        undefined,
        `container-offload:${input.containerId}`
      );
      storedItems.push({
        stockItemId,
        quantity: item.totalQuantity,
        rate: adjustedRate,
        totalValue: offloadValue,
        valueMoved: toMoney(issued.valueDelta),
        cogsVariance: offloadValue.minus(toMoney(issued.valueDelta)),
      });
      continue;
    }

    // The receipt moves the sub-ledger by the line's exact landed value. Into
    // negative stock it first settles the shortage (negative-stock policy):
    // the sub-ledger takes back the shortage's provisional value and the
    // difference to what the receipt paid for those bales goes to COGS on
    // the stock-in journal (cogs_variance).
    const received = await receiveInventoryAtValue(tx, {
      locationId: input.locationId,
      stockItemId,
      quantity: item.totalQuantity,
      value: offloadValue,
      companyId: input.companyId,
      // Not a voucher id: the layer's source_voucher_id references vouchers.
      sourceVoucherType: `container-offload:${input.containerId}`,
    });
    storedItems.push({
      stockItemId,
      quantity: item.totalQuantity,
      rate: adjustedRate,
      totalValue: offloadValue,
      valueMoved: toMoney(received.valueDelta),
      cogsVariance: toMoney(received.shortageSettlementVariance),
    });
  }

  await tx
    .update(schema.containers)
    .set({
      status: "OFFLOADED",
      offloadDate: input.offloadDate,
      dutyFee: amount(input.duties).greaterThan(0) ? input.duties : "0",
    })
    .where(eq(schema.containers.id, input.containerId));

  for (const po of purchaseOrders) {
    if (!po.voucherId) continue;
    await tx
      .update(schema.vouchers)
      .set({ description: `Purchase Order ${po.poNumber} - Container ${container.containerNumber} (Offloaded)` })
      .where(eq(schema.vouchers.id, po.voucherId));
  }

  await postChargeVouchers(tx, container, input.companyId, input);

  const [offload] = await tx
    .insert(schema.containerOffloads)
    .values({
      containerId: input.containerId,
      locationId: input.locationId,
      duties: input.duties,
      officeCharges: input.officeCharges,
      transferCharges: input.transferCharges,
      transportFees: input.transportFees,
      totalCharges: totalCharges.toFixed(2),
      totalBales: totalBales.toFixed(3),
      additionalCostPerBale: additionalCostPerBale.toFixed(2),
      offloadedAt: new Date(`${input.offloadDate}T00:00:00.000Z`),
    })
    .returning();

  const canonicalRevision = await nextCanonicalSourceRevision(
    tx,
    input.companyId,
    "container-offload",
    String(offload.id)
  );

  for (const item of storedItems) {
    await tx.insert(schema.containerOffloadItems).values({
      offloadId: offload.id,
      stockItemId: item.stockItemId,
      quantity: item.quantity.toFixed(3),
      rate: item.rate.toFixed(2),
      totalValue: item.totalValue.toFixed(2),
      valueMoved: item.valueMoved.toFixed(2),
      cogsVariance: item.cogsVariance.toFixed(2),
    });

    // Canonical evidence for the stock this offload received, on the same
    // transaction that applied it above. The rate is the container's
    // weighted cost after charges — the value the offload actually stored —
    // so the journal and the offload line agree by construction.
    //
    // A replace-only offload re-runs against the same container, so the
    // batch takes the next revision index rather than colliding with the
    // evidence the previous offload recorded.
    if (!item.quantity.isZero()) {
      await postStockMovementTx(
        tx,
        {
          companyId: input.companyId,
          stockItemId: item.stockItemId,
          kind: "receipt",
          quantity: item.quantity.toFixed(3),
          unitCost: item.rate.toFixed(2),
          toLocationId: input.locationId,
          occurredAt: new Date().toISOString(),
          source: {
            sourceType: "container-offload",
            sourceId: String(offload.id),
            idempotencyKey: `container-offload:${offload.id}:rev${canonicalRevision}:${item.stockItemId}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  }

  // Perpetual inventory (wave 11): the cost corrections revalue the stock on hand.
  await postInventoryMovementJournalTx(tx, {
    companyId: input.companyId,
    sourceType: "offload-cost-correction",
    sourceId: offload.id,
    date: input.offloadDate,
    reference: `Container ${container.containerNumber}`,
    lines: correctionLines,
    offsetAccountCode: "INVENTORY_REVALUATION",
    narration: "Stock cost corrected at offload",
    locationId: input.locationId,
  });

  await postSupplierPartnerJournals(tx, container, purchaseOrders, input);
  // Perpetual inventory (wave 8.2): the received stock moves to the ledger.
  await syncContainerStockInTx(tx, input.companyId, input.containerId);
  if (previousBeforeCutover) {
    // Wave 15 (C1): the edit of an offload dated before the cut-over. A new
    // date before it keeps the stock out of STOCK-IN, so the whole change is
    // journalled; a new date on or after it is STOCK-IN's, so only the
    // reversal of the old receipt is.
    const newBeforeCutover = await isPreCutoverOffloadChangeTx(tx, input.companyId, input.offloadDate);
    const received = storedItems.reduce<Decimal>((sum, item) => sum.plus(item.valueMoved), new MoneyDecimal(0));
    await postPreCutoverOffloadMovementTx(tx, {
      companyId: input.companyId,
      containerId: input.containerId,
      containerNumber: container.containerNumber,
      offloadDate: previousOffloadDate,
      locationId: input.locationId,
      valueDelta: newBeforeCutover ? reversalDelta.plus(received) : reversalDelta,
      mode: "inPlace",
      reason: "Offload edited",
    });
  }
  return { offload };
}
