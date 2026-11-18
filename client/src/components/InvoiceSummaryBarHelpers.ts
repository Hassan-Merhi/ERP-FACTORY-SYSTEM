// Extracted from ./InvoiceSummaryBar.tsx

export interface OrderLike {
  status: string;
  grandTotal: string;
  totalQtyBales: number;
  totalWeightKg: string;
  proformaExpectedBales?: string;
  loadedNotInProformaBales?: string;
}

export interface Bucket {
  label: string;
  color: string;
  dotColor: string;
  orders: OrderLike[];
}

export function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function sum(orders: OrderLike[], field: "grandTotal" | "totalWeightKg") {
  return orders.reduce((s, o) => s + parseFloat(o[field] || "0"), 0);
}

export function sumBales(orders: OrderLike[]) {
  return orders.reduce((s, o) => s + (o.totalQtyBales || 0), 0);
}

export interface LoadingStats {
  remainingBales: number;
  remainingKg: number;
  remainingPrice: number;
  overloadedBales: number;
  overloadedKg: number;
  overloadedPrice: number;
  underLoadedBales: number;
  underLoadedKg: number;
  underLoadedPrice: number;
  notRequestedBales: number;
  notRequestedKg: number;
  notRequestedPrice: number;
}
