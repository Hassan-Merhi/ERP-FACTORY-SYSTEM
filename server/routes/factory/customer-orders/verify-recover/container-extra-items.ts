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
type ProductRow = { article_code: string; name: string | null };
type PriceRow = { price_per_bale: string };
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
      const requestedCode = String(req.body?.articleCode ?? "").trim().toUpperCase();
      const quantity = Number(req.body?.quantity);
      if (!companyId || orderId === null) return res.status(400).json({ message: "Company and order required" });
      if (!requestedCode || requestedCode.length > 100 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000)
        return res.status(400).json({ message: "Select an article and enter a positive whole-number quantity" });

      const saved = await db.transaction(async (tx) => {
        const order = await findOrder(tx, companyId, orderId, true);
        if (!order.proforma_id_used)
          throw new HttpError(409, "This loading has no linked proforma");
        if (!["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(order.status))
          throw new HttpError(409, "Container items cannot be changed after finalization");

        // Canonical catalog lookup also blocks arbitrary/foreign-company items.
        const products = resultRows<ProductRow>(await tx.execute(sql`
          SELECT article_code, name FROM factory_bale_products
          WHERE company_id = ${companyId} AND deleted_at IS NULL
            AND UPPER(TRIM(article_code)) = ${requestedCode}
          LIMIT 1
        `));
        const product = products[0];
        if (!product) throw new HttpError(404, "Article not found in this company's product catalog");

        const prices = resultRows<PriceRow>(await tx.execute(sql`
          SELECT price_per_bale::text AS price_per_bale
          FROM customer_price_lists
          WHERE company_id = ${companyId} AND customer_id = ${order.customer_id}
            AND UPPER(TRIM(article_code)) = ${requestedCode}
          ORDER BY updated_at DESC LIMIT 1
        `));
        const agreedPrice = prices[0]?.price_per_bale;
        if (agreedPrice == null || !Number.isFinite(Number(agreedPrice)) || Number(agreedPrice) <= 0)
          throw new HttpError(409, "No saved agreed price for this customer and article. Save the price first.");

        const storedCode = product.article_code.trim().toUpperCase();
        const itemName = product.name?.trim() || storedCode;
        const row = resultRows<ExtraLineRow>(await tx.execute(sql`
          INSERT INTO customer_order_extra_expected_lines
            (company_id, order_id, article_code, product_name, expected_qty, price_per_bale)
          VALUES (${companyId}, ${orderId}, ${storedCode}, ${itemName}, ${quantity}, ${agreedPrice})
          ON CONFLICT (company_id, order_id, article_code)
          DO UPDATE SET
            product_name = EXCLUDED.product_name,
            expected_qty = EXCLUDED.expected_qty,
            price_per_bale = EXCLUDED.price_per_bale,
            updated_at = now()
          RETURNING article_code AS "articleCode", product_name AS "productName",
                    expected_qty AS "expectedQty", price_per_bale::text AS "pricePerBale"
        `))[0];

        // Previously scanned bales in THIS loading also adopt the saved agreed
        // rate. Recalculate the one article and order/daybook totals atomically.
        const repriced = resultRows<{ id: number }>(await tx.execute(sql`
          UPDATE customer_order_bales SET price_used = ${agreedPrice}
          WHERE order_id = ${orderId}
            AND UPPER(TRIM(article_code)) = ${storedCode}
            AND price_used IS DISTINCT FROM ${agreedPrice}::numeric
          RETURNING id
        `));
        if (repriced.length > 0) await recalculateOrderTotalsForScannedArticle(tx, orderId, product.article_code);
        return row;
      });
      return res.json(saved);
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
        return resultRows<{ id: number }>(await tx.execute(sql`
          DELETE FROM customer_order_extra_expected_lines
          WHERE company_id = ${companyId} AND order_id = ${orderId}
            AND UPPER(TRIM(article_code)) = ${articleCode}
          RETURNING id
        `));
      });
      if (!deleted.length) return res.status(404).json({ message: "Extra item not found" });
      return res.json({ deleted: true });
    } catch (error: unknown) {
      return sendHttpError(res, error);
    }
  });
}
