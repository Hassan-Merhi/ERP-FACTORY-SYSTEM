import { sql, type SQL } from "drizzle-orm";

import { resultRows } from "../../../../lib/queryResult";

type SqlExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

type OrderTotalsRow = Record<string, unknown> & {
  updated_at?: Date | string | null;
};

export interface ScannedArticleTotalsPatch {
  line: {
    id: number;
    orderId: number;
    articleCode: string;
    baleName: string;
    baleNameAr: string | null;
    qty: number;
    weightPerBale: string;
    totalWeight: string;
    pricePerBale: string;
    totalPrice: string;
    pricingMode: string;
    pricePerKg: string | null;
  } | null;
  totals: {
    subtotalBales: string;
    freightAmount: string;
    otherChargesTotal: string;
    grandTotal: string;
    totalQtyBales: number;
    updatedAt: Date | string | null;
  };
}

/**
 * Fast path for a single bale add.
 *
 * The scanner already holds the customer_orders row FOR UPDATE before calling
 * this helper, so there is no need for another lock round-trip here. Only the
 * scanned article can have changed. Rebuild that one article from its bales,
 * then derive the order totals from the already-materialized order lines plus
 * the replacement line returned by this statement. This keeps scan work
 * proportional to the affected article instead of re-aggregating every bale
 * and every article group in the loading on every scan.
 */
