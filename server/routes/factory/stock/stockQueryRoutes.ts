/**
 * factoryStockRoutes: FactoryStockQuery endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBales, customerOrders, customerOrderBales } from "@shared/schema";
import { eq, and, asc, desc, sql, inArray, isNull } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { getAuthoritativeAvailableStockSnapshot } from "../../../services/factory/authoritativeAvailableStock";
import { buildArticleCodeStockCountRecord } from "../../../services/factory/authoritativeStockPatch";

export function registerFactoryStockQueryRoutes(app: Express) {
  app.get("/api/factory/stock-entry/in-stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { locationId } = req.query;

      const conditions = [eq(factoryBales.companyId, companyId), eq(factoryBales.status, "IN_STOCK")];

      if (locationId) {
        conditions.push(eq(factoryBales.erpLocationId, parseInt(locationId as string)));
      }

      const results = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions))
        .orderBy(desc(factoryBales.finalizedAt));

      // Mark bales currently scanned into an active LOADING container order
      const allIds = results.map((b) => b.id);
      const loadingBaleIds = new Set<number>();
      if (allIds.length > 0) {
        const loadingRows = await db
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
          .where(and(eq(customerOrders.status, "LOADING"), inArray(customerOrderBales.baleId, allIds)));
        for (const r of loadingRows) loadingBaleIds.add(r.baleId);
      }

      res.json(results.map((b) => ({ ...b, isInLoadingOrder: loadingBaleIds.has(b.id) })));
    } catch (error: unknown) {
      logger.error("Error fetching in-stock bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/stock-entry/in-stock-locations
  // Returns distinct locations that have at least one IN_STOCK factory bale,
  // including the bale count per location. Used by Ground Scan to auto-scope verification.
  app.get("/api/factory/stock-entry/in-stock-locations", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db.execute(
        sql`SELECT l.id, l.name, COUNT(fb.id)::int AS count
            FROM factory_bales fb
            JOIN locations l ON l.id = fb.erp_location_id
            WHERE fb.company_id = ${companyId}
              AND fb.status = 'IN_STOCK'
              AND fb.erp_location_id IS NOT NULL
            GROUP BY l.id, l.name
            ORDER BY count DESC`
      );
      const result = resultRows(rows).map((r) => ({
        id: Number(r.id),
        name: r.name as string,
        count: Number(r.count),
      }));
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching in-stock locations:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/bale-stock-list?articleCode=HMD123&locationId=3
  // Returns array of IN_STOCK bales with referenceNumber, weightKg, etc. for a single articleCode.
  app.get("/api/factory/bale-stock-list", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const articleCode = ((req.query.articleCode as string) || "").trim();
      if (!articleCode) return res.status(400).json({ message: "articleCode is required" });

      const rawLocationId = req.query.locationId;
      const locationId = rawLocationId ? parseInt(rawLocationId as string) : null;

      const conditions = [
        eq(factoryBales.companyId, companyId),
        eq(factoryBales.status, "IN_STOCK"),
        isNull(factoryBales.deletedAt),
        eq(factoryBales.articleCode, articleCode),
      ];
      if (locationId && !isNaN(locationId)) {
        conditions.push(eq(factoryBales.erpLocationId, locationId));
      }

      const bales = await db
        .select({
          id: factoryBales.id,
          referenceNumber: factoryBales.referenceNumber,
          baleCode: factoryBales.baleCode,
          weightKg: factoryBales.weightKg,
          stockEntryDate: factoryBales.stockEntryDate,
          finalizedAt: factoryBales.finalizedAt,
          workerName: factoryBales.workerName,
          productionDate: sql<string | null>`COALESCE(
            ${factoryBales.stockEntryDate}::text,
            ${factoryBales.pressedAt}::date::text,
            ${factoryBales.finalizedAt}::date::text,
            ${factoryBales.createdAt}::date::text
          )`,
        })
        .from(factoryBales)
        .where(and(...conditions))
        .orderBy(
          asc(
            sql`COALESCE(
              ${factoryBales.stockEntryDate},
              ${factoryBales.pressedAt}::date,
              ${factoryBales.finalizedAt}::date,
              ${factoryBales.createdAt}::date
            )`
          ),
          asc(factoryBales.referenceNumber)
        );

      // Filter out bales currently locked in an active LOADING order
      const baleIds = bales.map((b) => b.id).filter((id): id is number => id != null);
      let loadingBaleIds = new Set<number>();
      if (baleIds.length > 0) {
        const loadingRows = await db
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
          .where(and(eq(customerOrders.status, "LOADING"), inArray(customerOrderBales.baleId, baleIds)));
        loadingBaleIds = new Set(loadingRows.map((r) => r.baleId));
      }

      const result = bales.map((b) => ({
        ...b,
        lockedInLoading: b.id ? loadingBaleIds.has(b.id) : false,
      }));

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching bale stock list:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/bale-stock-count?articleCodes=HMD123,HMD456&locationId=3
  // Returns authoritative physical stock-in-hand bale counts per article code.
  // Uses the same snapshot as Location Inventory and Invoice Verify, excluding
  // bales already tied to active/finalized customer orders.
  app.get("/api/factory/bale-stock-count", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawCodes = (req.query.articleCodes as string) || "";
      const articleCodes = rawCodes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (articleCodes.length === 0) return res.json({});

      const rawLocationId = req.query.locationId;
      const parsedLocationId = rawLocationId ? parseInt(rawLocationId as string) : null;
      const locationId = parsedLocationId != null && !isNaN(parsedLocationId) ? parsedLocationId : null;
      const snapshot = await getAuthoritativeAvailableStockSnapshot(Number(companyId), locationId);

      res.json(buildArticleCodeStockCountRecord(articleCodes, snapshot));
    } catch (error: unknown) {
      logger.error("Error fetching bale stock count:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 1. Factory Suppliers CRUD
  // ───────────────────────────────────────────────
}
