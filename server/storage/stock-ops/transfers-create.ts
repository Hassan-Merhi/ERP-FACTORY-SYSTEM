import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
  weightedAverageInventoryCost,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import type { StockTransferItem, StockAdjustmentItem } from "@shared/schema";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { shouldInsertAdjustmentVoucherEntry } from "./adjustmentVoucherEntryGuard";
import { lockInventoryRow } from "../inventoryRowLock";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/**
 * A second stock adjustment was created for a voucher that already had one.
 *
 * The route checks for this before it calls in, but a check made in one
 * connection and an insert made in another are two separate moments: two
 * submissions arriving together both find nothing and both apply their items to
 * inventory. The check below is made under a lock on the voucher row inside the
 * same transaction as the insert, so the second one loses.
 */
export class DuplicateStockAdjustmentError extends Error {
  readonly code = "STOCK_ADJUSTMENT_ALREADY_EXISTS";

  constructor(voucherId: number) {
    super(`Voucher ${voucherId} already has a stock adjustment`);
    this.name = "DuplicateStockAdjustmentError";
  }
}

/**
 * A second stock transfer document was created for a voucher that already had
 * one. The endpoint that attaches items to an existing voucher had no guard at
 * all: submitting it twice built a second transfer and moved the stock again.
 */
export class DuplicateStockTransferError extends Error {
  readonly code = "STOCK_TRANSFER_ALREADY_EXISTS";

  constructor(voucherId: number) {
    super(`Voucher ${voucherId} already has a stock transfer`);
    this.name = "DuplicateStockTransferError";
  }
}

export async function createStockTransfer(
  voucherId: number,
  destinationLocationId: number,
  notes: string,
  items: Array<{ sourceLocationId: number; stockItemId: number; quantity: string; rate: string }>
) {
  return await db.transaction(async (tx) => {
    // The lock makes the duplicate check below decisive: two submissions for the
    // same voucher are ordered, and the second one finds the first one's row.
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId)).for("update");
    if (!voucher) throw new Error(`Voucher ${voucherId} not found`);
    const isOptional = voucher.optional;

    const [duplicate] = await tx
      .select({ id: schema.stockTransferVouchers.id })
      .from(schema.stockTransferVouchers)
      .where(eq(schema.stockTransferVouchers.voucherId, voucherId))
      .limit(1);
    if (duplicate) throw new DuplicateStockTransferError(voucherId);

    if (!items || items.length === 0) throw new Error("No items provided for stock transfer");

    const sortedTransferItems = [...items].sort((a, b) => a.stockItemId - b.stockItemId);

    const [transfer] = await tx
      .insert(schema.stockTransferVouchers)
      .values({
        voucherId,
        sourceLocationId: items[0].sourceLocationId,
        destinationLocationId,
        notes,
        inventoryApplied: !isOptional,
      })
      .returning();

    const transferItems: StockTransferItem[] = [];
    for (const item of sortedTransferItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const rate = toInventoryDecimal(item.rate);
      const totalAmount = multiplyInventoryValues(quantity, rate);

      const [transferItem] = await tx
        .insert(schema.stockTransferItems)
        .values({
          transferId: transfer.id,
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(rate),
          totalAmount: inventoryMoney(totalAmount),
        })
        .returning();

      transferItems.push(transferItem);

      if (!isOptional) {
        const sourceInventory = await lockInventoryRow(tx, item.sourceLocationId, item.stockItemId);

        if (sourceInventory) {
          const currentQty = toInventoryDecimal(sourceInventory.quantity);
          const currentRate = toInventoryDecimal(sourceInventory.average_rate);
          const newQty = subtractInventoryValues(currentQty, quantity);
          const newValue = newQty.isPositive() ? multiplyInventoryValues(newQty, currentRate) : toInventoryDecimal(0);

          await tx
            .update(schema.inventory)
            .set({
              quantity: inventoryQuantity(newQty),
              averageRate: inventoryUnitCost(currentRate),
              totalValue: inventoryMoney(newValue),
              lastUpdated: new Date(),
            })
            .where(eq(schema.inventory.id, sourceInventory.id));
        }

        const destInventory = await lockInventoryRow(tx, destinationLocationId, item.stockItemId);

        if (destInventory) {
          const currentQty = toInventoryDecimal(destInventory.quantity);
          const currentRate = toInventoryDecimal(destInventory.average_rate);
          const newQty = addInventoryValues(currentQty, quantity);
          const newRate = weightedAverageInventoryCost(currentQty, currentRate, quantity, rate);
          const newValue = multiplyInventoryValues(newQty, newRate);

          await tx
            .update(schema.inventory)
            .set({
              quantity: inventoryQuantity(newQty),
              averageRate: inventoryUnitCost(newRate),
              totalValue: inventoryMoney(newValue),
              lastUpdated: new Date(),
            })
            .where(eq(schema.inventory.id, destInventory.id));
        } else {
          const [destLocation] = await tx
            .select()
            .from(schema.locations)
            .where(eq(schema.locations.id, destinationLocationId));
          if (!destLocation) throw new Error(`Destination location ${destinationLocationId} not found`);

          await tx.insert(schema.inventory).values({
            companyId: destLocation.companyId,
            locationId: destinationLocationId,
            stockItemId: item.stockItemId,
            quantity: inventoryQuantity(quantity),
            averageRate: inventoryUnitCost(rate),
            totalValue: inventoryMoney(totalAmount),
            lastUpdated: new Date(),
          });
        }

        // Canonical evidence for this leg, written inside the same transaction
        // that applied the inventory above. Reconciliation compares the transfer
        // document against these rows, so evidence and effect commit or roll
        // back together — a transfer can never appear in one and not the other.
        //
        // A leg whose source and destination are the same location moves no
        // stock between locations and has no balanced issue/receipt pair to
        // record; reconciliation surfaces such a document as unevidenced rather
        // than this path inventing a movement that did not happen.
        if (item.sourceLocationId !== destinationLocationId) {
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: item.stockItemId,
              kind: "transfer",
              quantity: inventoryQuantity(quantity),
              unitCost: inventoryUnitCost(rate),
              fromLocationId: item.sourceLocationId,
              toLocationId: destinationLocationId,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "stock-transfer",
                sourceId: String(transfer.id),
                idempotencyKey: `stock-transfer:${transfer.id}:${item.stockItemId}`,
              },
              // The journal records what the transfer did; it does not add a
              // negative-stock rule the transfer itself does not enforce.
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }
      }
    }

    return { transfer, items: transferItems };
  });
}