export async function recalculateOrderTotalsForScannedArticle(
  dbConn: SqlExecutor,
  orderId: number,
  articleCode: string | null | undefined
): Promise<ScannedArticleTotalsPatch> {
  const normalizedArticleCode = String(articleCode || "UNKNOWN").trim() || "UNKNOWN";

  const result = await dbConn.execute(sql`
    WITH target_group AS (
      SELECT
        COALESCE(NULLIF(cob.article_code, ''), 'UNKNOWN') AS article_code,
        COUNT(*)::int AS qty,
        COALESCE(SUM(cob.weight), 0)::numeric AS total_weight,
        COALESCE(SUM(cob.price_used), 0)::numeric AS summed_price,
        COALESCE(MAX(NULLIF(cob.bale_name, '')), COALESCE(NULLIF(cob.article_code, ''), 'UNKNOWN')) AS bale_name,
        MAX(NULLIF(cob.bale_name_ar, '')) AS bale_name_ar
      FROM customer_order_bales cob
      WHERE cob.order_id = ${orderId}
        AND COALESCE(NULLIF(cob.article_code, ''), 'UNKNOWN') = ${normalizedArticleCode}
      GROUP BY COALESCE(NULLIF(cob.article_code, ''), 'UNKNOWN')
    ),
    priced_target AS (
      SELECT
        tg.article_code,
        tg.qty,
        tg.total_weight,
        tg.bale_name,
        tg.bale_name_ar,
        COALESCE(cpl.pricing_mode, 'per_bale') AS pricing_mode,
        cpl.price_per_kg,
        CASE
          WHEN COALESCE(cpl.pricing_mode, 'per_bale') = 'per_kg'
            AND COALESCE(cpl.price_per_kg, 0) > 0
            AND tg.total_weight > 0
          THEN tg.total_weight * cpl.price_per_kg
          ELSE tg.summed_price
        END::numeric AS total_price
      FROM target_group tg
      JOIN customer_orders co ON co.id = ${orderId}
      LEFT JOIN LATERAL (
        SELECT cpl.pricing_mode, cpl.price_per_kg
        FROM customer_proforma_lines cpl
        WHERE cpl.proforma_id = co.proforma_id_used
          AND cpl.article_code = tg.article_code
        ORDER BY cpl.id DESC
        LIMIT 1
      ) cpl ON TRUE
    ),
    deleted_target AS (
      DELETE FROM customer_order_lines
      WHERE order_id = ${orderId}
        AND article_code = ${normalizedArticleCode}
      RETURNING id
    ),
    inserted_target AS (
      INSERT INTO customer_order_lines (
        order_id,
        article_code,
        bale_name,
        bale_name_ar,
        qty,
        weight_per_bale,
        total_weight,
        price_per_bale,
        total_price,
        pricing_mode,
        price_per_kg
      )
      SELECT
        ${orderId},
        pt.article_code,
        pt.bale_name,
        pt.bale_name_ar,
        pt.qty,
        CASE WHEN pt.qty > 0 THEN pt.total_weight / pt.qty ELSE 0 END,
        pt.total_weight,
        CASE WHEN pt.qty > 0 THEN pt.total_price / pt.qty ELSE 0 END,
        pt.total_price,
        pt.pricing_mode,
        pt.price_per_kg
      FROM priced_target pt
      WHERE pt.qty > 0
      RETURNING
        id,
        order_id,
        article_code,
        bale_name,
        bale_name_ar,
        qty,
        weight_per_bale,
        total_weight,
        price_per_bale,
        total_price,
        pricing_mode,
        price_per_kg
    ),
    existing_other_lines AS (
      SELECT
        COALESCE(SUM(col.total_price), 0)::numeric AS subtotal_bales,
        COALESCE(SUM(col.qty), 0)::int AS total_qty_bales
      FROM customer_order_lines col
      WHERE col.order_id = ${orderId}
        AND col.article_code <> ${normalizedArticleCode}
    ),
    order_totals AS (
      SELECT
        (eol.subtotal_bales + COALESCE((SELECT total_price FROM inserted_target LIMIT 1), 0))::numeric AS subtotal_bales,
        (eol.total_qty_bales + COALESCE((SELECT qty FROM inserted_target LIMIT 1), 0))::int AS total_qty_bales
      FROM existing_other_lines eol
    ),
    charges AS (
      SELECT
        COALESCE(SUM(coc.amount) FILTER (WHERE coc.charge_type = 'FREIGHT'), 0)::numeric AS freight_amount,
        COALESCE(SUM(coc.amount) FILTER (WHERE coc.charge_type = 'OTHER'), 0)::numeric AS other_charges_total
      FROM customer_order_charges coc
      WHERE coc.order_id = ${orderId}
    ),
    updated_order AS (
      UPDATE customer_orders co
      SET
        subtotal_bales = ot.subtotal_bales,
        freight_amount = ch.freight_amount,
        other_charges_total = ch.other_charges_total,
        grand_total = ot.subtotal_bales + ch.freight_amount + ch.other_charges_total,
        total_qty_bales = ot.total_qty_bales,
        updated_at = NOW()
      FROM order_totals ot, charges ch
      WHERE co.id = ${orderId}
      RETURNING
        co.subtotal_bales,
        co.freight_amount,
        co.other_charges_total,
        co.grand_total,
        co.total_qty_bales,
        co.updated_at
    )
    SELECT
      uo.subtotal_bales,
      uo.freight_amount,
      uo.other_charges_total,
      uo.grand_total,
      uo.total_qty_bales,
      uo.updated_at,
      it.id AS line_id,
      it.order_id AS line_order_id,
      it.article_code AS line_article_code,
      it.bale_name AS line_bale_name,
      it.bale_name_ar AS line_bale_name_ar,
      it.qty AS line_qty,
      it.weight_per_bale AS line_weight_per_bale,
      it.total_weight AS line_total_weight,
      it.price_per_bale AS line_price_per_bale,
      it.total_price AS line_total_price,
      it.pricing_mode AS line_pricing_mode,
      it.price_per_kg AS line_price_per_kg
    FROM updated_order uo
    LEFT JOIN inserted_target it ON TRUE
  `);

  const row: OrderTotalsRow = resultRows<OrderTotalsRow>(result)[0] || {};

  return {
    line:
      row.line_id == null
        ? null
        : {
            id: Number(row.line_id),
            orderId: Number(row.line_order_id),
            articleCode: String(row.line_article_code || normalizedArticleCode),
            baleName: String(row.line_bale_name || row.line_article_code || normalizedArticleCode),
            baleNameAr: row.line_bale_name_ar == null ? null : String(row.line_bale_name_ar),
            qty: Number(row.line_qty || 0),
            weightPerBale: String(row.line_weight_per_bale ?? "0"),
            totalWeight: String(row.line_total_weight ?? "0"),
            pricePerBale: String(row.line_price_per_bale ?? "0"),
            totalPrice: String(row.line_total_price ?? "0"),
            pricingMode: String(row.line_pricing_mode || "per_bale"),
            pricePerKg: row.line_price_per_kg == null ? null : String(row.line_price_per_kg),
          },
    totals: {
      subtotalBales: String(row.subtotal_bales ?? "0"),
      freightAmount: String(row.freight_amount ?? "0"),
      otherChargesTotal: String(row.other_charges_total ?? "0"),
      grandTotal: String(row.grand_total ?? "0"),
      totalQtyBales: Number(row.total_qty_bales || 0),
      updatedAt: row.updated_at ?? null,
    },
  };
}
