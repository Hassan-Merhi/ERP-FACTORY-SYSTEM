// Extracted from ./StockItemVouchers.tsx

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

export interface VouchersData {
  stockItem: {
    id: number;
    code: string;
    name: string;
    uom: string;
  };
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
