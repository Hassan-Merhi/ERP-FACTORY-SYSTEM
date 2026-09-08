import { eq, sql } from "drizzle-orm";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db, type RawQueryRow } from "../../db";
import * as schema from "@shared/schema";
import type { StockTransferItem, StockAdjustmentItem } from "@shared/schema";
import { getStockItemByCodeOrAlias } from "../inventory";
import { toFiniteNumber } from "@shared/typeGuards";

// ---------------------------------------------------------------------------

export async function updateCostPricesByBarcode(
  locationId: number,
  companyId: number,
  updates: Array<{ barcode: string; costPrice: number }>
): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;

  for (const update of updates) {
    try {
      const stockItem = await getStockItemByCodeOrAlias(update.barcode, companyId);
      if (!stockItem) {
        errors.push(`Barcode not found: ${update.barcode}`);
        continue;
      }

      await db.transaction(async (tx) => {
        // The row is locked FOR UPDATE, so it is read through raw SQL rather
        // than the query builder. `quantity` is a NOT NULL numeric column, so
        // it arrives as a decimal string and is parsed rather than coerced:
        // a blind parseFloat of a non-numeric would write "NaN" into totalValue.
        const inventoryRows = await tx.execute<RawQueryRow<{ id: number; quantity: string }>>(
          sql`SELECT id, quantity FROM inventory WHERE location_id = ${locationId} AND stock_item_id = ${stockItem.id} FOR UPDATE`
        );
        const inventory = inventoryRows.rows[0];

        if (inventory) {
          const quantity = toFiniteNumber(inventory.quantity);
          if (quantity === undefined) {
            errors.push(`Inventory quantity is not a number for barcode: ${update.barcode}`);
            return;
          }
          const newTotalValue = (quantity * update.costPrice).toFixed(2);
          await tx
            .update(schema.inventory)
            .set({
              averageRate: update.costPrice.toFixed(2),
              totalValue: newTotalValue,
              lastUpdated: new Date(),
            })
            .where(eq(schema.inventory.id, inventory.id));
          updated++;
        } else {
          errors.push(`Item not found in inventory for barcode: ${update.barcode}`);
        }
      });
    } catch (err: unknown) {
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

export async function updateStockTransferItem(
  id: number,
  updates: Partial<{ stockItemId: number; quantity: string; rate: string }>
): Promise<StockTransferItem> {
  const [currentItem] = await db.select().from(schema.stockTransferItems).where(eq(schema.stockTransferItems.id, id));
  if (!currentItem) throw new Error("Stock transfer item not found");

  const updateData: LineItemUpdate = {};
  if (updates.stockItemId !== undefined) updateData.stockItemId = updates.stockItemId;
  if (updates.quantity !== undefined) updateData.quantity = updates.quantity;
  if (updates.rate !== undefined) updateData.rate = updates.rate;

  const finalQuantity = updates.quantity !== undefined ? updates.quantity : currentItem.quantity;
  const finalRate = updates.rate !== undefined ? updates.rate : currentItem.rate;
  const qty = parseFloat(finalQuantity);
  const rate = parseFloat(finalRate);
  if (isNaN(qty) || isNaN(rate)) throw new Error("Invalid quantity or rate value");
  updateData.totalAmount = (qty * rate).toFixed(2);

  const [updated] = await db
    .update(schema.stockTransferItems)
    .set(updateData)
    .where(eq(schema.stockTransferItems.id, id))
    .returning();
  return updated;
}

export async function updateStockAdjustmentItem(
  id: number,
  updates: Partial<{ stockItemId: number; quantity: string; rate: string }>
): Promise<StockAdjustmentItem> {
  const [currentItem] = await db
    .select()
    .from(schema.stockAdjustmentItems)
    .where(eq(schema.stockAdjustmentItems.id, id));
  if (!currentItem) throw new Error("Stock adjustment item not found");

  const updateData: LineItemUpdate = {};
  if (updates.stockItemId !== undefined) updateData.stockItemId = updates.stockItemId;
  if (updates.quantity !== undefined) updateData.quantity = updates.quantity;
  if (updates.rate !== undefined) updateData.rate = updates.rate;

  const finalQuantity = updates.quantity !== undefined ? updates.quantity : currentItem.quantity;
  const finalRate = updates.rate !== undefined ? updates.rate : currentItem.rate;
  const qty = parseFloat(finalQuantity);
  const rate = parseFloat(finalRate);
  if (isNaN(qty) || isNaN(rate)) throw new Error("Invalid quantity or rate value");
  updateData.totalAmount = (qty * rate).toFixed(2);

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
