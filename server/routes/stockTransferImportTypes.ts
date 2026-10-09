/** Row shapes of the stock transfer import spreadsheet, parsed and validated. */
export type SpreadsheetCell = string | number | null | undefined;
export type SpreadsheetRow = Record<string, SpreadsheetCell>;

export interface ParsedStockTransferItem {
  rowNum: number;
  barcode: string;
  quantity: number;
  sourceLocation?: string;
}

export interface ValidatedStockTransferItem extends ParsedStockTransferItem {
  sourceLocationId?: number;
  stockItemId?: number;
  stockItemName?: string;
  stockItemUom?: string;
  currentStock?: number;
  remainingStock?: number;
  averageRate?: string | null;
  rate?: string | null;
  error?: string;
  warning?: string;
}
