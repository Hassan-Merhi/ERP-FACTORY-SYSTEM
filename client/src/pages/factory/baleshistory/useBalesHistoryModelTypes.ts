// Extracted from ./useBalesHistoryModel.tsx to keep that module under the source-size cap.

interface BaleRecord {
  id: number;
  referenceNumber: string;
  baleCode: string;
  articleCode?: string | null;
  category?: string | null;
  barcodeValue?: string | null;
  productName?: string | null;
  quantity: number;
  weightKg: string;
  status: string;
  mixBatchId?: number | null;
  stockEntryDate?: string | null;
  createdAt?: string | null;
}

interface BaleProduct {
  name?: string | null;
  articleCode?: string | null;
  sellingPrice?: string | null;
}

export interface BaleRow {
  bale: BaleRecord;
  product?: BaleProduct | null;
  mixBatch?: { name?: string | null } | null;
  lastPrintedAt?: string | null;
}

export type BalesPage = { items: BaleRow[]; total: number; page: number; limit: number; totalPages: number };
