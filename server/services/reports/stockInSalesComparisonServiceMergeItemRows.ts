// Extracted from ./stockInSalesComparisonService.ts
import {
  ZERO,
  decimal,
  type ItemAggregateRow,
  type MutableItemMetrics,
} from "./stockInSalesComparisonServiceLoadAdjustmentItemRows";

export function mergeItemRows(target: Map<number, MutableItemMetrics>, rows: ItemAggregateRow[]): void {
  for (const row of rows) {
    const current = target.get(row.stockItemId) ?? {
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      stockInQty: ZERO,
      stockInValue: ZERO,
      stockOutQty: ZERO,
      stockOutValue: ZERO,
      totalSales: ZERO,
      costOfSales: ZERO,
      costProfit: ZERO,
    };
    current.stockInQty = current.stockInQty.plus(decimal(row.stockInQty));
    current.stockInValue = current.stockInValue.plus(decimal(row.stockInValue));
    current.stockOutQty = current.stockOutQty.plus(decimal(row.stockOutQty));
    current.stockOutValue = current.stockOutValue.plus(decimal(row.stockOutValue));
    current.totalSales = current.totalSales.plus(decimal(row.totalSales));
    current.costOfSales = current.costOfSales.plus(decimal(row.costOfSales));
    current.costProfit = current.costProfit.plus(decimal(row.costProfit));
    target.set(row.stockItemId, current);
  }
}
