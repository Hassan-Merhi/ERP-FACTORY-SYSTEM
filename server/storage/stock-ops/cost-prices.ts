import { eq } from "drizzle-orm";
import { getErrorMessage, HttpError } from "../../lib/httpHandlers";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { StockTransferItem, StockAdjustmentItem } from "@shared/schema";
import { getStockItemByCodeOrAlias } from "../inventory";
import { moneyString, parseMoneyInput } from "../../lib/money";
import { lockInventoryRow } from "../inventoryRowLock";
import { recordInventoryValuationOverride } from "../../services/inventory/recordInventoryValuationOverride";
import { writeAuditEvent } from "../../services/audit/auditService";
import {
  assertNoInventoryCutoverTx,
  InventoryCutoverRefusalError,
} from "../../services/accounting/perpetualInventory/cutoverRefusal";

// ---------------------------------------------------------------------------

/** Who runs the cost-price import (the audit row's actor). */
export interface CostPriceImportActor {
  userId: string;
  username: string;
}

/**
 * The location cost-price import (phase 19 C, I2): it overwrites an inventory
 * row's average rate and value with no stock movement and no journal, so the
 * route is Admin/Owner and refused once the company's perpetual cut-over is
 * applied. Each row is one transaction: the cut-over is re-checked in it, the
 * rate is exact (Decimal, 6 places; was a float at 2), the value is quantity ×
 * rate at cents, and the valuation override and an audit row (before/after)
 * are written in it.
 */
export async function updateCostPricesByBarcode(
  locationId: number,
  companyId: number,
  updates: Array<{ barcode: string; costPrice: unknown }>,
  actor: CostPriceImportActor = { userId: "system", username: "system" }
): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;

  for (const update of updates) {
    try {
      const costPrice = parseMoneyInput(update.costPrice);
      if (!costPrice || costPrice.lt(0)) {
        errors.push(`Invalid cost price for barcode: ${update.barcode}`);
        continue;
      }
      const averageRate = costPrice.toDecimalPlaces(6).toFixed(6);
      const stockItem = await getStockItemByCodeOrAlias(update.barcode, companyId);
      if (!stockItem) {
        errors.push(`Barcode not found: ${update.barcode}`);
        continue;
      }

      await db.transaction(async (tx) => {
        await assertNoInventoryCutoverTx(tx, companyId, "cost-price-import");
        const inventory = await lockInventoryRow(tx, locationId, stockItem.id);

        if (inventory) {
          const quantity = parseMoneyInput(String(inventory.quantity));
          if (!quantity) {
            errors.push(`Inventory quantity is not a number for barcode: ${update.barcode}`);
            return;
          }
          const newTotalValue = quantity.times(averageRate).toDecimalPlaces(2).toFixed(2);
          await tx
            .update(schema.inventory)
            .set({
              averageRate,
              totalValue: newTotalValue,
              lastUpdated: new Date(),
            })
            .where(eq(schema.inventory.id, inventory.id));
          // This overwrite has no stock movement, so record the exact before
          // and after valuation as evidence for historical cost replay.
          await recordInventoryValuationOverride(tx, {
            companyId,
            locationId,
            stockItemId: stockItem.id,
            inventoryId: inventory.id,
            sourceType: "location-cost-price-import",
            before: {
              quantity: inventory.quantity,
              averageRate: inventory.average_rate,
              totalValue: inventory.total_value,
            },
            after: {
              quantity: inventory.quantity,
              averageRate,
              totalValue: newTotalValue,
            },
          });
          await writeAuditEvent(
            {
              userId: actor.userId,
              username: actor.username,
              companyId,
              action: "update",
              tableName: "inventory",
              recordId: inventory.id,
              recordIdentifier: `cost-price import: ${update.barcode} at location ${locationId}`,
              changes: {
                averageRate: { old: inventory.average_rate, new: averageRate },
                totalValue: { old: inventory.total_value, new: newTotalValue },
                source: { new: "location-cost-price-import" },
              },
            },
            tx
          );
          updated++;
        } else {
          errors.push(`Item not found in inventory for barcode: ${update.barcode}`);
        }
      });
    } catch (err: unknown) {
      // The cut-over refusal stops the whole import (nothing more is written).
      if (err instanceof InventoryCutoverRefusalError) throw err;
      errors.push(`Error processing ${update.barcode}: ${getErrorMessage(err)}`);
    }
  }

  return { updated, errors };
}

// ---------------------------------------------------------------------------
// Update Stock Transfer / Adjustment Items (inline edits, no inventory side-effect)
// ---------------------------------------------------------------------------

/**
 * The columns an inline line-item edit may set. Transfer and adjustment items
 * share these four, and `totalAmount` is always recomputed rather than accepted
 * from the caller.
 */
interface LineItemUpdate {
  stockItemId?: number;
  quantity?: string;
  rate?: string;
  totalAmount?: string;
}

export const POSTED_STOCK_LINE_EDIT_MESSAGE =
  "This line belongs to a posted stock document. Edit the document itself so its stock and journal move with the change.";

