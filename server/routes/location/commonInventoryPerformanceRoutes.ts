import type { Express, NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { inventory, locations, stockGroups, stockItems } from "@shared/schema";
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

function parsePage(value: unknown): number {
  return Math.max(1, Number.parseInt(String(value), 10) || 1);
}

function parsePageSize(value: unknown): number {
  return Math.min(250, Math.max(1, Number.parseInt(String(value), 10) || 100));
}

/** Higher cap used only by the combined all-locations inventory view, which must
 *  return every (stockItem × location) row in a single shot so the client-side
 *  pivot table is never truncated. */
function parseInventoryPageSize(value: unknown): number {
  return Math.min(5000, Math.max(1, Number.parseInt(String(value), 10) || 250));
}

export function registerCommonInventoryPerformanceRoutes(app: Express): void {
  app.get("/api/stock-items", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    if (!req.query.page) return next();

    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const page = parsePage(req.query.page);
      const pageSize = parsePageSize(req.query.pageSize);
      const offset = (page - 1) * pageSize;
      const conditions: (SQL | undefined)[] = [eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)];

      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (search) {
        const query = `%${search}%`;
        conditions.push(or(ilike(stockItems.name, query), ilike(stockItems.code, query)));
      }

      if (req.query.stockGroupId && req.query.stockGroupId !== "all") {
        conditions.push(eq(stockItems.stockGroupId, Number.parseInt(String(req.query.stockGroupId), 10)));
      }
      if (req.query.gradeId === "none") conditions.push(isNull(stockItems.gradeId));
      else if (req.query.gradeId && req.query.gradeId !== "all") {
        conditions.push(eq(stockItems.gradeId, Number.parseInt(String(req.query.gradeId), 10)));
      }
      if (req.query.categoryId === "none") conditions.push(isNull(stockItems.categoryId));
      else if (req.query.categoryId && req.query.categoryId !== "all") {
        conditions.push(eq(stockItems.categoryId, Number.parseInt(String(req.query.categoryId), 10)));
      }
      if (req.query.active === "true") conditions.push(eq(stockItems.active, true));
      else if (req.query.active === "false") conditions.push(eq(stockItems.active, false));

      const where = and(...conditions);
      const [countRows, data] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(stockItems)
          .where(where),
        db.select().from(stockItems).where(where).orderBy(asc(stockItems.name)).limit(pageSize).offset(offset),
      ]);
      const total = countRows[0]?.total ?? 0;

      return res.json({ data, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/inventory", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    if (!req.query.page) return next();

    try {
      // POS inventory access must stay on assigned-location routes. This
      // company-wide paginated route includes cost and is therefore blocked.
      if (req.user?.role === "POS") return res.status(403).json({ message: "Forbidden" });

      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const page = parsePage(req.query.page);
      const pageSize = parseInventoryPageSize(req.query.pageSize);
      const offset = (page - 1) * pageSize;
      const conditions: (SQL | undefined)[] = [
        eq(inventory.companyId, companyId),
        isNull(locations.deletedAt),
        isNull(stockItems.deletedAt),
      ];

      if (req.query.locationId) {
        conditions.push(eq(inventory.locationId, Number.parseInt(String(req.query.locationId), 10)));
      }
      if (req.query.stockGroupId && req.query.stockGroupId !== "all") {
        conditions.push(eq(stockItems.stockGroupId, Number.parseInt(String(req.query.stockGroupId), 10)));
      }
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (search) {
        const query = `%${search}%`;
        conditions.push(or(ilike(stockItems.name, query), ilike(stockItems.code, query)));
      }

      const where = and(...conditions);
      const countQuery = db
        .select({ total: sql<number>`count(*)::int` })
        .from(inventory)
        .leftJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(where);
      const dataQuery = db
        .select({
          inventoryId: inventory.id,
          locationId: inventory.locationId,
          locationName: locations.name,
          locationCode: locations.code,
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
          lastUpdated: inventory.lastUpdated,
          stockItemCode: stockItems.code,
          stockItemName: stockItems.name,
          stockItemUom: stockItems.uom,
          stockGroupId: stockItems.stockGroupId,
          stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
          stockGroupCode: sql<string>`COALESCE(${stockGroups.code}, '')`,
        })
        .from(inventory)
        .leftJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(where)
        .orderBy(asc(stockItems.code), asc(locations.name))
        .limit(pageSize)
        .offset(offset);

      const [countRows, data] = await Promise.all([countQuery, dataQuery]);
      const total = countRows[0]?.total ?? 0;
      return res.json({ data, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
