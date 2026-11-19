// Extracted from ./factoryInvoiceDocumentSource.ts

/** Reads a customer order as it stands now, as a canonical invoice document. */
export type HeaderRow = {
  id: unknown;
  company_id: unknown;
  invoice_number: unknown;
  order_date: unknown;
  status: unknown;
  subtotal_bales: unknown;
  freight_amount: unknown;
  other_charges_total: unknown;
  grand_total: unknown;
  total_qty_bales: unknown;
  container_number: unknown;
  destination: unknown;
  shipping_company: unknown;
  customer_name: unknown;
  customer_code: unknown;
  base_currency: unknown;
};

export type LineRow = {
  id: unknown;
  article_code: unknown;
  bale_name: unknown;
  bale_name_ar: unknown;
  bale_name_fr: unknown;
  qty: unknown;
  weight_per_bale: unknown;
  total_weight: unknown;
  pricing_mode: unknown;
  price_per_bale: unknown;
  price_per_kg: unknown;
  total_price: unknown;
  category_name: unknown;
  category_name_ar: unknown;
  category_name_fr: unknown;
};

export type ChargeRow = {
  id: unknown;
  name: unknown;
  amount: unknown;
  charge_type: unknown;
};