/**
 * Wave 11: an inline edit changes the line's quantity, rate or item with no
 * stock or journal change, so it is refused (409) on a posted document — a
 * transfer whose stock is applied, an adjustment whose voucher is not
 * optional — and on a document of another company (404). Draft (optional)
 * documents can still be edited inline; their stock moves when they post.
 */
export class PostedStockLineEditError extends HttpError {
  constructor(status: 404 | 409, message: string) {
    super(status, message);
    this.name = "PostedStockLineEditError";
  }
}

async function assertInlineEditableTransferLine(transferId: number, companyId: number | undefined): Promise<void> {
  const [document] = await db
    .select({
      companyId: schema.vouchers.companyId,
      optional: schema.vouchers.optional,
      inventoryApplied: schema.stockTransferVouchers.inventoryApplied,
    })
    .from(schema.stockTransferVouchers)
    .innerJoin(schema.vouchers, eq(schema.vouchers.id, schema.stockTransferVouchers.voucherId))
    .where(eq(schema.stockTransferVouchers.id, transferId));
  if (!document || (companyId !== undefined && document.companyId !== companyId)) {
    throw new PostedStockLineEditError(404, "Stock transfer item not found");
  }
  if (document.inventoryApplied || document.optional !== true) {
    throw new PostedStockLineEditError(409, POSTED_STOCK_LINE_EDIT_MESSAGE);
  }
}

async function assertInlineEditableAdjustmentLine(adjustmentId: number, companyId: number | undefined): Promise<void> {
  const [document] = await db
    .select({ companyId: schema.vouchers.companyId, optional: schema.vouchers.optional })
    .from(schema.stockAdjustmentVouchers)
    .innerJoin(schema.vouchers, eq(schema.vouchers.id, schema.stockAdjustmentVouchers.voucherId))
    .where(eq(schema.stockAdjustmentVouchers.id, adjustmentId));
  if (!document || (companyId !== undefined && document.companyId !== companyId)) {
    throw new PostedStockLineEditError(404, "Stock adjustment item not found");
  }
  if (document.optional !== true) throw new PostedStockLineEditError(409, POSTED_STOCK_LINE_EDIT_MESSAGE);
}

/**
 * Quantity × rate at cents, exact and rounded half up. The float product
 * rounded the binary value: 3 × 1.115 is 3.3449… as a float and was stored
 * as 3.34.
 */
export function lineTotal(quantity: string, rate: string): string {
  const qty = parseMoneyInput(quantity);
  const unitRate = parseMoneyInput(rate);
  if (!qty || !unitRate) throw new Error("Invalid quantity or rate value");
  return moneyString(qty.times(unitRate));
}

export async function updateStockTransferItem(
  id: number,
  updates: Partial<{ stockItemId: number; quantity: string; rate: string }>,
  companyId?: number
): Promise<StockTransferItem> {
  const [currentItem] = await db.select().from(schema.stockTransferItems).where(eq(schema.stockTransferItems.id, id));
  if (!currentItem) throw new Error("Stock transfer item not found");
  await assertInlineEditableTransferLine(currentItem.transferId, companyId);

  const updateData: LineItemUpdate = {};
  if (updates.stockItemId !== undefined) updateData.stockItemId = updates.stockItemId;
  if (updates.quantity !== undefined) updateData.quantity = updates.quantity;
  if (updates.rate !== undefined) updateData.rate = updates.rate;

  const finalQuantity = updates.quantity !== undefined ? updates.quantity : currentItem.quantity;
  const finalRate = updates.rate !== undefined ? updates.rate : currentItem.rate;
  updateData.totalAmount = lineTotal(finalQuantity, finalRate);

  const [updated] = await db
    .update(schema.stockTransferItems)
    .set(updateData)
    .where(eq(schema.stockTransferItems.id, id))
    .returning();
  return updated;
}

export async function updateStockAdjustmentItem(
  id: number,
  updates: Partial<{ stockItemId: number; quantity: string; rate: string }>,
  companyId?: number
): Promise<StockAdjustmentItem> {
  const [currentItem] = await db
    .select()
    .from(schema.stockAdjustmentItems)
    .where(eq(schema.stockAdjustmentItems.id, id));
  if (!currentItem) throw new Error("Stock adjustment item not found");
  await assertInlineEditableAdjustmentLine(currentItem.adjustmentId, companyId);

  const updateData: LineItemUpdate = {};
  if (updates.stockItemId !== undefined) updateData.stockItemId = updates.stockItemId;
  if (updates.quantity !== undefined) updateData.quantity = updates.quantity;
  if (updates.rate !== undefined) updateData.rate = updates.rate;

  const finalQuantity = updates.quantity !== undefined ? updates.quantity : currentItem.quantity;
  const finalRate = updates.rate !== undefined ? updates.rate : currentItem.rate;
  updateData.totalAmount = lineTotal(finalQuantity, finalRate);

  const [updated] = await db
    .update(schema.stockAdjustmentItems)
    .set(updateData)
    .where(eq(schema.stockAdjustmentItems.id, id))
    .returning();
  return updated;
}

// ---------------------------------------------------------------------------
// Create Stock Transfer
// ---------------------------------------------------------------------------
