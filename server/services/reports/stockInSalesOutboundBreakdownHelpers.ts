// Extracted from ./stockInSalesOutboundBreakdown.ts
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import Decimal from "decimal.js";
import { inArray, or, type SQL } from "drizzle-orm";
import { stockGroups, stockItems } from "@shared/schema";
import type { StockInSalesReportFilters } from "./stockInSalesReportService";

export interface StockInSalesOutboundMetrics {
  salesOutQty: number;
  salesOutValue: number;
  transferOutQty: number;
  transferOutValue: number;
  otherStockOutQty: number;
  otherStockOutValue: number;
  netSalesQty: number;
}

export interface AggregateRow {
  periodKey: string;
  quantity?: string | number | null;
  value?: string | number | null;
}

export interface MutableBreakdown {
  salesOutQty: Decimal;
  salesOutValue: Decimal;
  transferOutQty: Decimal;
  transferOutValue: Decimal;
  otherStockOutQty: Decimal;
  otherStockOutValue: Decimal;
}

export function addItemFilters(
  conditions: SQL[],
  filters: StockInSalesReportFilters,
  locationCondition?: SQL,
  extra: SQL[] = []
): void {
  if (locationCondition) conditions.push(locationCondition);
  if (filters.stockGroupIds.length > 0) conditions.push(inArray(stockItems.stockGroupId, filters.stockGroupIds));
  if (!filters.search) return;
  conditions.push(
    or(
      punctuationInsensitiveSearch(stockItems.code, filters.search),
      punctuationInsensitiveSearch(stockItems.name, filters.search),
      punctuationInsensitiveSearch(stockGroups.name, filters.search),
      ...extra
    )!
  );
}
