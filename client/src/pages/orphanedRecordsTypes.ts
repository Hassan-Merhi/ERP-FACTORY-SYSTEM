// Extracted from ./OrphanedRecords.tsx to keep that module under the source-size cap.
export interface OrphanedVoucher {
  id: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  locationId: number | null;
  locationName: string | null;
  totalAmount: string;
  description: string | null;
  createdAt: string;
}

export interface UnbalancedVoucher {
  id: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  locationId: number | null;
  locationName: string | null;
  totalAmount: string;
  description: string | null;
  createdAt: string;
  totalDebits: string;
  totalCredits: string;
  imbalance: string;
}

export interface OrphanedRecordsResponse {
  orphanedVouchers: OrphanedVoucher[];
  unbalancedVouchers: UnbalancedVoucher[];
}

export interface StockGroupArchive {
  id: number;
  companyId: number;
  locationId: number;
  stockGroupId: number;
  locationName: string;
  stockGroupName: string;
  totalQuantity: string;
  totalValue: string;
  itemCount: number;
  archivedBy: string;
  archivedAt: string;
  restoredAt: string | null;
  deletedAt: string | null;
  notes: string | null;
}
