import Decimal from "decimal.js";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "../../db";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import type { StockTransferItem, StockAdjustmentItem } from "@shared/schema";
import { stockAdjustmentHeaderTotal, stockAdjustmentNetLine } from "./stockAdjustmentTotals";
import { syncStockAdjustmentInventoryTx } from "../../services/accounting/perpetualInventory/stockAdjustments";
import {
  inventoryLedgerNetTx,
  lineValueMoved,
  postReversalResidualTx,
  reversalDate,
  restoreIssuedValueTx,
  reverseReceivedValueTx,
  sumDecimals,
} from "../../services/inventory/valueExactReversal";
import {
  moveTransferLegConservedTx,
  postTransferResidualTx,
  reverseTransferLegExactTx,
} from "../../services/inventory/conservedStockTransfer";
import { assertNoBaleMirrorMovementTx } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { adjustInventory, receiveInventoryAtValue, reverseInventoryByExactValue } from "../../inventoryHelper";
import { lockInventoryRow } from "../inventoryRowLock";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

function isProductionAdjustment(adjustmentType: string, quantity: Decimal): boolean {
  const normalized = adjustmentType.trim().toLowerCase();
  return normalized === "production" || (normalized === "mixed" && quantity.isPositive());
}

function sameDecimal(a: Decimal, b: Decimal): boolean {
  return a.equals(b);
}

