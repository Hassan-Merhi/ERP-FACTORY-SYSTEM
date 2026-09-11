import Decimal from "decimal.js";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
import { firstRow } from "../../lib/queryResult";
import { reverseInventoryByExactValue } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { restoreInventoryByExactValue } from "../../services/inventory/exactValueInventory";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";

/** An inventory row locked FOR UPDATE while a transfer/adjustment is rewritten. */
type InventoryLockRow = { id: number; quantity: string; average_rate: string; total_value: string };
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import type { StockTransferItem, StockAdjustmentItem } from "@shared/schema";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

function isProductionAdjustment(adjustmentType: string, quantity: Decimal): boolean {
  const normalized = adjustmentType.toLowerCase();
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

    // A transfer edit is a reversal of the historical transfer followed by the
    // requested replacement. Reverse the exact stored quantity + value instead
    // of reconstructing either leg from today's rounded average rate.
    if (existingTransfer.inventoryApplied || !isOptional) {
      existingItems.sort((a, b) => a.stockItemId - b.stockItemId || a.id - b.id);
      for (const oldItem of existingItems) {
        const quantity = toInventoryDecimal(oldItem.quantity).abs();
        const totalAmount = toInventoryDecimal(oldItem.totalAmount).abs();
        const rate = quantity.gt(0) ? totalAmount.dividedBy(quantity) : toInventoryDecimal(oldItem.rate);
        const sourceLocationId = oldItem.sourceLocationId || existingTransfer.sourceLocationId;
        if (!sourceLocationId) throw new Error(`Stock transfer item ${oldItem.id} has no source location`);

        // Original transfer issued value from the source and received the same
        // value at the destination. Undo those exact effects in the opposite
        // direction. The restore path deliberately does not settle unrelated
        // negative-stock layers.
        await restoreInventoryByExactValue(
          tx,
          voucher.companyId,
          sourceLocationId,
          oldItem.stockItemId,
          quantity.toNumber(),
          totalAmount.toNumber()
        );
        await reverseInventoryByExactValue(
          tx,
          existingTransfer.destinationLocationId!,
          oldItem.stockItemId,
          quantity.toNumber(),
          totalAmount.toNumber(),
          voucher.companyId,
          "stock_transfer_edit_reverse",
          existingTransfer.voucherId
        );

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
      const appliedRate = quantity.gt(0) ? totalAmount.dividedBy(quantity) : requestedRate;

      const [transferItem] = await tx
        .insert(schema.stockTransferItems)
        .values({
          transferId: updatedTransfer.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(appliedRate),
          totalAmount: inventoryMoney(totalAmount),
        })
        .returning();
      transferItems.push(transferItem);

      if (!isOptional) {
        // Apply the replacement transfer as an exact value move. Source and
        // destination therefore move by the same amount and an unchanged save
        // is valuation-neutral even if either location's average rate changed
        // after the original transfer.
        await reverseInventoryByExactValue(
          tx,
          item.sourceLocationId,
          item.stockItemId,
          quantity.toNumber(),
          totalAmount.toNumber(),
          voucher.companyId,
          "stock_transfer_edit_apply",
          existingTransfer.voucherId
        );
        await restoreInventoryByExactValue(
          tx,
          voucher.companyId,
          destinationLocationId,
          item.stockItemId,
          quantity.toNumber(),
          totalAmount.toNumber()
        );

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

    return { transfer: updatedTransfer, items: transferItems };
  });
}

export async function updateStockAdjustment(
  id: number,
  locationId: number,
  adjustmentType: "Production" | "Consumption" | "Mixed",
  notes: string,
  items: Array<{ stockItemId: number; quantity: string; rate: string }>
) {
  return await db.transaction(async (tx) => {
    const [existingAdjustment] = await tx
      .select()
      .from(schema.stockAdjustmentVouchers)
      .where(eq(schema.stockAdjustmentVouchers.id, id));
    if (!existingAdjustment) throw new Error(`Stock adjustment ${id} not found`);

    const [voucher] = await tx
      .select()
      .from(schema.vouchers)
      .where(eq(schema.vouchers.id, existingAdjustment.voucherId));
    if (!voucher) throw new Error(`Voucher ${existingAdjustment.voucherId} not found`);
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

    if (!isOptional) {
      existingItems.sort((a, b) => a.stockItemId - b.stockItemId || a.id - b.id);
      for (const oldItem of existingItems) {
        const quantity = toInventoryDecimal(oldItem.quantity);
        const absoluteQuantity = quantity.abs();
        const storedTotalAmount = toInventoryDecimal(oldItem.totalAmount).abs();
        const storedRate = absoluteQuantity.gt(0)
          ? storedTotalAmount.dividedBy(absoluteQuantity)
          : toInventoryDecimal(oldItem.rate);
        const wasProduction = isProductionAdjustment(existingAdjustment.adjustmentType, quantity);

        if (wasProduction) {
          await reverseInventoryByExactValue(
            tx,
            existingAdjustment.locationId,
            oldItem.stockItemId,
            absoluteQuantity.toNumber(),
            storedTotalAmount.toNumber(),
            location.companyId,
            "stock_adjustment_edit_reverse",
            existingAdjustment.voucherId
          );
        } else {
          await restoreInventoryByExactValue(
            tx,
            location.companyId,
            existingAdjustment.locationId,
            oldItem.stockItemId,
            absoluteQuantity.toNumber(),
            storedTotalAmount.toNumber()
          );
        }

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
      let [account] = await tx
        .select()
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.companyId, newLocation.companyId),
            eq(schema.ledgerAccounts.code, code),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .limit(1);
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
          .returning();
      }
      return account.id;
    };

    let productionAccountId: number | null = null;
    let consumptionAccountId: number | null = null;
    if (!isOptional) {
      const adjustmentAccountId = await findOrCreateAdjustmentAccount(
        "STOCK_ADJUSTMENT",
        "Stock Adjustment (Production/Consumption)",
        "Indirect Expense",
        "Dr"
      );
      productionAccountId = adjustmentAccountId;
      consumptionAccountId = adjustmentAccountId;
    }

    let totalProductionValue = toInventoryDecimal(0);
    let totalConsumptionValue = toInventoryDecimal(0);

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

      if (!isOptional) {
        const currentInventoryRows = await tx.execute(
          sql`SELECT id, quantity, average_rate, total_value
              FROM inventory
              WHERE company_id = ${newLocation.companyId}
                AND location_id = ${locationId}
                AND stock_item_id = ${item.stockItemId}
              FOR UPDATE`
        );
        const currentInventory = firstRow<InventoryLockRow>(currentInventoryRows);

        if (currentInventory) {
          const currentQty = toInventoryDecimal(currentInventory.quantity);
          const currentRate = toInventoryDecimal(currentInventory.average_rate);
          const currentValue = toInventoryDecimal(currentInventory.total_value);
          let newQty: Decimal;
          let newValue: Decimal;
          let newRate: Decimal;

          if (isProduction) {
            // If this is an unchanged production line, reapply the historical
            // stored value byte-for-byte. Otherwise the requested rate defines
            // the replacement production value. In both cases the live stored
            // total_value — not qty × rounded average_rate — is the base.
            const oldQty = historicalMatch ? toInventoryDecimal(historicalMatch.quantity).abs() : toInventoryDecimal(0);
            const oldRate = historicalMatch ? toInventoryDecimal(historicalMatch.rate) : toInventoryDecimal(0);
            if (
              historicalMatch &&
              sameDecimal(oldQty, absoluteQuantity) &&
              sameDecimal(oldRate, requestedRate)
            ) {
              actualTotalAmount = toInventoryDecimal(historicalMatch.totalAmount).abs();
              actualRate = absoluteQuantity.gt(0)
                ? actualTotalAmount.dividedBy(absoluteQuantity)
                : requestedRate;
            }

            newQty = addInventoryValues(currentQty, absoluteQuantity);
            newValue = addInventoryValues(currentValue, actualTotalAmount);
            newRate = newQty.isPositive() ? newValue.dividedBy(newQty) : actualRate;
            totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
          } else {
            // Preserve the historical value for the overlap with the old issue;
            // only additional quantity is costed from the live inventory that
            // exists after the historical issue was reversed.
            const oldQty = historicalMatch ? toInventoryDecimal(historicalMatch.quantity).abs() : toInventoryDecimal(0);
            const oldValue = historicalMatch ? toInventoryDecimal(historicalMatch.totalAmount).abs() : toInventoryDecimal(0);
            const overlapQty = historicalMatch ? Decimal.min(oldQty, absoluteQuantity) : toInventoryDecimal(0);
            const preservedValue =
              historicalMatch && oldQty.gt(0) ? oldValue.times(overlapQty).dividedBy(oldQty) : toInventoryDecimal(0);
            const extraQty = absoluteQuantity.minus(overlapQty);

            const qtyAfterPreserved = currentQty.minus(overlapQty);
            const valueAfterPreserved = Decimal.max(currentValue.minus(preservedValue), toInventoryDecimal(0));
            const liveExtraRate = qtyAfterPreserved.gt(0)
              ? valueAfterPreserved.dividedBy(qtyAfterPreserved)
              : currentRate;
            const extraValue = multiplyInventoryValues(extraQty, liveExtraRate);

            actualTotalAmount = addInventoryValues(preservedValue, extraValue);
            actualRate = absoluteQuantity.gt(0)
              ? actualTotalAmount.dividedBy(absoluteQuantity)
              : liveExtraRate;
            newQty = subtractInventoryValues(currentQty, absoluteQuantity);
            newValue = newQty.isPositive()
              ? Decimal.max(currentValue.minus(actualTotalAmount), toInventoryDecimal(0))
              : toInventoryDecimal(0);
            newRate = newQty.isPositive() && newValue.gt(0) ? newValue.dividedBy(newQty) : actualRate;
            totalConsumptionValue = addInventoryValues(totalConsumptionValue, actualTotalAmount);
          }

          await tx
            .update(schema.inventory)
            .set({
              quantity: inventoryQuantity(newQty),
              averageRate: inventoryUnitCost(Decimal.max(newRate, toInventoryDecimal(0))),
              totalValue: inventoryMoney(Decimal.max(newValue, toInventoryDecimal(0))),
              lastUpdated: new Date(),
            })
            .where(eq(schema.inventory.id, currentInventory.id));
        } else if (isProduction) {
          await tx.insert(schema.inventory).values({
            companyId: newLocation.companyId,
            locationId,
            stockItemId: item.stockItemId,
            quantity: inventoryQuantity(absoluteQuantity),
            averageRate: inventoryUnitCost(requestedRate),
            totalValue: inventoryMoney(actualTotalAmount),
            lastUpdated: new Date(),
          });
          totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
        } else {
          throw new Error(`Insufficient inventory at location ${locationId} for stock item ${item.stockItemId}.`);
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
        })
        .returning();
      adjustmentItems.push(adjustmentItem);

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
      if (totalProductionValue.isPositive() && productionAccountId) {
        await tx.insert(schema.voucherEntries).values({
          voucherId: existingAdjustment.voucherId,
          ledgerAccountId: productionAccountId,
          debitAmount: "0",
          creditAmount: inventoryMoney(totalProductionValue),
          narration: `Production adjustment - ${adjustmentType} voucher`,
        });
      }
      if (totalConsumptionValue.isPositive() && consumptionAccountId) {
        await tx.insert(schema.voucherEntries).values({
          voucherId: existingAdjustment.voucherId,
          ledgerAccountId: consumptionAccountId,
          debitAmount: inventoryMoney(totalConsumptionValue),
          creditAmount: "0",
          narration: `Consumption expense - ${adjustmentType} voucher`,
        });
      }
    }

    return { adjustment: updatedAdjustment, items: adjustmentItems };
  });
}
