/**
 * factoryProductsRoutes: FactoryProductRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  factoryBales,
  customerOrders,
  customerOrderBales,
  customers,
  locations,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";

export function registerFactoryProductReadRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 3. Factory Bale Products CRUD + Import
  // ───────────────────────────────────────────────

  app.get("/api/factory/bale-products", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const where = and(eq(factoryBaleProducts.companyId, companyId), isNull(factoryBaleProducts.deletedAt));
      if (req.query.profile === "picker") {
        const results = await db
          .select({
            id: factoryBaleProducts.id,
            code: factoryBaleProducts.code,
            articleCode: factoryBaleProducts.articleCode,
            name: factoryBaleProducts.name,
            nameAr: factoryBaleProducts.nameAr,
            nameFr: factoryBaleProducts.nameFr,
            weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
            categoryId: factoryBaleProducts.categoryId,
            active: factoryBaleProducts.active,
          })
          .from(factoryBaleProducts)
          .where(where)
          .orderBy(factoryBaleProducts.id);
        return res.json(results);
      }

      const results = await db.select().from(factoryBaleProducts).where(where).orderBy(factoryBaleProducts.id);
      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching factory bale products:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bale-products/generate-code", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const grade = req.query.grade as string;
      const gradeToPrefix: Record<string, string> = {
        CREAM: "HMD10",
        "#1": "HMD11",
        "#2": "HMD12",
        "#3": "HMD13",
        "#4": "HMD14",
        Garbage: "HMD16",
      };

      if (!grade || !gradeToPrefix[grade]) {
        return res.status(400).json({ message: "Valid grade is required (CREAM, #1, #2, #3, #4, Garbage)" });
      }

      const prefix = gradeToPrefix[grade];
      const prefixLen = prefix.length;
      const [maxResult] = await db
        .select({
          maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${factoryBaleProducts.articleCode} FROM ${prefixLen + 1}) AS INTEGER)), 0)`,
        })
        .from(factoryBaleProducts)
        .where(
          and(
            eq(factoryBaleProducts.companyId, companyId),
            sql`${factoryBaleProducts.articleCode} LIKE ${prefix + "%"}`,
            sql`SUBSTRING(${factoryBaleProducts.articleCode} FROM ${prefixLen + 1}) ~ '^[0-9]+$'`
          )
        );

      let nextNum = (maxResult?.maxNum || 0) + 1;
      let candidateCode = `${prefix}${String(nextNum).padStart(3, "0")}`;
      let attempts = 0;
      while (attempts < 100) {
        const candidateCodeClean = candidateCode
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase()
          .substring(0, 50);
        const [dupArticle] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, candidateCode)));
        const [dupCode] = await db
          .select({ id: factoryBaleProducts.id })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.code, candidateCodeClean)));
        if (!dupArticle && !dupCode) break;
        nextNum++;
        candidateCode = `${prefix}${String(nextNum).padStart(3, "0")}`;
        attempts++;
      }

      res.json({ articleCode: candidateCode });
    } catch (error: unknown) {
      logger.error("Error generating article code:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/bale-products/merge-stats — must be before /:id to avoid interception
  app.get("/api/factory/bale-products/merge-stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db.execute(sql`
        SELECT
          fbp.id,
          fbp.code,
          fbp.article_code AS "articleCode",
          fbp.name,
          fbp.name_ar AS "nameAr",
          fbp.active,
          fbp.category_id AS "categoryId",
          COUNT(fb.id) FILTER (WHERE fb.status NOT IN ('REMOVED','DELETED')) AS "totalBales",
          COUNT(fb.id) FILTER (WHERE fb.status = 'IN_STOCK') AS "inStockBales"
        FROM factory_bale_products fbp
        LEFT JOIN factory_bales fb ON fb.product_id = fbp.id AND fb.company_id = ${companyId}
        WHERE fbp.company_id = ${companyId}
        GROUP BY fbp.id, fbp.code, fbp.article_code, fbp.name, fbp.name_ar, fbp.active, fbp.category_id
        ORDER BY fbp.id ASC
      `);

      res.json(rows.rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bale-products/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(404).json({ message: "Product not found" });
      const [product] = await db
        .select()
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)));

      if (!product) return res.status(404).json({ message: "Product not found" });
      res.json(product);
    } catch (error: unknown) {
      logger.error("Error fetching factory bale product:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bale-product-detail/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const productId = parseId(req.params.productId);
      if (productId === null) return res.status(400).json({ message: "Invalid id" });
      if (!productId) return res.status(400).json({ message: "Invalid product ID" });

      const [product] = await db
        .select()
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));
      if (!product) return res.status(404).json({ message: "Product not found" });

      const articleCode = product.articleCode;

      // 1. Pressed/Printed: bales grouped by entry date
      const allBales = await db
        .select({
          createdAt: factoryBales.createdAt,
          pressedAt: factoryBales.pressedAt,
          weightKg: factoryBales.weightKg,
          totalCost: factoryBales.totalCost,
          status: factoryBales.status,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.productId, productId),
            inArray(factoryBales.status, ["IN_STOCK", "SOLD", "REMOVED", "DELETED", "DISPATCHED"])
          )
        )
        .orderBy(factoryBales.createdAt);

      const pressedMap = new Map<string, { date: string; qty: number; totalWeight: number; totalCost: number }>();
      for (const bale of allBales) {
        const dateKey = ((bale.pressedAt || bale.createdAt) as Date).toISOString().split("T")[0];
        const existing = pressedMap.get(dateKey) || { date: dateKey, qty: 0, totalWeight: 0, totalCost: 0 };
        existing.qty += 1;
        existing.totalWeight += parseFloat(bale.weightKg) || 0;
        existing.totalCost += parseFloat(bale.totalCost) || 0;
        pressedMap.set(dateKey, existing);
      }
      const pressed = Array.from(pressedMap.values()).sort((a, b) => b.date.localeCompare(a.date));

      // 2. Sales: finalized orders for this article code
      const sales = [];
      // 3. Loaded/OTW: loading-status orders for this article code
      const loaded = [];

      if (articleCode) {
        const orderBalesForProduct = await db
          .select({
            orderId: customerOrderBales.orderId,
            weight: customerOrderBales.weight,
            priceUsed: customerOrderBales.priceUsed,
          })
          .from(customerOrderBales)
          .where(eq(customerOrderBales.articleCode, articleCode));

        if (orderBalesForProduct.length > 0) {
          const orderIds = [...new Set(orderBalesForProduct.map((b) => b.orderId))];

          const allRelevantOrders = await db
            .select({
              id: customerOrders.id,
              invoiceNumber: customerOrders.invoiceNumber,
              orderDate: customerOrders.orderDate,
              customerId: customerOrders.customerId,
              status: customerOrders.status,
              containerNumber: customerOrders.containerNumber,
            })
            .from(customerOrders)
            .where(and(eq(customerOrders.companyId, companyId), inArray(customerOrders.id, orderIds)));

          for (const order of allRelevantOrders) {
            const balesInOrder = orderBalesForProduct.filter((b) => b.orderId === order.id);
            const qty = balesInOrder.length;
            const total = balesInOrder.reduce((s: number, b) => s + parseFloat(b.priceUsed || "0"), 0);
            const pricePerBale = qty > 0 ? total / qty : 0;

            const [customer] = await db
              .select({ legalName: customers.legalName })
              .from(customers)
              .where(eq(customers.id, order.customerId));

            const entry = {
              orderId: order.id,
              invoiceNumber: order.invoiceNumber || `Order #${order.id}`,
              orderDate: order.orderDate,
              containerNumber: order.containerNumber,
              customerName: customer?.legalName || "Unknown",
              qty,
              pricePerBale: pricePerBale.toFixed(2),
              total: total.toFixed(2),
              status: order.status,
            };

            if (order.status === "FINALIZED") {
              sales.push(entry);
            } else if (["LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(order.status)) {
              loaded.push(entry);
            }
          }

          sales.sort((a, b) => b.orderDate.localeCompare(a.orderDate));
          loaded.sort((a, b) => b.orderDate.localeCompare(a.orderDate));
        }
      }

      // Current stock: IN_STOCK + FINALIZED bales grouped by location
      const inStockBales = await db
        .select({
          id: factoryBales.id,
          weightKg: factoryBales.weightKg,
          erpLocationId: factoryBales.erpLocationId,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.productId, productId),
            eq(factoryBales.status, "IN_STOCK")
          )
        );

      const locStockMap = new Map<
        number,
        { locationId: number; locationName: string; qty: number; totalWeight: number }
      >();
      for (const bale of inStockBales) {
        const locId = bale.erpLocationId ?? 0;
        const existing = locStockMap.get(locId) ?? {
          locationId: locId,
          locationName: "Unknown",
          qty: 0,
          totalWeight: 0,
        };
        existing.qty += 1;
        existing.totalWeight += parseFloat(bale.weightKg) || 0;
        locStockMap.set(locId, existing);
      }
      const locIds = [...locStockMap.keys()].filter((id) => id > 0);
      if (locIds.length > 0) {
        const locRecords = await db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locIds));
        for (const loc of locRecords) {
          const entry = locStockMap.get(loc.id);
          if (entry) entry.locationName = loc.name;
        }
      }
      const currentStock = {
        totalQty: inStockBales.length,
        totalWeight: inStockBales.reduce((s, b) => s + (parseFloat(b.weightKg) || 0), 0),
        locations: Array.from(locStockMap.values()).sort((a, b) => b.qty - a.qty),
      };

      return res.json({ product, pressed, sales, loaded, currentStock });
    } catch (error: unknown) {
      logger.error("Error fetching bale product detail:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
