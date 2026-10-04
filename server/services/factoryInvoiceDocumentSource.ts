import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  normalizePricingMode,
  resultRows,
  safeNumber,
  safeString,
  type CanonicalInvoiceCharge,
  type CanonicalInvoiceDocument,
  type CanonicalInvoiceLine,
} from "./factoryInvoiceDocumentModel";

/** Reads a customer order as it stands now, as a canonical invoice document. */
type HeaderRow = {
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

type LineRow = {
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

type ChargeRow = {
  id: unknown;
  name: unknown;
  amount: unknown;
  charge_type: unknown;
};

export async function buildLiveCanonicalInvoiceDocument(
  orderId: number,
  companyId: number
): Promise<CanonicalInvoiceDocument | null> {
  const headerResult = await db.execute(sql`
    SELECT
      co.id,
      co.company_id,
      co.invoice_number,
      co.order_date,
      co.status,
      co.subtotal_bales,
      co.freight_amount,
      co.other_charges_total,
      co.grand_total,
      co.total_qty_bales,
      co.container_number,
      co.destination,
      co.shipping_company,
      c.legal_name AS customer_name,
      c.code AS customer_code,
      cmp.base_currency
    FROM customer_orders co
    LEFT JOIN customers c ON c.id = co.customer_id
    LEFT JOIN companies cmp ON cmp.id = co.company_id
    WHERE co.id = ${orderId} AND co.company_id = ${companyId}
    LIMIT 1
  `);
  const header = resultRows<HeaderRow>(headerResult)[0];
  if (!header) return null;

  const lineResult = await db.execute(sql`
    SELECT
      col.id,
      col.article_code,
      col.bale_name,
      col.bale_name_ar,
      col.bale_name_fr,
      col.qty,
      col.weight_per_bale,
      col.total_weight,
      col.pricing_mode,
      col.price_per_bale,
      col.price_per_kg,
      col.total_price,
      COALESCE(
        NULLIF((
          SELECT NULLIF(BTRIM(fb.category), '')
          FROM customer_order_bales cob
          INNER JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = co.company_id
          WHERE cob.order_id = col.order_id
            AND UPPER(BTRIM(COALESCE(cob.article_code, fb.article_code, ''))) = UPPER(BTRIM(col.article_code))
            AND NULLIF(BTRIM(fb.category), '') IS NOT NULL
          ORDER BY cob.id
          LIMIT 1
        ), ''),
        fc.name,
        ''
      ) AS category_name,
      COALESCE(
        NULLIF((
          SELECT NULLIF(BTRIM(fb.category_ar), '')
          FROM customer_order_bales cob
          INNER JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = co.company_id
          WHERE cob.order_id = col.order_id
            AND UPPER(BTRIM(COALESCE(cob.article_code, fb.article_code, ''))) = UPPER(BTRIM(col.article_code))
            AND NULLIF(BTRIM(fb.category_ar), '') IS NOT NULL
          ORDER BY cob.id
          LIMIT 1
        ), ''),
        fc.name_ar
      ) AS category_name_ar,
      COALESCE(
        NULLIF((
          SELECT NULLIF(BTRIM(fb.category_fr), '')
          FROM customer_order_bales cob
          INNER JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = co.company_id
          WHERE cob.order_id = col.order_id
            AND UPPER(BTRIM(COALESCE(cob.article_code, fb.article_code, ''))) = UPPER(BTRIM(col.article_code))
            AND NULLIF(BTRIM(fb.category_fr), '') IS NOT NULL
          ORDER BY cob.id
          LIMIT 1
        ), ''),
        fc.name_fr
      ) AS category_name_fr
    FROM customer_order_lines col
    INNER JOIN customer_orders co ON co.id = col.order_id
    LEFT JOIN factory_bale_products fp
      ON fp.company_id = co.company_id
     AND fp.deleted_at IS NULL
     AND UPPER(BTRIM(COALESCE(fp.article_code, ''))) = UPPER(BTRIM(col.article_code))
    LEFT JOIN factory_categories fc
      ON fc.id = fp.category_id
     AND fc.company_id = co.company_id
     AND fc.deleted_at IS NULL
    WHERE col.order_id = ${orderId}
      AND co.company_id = ${companyId}
    ORDER BY UPPER(BTRIM(col.article_code)), col.id
  `);

  const lines = resultRows<LineRow>(lineResult).map((row) => {
    const pricingMode = normalizePricingMode(row.pricing_mode);
    const totalWeight = safeNumber(row.total_weight);
    const totalPrice = safeNumber(row.total_price);
    const storedPerKg = safeNumber(row.price_per_kg);
    const derivedPerKg = totalWeight > 0 ? totalPrice / totalWeight : 0;
    const pricePerKg = storedPerKg > 0 ? storedPerKg : derivedPerKg;
    const pricePerBale = safeNumber(row.price_per_bale);
    return {
      articleCode: safeString(row.article_code),
      productName: safeString(row.bale_name, safeString(row.article_code)),
      productNameAr: row.bale_name_ar == null ? null : safeString(row.bale_name_ar),
      productNameFr: row.bale_name_fr == null ? null : safeString(row.bale_name_fr),
      category: safeString(row.category_name),
      categoryAr: row.category_name_ar == null ? null : safeString(row.category_name_ar),
      categoryFr: row.category_name_fr == null ? null : safeString(row.category_name_fr),
      qty: safeNumber(row.qty),
      weightPerBale: safeNumber(row.weight_per_bale),
      totalWeight,
      pricingMode,
      pricePerBale,
      pricePerKg,
      unitPrice: pricingMode === "per_kg" ? pricePerKg : pricePerBale,
      totalPrice,
    } satisfies CanonicalInvoiceLine;
  });

  const chargeResult = await db.execute(sql`
    SELECT id, name, amount, charge_type
    FROM customer_order_charges
    WHERE order_id = ${orderId}
    ORDER BY id
  `);
  const charges = resultRows<ChargeRow>(chargeResult).map(
    (row) =>
      ({
        id: safeNumber(row.id),
        name: safeString(row.name, "Charge"),
        amount: safeNumber(row.amount),
        chargeType: safeString(row.charge_type, "OTHER"),
      }) satisfies CanonicalInvoiceCharge
  );

  return {
    version: 1,
    orderId: safeNumber(header.id),
    companyId: safeNumber(header.company_id),
    invoiceNumber: safeString(header.invoice_number) || `INV-${String(orderId).padStart(6, "0")}`,
    orderDate: safeString(header.order_date),
    status: safeString(header.status),
    customerName: safeString(header.customer_name, "-"),
    customerCode: safeString(header.customer_code),
    baseCurrency: safeString(header.base_currency, "USD").toUpperCase(),
    containerNumber: safeString(header.container_number),
    destination: safeString(header.destination),
    shippingCompany: safeString(header.shipping_company),
    subtotalBales: safeNumber(header.subtotal_bales),
    freightAmount: safeNumber(header.freight_amount),
    otherChargesTotal: safeNumber(header.other_charges_total),
    grandTotal: safeNumber(header.grand_total),
    totalQtyBales: safeNumber(header.total_qty_bales),
    lines,
    charges,
    frozenAt: null,
  };
}
