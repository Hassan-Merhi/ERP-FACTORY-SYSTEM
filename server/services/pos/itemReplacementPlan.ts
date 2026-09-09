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

function markTrustedTotal<T extends PosReplacementEditedLine>(row: T): T {
  Object.defineProperty(row, POS_INTERNAL_TOTAL_SALES_OVERRIDE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return row;
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
    const originalQty = toInventoryDecimal(originalItem.quantity);
    const lineReplacements = replacementsBySaleItem.get(originalItem.id) || [];
    if (!lineReplacements.length) {
      // Some historical POS vouchers contain zero-quantity sales_items. The
      // normal POS edit flow rejects quantity 0, so replaying one unchanged
      // makes an otherwise valid item correction fail. Zero-quantity rows have
      // no inventory effect and are safe to omit while rebuilding the voucher.
      if (originalQty.isZero()) {
        continue;
      }

      editedItems.push(
        markTrustedTotal({
          id: originalItem.id,
          stockItemId: originalItem.stockItemId,
          quantity: originalItem.quantity,
          sellingPrice: originalItem.sellingPrice,
          totalSales: originalItem.totalSales,
        })
      );
      continue;
    }

    const replaceQty = lineReplacements.reduce(
      (sum, row) => sum.plus(toInventoryDecimal(row.quantity)),
      toInventoryDecimal(0)
    );
    const remainingQty = originalQty.minus(replaceQty);

    const segments: Array<Omit<PosReplacementEditedLine, "totalSales">> = [];
    // Decimal.js treats +0 as having a positive sign, so isPositive() can admit
    // a zero remainder after a full replacement (for example 1 - 1). Compare
    // numerically instead so the old line is omitted whenever nothing remains.
    if (remainingQty.gt(0)) {
      segments.push({
        id: originalItem.id,
        stockItemId: originalItem.stockItemId,
        quantity: remainingQty.toString(),
        sellingPrice: originalItem.sellingPrice,
      });
    }

    for (const replacement of lineReplacements) {
      segments.push({
        stockItemId: replacement.replacementStockItemId,
        quantity: toInventoryDecimal(replacement.quantity).toString(),
        sellingPrice: originalItem.sellingPrice,
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
      editedItems.push(markTrustedTotal({ ...segment, totalSales: segmentTotal.toFixed(2) }));
    });
  }

  return { items: editedItems, replacedQuantity: replacedQuantity.toString() };
}
