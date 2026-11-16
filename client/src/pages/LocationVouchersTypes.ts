// Extracted from ./LocationVouchers.tsx to keep that module under the source-size cap.

export interface Transaction {
  date: string;
  particulars: string;
  vchType: string;
  voucherId: number;
  poId?: number;
  inwardQty: number;
  inwardRate: number;
  inwardValue: number;
  outwardQty: number;
  outwardRate: number;
  outwardValue: number;
  closingQty: number;
  closingRate: number;
  closingValue: number;
  isOpeningBalance?: boolean;
  isPOS?: boolean;
  posSellingRate?: number;
  posSellingValue?: number;
}

/** A transaction row in the ledger, or a month-separator marker row. */
export type DisplayRow = Transaction & { _isSeparator?: boolean; _separatorLabel?: string };

export interface LocationVouchersData {
  stockItem: { id: number; code: string; name: string; uom: string };
  location: { id: number; code: string; name: string };
  year: number;
  month: number;
  monthName: string;
  transactions: Transaction[];
  totals: {
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
    closingQty: number;
    closingRate: number;
    closingValue: number;
  };
}

export interface RangeVouchersData {
  stockItem: { id: number; code: string; name: string; uom: string };
  location: { id: number; code: string; name: string };
  startDate: string;
  endDate: string;
  transactions: Transaction[];
  totals: {
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
    closingQty: number;
    closingRate: number;
    closingValue: number;
  };
}
