/**
 * Read-only Factory Stock Query. Quantities use the same available-bale
 * exclusions as authoritativeAvailableStock; sales use finalized scans and
 * their persisted price_used, not price-list estimates or invoice totals.
 * No mutation or accounting valuation is performed here.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { getErrorMessage } from "../../../lib/httpHandlers";

type Row = Record<string, unknown>;
const number = (value: unknown) => Number(value ?? 0);
const dateValid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const optionalId = (value: unknown) => {
  if (value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : NaN;
};

export function registerFactoryStockQueryReportRoutes(app: Express) {
  app.get("/api/factory/stock-query-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
      if (!Number.isSafeInteger(companyId) || companyId <= 0) {
        return res.status(400).json({ message: "No company selected" });
      }

      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      const locationId = optionalId(req.query.locationId);
      const customerId = optionalId(req.query.customerId);
      const categoryId = optionalId(req.query.categoryId);
      const container = String(req.query.container ?? "").trim().slice(0, 100);
      if ((from && !dateValid(from)) || (to && !dateValid(to)) ||
          (from && to && from > to) ||
          [locationId, customerId, categoryId].some((id) => Number.isNaN(id))) {
        return res.status(400).json({ message: "Invalid Stock Query filters" });
      }

      const stockLocation = locationId == null ? sql`` : sql`AND fb.erp_location_id = ${locationId}`;
      const saleLocation = locationId == null ? sql`` : sql`AND cob.location_id = ${locationId}`;
      const saleCustomer = customerId == null ? sql`` : sql`AND co.customer_id = ${customerId}`;
      const saleFrom = !from ? sql`` : sql`AND co.order_date >= ${from}::date`;
      const saleTo = !to ? sql`` : sql`AND co.order_date <= ${to}::date`;
      const saleContainer = !container ? sql`` : sql`AND co.container_number = ${container}`;
      const productCategory = categoryId == null ? sql`` : sql`AND p.category_id = ${categoryId}`;

      // The stock query intentionally never dates current stock backwards.
      // Reserved/verified/loaded bales do not count as physically available.
      const [catalogResult, inventoryResult, salesResult, locationResult, customerResult, containerResult] = await Promise.all([
        db.execute(sql`
          SELECT p.id, p.name, p.code, p.article_code AS "articleCode",
                 p.category_id AS "categoryId", COALESCE(c.name, 'Uncategorized') AS "categoryName"
          FROM factory_bale_products p
          LEFT JOIN factory_categories c ON c.id = p.category_id AND c.company_id = p.company_id
          WHERE p.company_id = ${companyId} AND p.deleted_at IS NULL ${productCategory}
          ORDER BY p.name, p.id
        `),
        db.execute(sql`
          SELECT fb.product_id AS "productId", fb.erp_location_id AS "locationId",
                 COALESCE(l.name, 'Unassigned') AS "locationName",
                 COUNT(*)::int AS "bales", COALESCE(SUM(fb.weight_kg::numeric), 0) AS "kg"
          FROM factory_bales fb
          LEFT JOIN locations l ON l.id = fb.erp_location_id AND l.company_id = fb.company_id
          WHERE fb.company_id = ${companyId} AND fb.status = 'IN_STOCK'
            AND fb.deleted_at IS NULL ${stockLocation}
            AND NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = fb.id AND co.company_id = ${companyId}
                AND co.deleted_at IS NULL
                AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
            )
          GROUP BY fb.product_id, fb.erp_location_id, l.name
        `),
        db.execute(sql`
          SELECT p.id AS "productId", co.id AS "orderId",
                 co.invoice_number AS "invoiceNumber", co.order_date::text AS "date",
                 co.container_number AS "containerNumber", co.customer_id AS "customerId",
                 COALESCE(c.legal_name, 'Unknown customer') AS "customerName",
                 COUNT(*)::int AS "qty", COALESCE(SUM(cob.weight::numeric), 0) AS "kg",
                 COALESCE(SUM(cob.price_used::numeric), 0) AS "total"
          FROM customer_order_bales cob
          JOIN customer_orders co ON co.id = cob.order_id
          JOIN factory_bale_products p
            ON p.article_code = cob.article_code AND p.company_id = co.company_id
               AND p.deleted_at IS NULL ${productCategory}
          LEFT JOIN customers c ON c.id = co.customer_id AND c.company_id = co.company_id
          WHERE co.company_id = ${companyId} AND co.status = 'FINALIZED'
            AND co.deleted_at IS NULL ${saleLocation} ${saleCustomer}
            ${saleFrom} ${saleTo} ${saleContainer}
          GROUP BY p.id, co.id, co.invoice_number, co.order_date,
                   co.container_number, co.customer_id, c.legal_name
          ORDER BY co.order_date DESC, co.id DESC, p.id
        `),
        db.execute(sql`SELECT id, name FROM locations WHERE company_id = ${companyId} ORDER BY name`),
        db.execute(sql`SELECT id, legal_name AS name FROM customers WHERE company_id = ${companyId} ORDER BY legal_name`),
        db.execute(sql`
          SELECT DISTINCT container_number AS name FROM customer_orders
          WHERE company_id = ${companyId} AND deleted_at IS NULL AND status = 'FINALIZED'
            AND NULLIF(BTRIM(container_number), '') IS NOT NULL
          ORDER BY name
        `),
      ]);

      const products = resultRows<Row>(catalogResult).map((r) => ({
        id: number(r.id),
        name: String(r.name ?? ""),
        code: String(r.articleCode || r.code || ""),
        categoryId: r.categoryId == null ? null : number(r.categoryId),
        categoryName: String(r.categoryName ?? "Uncategorized"),
        bales: 0,
        kg: 0,
        soldBales: 0,
        soldKg: 0,
        salesValue: 0,
        locations: [] as { id: number | null; name: string; bales: number; kg: number }[],
      }));
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const r of resultRows<Row>(inventoryResult)) {
        const p = byId.get(number(r.productId));
        if (!p) continue;
        const bales = number(r.bales), kg = number(r.kg);
        p.bales += bales;
        p.kg += kg;
        p.locations.push({ id: r.locationId == null ? null : number(r.locationId),
          name: String(r.locationName ?? "Unassigned"), bales, kg });
      }
      const sales = resultRows<Row>(salesResult).map((r) => {
        const qty = number(r.qty), total = number(r.total);
        const productId = number(r.productId);
        const product = byId.get(productId);
        if (product) {
          product.soldBales += qty;
          product.soldKg += number(r.kg);
          product.salesValue += total;
        }
        return {
          productId,
          orderId: number(r.orderId),
          invoiceNumber: String(r.invoiceNumber || `Order #${r.orderId}`),
          date: String(r.date ?? ""),
          containerNumber: r.containerNumber == null ? null : String(r.containerNumber),
          customerId: number(r.customerId),
          customerName: String(r.customerName ?? "Unknown customer"),
          qty, kg: number(r.kg), total,
          pricePerBale: qty ? total / qty : 0,
        };
      });
      const categories = [...new Map(products.map((p) => [p.categoryId ?? 0, {
        id: p.categoryId ?? 0, name: p.categoryName,
      }])).values()].sort((a, b) => a.name.localeCompare(b.name));
      res.json({
        products, sales, categories,
        locations: resultRows<Row>(locationResult).map((r) => ({ id: number(r.id), name: String(r.name) })),
        customers: resultRows<Row>(customerResult).map((r) => ({ id: number(r.id), name: String(r.name) })),
        containers: resultRows<Row>(containerResult).map((r) => String(r.name)),
      });
    } catch (error: unknown) {
      logger.error("Factory stock query report failed", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
