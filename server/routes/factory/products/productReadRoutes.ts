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
import { factoryBaleProducts } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { registerFactoryProductReadRoutesPart1 } from "./registerFactoryProductReadRoutesPart1";

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
            labelDesignColor: factoryBaleProducts.labelDesignColor,
            name: factoryBaleProducts.name,
            nameAr: factoryBaleProducts.nameAr,
            weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
            categoryId: factoryBaleProducts.categoryId,
            active: factoryBaleProducts.active,
            sellingPrice: factoryBaleProducts.sellingPrice,
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

  registerFactoryProductReadRoutesPart1(app);
}
