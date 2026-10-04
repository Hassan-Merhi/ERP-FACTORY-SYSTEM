import type { FactoryDocumentLanguage } from "./factoryDocumentLanguage";

/** The canonical invoice document every Excel/PDF rendering is built from. */
export interface CanonicalInvoiceLine {
  articleCode: string;
  productName: string;
  productNameAr: string | null;
  productNameFr: string | null;
  category: string;
  categoryAr: string | null;
  categoryFr: string | null;
  qty: number;
  weightPerBale: number;
  totalWeight: number;
  pricingMode: "per_bale" | "per_kg";
  pricePerBale: number;
  pricePerKg: number;
  unitPrice: number;
  totalPrice: number;
}

export interface CanonicalInvoiceCharge {
  id: number;
  name: string;
  amount: number;
  chargeType: string;
}

export interface CanonicalInvoiceDocument {
  version: 1;
  orderId: number;
  companyId: number;
  invoiceNumber: string;
  orderDate: string;
  status: string;
  customerName: string;
  customerCode: string;
  baseCurrency: string;
  containerNumber: string;
  destination: string;
  shippingCompany: string;
  subtotalBales: number;
  freightAmount: number;
  otherChargesTotal: number;
  grandTotal: number;
  totalQtyBales: number;
  lines: CanonicalInvoiceLine[];
  charges: CanonicalInvoiceCharge[];
  frozenAt: string | null;
}

export interface InvoiceRenderOptions {
  hideSelling?: boolean;
  noCharges?: boolean;
  language?: FactoryDocumentLanguage;
}

export function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export function safeString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

export function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePricingMode(value: unknown): "per_bale" | "per_kg" {
  return String(value || "").toLowerCase() === "per_kg" ? "per_kg" : "per_bale";
}
