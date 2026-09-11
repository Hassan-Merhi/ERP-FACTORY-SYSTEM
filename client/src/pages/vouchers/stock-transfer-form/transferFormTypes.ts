/**
 * Row shapes the stock transfer form reads back from the transfer endpoints.
 *
 * These describe JSON payloads, not component state, so they carry no
 * dependency on the form model's scope and live here rather than inside the
 * hook body — alongside TransferInventoryItem in ./useTransferFormDerived.
 */

export type TransferRevisionItem = {
  stockItemName?: string;
  sourceLocationName?: string;
  delta?: string;
  originalQuantity?: string;
  newQuantity?: string;
};

export type TransferRevision = {
  id: number;
  revisionNumber?: number;
  revisionDate?: string | Date | null;
  optional?: boolean;
  note?: string | null;
  items?: TransferRevisionItem[];
  _mergedCount?: number;
};

export type StockTransferLineItem = {
  stockItemId: number;
  sourceLocationId: number;
  quantity: string;
  rate?: string;
  stockItemName?: string;
  stockItemCode?: string;
  sourceLocationName?: string;
};

export type ValidatedTransferImportItem = {
  rowNum?: number;
  barcode?: string;
  quantity: string;
  error?: string;
  warning?: string;
  stockItemId?: number;
  stockItemName?: string;
  stockItemUom?: string;
  sourceLocationId?: number;
  currentStock?: number;
  remainingStock?: number;
  averageRate?: string;
  rate?: string;
};

export type TransferImportValidationResult = {
  errors: string[];
  warnings: string[];
  validatedItems: ValidatedTransferImportItem[];
};
