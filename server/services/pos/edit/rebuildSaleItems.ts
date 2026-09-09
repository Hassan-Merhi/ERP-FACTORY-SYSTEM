/**
 * server/services/pos/edit/rebuildSaleItems.ts
 *
 * PHASE 20 structural split — moved from server/routes/pos/posEditSaleRoutes.ts.
 */
import type { DbTransaction } from "../../../db";
import { salesItems, inventory, stockItemLocationPrices } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";
import { POS_INTERNAL_TOTAL_SALES_OVERRIDE } from "./posEditInternalSymbols";
const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../../lib/inventoryMath";

export interface RebuildSaleItemsResult {
  grandTotal: number;
  totalSupplierCostEdit: number;
  totalQtySoldEdit: number;
}

export async function rebuildSaleItems(
  tx: DbTransaction,
  params: {
    voucherId: number;
    targetLocationId: number;
    items: any[];
    oldItemsMap: Map<number, any>;
    canSellNegativeStock: boolean;
    companyId: number;
    canonicalRevision?: number;
  }
): Promise<RebuildSaleItemsResult> {
  const { voucherId, targetLocationId, items, oldItemsMap, canSellNegativeStock, companyId, canonicalRevision } =
    params;

  const sortedNewItems = [...items].sort(
    (a: { stockItemId: number }, b: { stockItemId: number }) => a.stockItemId - b.stockItemId
  );
  let grandTotal = toInventoryDecimal(0);
  let totalSupplierCostEdit = toInventoryDecimal(0);
  let totalQtySoldEdit = toInventoryDecimal(0);
  const issueOrdinalByStockItem = new Map<number, number>();

  for (const item of sortedNewItems) {
    const { id, stockItemId, quantity, sellingPrice } = item;

    const [inventoryRecord] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.locationId, targetLocationId), eq(inventory.stockItemId, stockItemId)))
      .limit(1);

    const currentQty = toInventoryDecimal(inventoryRecord?.quantity);
    const sellQty = toInventoryDecimal(quantity);

    if (currentQty.lessThan(sellQty) && !canSellNegativeStock) {
      throw new Error(
        `Insufficient stock for item ${stockItemId}. Available: ${currentQty.toString()}, Requested: ${sellQty.toString()}`
      );
    }

    const oldItem = id !== undefined && id > 0 ? oldItemsMap.get(id) : null;
    const costPrice = toInventoryDecimal(oldItem?.costPrice ?? inventoryRecord?.averageRate);
    const effectiveSellingPrice = toInventoryDecimal(sellingPrice);

    // Only trusted in-process callers can preserve an exact historical rounded
    // line total. JSON requests cannot serialize the symbol marker below, so a
    // normal POS edit always derives totalSales from quantity × selling price.
    const totalSales =
      item[POS_INTERNAL_TOTAL_SALES_OVERRIDE] === true && item.totalSales !== undefined && item.totalSales !== null
        ? toInventoryDecimal(item.totalSales)
        : multiplyInventoryValues(sellQty, effectiveSellingPrice);
    const totalCost = multiplyInventoryValues(sellQty, costPrice);
    const profit = subtractInventoryValues(totalSales, totalCost);

    const [editLocPrice] = await tx
      .select()
      .from(stockItemLocationPrices)
      .where(
        and(
          eq(stockItemLocationPrices.stockItemId, stockItemId),
          eq(stockItemLocationPrices.locationId, targetLocationId)
        )
      )
      .limit(1);
    const configuredPrice = toInventoryDecimal(editLocPrice?.sellingPrice);

    await tx.insert(salesItems).values({
      voucherId,
      stockItemId,
      quantity: inventoryQuantity(sellQty),
      sellingPrice: inventoryMoney(effectiveSellingPrice),
      costPrice: inventoryUnitCost(costPrice),
      totalSales: inventoryMoney(totalSales),
      totalCost: inventoryMoney(totalCost),
      profit: inventoryMoney(profit),
      configuredPrice: configuredPrice.isPositive() ? inventoryUnitCost(configuredPrice) : null,
    });

    await adjustInventory(tx, targetLocationId, stockItemId, sellQty.negated().toNumber(), companyId);

    if (canonicalRevision !== undefined && !sellQty.isZero()) {
      const issueOrdinal = (issueOrdinalByStockItem.get(stockItemId) ?? 0) + 1;
      issueOrdinalByStockItem.set(stockItemId, issueOrdinal);
      await postStockMovementTx(
        tx,
        {
          companyId,
          stockItemId,
          kind: "issue",
          quantity: inventoryQuantity(sellQty),
          unitCost: inventoryUnitCost(costPrice),
          fromLocationId: targetLocationId,
          occurredAt: new Date().toISOString(),
          source: {
            sourceType: "pos-sale",
            sourceId: String(voucherId),
            idempotencyKey: `pos-sale:${voucherId}:rev${canonicalRevision}:issue:${stockItemId}:line:${issueOrdinal}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }

    grandTotal = addInventoryValues(grandTotal, totalSales);
    totalSupplierCostEdit = addInventoryValues(totalSupplierCostEdit, totalCost);
    totalQtySoldEdit = addInventoryValues(totalQtySoldEdit, sellQty);
  }

  return {
    grandTotal: grandTotal.toNumber(),
    totalSupplierCostEdit: totalSupplierCostEdit.toNumber(),
    totalQtySoldEdit: totalQtySoldEdit.toNumber(),
  };
}
