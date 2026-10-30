/**
 * Container-specific additions to expected items, separate from the reusable
 * customer proforma. Only Admin, Developer and Owner may write/read these edits.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { resultRows } from "../../../../lib/queryResult";
import { parseId } from "../../../../lib/parseId";
import { HttpError, sendHttpError } from "../../../../lib/httpHandlers";
import { recalculateOrderTotalsForScannedArticle } from "../bale-scanning/incrementalTotals";

type OrderRow = { customer_id: number; proforma_id_used: number | null; status: string };
type ProductRow = { article_code: string; name: string | null; selling_price: string | null };
type PriceRow = { article_code: string; price_per_bale: string };
type ExtraLineRow = {
  articleCode: string;
  productName: string;
  expectedQty: number;
  pricePerBale: string;
};

function allowed(req: Request): boolean {
  return ["admin", "developer", "owner"].includes(
    String(req.session.currentRole || req.session.role || "").toLowerCase()
  );
}

async function findOrder(
  executor: Pick<typeof db, "execute">,
  companyId: number,
  orderId: number,
  lock: boolean
): Promise<OrderRow> {
  const rows = resultRows<OrderRow>(await executor.execute(
    lock
      ? sql`SELECT customer_id, proforma_id_used, status FROM customer_orders
            WHERE company_id = ${companyId} AND id = ${orderId} AND deleted_at IS NULL FOR UPDATE`
      : sql`SELECT customer_id, proforma_id_used, status FROM customer_orders
            WHERE company_id = ${companyId} AND id = ${orderId} AND deleted_at IS NULL`
  ));
  if (!rows[0]) throw new HttpError(404, "Container loading not found");
  return rows[0];
}


type ExtraInput = { articleCode: string; quantity: number; pricePerBale?: number | string | null };

function validateExtraItems(raw: unknown): ExtraInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500)
    throw new HttpError(400, "Import must contain between 1 and 500 article rows");
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const item = value as Partial<ExtraInput> | null;
    const code = String(item?.articleCode ?? "").trim().toUpperCase();
    const qty = Number(item?.quantity);
    if (!code || code.length > 100 || !Number.isSafeInteger(qty) || qty < 1 || qty > 100000)
      throw new HttpError(400, `Row ${index + 1}: valid article code and whole-number quantity (1–100000) required`);
    if (seen.has(code)) throw new HttpError(400, `Row ${index + 1}: duplicate article ${code}; combine quantities before importing`);
    seen.add(code);
    if (item?.pricePerBale !== undefined && item.pricePerBale !== null && item.pricePerBale !== "") {
      const price = Number(item.pricePerBale);
      if (!Number.isFinite(price) || price < 0 || price > 99999999 || !/^\d+(?:\.\d{1,4})?$/.test(String(item.pricePerBale)))
        throw new HttpError(400, `Row ${index + 1}: price must be a non-negative amount with at most four decimals`);
      return { articleCode: code, quantity: qty, pricePerBale: price };
    }
    return { articleCode: code, quantity: qty };
  });
}

/**
 * Bulk and manual updates use the same atomic pricing precedence.
 * Explicit manual price (including zero) > customer agreed > catalog selling > 0 pending.
 * All writes are only to this order, never to the source proforma or agreed price list.
 */
