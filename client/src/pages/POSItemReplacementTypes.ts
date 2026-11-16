// Extracted from ./POSItemReplacement.tsx to keep that module under the source-size cap.

export interface Location {
  id: number;
  name: string;
  code?: string | null;
  active?: boolean;
  deletedAt?: string | null;
}

export interface StockItem {
  id: number;
  name: string;
  code: string;
  active?: boolean;
}

export interface ReplacementCandidate {
  saleItemId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  description: string | null;
  locationId: number | null;
  shiftId: number | null;
  isCreditSale: boolean | null;
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  quantity: string;
  sellingPrice: string;
  totalSales: string;
}

export interface CandidateResponse {
  rows: ReplacementCandidate[];
  count: number;
  capped: boolean;
}

export interface LastSoldPriceResponse {
  sellingPrice: string | null;
}

export interface ReplacementResult {
  message: string;
  updatedVoucherIds: number[];
  replacedQuantity: string;
  replacementsApplied: number;
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function initialDateRange(): { from: string; to: string } {
  const today = new Date();
  return {
    from: localDateString(new Date(today.getFullYear(), today.getMonth(), 1)),
    to: localDateString(today),
  };
}

export function displayQty(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function displayMoney(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
