/** Company-scoped monthly bale-production matrix and shared row order. */
import type { Express, Request, Response } from "express";
import { sql, eq } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { factorySettings } from "@shared/schema";
import { authorizeFactoryPageAccess, sendFactoryAccessDenied } from "../../../lib/factoryAccessControl";
import { mergeActiveMatrixOrder } from "./monthly-production-order";

type DbRow = Record<string, unknown>;
const number = (value: unknown) => Number(value ?? 0);
const companyFor = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId);
const validCompany = (id: number) => Number.isSafeInteger(id) && id > 0;
const getSavedOrder = (extra: unknown): number[] => {
  const raw = (extra && typeof extra === "object" && !Array.isArray(extra)
    ? (extra as Record<string, unknown>).monthlyProductionRowOrder : null);
  return Array.isArray(raw) ? raw.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
};

export function registerFactoryMonthlyProductionMatrixRoutes(app: Express) {
  app.get("/api/factory/monthly-production-matrix", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyFor(req);
    if (!validCompany(companyId)) return res.status(400).json({ message: "No company selected" });
    const access = await authorizeFactoryPageAccess(req, "factory/monthly-production-matrix");
    if (!access.allowed) return sendFactoryAccessDenied(res, access);
    try {
      const [productsResult, monthlyResult, settings] = await Promise.all([
        db.execute(sql`
          SELECT p.id, p.name, p.article_code AS "articleCode",
                 COALESCE(c.name, 'Uncategorized') AS "categoryName"
          FROM factory_bale_products p
          LEFT JOIN factory_categories c ON c.id = p.category_id AND c.company_id = p.company_id
          WHERE p.company_id = ${companyId} AND p.deleted_at IS NULL AND p.active = TRUE
          ORDER BY p.name, p.id
        `),
        db.execute(sql`
          SELECT p.id AS "productId",
                 TO_CHAR(DATE_TRUNC('month', COALESCE(b.stock_entry_date::date, b.created_at::date)), 'YYYY-MM') AS month,
                 COUNT(*)::int AS quantity
          FROM factory_bales b
          JOIN factory_bale_products p ON p.company_id = b.company_id AND p.deleted_at IS NULL AND p.active = TRUE
            AND (p.id = b.product_id OR (b.product_id IS NULL AND p.article_code = b.article_code))
          WHERE b.company_id = ${companyId}
            AND b.deleted_at IS NULL
            AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')
          GROUP BY p.id, DATE_TRUNC('month', COALESCE(b.stock_entry_date::date, b.created_at::date))
          ORDER BY month, p.id
        `),
        db.select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings).where(eq(factorySettings.companyId, companyId)).limit(1),
      ]);
      res.set("Cache-Control", "private, no-store");
      return res.json({
        products: resultRows<DbRow>(productsResult).map((row) => ({
          id: number(row.id), name: String(row.name ?? ""),
          articleCode: String(row.articleCode ?? ""), categoryName: String(row.categoryName ?? ""),
        })),
        monthly: resultRows<DbRow>(monthlyResult).map((row) => ({
          productId: number(row.productId), month: String(row.month), quantity: number(row.quantity),
        })),
        rowOrder: getSavedOrder(settings[0]?.extraSettings),
      });
    } catch (error: unknown) {
      logger.error("Monthly production matrix read failed", { error });
      return res.status(500).json({ message: "Unable to load monthly production" });
    }
  });

  app.put("/api/factory/monthly-production-matrix/order", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyFor(req);
    if (!validCompany(companyId)) return res.status(400).json({ message: "No company selected" });
    const access = await authorizeFactoryPageAccess(req, "factory/monthly-production-matrix");
    if (!access.allowed) return sendFactoryAccessDenied(res, access);
    const ids: unknown = req.body?.productIds;
    if (!Array.isArray(ids) || ids.length > 20000 ||
        ids.some((id: unknown) => !Number.isSafeInteger(id) || (id as number) <= 0) ||
        new Set(ids).size !== ids.length) {
      return res.status(400).json({ message: "Invalid product ordering" });
    }
    try {
      const [knownResult, existingSettings] = await Promise.all([
        db.execute(sql`
          SELECT id, active FROM factory_bale_products
          WHERE company_id = ${companyId} AND deleted_at IS NULL
          ORDER BY name, id
        `),
        db.select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings).where(eq(factorySettings.companyId, companyId)).limit(1),
      ]);
      const known = resultRows<DbRow>(knownResult);
      const knownIds = new Set(known.map((row) => number(row.id)));
      const activeIds = new Set(known.filter((row) => row.active === true).map((row) => number(row.id)));
      if (!ids.every((id: number) => activeIds.has(id))) {
        return res.status(400).json({ message: "Ordering includes an inactive or foreign product" });
      }
      // A hidden inactive item stays in its previous slot. Reactivating it will
      // restore its placement without showing it while inactive.
      const rowOrder = mergeActiveMatrixOrder(
        ids as number[],
        getSavedOrder(existingSettings[0]?.extraSettings),
        activeIds,
        knownIds
      );
      // Atomically merge this layout key, preserving unrelated Factory settings.
      const patch = JSON.stringify({ monthlyProductionRowOrder: rowOrder });
      await db.insert(factorySettings).values({
        companyId, extraSettings: { monthlyProductionRowOrder: rowOrder },
      }).onConflictDoUpdate({
        target: factorySettings.companyId,
        set: {
          extraSettings: sql`COALESCE(${factorySettings.extraSettings}, '{}'::jsonb) || ${patch}::jsonb`,
          updatedAt: new Date(),
        },
      });
      res.set("Cache-Control", "private, no-store");
      return res.json({ rowOrder });
    } catch (error: unknown) {
      logger.error("Monthly production matrix order save failed", { error });
      return res.status(500).json({ message: "Unable to save shared item order" });
    }
  });
}
