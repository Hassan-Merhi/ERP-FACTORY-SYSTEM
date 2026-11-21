// Extracted from ./StockItemHistory.tsx

interface MonthlyData {
  month: number;
  monthName: string;
  inwardQty: number;
  inwardValue: number;
  outwardQty: number;
  outwardValue: number;
  closingQty: number;
  closingValue: number;
}

export interface StockItemSummary {
  stockItem: {
    id: number;
    code: string;
    name: string;
    uom: string;
  };
  year: number;
  monthlyData: MonthlyData[];
  grandTotal: {
    inwardQty: number;
    inwardValue: number;
    outwardQty: number;
    outwardValue: number;
    closingQty: number;
    closingValue: number;
  };
}
