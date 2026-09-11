/**
 * server/services/pos/deductSaleInventory.ts
 *
 * Authoritative in-transaction stock check, row lock, and inventory deduction
 * for one POS sale item.
 */
import { sql } from "drizzle-orm";
import { adjustInventory } from "../../inventoryHelper";
import { inventoryQuantity, inventoryUnitCost, toInventoryDecimal } from "../../lib/inventoryMath";
import { createDatabaseStockMovementAdapter } from "../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../inventory/stockMovementIntegrityService";
import type { DbTransaction } from "../../db";
import { firstRow } from "../../lib/queryResult";
import type { ValidatedInventoryItem } from "./posSaleTypes";

/** The inventory row a sale locks FOR UPDATE before deducting from it. */
type LockedStockRow = { quantity: string; average_rate: string; item_name: string | null };

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export interface LockedInventoryResult {
  lockedQty: number;
  costPrice: number;
}

export async function lockAndDeductInventoryForSaleItem(
  tx: DbTransaction,
  parsedLocationId: number,
  locationId: number,
  validatedItem: ValidatedInventoryItem,
  canSellNegativeStock: boolean,
  companyId: number,
  canonicalSource?: { sourceId: string; idempotencyKey: string }
): Promise<LockedInventoryResult> {
  const { item, currentRate, inventoryRecord, saleQty } = validatedItem;

  const stockLockResult = await tx.execute(sql`
    SELECT i.quantity, i.average_rate, si.name AS item_name
    FROM inventory i
    LEFT JOIN stock_items si ON si.id = i.stock_item_id
    WHERE i.location_id = ${parsedLocationId} AND i.stock_item_id = ${item.stockItemId}
    FOR UPDATE OF i
  `);
  const lockedRow = firstRow<LockedStockRow>(stockLockResult);
  const lockedQuantity = toInventoryDecimal(lockedRow?.quantity);
  const requestedQuantity = toInventoryDecimal(saleQty);

  if (lockedQuantity.lessThan(requestedQuantity) && !canSellNegativeStock) {
    throw new Error(
      `Not enough stock for "${lockedRow?.item_name || inventoryRecord?.itemName || item.stockItemId}". Available: ${lockedQuantity.toString()}, requested: ${requestedQuantity.toString()}.`
    );
  }

  const sourceVoucherId = canonicalSource ? Number(canonicalSource.sourceId) : Number.NaN;
  const attributableVoucherId =
    Number.isSafeInteger(sourceVoucherId) && sourceVoucherId > 0 ? sourceVoucherId : undefined;

  await adjustInventory(
    tx,
    locationId,
    item.stockItemId,
    requestedQuantity.negated().toNumber(),
    companyId,
    undefined,
    attributableVoucherId ? "pos-sale" : undefined,
    attributableVoucherId
  );

  const costPrice = toInventoryDecimal(lockedRow?.average_rate ?? currentRate);

  // Canonical evidence for the stock this sale issued, on the same transaction
  // that deducted it. The unit cost is the locked average rate the sale was
  // costed at, which is what the sale line records too.
  if (canonicalSource) {
    await postStockMovementTx(
      tx,
      {
        companyId,
        stockItemId: item.stockItemId,
        kind: "issue",
        quantity: inventoryQuantity(requestedQuantity),
        unitCost: inventoryUnitCost(costPrice),
        fromLocationId: parsedLocationId,
        occurredAt: new Date().toISOString(),
        source: {
          sourceType: "pos-sale",
          sourceId: canonicalSource.sourceId,
          idempotencyKey: canonicalSource.idempotencyKey,
        },
        // A POS sale may be permitted to go negative by configuration; the
        // journal records what happened rather than re-deciding it.
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }

  return {
    lockedQty: lockedQuantity.toNumber(),
    costPrice: costPrice.toNumber(),
  };
}
