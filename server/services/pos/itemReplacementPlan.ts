import Decimal from "decimal.js";
import { toInventoryDecimal } from "../../lib/inventoryMath";
import { POS_INTERNAL_TOTAL_SALES_OVERRIDE } from "./edit/posEditInternalSymbols";

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
  totalSales: string;
}

export interface PosReplacementEditedLine {
  id?: number;
  stockItemId: number;
  quantity: string;
  sellingPrice: string;
  /** Exact rounded amount allocated from the original sale line. */
  totalSales?: string;
  [POS_INTERNAL_TOTAL_SALES_OVERRIDE]?: true;
}

/**
 * Split sale lines for a replacement without changing what the customer paid.
 *
 * The remaining portion keeps the original sales_item id so the normal POS
 * edit flow preserves its historical cost. Replacement portions deliberately
 * have no id, which makes rebuildSaleItems cost the new item from current stock.
 *
 * Rounded line revenue is allocated across split portions and forced to sum to
 * the original stored totalSales. This avoids a 0.03 line becoming 0.04 after a
 * 0.5/0.5 split due to independent cent rounding.
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
        totalSales: originalItem.totalSales,
        [POS_INTERNAL_TOTAL_SALES_OVERRIDE]: true,
      });
      continue;
    }

    const originalQty = toInventoryDecimal(originalItem.quantity);
    const replaceQty = lineReplacements.reduce(
      (sum, row) => sum.plus(toInventoryDecimal(row.quantity)),
      toInventoryDecimal(0)
    );
    const remainingQty = originalQty.minus(replaceQty);

    const segments: Array<Omit<PosReplacementEditedLine, "totalSales">> = [];
    if (remainingQty.isPositive()) {
      segments.push({
        id: originalItem.id,
        stockItemId: originalItem.stockItemId,
        quantity: remainingQty.toString(),
        sellingPrice: originalItem.sellingPrice,
        [POS_INTERNAL_TOTAL_SALES_OVERRIDE]: true,
      });
    }

    for (const replacement of lineReplacements) {
      segments.push({
        stockItemId: replacement.replacementStockItemId,
        quantity: toInventoryDecimal(replacement.quantity).toString(),
        sellingPrice: originalItem.sellingPrice,
        [POS_INTERNAL_TOTAL_SALES_OVERRIDE]: true,
      });
      replacedQuantity = replacedQuantity.plus(toInventoryDecimal(replacement.quantity));
    }

    const originalRoundedTotal = toInventoryDecimal(originalItem.totalSales);
    let allocated = new Decimal(0);
    segments.forEach((segment, index) => {
      let segmentTotal: Decimal;
      if (index === segments.length - 1) {
        segmentTotal = originalRoundedTotal.minus(allocated);
      } else {
        const qty = toInventoryDecimal(segment.quantity);
        segmentTotal = originalRoundedTotal
          .times(qty)
          .dividedBy(originalQty)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        allocated = allocated.plus(segmentTotal);
      }
      editedItems.push({ ...segment, totalSales: segmentTotal.toFixed(2) });
    });
  }

  return { items: editedItems, replacedQuantity: replacedQuantity.toString() };
}
