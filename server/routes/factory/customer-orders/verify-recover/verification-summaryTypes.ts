// Extracted from ./verification-summary.ts to keep that module under the source-size cap.
import { MoneyDecimal, type MoneyInput, toMoney } from "../../../../lib/money";

/** `total` split into `count` decimal strings that add back to `total` exactly. */
export function splitEvenly(total: MoneyInput, count: number): string[] {
  if (count <= 0) return [];
  const exact = toMoney(total);
  const share = exact.dividedBy(count).toDecimalPlaces(6, MoneyDecimal.ROUND_DOWN);
  const last = exact.minus(share.times(count - 1));
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? last : share).toFixed());
}

// Raw-row contracts for the SELECT * queries in this route. The columns are
// snake_case because they come straight from PostgreSQL, and every field is
// optional-or-nullable because the query is deliberately schema-drift tolerant.
export type RawOrderRow = {
  id: number;
  company_id: number;
  customer_id: number | null;
  invoice_number: string | null;
  order_date: string | null;
  proforma_id_used: number | null;
  status: string | null;
  subtotal_bales: string | null;
  freight_amount: string | null;
  other_charges_total: string | null;
  grand_total: string | null;
  total_qty_bales: number | null;
  container_number: string | null;
  shipping_company: string | null;
  container_notes: string | null;
  destination: string | null;
  verified_by_user_id: number | null;
  verified_at: Date | null;
  loading_started_at: Date | null;
  loading_finalized_at: Date | null;
  location_id: number | null;
  deleted_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
};

export type RawOrderLineRow = {
  qty?: number | null;
  article_code?: string | null;
  articleCode?: string | null;
  total_weight?: string | number | null;
  totalWeight?: string | number | null;
  total_price?: string | number | null;
  totalPrice?: string | number | null;
  bale_name?: string | null;
  baleName?: string | null;
};

export type RawProformaLineRow = {
  id?: number | null;
  article_code?: string | null;
  articleCode?: string | null;
  pricing_mode?: string | null;
  pricingMode?: string | null;
  price_per_kg?: string | number | null;
  pricePerKg?: string | number | null;
  product_name?: string | null;
  productName?: string | null;
  quantity?: number | null;
  price_per_bale?: string | null;
  pricePerBale?: string | null;
  created_at?: Date | string | null;
};

export type OrderComparisonRow = {
  articleCode: string;
  productName: string;
  loadedQty: number;
  expectedQty: number;
  diff: number;
  totalWeight: number;
  totalPrice: number;
  pricePerBale: string;
  inProforma: boolean;
  status: string;
  stockQty: number;
  stockTotalWeight: number;
};
