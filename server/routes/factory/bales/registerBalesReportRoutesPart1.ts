// Extracted from ./balesReportRoutes.ts to keep that module under the source-size cap.
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { resultRows } from "../../../lib/queryResult";
import { toMoney } from "../../../lib/money";
import { sql } from "drizzle-orm";

export function registerBalesReportRoutesPart1(app: Express) {
  // Lightweight daily summary — counts and weights by category for a single date.
  // Much faster than the full /api/factory/bales endpoint which returns up to 2000 rows.
  app.get("/api/factory/bales/daily-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { date } = req.query as Record<string, string>;
      if (!date) return res.status(400).json({ message: "date is required (YYYY-MM-DD)" });

      const rows = await db.execute(sql`
        SELECT
          LOWER(TRIM(COALESCE(category, ''))) AS "category",
          COUNT(*)::int                        AS "count",
          ROUND(COALESCE(SUM(CAST(weight_kg AS numeric)), 0), 3)::text AS "totalKg"
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND stock_entry_date::text = ${date}
          AND status NOT IN ('DELETED', 'REMOVED')
        GROUP BY LOWER(TRIM(COALESCE(category, '')))
      `);

      res.json(resultRows(rows));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/bales/stock-entry-history", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const userRole = (req.session.currentRole as string) || (req.session.factoryRole as string) || "";
      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(userRole);

      const {
        startDate,
        endDate,
        workerId,
        productId,
        locationId,
        categoryId,
        status,
        search,
        includeUnassigned,
        lite,
      } = req.query as Record<string, string>;

      const today = getClientDate(req);
      const effectiveStart = startDate || today;
      const effectiveEnd = endDate || today;

      // Pagination — page ≥ 1, limit 1–250 (default 100)
      const rawPage = parseInt(String(req.query.page ?? ""), 10);
      const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
      const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 250);
      const offset = (page - 1) * limit;

      const workerFilter = workerId ? sql`AND fb.finalized_by = ${parseInt(workerId)}` : sql``;
      const productFilter = productId ? sql`AND fb.product_id = ${parseInt(productId)}` : sql``;
      const locationFilter = locationId ? sql`AND fb.erp_location_id = ${parseInt(locationId)}` : sql``;
      // categoryId may be comma-separated for multi-select; build an IN(...) clause
      const categoryIds2 = categoryId
        ? categoryId
            .split(",")
            .map((s: string) => parseInt(s, 10))
            .filter((n: number) => Number.isFinite(n) && n > 0)
        : [];
      const categoryFilter2 =
        categoryIds2.length === 1
          ? sql`AND fbp.category_id = ${categoryIds2[0]}`
          : categoryIds2.length > 1
            ? sql`AND fbp.category_id = ANY(${categoryIds2}::int[])`
            : sql``;
      const statusFilter = status ? sql`AND fb.status = ${status}` : sql``;
      const searchFilter = search
        ? sql`AND (
            LOWER(fb.reference_number) LIKE ${"%" + String(search).toLowerCase() + "%"}
            OR regexp_replace(lower(coalesce(fb.reference_number, '')), '[^[:alnum:]]+', '', 'g') LIKE ${"%" + normalizeSearchText(search) + "%"}
          )`
        : sql``;
      const unassignedFilter = includeUnassigned === "false" ? sql`AND fb.finalized_by IS NOT NULL` : sql``;
      // Privileged users can see deleted bales when searching by ref code;
      // otherwise exclude deleted/removed bales (consistent with daily-summary)
      const deletedFilter = isPrivileged && search ? sql`` : sql`AND fb.status NOT IN ('DELETED', 'REMOVED')`;
      // Explicit date ranges always constrain reference searches; legacy search
      // without date parameters may still find historical references globally.
      const dateFilter =
        search && !startDate && !endDate
          ? sql``
          : sql`AND fb.stock_entry_date >= ${effectiveStart} AND fb.stock_entry_date <= ${effectiveEnd}`;

      // Shared WHERE base reused by both the data query and the COUNT subquery.
      // Date and worker filters must apply together when the caller supplies a range.
      const whereClause = sql`
        WHERE fb.company_id = ${companyId}
          ${deletedFilter}
          AND fb.stock_entry_date IS NOT NULL
          ${dateFilter}
          ${workerFilter}
          ${productFilter}
          ${locationFilter}
          ${categoryFilter2}
          ${statusFilter}
          ${searchFilter}
          ${unassignedFilter}`;

      const groupByClause = sql`GROUP BY fb.stock_entry_date, fb.erp_location_id, l.name, fb.finalized_by, fw.full_name, fb.product_id, fbp.name, fbp.article_code`;
      const orderByClause = sql`ORDER BY fb.stock_entry_date DESC, l.name NULLS LAST, fw.full_name NULLS LAST, fbp.name NULLS LAST`;

      const joinClause = sql`
        FROM factory_bales fb
        LEFT JOIN factory_workers fw ON fb.finalized_by = fw.id AND fw.company_id = ${companyId}
        LEFT JOIN factory_bale_products fbp ON fb.product_id = fbp.id AND fbp.company_id = ${companyId}
        LEFT JOIN locations l ON fb.erp_location_id = l.id AND l.company_id = ${companyId}`;

      // COUNT query: counts distinct groups + total bales + total weight across all matching groups.
      // Runs in parallel with the data query.
      const countQuery = sql`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(grp_bale_count), 0) AS total_bales,
          COALESCE(SUM(grp_weight), 0) AS total_weight
        FROM (
          SELECT COUNT(fb.id) AS grp_bale_count, COALESCE(SUM(CAST(fb.weight_kg AS numeric)), 0) AS grp_weight
          ${joinClause}
          ${whereClause}
          ${groupByClause}
        ) AS grp`;

      function buildPaginatedResponse(items: unknown[], total: number, totalBales = 0, totalWeight = 0) {
        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
        return {
          items,
          total,
          totalBales,
          totalWeight,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1 && totalPages > 0,
        };
      }

      // Lite mode: omit per-bale JSON_AGG — returns a summary-only payload (~95% smaller).
      // The condensed view uses this for the initial page load; bale details are fetched on demand.
      if (lite === "1") {
        const [liteResult, countResult] = await Promise.all([
          db.execute(sql`
            SELECT
              fb.stock_entry_date::text AS "stockEntryDate",
              fb.erp_location_id AS "erpLocationId",
              COALESCE(l.name, 'Unknown') AS "locationName",
              fb.finalized_by AS "workerId",
              fw.full_name AS "workerName",
              fb.product_id AS "productId",
              fbp.name AS "productName",
              fbp.article_code AS "articleCode",
              COUNT(*)::int AS "baleCount",
              ROUND(SUM(CAST(fb.weight_kg AS numeric)), 3) AS "totalWeight",
              ROUND(AVG(CAST(fb.weight_kg AS numeric)), 3) AS "avgWeight",
              MIN(fb.finalized_at) AS "firstFinalizedAt",
              MAX(fb.finalized_at) AS "lastFinalizedAt"
            ${joinClause}
            ${whereClause}
            ${groupByClause}
            ${orderByClause}
            LIMIT ${limit} OFFSET ${offset}
          `),
          db.execute(countQuery),
        ]);
        const total = parseInt(String(countResult.rows[0]?.total ?? "0"), 10);
        const totalBales = parseInt(String(countResult.rows[0]?.total_bales ?? "0"), 10);
        const totalWeight = toMoney(String(countResult.rows[0]?.total_weight ?? "0")).toNumber();
        const items = liteResult.rows.map((r) => ({ ...r, bales: [] }));
        return res.json(buildPaginatedResponse(items, total, totalBales, totalWeight));
      }

      const [dataResult, countResult] = await Promise.all([
        db.execute(sql`
          SELECT
            fb.stock_entry_date::text AS "stockEntryDate",
            fb.erp_location_id AS "erpLocationId",
            COALESCE(l.name, 'Unknown') AS "locationName",
            fb.finalized_by AS "workerId",
            fw.full_name AS "workerName",
            fb.product_id AS "productId",
            fbp.name AS "productName",
            fbp.article_code AS "articleCode",
            COUNT(*)::int AS "baleCount",
            ROUND(SUM(CAST(fb.weight_kg AS numeric)), 3) AS "totalWeight",
            ROUND(AVG(CAST(fb.weight_kg AS numeric)), 3) AS "avgWeight",
            MIN(fb.finalized_at) AS "firstFinalizedAt",
            MAX(fb.finalized_at) AS "lastFinalizedAt",
            JSON_AGG(JSON_BUILD_OBJECT(
              'id', fb.id,
              'referenceNumber', fb.reference_number,
              'weightKg', fb.weight_kg,
              'status', fb.status,
              'finalizedAt', fb.finalized_at,
              'stockEntryDate', fb.stock_entry_date::text,
              'locationName', COALESCE(l.name, 'Unknown'),
              'workerId', fb.finalized_by,
              'workerName', fw.full_name,
              'productName', fbp.name,
              'articleCode', fbp.article_code
            ) ORDER BY fb.finalized_at ASC) AS "bales"
          ${joinClause}
          ${whereClause}
          ${groupByClause}
          ${orderByClause}
          LIMIT ${limit} OFFSET ${offset}
        `),
        db.execute(countQuery),
      ]);

      const total = parseInt(String(countResult.rows[0]?.total ?? "0"), 10);
      const totalBales = parseInt(String(countResult.rows[0]?.total_bales ?? "0"), 10);
      const totalWeight = toMoney(String(countResult.rows[0]?.total_weight ?? "0")).toNumber();
      res.json(buildPaginatedResponse(dataResult.rows, total, totalBales, totalWeight));
    } catch (error: unknown) {
      logger.error("Error fetching stock entry history:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