export async function updateStockTransfer(
  id: number,
  destinationLocationId: number,
  notes: string,
  items: Array<{ sourceLocationId: number; stockItemId: number; quantity: string; rate: string }>
) {
  return await db.transaction(async (tx) => {
    const [existingTransfer] = await tx
      .select()
      .from(schema.stockTransferVouchers)
      .where(eq(schema.stockTransferVouchers.id, id));
    if (!existingTransfer) throw new Error(`Stock transfer ${id} not found`);

    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, existingTransfer.voucherId));
    if (!voucher) throw new Error(`Voucher ${existingTransfer.voucherId} not found`);
    const isOptional = voucher.optional;
    // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
    if (!isOptional) {
      await assertNoBaleMirrorMovementTx(
        tx,
        voucher.companyId,
        items.map((item) => item.stockItemId),
        "stock-transfer-edit"
      );
    }

    const existingItems = await tx
      .select()
      .from(schema.stockTransferItems)
      .where(eq(schema.stockTransferItems.transferId, id));
    const itemsWithoutSource = existingItems.filter((item) => !item.sourceLocationId);
    if (itemsWithoutSource.length > 0) {
      throw new Error(
        `Cannot edit this stock transfer: ${itemsWithoutSource.length} items missing source location data.`
      );
    }

    // Signed sub-ledger changes of every leg of this edit; their net (normally
    // zero) is posted so the ledger keeps moving with the sub-ledger.
    const transferDeltas: Decimal[] = [];
    // A transfer edit is a reversal of the historical transfer followed by the
    // requested replacement. Reverse the exact stored quantity + value instead
    // of reconstructing either leg from today's rounded average rate.
    if (existingTransfer.inventoryApplied || !isOptional) {
      existingItems.sort((a, b) => a.stockItemId - b.stockItemId || a.id - b.id);
      for (const oldItem of existingItems) {
        const quantity = toInventoryDecimal(oldItem.quantity).abs();
        // Wave 11: the exact value the line moved (legacy lines: their total).
        const totalAmount = lineValueMoved({ valueMoved: oldItem.valueMoved, total: oldItem.totalAmount });
        const rate = quantity.gt(0) ? totalAmount.dividedBy(quantity) : toInventoryDecimal(oldItem.rate);
        const sourceLocationId = oldItem.sourceLocationId || existingTransfer.sourceLocationId;
        if (!sourceLocationId) {
          throw Object.assign(new Error(), {
            code: "STOCK_TRANSFER_SOURCE_LOCATION_MISSING",
            stockTransferItemId: oldItem.id,
          });
        }

        // Original transfer issued value from the source and received the same
        // value at the destination. Undo those exact effects in the opposite
        // direction. The restore path deliberately does not settle unrelated
        // negative-stock layers.
        const reversed = await reverseTransferLegExactTx(tx, {
          companyId: voucher.companyId,
          sourceLocationId,
          destinationLocationId: existingTransfer.destinationLocationId!,
          stockItemId: oldItem.stockItemId,
          quantity,
          value: totalAmount,
          sourceVoucherType: "stock_transfer_edit_reverse",
          sourceVoucherId: existingTransfer.voucherId,
        });
        transferDeltas.push(reversed.sourceDelta, reversed.destinationDelta);

        if (sourceLocationId !== existingTransfer.destinationLocationId) {
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: oldItem.stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(quantity),
              unitCost: inventoryUnitCost(rate),
              fromLocationId: existingTransfer.destinationLocationId!,
              toLocationId: sourceLocationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "stock_transfer_edit_reverse",
                sourceId: String(existingTransfer.voucherId),
                idempotencyKey: `stock-transfer-edit:reverse:${voucher.companyId}:${id}:${oldItem.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      }
    }

    if (!items || items.length === 0) throw new Error("No items provided for stock transfer update");

    await tx.delete(schema.stockTransferItems).where(eq(schema.stockTransferItems.transferId, id));

    const [updatedTransfer] = await tx
      .update(schema.stockTransferVouchers)
      .set({
        sourceLocationId: items[0].sourceLocationId,
        destinationLocationId,
        notes,
        inventoryApplied: !isOptional,
      })
      .where(eq(schema.stockTransferVouchers.id, id))
      .returning();

    const sortedNewTransferItems = [...items].sort(
      (a, b) => a.stockItemId - b.stockItemId || a.sourceLocationId - b.sourceLocationId
    );
    const transferItems: StockTransferItem[] = [];
    for (const item of sortedNewTransferItems) {
      const quantity = toInventoryDecimal(item.quantity).abs();
      const requestedRate = toInventoryDecimal(item.rate);

      // When the user saves an unchanged historical transfer, preserve the
      // original stored value exactly. This prevents a harmless edit from
      // turning qty × rounded average_rate into a new cost basis.
      const unchangedOldItem =
        existingTransfer.destinationLocationId === destinationLocationId
          ? existingItems.find(
              (oldItem) =>
                oldItem.sourceLocationId === item.sourceLocationId &&
                oldItem.stockItemId === item.stockItemId &&
                sameDecimal(toInventoryDecimal(oldItem.quantity).abs(), quantity) &&
                sameDecimal(toInventoryDecimal(oldItem.rate), requestedRate)
            )
          : undefined;
      const totalAmount = unchangedOldItem
        ? toInventoryDecimal(unchangedOldItem.totalAmount).abs()
        : multiplyInventoryValues(quantity, requestedRate);
      let appliedRate = quantity.gt(0) ? totalAmount.dividedBy(quantity) : requestedRate;
      let valueMoved: Decimal | null = null;

      if (!isOptional) {
        if (unchangedOldItem) {
          // An unchanged line moves its exact historical value again, so an
          // unchanged save is valuation-neutral.
          valueMoved = lineValueMoved({ valueMoved: unchangedOldItem.valueMoved, total: unchangedOldItem.totalAmount });
          const moved = await reverseTransferLegExactTx(tx, {
            companyId: voucher.companyId,
            // The forward move is the reverse leg seen from the other side.
            sourceLocationId: destinationLocationId,
            destinationLocationId: item.sourceLocationId,
            stockItemId: item.stockItemId,
            quantity,
            value: valueMoved,
            sourceVoucherType: "stock_transfer_edit_apply",
            sourceVoucherId: existingTransfer.voucherId,
          });
          transferDeltas.push(moved.sourceDelta, moved.destinationDelta);
        } else {
          // A changed line moves what the source holds: the destination
          // receives exactly the value the source relieved.
          const moved = await moveTransferLegConservedTx(tx, {
            companyId: voucher.companyId,
            sourceLocationId: item.sourceLocationId,
            destinationLocationId,
            stockItemId: item.stockItemId,
            quantity,
            fallbackRate: requestedRate,
            sourceVoucherType: "stock_transfer_edit_apply",
            sourceVoucherId: existingTransfer.voucherId,
          });
          valueMoved = moved.relieved;
          appliedRate = moved.rate;
          transferDeltas.push(moved.sourceDelta, moved.destinationDelta);
        }
      }

      const [transferItem] = await tx
        .insert(schema.stockTransferItems)
        .values({
          transferId: updatedTransfer.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(quantity.gt(0) ? totalAmount.dividedBy(quantity) : requestedRate),
          totalAmount: inventoryMoney(totalAmount),
          valueMoved: valueMoved === null ? null : inventoryMoney(valueMoved),
        })
        .returning();
      transferItems.push(transferItem);

      if (!isOptional) {
        if (item.sourceLocationId !== destinationLocationId) {
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: item.stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(quantity),
              unitCost: inventoryUnitCost(appliedRate),
              fromLocationId: item.sourceLocationId,
              toLocationId: destinationLocationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "stock_transfer_edit_apply",
                sourceId: String(existingTransfer.voucherId),
                idempotencyKey: `stock-transfer-edit:apply:${voucher.companyId}:${id}:${transferItem.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      }
    }

    await postTransferResidualTx(tx, {
      companyId: voucher.companyId,
      transferId: id,
      date: reversalDate(),
      reference: voucher.voucherNumber,
      deltas: transferDeltas,
    });

    return { transfer: updatedTransfer, items: transferItems };
  });
}