async function saveExtraItems(companyId: number, orderId: number, items: ExtraInput[]) {
  return db.transaction(async (tx) => {
    const order = await findOrder(tx, companyId, orderId, true);
    if (!order.proforma_id_used) throw new HttpError(409, "This loading has no linked proforma");
    if (!["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(order.status))
      throw new HttpError(409, "Container items cannot be changed after finalization");

    const codes = sql.join(items.map((item) => sql`${item.articleCode}`), sql`, `);
    const products = resultRows<ProductRow>(await tx.execute(sql`
      SELECT article_code, name, selling_price::text AS selling_price
      FROM factory_bale_products
      WHERE company_id = ${companyId} AND deleted_at IS NULL
        AND UPPER(TRIM(article_code)) IN (${codes})
    `));
    const productMap = new Map(products.map((p) => [p.article_code.trim().toUpperCase(), p]));
    for (const item of items)
      if (!productMap.has(item.articleCode))
        throw new HttpError(404, `Article ${item.articleCode} not found in this company's product catalog`);

    const prices = resultRows<PriceRow>(await tx.execute(sql`
      SELECT DISTINCT ON (UPPER(TRIM(article_code)))
        article_code, price_per_bale::text AS price_per_bale
      FROM customer_price_lists
      WHERE company_id = ${companyId} AND customer_id = ${order.customer_id}
        AND UPPER(TRIM(article_code)) IN (${codes})
      ORDER BY UPPER(TRIM(article_code)), updated_at DESC
    `));
    const agreedMap = new Map(prices.map((p) => [p.article_code.trim().toUpperCase(), Number(p.price_per_bale)]));
    const normalized = items.map((item) => {
      const product = productMap.get(item.articleCode)!;
      const agreed = agreedMap.get(item.articleCode);
      const selling = Number(product.selling_price);
      const price = item.pricePerBale !== undefined && item.pricePerBale !== null
        ? Number(item.pricePerBale)
        : agreed !== undefined && Number.isFinite(agreed) && agreed > 0
          ? agreed
          : Number.isFinite(selling) && selling > 0 ? selling : 0;
      return {
        code: product.article_code.trim(),
        normalizedCode: item.articleCode,
        name: product.name?.trim() || product.article_code.trim(),
        quantity: item.quantity,
        price: price.toFixed(4),
        source: item.pricePerBale !== undefined && item.pricePerBale !== null
          ? "manual" : agreed !== undefined && agreed > 0 ? "agreed" : selling > 0 ? "selling" : "pending",
      };
    });
    const lineValues = sql.join(normalized.map((item) =>
      sql`(${companyId}, ${orderId}, ${item.code}, ${item.name}, ${item.quantity}, ${item.price}::numeric)`), sql`, `);
    const saved = resultRows<ExtraLineRow>(await tx.execute(sql`
      INSERT INTO customer_order_extra_expected_lines
        (company_id, order_id, article_code, product_name, expected_qty, price_per_bale)
      VALUES ${lineValues}
      ON CONFLICT (company_id, order_id, article_code)
      DO UPDATE SET product_name = EXCLUDED.product_name,
        expected_qty = EXCLUDED.expected_qty, price_per_bale = EXCLUDED.price_per_bale,
        updated_at = now()
      RETURNING article_code AS "articleCode", product_name AS "productName",
        expected_qty AS "expectedQty", price_per_bale::text AS "pricePerBale"
    `));

    const priceValues = sql.join(normalized.map((item) =>
      sql`(${item.normalizedCode}, ${item.price}::numeric)`), sql`, `);
    const repriced = resultRows<{ article_code: string }>(await tx.execute(sql`
      UPDATE customer_order_bales b SET price_used = p.price
      FROM (VALUES ${priceValues}) AS p(article_code, price)
      WHERE b.order_id = ${orderId} AND UPPER(TRIM(b.article_code)) = p.article_code
        AND b.price_used IS DISTINCT FROM p.price
      RETURNING b.article_code
    `));
    for (const code of new Set(repriced.map((row) => row.article_code)))
      await recalculateOrderTotalsForScannedArticle(tx, orderId, code);

    return { items: saved, unpricedCount: normalized.filter((item) => item.source === "pending").length };
  });
}

export function registerContainerExtraExpectedLineRoutes(app: Express) {
  app.get("/api/factory/customer-orders/:id/container-extra-items", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!allowed(req)) return res.status(403).json({ message: "Access denied" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const orderId = parseId(req.params.id);
      if (!companyId || orderId === null) return res.status(400).json({ message: "Company and order required" });
      await findOrder(db, companyId, orderId, false);
      const result = await db.execute(sql`
        SELECT article_code AS "articleCode", product_name AS "productName",
               expected_qty AS "expectedQty", price_per_bale::text AS "pricePerBale"
        FROM customer_order_extra_expected_lines
        WHERE company_id = ${companyId} AND order_id = ${orderId}
        ORDER BY article_code
      `);
      return res.json(resultRows<ExtraLineRow>(result));
    } catch (error: unknown) {
      return sendHttpError(res, error);
    }
  });


  app.put("/api/factory/customer-orders/:id/container-extra-items", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!allowed(req)) return res.status(403).json({ message: "Access denied" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const orderId = parseId(req.params.id);
      if (!companyId || orderId === null) return res.status(400).json({ message: "Company and order required" });
      const result = await saveExtraItems(companyId, orderId, validateExtraItems([req.body]));
      return res.json(result.items[0]);
    } catch (error: unknown) {
      return sendHttpError(res, error);
    }
  });

  app.post("/api/factory/customer-orders/:id/container-extra-items/import", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!allowed(req)) return res.status(403).json({ message: "Access denied" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const orderId = parseId(req.params.id);
      if (!companyId || orderId === null) return res.status(400).json({ message: "Company and order required" });
      const result = await saveExtraItems(companyId, orderId, validateExtraItems(req.body?.items));
      return res.json({ imported: result.items.length, unpricedCount: result.unpricedCount, items: result.items });
    } catch (error: unknown) {
      return sendHttpError(res, error);
    }
  });

  app.delete("/api/factory/customer-orders/:id/container-extra-items/:articleCode", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!allowed(req)) return res.status(403).json({ message: "Access denied" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      const orderId = parseId(req.params.id);
      const articleCode = String(req.params.articleCode ?? "").trim().toUpperCase();
      if (!companyId || orderId === null || !articleCode)
        return res.status(400).json({ message: "Company, order and article required" });
      const deleted = await db.transaction(async (tx) => {
        const order = await findOrder(tx, companyId, orderId, true);
        if (!["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(order.status))
          throw new HttpError(409, "Container items cannot be changed after finalization");
        const removed = resultRows<{ id: number }>(await tx.execute(sql`
          DELETE FROM customer_order_extra_expected_lines
          WHERE company_id = ${companyId} AND order_id = ${orderId}
            AND UPPER(TRIM(article_code)) = ${articleCode}
          RETURNING id
        `));
        if (!removed.length) return removed;

        // Restore the original proforma price for this article if it belongs
        // to the master. Removing a supplement must remove its price override.
        if (order.proforma_id_used) {
          const restoredBales = resultRows<{ article_code: string }>(await tx.execute(sql`
            UPDATE customer_order_bales cob
            SET price_used = CASE
              WHEN COALESCE(master.pricing_mode, 'per_bale') = 'per_kg'
                AND COALESCE(master.price_per_kg, 0) > 0
              THEN ROUND(COALESCE(cob.weight, 0)::numeric * master.price_per_kg::numeric, 2)
              ELSE COALESCE(master.price_per_bale, 0)::numeric
            END
            FROM LATERAL (
              SELECT cpl.pricing_mode, cpl.price_per_kg, cpl.price_per_bale
              FROM customer_proforma_lines cpl
              WHERE cpl.proforma_id = ${order.proforma_id_used}
                AND UPPER(TRIM(cpl.article_code)) = ${articleCode}
              ORDER BY cpl.id DESC LIMIT 1
            ) master
            WHERE cob.order_id = ${orderId}
              AND UPPER(TRIM(cob.article_code)) = ${articleCode}
            RETURNING cob.article_code
          `));
          for (const code of new Set(restoredBales.map((row) => row.article_code))) {
            await recalculateOrderTotalsForScannedArticle(tx, orderId, code);
          }
        }
        return removed;
      });
      if (!deleted.length) return res.status(404).json({ message: "Extra item not found" });
      return res.json({ deleted: true });
    } catch (error: unknown) {
      return sendHttpError(res, error);
    }
  });
}
