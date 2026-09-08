import { toInventoryDecimal } from "../../lib/inventoryMath";

export interface PosItemReplacementInput {
  saleItemId: number;
  replacementStockItemId: number;
  quantity: number;
}

export interface PosReplacementSourceLine {
  id: number;
  stockItemId: number;
  quantity: string;
  sellingPrice: string;
}

export interface PosReplacementEditedLine {
  id?: number;
  stockItemId: number;
  quantity: string;
  sellingPrice: string;
}

/**
 * Split sale lines for a replacement without changing what the customer paid.
 *
 * The remaining portion keeps the original sales_item id so the normal POS
 * edit flow preserves its historical cost. The replacement portion deliberately
 * has no id, which makes rebuildSaleItems cost the new item from current stock.
 */
export function buildPosReplacementSaleItems(
  originalItems: PosReplacementSourceLine[],
  replacementsBySaleItem: Map<number, PosItemReplacementInput[]>
): { items: PosReplacementEditedLine[]; replacedQuantity: string } {
  const editedItems: PosReplacementEditedLine[] = [];
  let replacedQuantity = toInventoryDecimal(0);

  for (const originalItem of originalItems) {
    const lineReplacements = replacementsBySaleItem.get(originalItem.id) || [];
    if (!lineReplacements.length) {
      editedItems.push({
        id: originalItem.id,
        stockItemId: originalItem.stockItemId,
        quantity: originalItem.quantity,
        sellingPrice: originalItem.sellingPrice,
      });
      continue;
    }

    const originalQty = toInventoryDecimal(originalItem.quantity);
    const replaceQty = lineReplacements.reduce(
      (sum, row) => sum.plus(toInventoryDecimal(row.quantity)),
      toInventoryDecimal(0)
    );
    const remainingQty = originalQty.minus(replaceQty);

    if (remainingQty.isPositive()) {
      editedItems.push({
        id: originalItem.id,
        stockItemId: originalItem.stockItemId,
        quantity: remainingQty.toString(),
        sellingPrice: originalItem.sellingPrice,
      });
    }

    for (const replacement of lineReplacements) {
      editedItems.push({
        stockItemId: replacement.replacementStockItemId,
        quantity: toInventoryDecimal(replacement.quantity).toString(),
        sellingPrice: originalItem.sellingPrice,
      });
      replacedQuantity = replacedQuantity.plus(toInventoryDecimal(replacement.quantity));
    }
  }

  return { items: editedItems, replacedQuantity: replacedQuantity.toString() };
}