export async function updateStockAdjustment(
  id: number,
  locationId: number,
  // Compared case-insensitively below and persisted verbatim: the column holds
  // whatever spelling the creating path wrote, and re-editing must not rewrite
  // it into a different case.
  adjustmentType: string,
  notes: string,
  items: Array<{ stockItemId: number; quantity: string; rate: string }>,
  voucherHeader?: { voucherDate?: string; description?: string }
) {
  return await db.transaction(async (tx) => {
    // Follow the same lock order as stock-adjustment deletion: voucher first,
    // then the adjustment row. This serializes concurrent edit/delete requests
    // without creating a voucher<->adjustment deadlock.
    let [existingAdjustment] = await tx
      .select()
      .from(schema.stockAdjustmentVouchers)
      .where(eq(schema.stockAdjustmentVouchers.id, id));
    if (!existingAdjustment) throw new Error(`Stock adjustment ${id} not found`);

    const [voucher] = await tx
      .select()
      .from(schema.vouchers)
      .where(eq(schema.vouchers.id, existingAdjustment.voucherId))
      .for("update");
    if (!voucher) throw new Error(`Voucher ${existingAdjustment.voucherId} not found`);

    const [lockedAdjustment] = await tx
      .select()
      .from(schema.stockAdjustmentVouchers)
      .where(eq(schema.stockAdjustmentVouchers.id, id))
      .for("update");
    if (!lockedAdjustment) throw new Error(`Stock adjustment ${id} not found`);
    existingAdjustment = lockedAdjustment;
    const isOptional = voucher.optional;

    const existingItems = await tx
      .select()
      .from(schema.stockAdjustmentItems)
      .where(eq(schema.stockAdjustmentItems.adjustmentId, id));

    const [location] = await tx
      .select()
      .from(schema.locations)
      .where(eq(schema.locations.id, existingAdjustment.locationId));
    if (!location) throw new Error(`Location ${existingAdjustment.locationId} not found`);

    // Keep the old lines available after deletion. Matching them to replacement
    // consumption lines lets an unchanged historical issue retain its exact
    // stored value while any newly-added quantity is costed from the live stock.
    const usedHistoricalItemIds = new Set<number>();
    // Inventory the voucher carried before the edit, and what the reversal of
    // its old lines actually moved in the sub-ledger.
    const ledgerBefore = await inventoryLedgerNetTx(tx, location.companyId, [existingAdjustment.voucherId]);
    const reversalDeltas: Decimal[] = [];

    if (!isOptional) {
      existingItems.sort((a, b) => a.stockItemId - b.stockItemId || a.id - b.id);
      for (const oldItem of existingItems) {
        const quantity = toInventoryDecimal(oldItem.quantity);
        const absoluteQuantity = quantity.abs();
        // Wave 11: the exact value the line moved (legacy lines: their total).
        const storedTotalAmount = lineValueMoved({ valueMoved: oldItem.valueMoved, total: oldItem.totalAmount });
        const storedRate = absoluteQuantity.gt(0)
          ? storedTotalAmount.dividedBy(absoluteQuantity)
          : toInventoryDecimal(oldItem.rate);
        const wasProduction = isProductionAdjustment(existingAdjustment.adjustmentType, quantity);

        const reversal = {
          companyId: location.companyId,
          locationId: existingAdjustment.locationId,
          stockItemId: oldItem.stockItemId,
          quantity: absoluteQuantity,
          value: storedTotalAmount,
          sourceVoucherType: "stock_adjustment_edit_reverse",
          sourceVoucherId: existingAdjustment.voucherId,
        };
        reversalDeltas.push(
          wasProduction ? await reverseReceivedValueTx(tx, reversal) : await restoreIssuedValueTx(tx, reversal)
        );

        if (!absoluteQuantity.isZero()) {
          await postStockMovementTx(
            tx,
            {
              companyId: location.companyId,
              stockItemId: oldItem.stockItemId,
              kind: "adjustment",
              quantity: inventoryQuantity(absoluteQuantity),
              unitCost: inventoryUnitCost(storedRate),
              fromLocationId: wasProduction ? existingAdjustment.locationId : undefined,
              toLocationId: wasProduction ? undefined : existingAdjustment.locationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "stock_adjustment_edit_reverse",
                sourceId: String(existingAdjustment.voucherId),
                idempotencyKey: `stock-adjustment-edit:reverse:${location.companyId}:${id}:${oldItem.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      }
    }

    await tx.delete(schema.stockAdjustmentItems).where(eq(schema.stockAdjustmentItems.adjustmentId, id));

    if (!isOptional) {
      // Older adjustment edits used separate production/consumption accounts;
      // the current create/update path posts both through STOCK_ADJUSTMENT. Clean
      // all three codes so repeated edits cannot accumulate duplicate entries.
      const generatedAccounts = await tx
        .select({ id: schema.ledgerAccounts.id })
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.companyId, location.companyId),
            inArray(schema.ledgerAccounts.code, ["STOCK_ADJUSTMENT", "PRODUCTION_ADJUSTMENT", "CONSUMPTION_EXPENSE"]),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        );
      const accountIdsToDelete = generatedAccounts.map((account) => account.id);
      if (accountIdsToDelete.length > 0) {
        await tx
          .delete(schema.voucherEntries)
          .where(
            and(
              eq(schema.voucherEntries.voucherId, existingAdjustment.voucherId),
              inArray(schema.voucherEntries.ledgerAccountId, accountIdsToDelete)
            )
          );
      }
    }

    const [updatedAdjustment] = await tx
      .update(schema.stockAdjustmentVouchers)
      .set({ locationId, adjustmentType, notes })
      .where(eq(schema.stockAdjustmentVouchers.id, id))
      .returning();

    const [newLocation] = await tx.select().from(schema.locations).where(eq(schema.locations.id, locationId));
    if (!newLocation) throw new Error(`Location ${locationId} not found`);

    const findOrCreateAdjustmentAccount = async (
      code: string,
      name: string,
      accountType: string,
      openingBalanceSide: "Dr" | "Cr"
    ): Promise<number> => {
      // A soft-deleted system account still owns the unique (company_id, code)
      // key. Editing an adjustment must therefore restore that row instead of
      // trying to insert a duplicate. The upsert also makes concurrent account
      // creation from different vouchers safe.
      let [account] = await tx
        .select()
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.companyId, newLocation.companyId), eq(schema.ledgerAccounts.code, code)))
        .limit(1);

      if (account?.deletedAt || account?.active === false) {
        [account] = await tx
          .update(schema.ledgerAccounts)
          .set({
            name,
            accountType,
            subType: accountType,
            openingBalanceSide,
            active: true,
            isHidden: false,
            deletedAt: null,
          })
          .where(eq(schema.ledgerAccounts.id, account.id))
          .returning();
      }

      if (!account) {
        [account] = await tx
          .insert(schema.ledgerAccounts)
          .values({
            companyId: newLocation.companyId,
            code,
            name,
            accountType,
            subType: accountType,
            openingBalance: "0",
            openingBalanceSide,
          })
          .onConflictDoUpdate({
            target: [schema.ledgerAccounts.companyId, schema.ledgerAccounts.code],
            set: {
              name,
              accountType,
              subType: accountType,
              openingBalanceSide,
              active: true,
              isHidden: false,
              deletedAt: null,
            },
          })
          .returning();
      }
      return account.id;
    };

    // Production and consumption both post to STOCK_ADJUSTMENT.
    let productionAccountId: number | null = null;
    if (!isOptional) {
      productionAccountId = await findOrCreateAdjustmentAccount(
        "STOCK_ADJUSTMENT",
        "Stock Adjustment (Production/Consumption)",
        "Indirect Expense",
        "Dr"
      );
    }

    let totalProductionValue = toInventoryDecimal(0);
    let totalConsumptionValue = toInventoryDecimal(0);
    let productionDelta = toInventoryDecimal(0);
    let consumptionDelta = toInventoryDecimal(0);

    const sortedUpdAdjItems = [...items].sort((a, b) => a.stockItemId - b.stockItemId);
    const adjustmentItems: StockAdjustmentItem[] = [];
    for (const item of sortedUpdAdjItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const absoluteQuantity = quantity.abs();
      const requestedRate = toInventoryDecimal(item.rate);
      const isProduction = isProductionAdjustment(adjustmentType, quantity);

      let historicalMatch: (typeof existingItems)[number] | undefined;
      if (existingAdjustment.locationId === locationId) {
        historicalMatch = existingItems.find((oldItem) => {
          if (usedHistoricalItemIds.has(oldItem.id) || oldItem.stockItemId !== item.stockItemId) return false;
          const oldQuantity = toInventoryDecimal(oldItem.quantity);
          return isProductionAdjustment(existingAdjustment.adjustmentType, oldQuantity) === isProduction;
        });
      }
      if (historicalMatch) usedHistoricalItemIds.add(historicalMatch.id);

      let actualRate = requestedRate;
      let actualTotalAmount = multiplyInventoryValues(absoluteQuantity, requestedRate);
      let valueMoved: Decimal | null = null;

      if (!isOptional) {
        // Wave 17 B: reapplied through the value-exact path the create uses
        // (adjustInventory / reverseInventoryByExactValue), on the negative-stock
        // model: the line records the exact value it moved (value_moved), a
        // consumption may take the row short (a negative layer at the cost
        // memory, like the create), and nothing is clamped at zero. The hand
        // arithmetic here used to clamp the value at 0, leave value on a
        // zero-quantity row, and refuse a consumption with no stock row.
        const currentInventory = await lockInventoryRow(tx, locationId, item.stockItemId);
        if (isProduction) {
          // An unchanged production line reapplies its historical stored value
          // exactly; otherwise the requested rate defines the receipt value.
          const oldQty = historicalMatch ? toInventoryDecimal(historicalMatch.quantity).abs() : toInventoryDecimal(0);
          const oldRate = historicalMatch ? toInventoryDecimal(historicalMatch.rate) : toInventoryDecimal(0);
          if (historicalMatch && sameDecimal(oldQty, absoluteQuantity) && sameDecimal(oldRate, requestedRate)) {
            actualTotalAmount = toInventoryDecimal(historicalMatch.totalAmount).abs();
            actualRate = absoluteQuantity.gt(0) ? actualTotalAmount.dividedBy(absoluteQuantity) : requestedRate;
          }
          const moved = await receiveInventoryAtValue(tx, {
            locationId,
            stockItemId: item.stockItemId,
            quantity: absoluteQuantity,
            value: inventoryMoney(actualTotalAmount),
            companyId: newLocation.companyId,
            sourceVoucherType: "Stock Adjustment",
            sourceVoucherId: existingAdjustment.voucherId,
          });
          valueMoved = toInventoryDecimal(moved.valueDelta).abs();
          totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
        } else {
          // The overlap with the old issue goes out at its historical value
          // exactly; only additional quantity is costed from the live row, as
          // the create costs it (its cost memory, else the item's opening rate
          // as the provisional cost of a shortage).
          const oldQty = historicalMatch ? toInventoryDecimal(historicalMatch.quantity).abs() : toInventoryDecimal(0);
          const oldValue = historicalMatch
            ? lineValueMoved({ valueMoved: historicalMatch.valueMoved, total: historicalMatch.totalAmount })
            : toInventoryDecimal(0);
          const overlapQty = historicalMatch ? Decimal.min(oldQty, absoluteQuantity) : toInventoryDecimal(0);
          const preservedValue = toInventoryDecimal(
            inventoryMoney(
              historicalMatch && oldQty.gt(0) ? oldValue.times(overlapQty).dividedBy(oldQty) : toInventoryDecimal(0)
            )
          );
          const extraQty = absoluteQuantity.minus(overlapQty);
          let moved = toInventoryDecimal(0);
          if (overlapQty.gt(0) && currentInventory) {
            const preserved = await reverseInventoryByExactValue(
              tx,
              locationId,
              item.stockItemId,
              overlapQty.toNumber(),
              preservedValue,
              newLocation.companyId,
              "Stock Adjustment",
              existingAdjustment.voucherId
            );
            moved = moved.plus(toInventoryDecimal(preserved?.valueDelta ?? 0));
          }
          const issueQty = overlapQty.gt(0) && currentInventory ? extraQty : absoluteQuantity;
          let extraValue = toInventoryDecimal(0);
          if (issueQty.gt(0)) {
            const row = currentInventory ? await lockInventoryRow(tx, locationId, item.stockItemId) : null;
            let incomingRate: number | undefined;
            let extraRate: Decimal;
            if (row) {
              extraRate = Decimal.max(toInventoryDecimal(row.average_rate), 0);
            } else {
              const [stockItem] = await tx
                .select()
                .from(schema.stockItems)
                .where(eq(schema.stockItems.id, item.stockItemId));
              if (!stockItem) throw new Error(`Stock item ${item.stockItemId} not found.`);
              extraRate = toInventoryDecimal(stockItem.openingRate);
              if (!extraRate.isPositive()) throw new Error(`Stock item "${stockItem.name}" has no opening rate set.`);
              incomingRate = extraRate.toNumber();
            }
            const issued = await adjustInventory(
              tx,
              locationId,
              item.stockItemId,
              issueQty.negated().toNumber(),
              newLocation.companyId,
              incomingRate,
              "Stock Adjustment",
              existingAdjustment.voucherId
            );
            moved = moved.plus(toInventoryDecimal(issued.valueDelta));
            extraValue = multiplyInventoryValues(issueQty, extraRate);
          }
          actualTotalAmount = addInventoryValues(
            overlapQty.gt(0) && currentInventory ? preservedValue : toInventoryDecimal(0),
            extraValue
          );
          actualRate = absoluteQuantity.gt(0) ? actualTotalAmount.dividedBy(absoluteQuantity) : requestedRate;
          valueMoved = moved.abs();
          totalConsumptionValue = addInventoryValues(totalConsumptionValue, actualTotalAmount);
        }
      }

      const [adjustmentItem] = await tx
        .insert(schema.stockAdjustmentItems)
        .values({
          adjustmentId: updatedAdjustment.id,
          stockItemId: item.stockItemId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(actualRate),
          totalAmount: inventoryMoney(actualTotalAmount),
          valueMoved: valueMoved === null ? null : inventoryMoney(valueMoved),
        })
        .returning();
      adjustmentItems.push(adjustmentItem);
      if (valueMoved !== null) {
        if (isProduction) productionDelta = addInventoryValues(productionDelta, valueMoved);
        else consumptionDelta = addInventoryValues(consumptionDelta, valueMoved);
      }

      if (!isOptional && !absoluteQuantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: newLocation.companyId,
            stockItemId: item.stockItemId,
            kind: "adjustment",
            quantity: inventoryQuantity(absoluteQuantity),
            unitCost: inventoryUnitCost(actualRate),
            fromLocationId: isProduction ? undefined : locationId,
            toLocationId: isProduction ? locationId : undefined,
            occurredAt: new Date().toISOString(),
            source: {
              sourceType: "stock_adjustment_edit_apply",
              sourceId: String(existingAdjustment.voucherId),
              idempotencyKey: `stock-adjustment-edit:apply:${newLocation.companyId}:${id}:${adjustmentItem.id}`,
            },
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
    }

    if (!isOptional) {
      // Production and consumption post to the same STOCK_ADJUSTMENT account: one net line (wave 12).
      const netLine = stockAdjustmentNetLine(totalProductionValue, totalConsumptionValue, adjustmentType);
      if (netLine && productionAccountId) {
        await tx.insert(schema.voucherEntries).values({
          voucherId: existingAdjustment.voucherId,
          ledgerAccountId: productionAccountId,
          ...netLine,
        });
      }
    }

    const headerTotal = stockAdjustmentHeaderTotal(adjustmentType, adjustmentItems);
    const [updatedVoucher] = await tx
      .update(schema.vouchers)
      .set({
        totalAmount: headerTotal,
        locationId,
        ...(voucherHeader?.description !== undefined ? { description: voucherHeader.description } : {}),
        ...(voucherHeader?.voucherDate !== undefined ? { voucherDate: voucherHeader.voucherDate } : {}),
      })
      .where(eq(schema.vouchers.id, existingAdjustment.voucherId))
      .returning();

    if (!updatedVoucher) throw new Error(`Voucher ${existingAdjustment.voucherId} not found`);

    // Perpetual inventory (wave 8.3): the voucher carries the inventory side of the adjustment.
    await syncStockAdjustmentInventoryTx(tx, voucher.companyId, existingAdjustment.voucherId);

    // Wave 11: the ledger must move with the sub-ledger. The edit moved the
    // sub-ledger by the reversal of the old lines plus the new lines; the
    // re-synced Inventory line moved the ledger by its own change. Whatever the
    // two differ by (a reversal that clamped because the stock was sold since,
    // or a voucher dated before the cut-over that carries no Inventory line)
    // is posted as a reversal difference, dated today.
    if (!isOptional) {
      const ledgerAfter = await inventoryLedgerNetTx(tx, location.companyId, [existingAdjustment.voucherId]);
      const subLedgerDelta = sumDecimals(reversalDeltas).plus(productionDelta).minus(consumptionDelta);
      await postReversalResidualTx(tx, {
        companyId: voucher.companyId,
        sourceType: "stock-adjustment-edit",
        sourceId: `${existingAdjustment.voucherId}:${Date.now().toString(36)}`,
        reference: voucher.voucherNumber,
        subLedgerDelta,
        ledgerDelta: ledgerAfter.minus(ledgerBefore),
      });
    }

    return { adjustment: updatedAdjustment, items: adjustmentItems, voucher: updatedVoucher };
  });
}