export async function createStockAdjustment(
  voucherId: number,
  locationId: number,
  adjustmentType: "Production" | "Consumption" | "Mixed",
  notes: string,
  items: Array<{ stockItemId: number; quantity: string; rate: string }>,
  _consumptionAccountOverride?: { code: string; name: string }
) {
  return await db.transaction(async (tx) => {
    // Locking the voucher row serialises everyone who wants to adjust it, so the
    // duplicate check below cannot be overtaken between reading and inserting.
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId)).for("update");
    if (!voucher) throw new Error(`Voucher ${voucherId} not found`);
    const isOptional = voucher.optional;

    const [duplicate] = await tx
      .select({ id: schema.stockAdjustmentVouchers.id })
      .from(schema.stockAdjustmentVouchers)
      .where(eq(schema.stockAdjustmentVouchers.voucherId, voucherId))
      .limit(1);
    if (duplicate) throw new DuplicateStockAdjustmentError(voucherId);

    const [adjustment] = await tx
      .insert(schema.stockAdjustmentVouchers)
      .values({ voucherId, locationId, adjustmentType, notes })
      .returning();

    const [location] = await tx.select().from(schema.locations).where(eq(schema.locations.id, locationId));
    if (!location) throw new Error(`Location ${locationId} not found`);

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
            eq(schema.ledgerAccounts.companyId, location.companyId),
            eq(schema.ledgerAccounts.code, code),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .limit(1);
      if (!account) {
        [account] = await tx
          .insert(schema.ledgerAccounts)
          .values({
            companyId: location.companyId,
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

    const sortedAdjItems = [...items].sort((a, b) => a.stockItemId - b.stockItemId);
    const adjustmentItems: StockAdjustmentItem[] = [];
    for (const item of sortedAdjItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const absoluteQuantity = quantity.abs();
      const rate = toInventoryDecimal(item.rate);
      const isProduction = adjustmentType === "Production" || (adjustmentType === "Mixed" && quantity.isPositive());
      let actualRate = rate;
      let actualTotalAmount = multiplyInventoryValues(absoluteQuantity, rate);

      if (!isOptional) {
        const currentInventory = await lockInventoryRow(tx, locationId, item.stockItemId);

        if (currentInventory) {
          const currentQty = toInventoryDecimal(currentInventory.quantity);
          const currentRate = toInventoryDecimal(currentInventory.average_rate);
          let newQty;
          let newValue;
          let newRate;

          if (isProduction) {
            newQty = addInventoryValues(currentQty, absoluteQuantity);
            newRate = weightedAverageInventoryCost(currentQty, currentRate, absoluteQuantity, rate);
            newValue = multiplyInventoryValues(newQty, newRate);
            totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
          } else {
            newQty = subtractInventoryValues(currentQty, absoluteQuantity);
            newValue = newQty.isPositive() ? multiplyInventoryValues(newQty, currentRate) : toInventoryDecimal(0);
            newRate = currentRate;
            actualRate = currentRate;
            actualTotalAmount = multiplyInventoryValues(absoluteQuantity, currentRate);
            totalConsumptionValue = addInventoryValues(totalConsumptionValue, actualTotalAmount);
          }

          await tx
            .update(schema.inventory)
            .set({
              quantity: inventoryQuantity(newQty),
              averageRate: inventoryUnitCost(newRate),
              totalValue: inventoryMoney(newValue),
              lastUpdated: new Date(),
            })
            .where(eq(schema.inventory.id, currentInventory.id));
        } else if (isProduction) {
          await tx.insert(schema.inventory).values({
            companyId: location.companyId,
            locationId,
            stockItemId: item.stockItemId,
            quantity: inventoryQuantity(absoluteQuantity),
            averageRate: inventoryUnitCost(rate),
            totalValue: inventoryMoney(actualTotalAmount),
            lastUpdated: new Date(),
          });
          totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
        } else {
          const [stockItem] = await tx
            .select()
            .from(schema.stockItems)
            .where(eq(schema.stockItems.id, item.stockItemId));
          if (!stockItem) throw new Error(`Stock item ${item.stockItemId} not found.`);
          const fallbackRate = toInventoryDecimal(stockItem.openingRate);
          if (!fallbackRate.isPositive()) throw new Error(`Stock item "${stockItem.name}" has no opening rate set.`);
          actualRate = fallbackRate;
          actualTotalAmount = multiplyInventoryValues(absoluteQuantity, fallbackRate);
          totalConsumptionValue = addInventoryValues(totalConsumptionValue, actualTotalAmount);
          await tx.insert(schema.inventory).values({
            companyId: location.companyId,
            locationId,
            stockItemId: item.stockItemId,
            quantity: inventoryQuantity(absoluteQuantity.negated()),
            averageRate: inventoryUnitCost(fallbackRate),
            totalValue: inventoryMoney(actualTotalAmount.negated()),
            lastUpdated: new Date(),
          });
        }
      }

      // Canonical evidence for the applied adjustment, on the same transaction
      // that just moved the inventory above. The rate is the one the adjustment
      // actually resolved — a consumption line takes the location's current
      // average or the item's opening rate, not the rate the caller sent — so
      // the journal records the cost that was really applied.
      //
      // A zero-quantity adjustment changes no stock and gets no movement row:
      // the canonical boundary rejects a zero quantity precisely because it is
      // not a movement.
      if (!isOptional && !absoluteQuantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: voucher.companyId,
            stockItemId: item.stockItemId,
            kind: isProduction ? "receipt" : "issue",
            quantity: inventoryQuantity(absoluteQuantity),
            unitCost: inventoryUnitCost(actualRate),
            fromLocationId: isProduction ? null : locationId,
            toLocationId: isProduction ? locationId : null,
            occurredAt: new Date().toISOString(),
            source: {
              sourceType: "stock-adjustment",
              sourceId: String(adjustment.id),
              idempotencyKey: `stock-adjustment:${adjustment.id}:${item.stockItemId}`,
            },
            // The journal records what the adjustment did; it does not add a
            // negative-stock rule the adjustment does not itself enforce.
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }

      const [adjustmentItem] = await tx
        .insert(schema.stockAdjustmentItems)
        .values({
          adjustmentId: adjustment.id,
          stockItemId: item.stockItemId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(actualRate),
          totalAmount: inventoryMoney(actualTotalAmount),
        })
        .returning();
      adjustmentItems.push(adjustmentItem);
    }

    if (!isOptional) {
      if (shouldInsertAdjustmentVoucherEntry(totalProductionValue, productionAccountId)) {
        await tx.insert(schema.voucherEntries).values({
          voucherId,
          ledgerAccountId: productionAccountId,
          debitAmount: "0",
          creditAmount: inventoryMoney(totalProductionValue),
          narration: `Production adjustment - ${adjustmentType} voucher`,
        });
      }
      if (shouldInsertAdjustmentVoucherEntry(totalConsumptionValue, consumptionAccountId)) {
        await tx.insert(schema.voucherEntries).values({
          voucherId,
          ledgerAccountId: consumptionAccountId,
          debitAmount: inventoryMoney(totalConsumptionValue),
          creditAmount: "0",
          narration: `Consumption expense - ${adjustmentType} voucher`,
        });
      }
    }

    return { adjustment, items: adjustmentItems };
  });
}
