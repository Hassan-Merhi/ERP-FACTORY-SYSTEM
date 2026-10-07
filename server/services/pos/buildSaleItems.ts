/**
 * server/services/pos/buildSaleItems.ts
 *
 * PHASE 19 structural split — moved (unchanged) from server/routes/pos/posSalesRoutes.ts:
 *   - basic per-item field validation
 *   - grand total calculation
 *   - inventory availability pre-check (best-effort; authoritative check is inside the tx)
 */
import { db } from "../../db";
import { inventory, stockItems } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type { HandlerErrorResult, PosSaleItemInput, ValidatedInventoryItem } from "./posSaleTypes";
import { MoneyDecimal, parseMoneyInput } from "../../lib/money";

/** A request amount read as parseFloat read it; NaN when it does not parse. */
function requestNumber(value: unknown): number {
  return parseMoneyInput(String(value))?.toNumber() ?? NaN;
}

/** Input validation assertions for inventory safety. */
export function validateItemsBasic(
  locationId: number | string | null | undefined,
  items: PosSaleItemInput[]
): { error: HandlerErrorResult } | null {
  const parsedLocationId = Number(locationId);
  if (!locationId || isNaN(parsedLocationId)) {
    return { error: { status: 400, body: { message: `Invalid locationId: ${locationId}` } } };
  }
  for (const item of items) {
    if (!item.stockItemId || isNaN(Number(item.stockItemId))) {
      return { error: { status: 400, body: { message: `Invalid stockItemId: ${item.stockItemId}` } } };
    }
    const qty = requestNumber(item.quantity);
    if (isNaN(qty) || !isFinite(qty) || qty <= 0) {
      return {
        error: { status: 400, body: { message: `Invalid quantity for item ${item.stockItemId}: ${item.quantity}` } },
      };
    }
  }
  return null;
}

/**
 * Validate and calculate total. Each line is taken at cents (half up), as the
 * stored sale line is, and the total is their sum, so the voucher equals its
 * lines: 1.3 x 0.35 is 0.46 (the float product 0.45499... gave 0.45).
 */
export function calculateGrandTotal(items: PosSaleItemInput[]): { grandTotal: number } | { error: HandlerErrorResult } {
  let grandTotal = new MoneyDecimal(0);
  for (const item of items) {
    if (!item.stockItemId) {
      return { error: { status: 400, body: { message: "Stock item ID is required for all items" } } };
    }
    const quantity = parseMoneyInput(String(item.quantity));
    const rate = parseMoneyInput(String(item.rate));
    if (!item.quantity || !quantity || quantity.lessThanOrEqualTo(0)) {
      return { error: { status: 400, body: { message: "Quantity must be positive for all items" } } };
    }
    if (!item.rate || !rate || rate.lessThan(0)) {
      return { error: { status: 400, body: { message: "Rate must be non-negative for all items" } } };
    }
    grandTotal = grandTotal.plus(quantity.times(rate).toDecimalPlaces(2));
  }
  return { grandTotal: grandTotal.toNumber() };
}

/**
 * STEP 1a: Validate inventory rows (best-effort pre-check; authoritative check is inside
 * the transaction). Throws Error (same messages as before) on missing inventory / insufficient
 * stock so the route's outer catch block can map them to the correct status codes.
 */
export async function validateInventoryAvailability(
  locationId: number,
  items: PosSaleItemInput[],
  canSellNegativeStock: boolean
): Promise<ValidatedInventoryItem[]> {
  const inventoryValidation: ValidatedInventoryItem[] = [];

  for (const item of items) {
    const [inventoryRecord] = await db
      .select({
        id: inventory.id,
        locationId: inventory.locationId,
        stockItemId: inventory.stockItemId,
        quantity: inventory.quantity,
        averageRate: inventory.averageRate,
        itemName: stockItems.name,
      })
      .from(inventory)
      .leftJoin(stockItems, eq(stockItems.id, inventory.stockItemId))
      .where(and(eq(inventory.locationId, locationId), eq(inventory.stockItemId, item.stockItemId)));

    if (!inventoryRecord) {
      throw new Error(`Inventory not found for item ${item.stockItemId} at location ${locationId}`);
    }

    const currentQty = Number(inventoryRecord.quantity);
    const saleQty = requestNumber(item.quantity);
    const itemDisplayName = inventoryRecord.itemName || `item ${item.stockItemId}`;

    if (currentQty < saleQty && !canSellNegativeStock) {
      throw new Error(`Not enough stock for "${itemDisplayName}". Available: ${currentQty}, requested: ${saleQty}.`);
    }

    inventoryValidation.push({
      item,
      inventoryRecord,
      currentQty,
      saleQty,
      newQty: currentQty - saleQty,
      currentRate: Number(inventoryRecord.averageRate),
    });
  }

  // Sort by stockItemId so all concurrent transactions acquire inventory row locks
  // in the same order — prevents deadlocks when two cashiers sell the same items.
  inventoryValidation.sort((a, b) => a.item.stockItemId - b.item.stockItemId);

  return inventoryValidation;
}
