import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, Request } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { resultRows } from "../../../lib/queryResult";

const DEFAULT_GROUP_PAGE_SIZE = 25;
const MAX_GROUP_PAGE_SIZE = 100;
const DEFAULT_HISTORY_PAGE_SIZE = 10;
const MAX_HISTORY_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 120;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

type FactorySession = Request["session"] & { factoryCompanyId?: number };

function getCompanyId(req: Request): number | null {
  const session = req.session as FactorySession;
  const value = session.factoryCompanyId || session.currentCompanyId;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getSearch(req: Request): string {
  return String(req.query?.search || "")
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
}

function eligibleWasteBalesSql(companyId: number, search: string) {
  const pattern = `%${search}%`;
  const compactPattern = `%${normalizeSearchText(search)}%`;
  const searchClause = search
    ? sql`AND (
        fb.reference_number ILIKE ${pattern}
        OR COALESCE(p.name, '') ILIKE ${pattern}
        OR COALESCE(p.article_code, fb.article_code, '') ILIKE ${pattern}
        OR COALESCE(c.name, fb.category, '') ILIKE ${pattern}
        OR COALESCE(l.name, '') ILIKE ${pattern}
        OR regexp_replace(lower(COALESCE(fb.reference_number, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
        OR regexp_replace(lower(COALESCE(p.name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
        OR regexp_replace(lower(COALESCE(p.article_code, fb.article_code, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
        OR regexp_replace(lower(COALESCE(c.name, fb.category, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
        OR regexp_replace(lower(COALESCE(l.name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactPattern}
      )`
    : sql``;

  return sql`
    SELECT
      fb.id,
      fb.product_id AS "productId",
      fb.reference_number AS "referenceNumber",
      COALESCE(p.name, p.article_code, fb.product_name, 'Unknown') AS "productName",
      COALESCE(p.article_code, fb.article_code, '') AS "articleCode",
      COALESCE(c.name, fb.category, '—') AS "categoryName",
      COALESCE(l.name, 'No Location') AS "locationName",
      COALESCE(fb.weight_kg, 0)::float AS "weightKg",
      COALESCE(fb.total_cost, 0)::float AS "totalCost"
    FROM factory_bales fb
    INNER JOIN factory_bale_products p
      ON p.id = fb.product_id
      AND p.company_id = ${companyId}
    LEFT JOIN factory_categories c ON c.id = p.category_id
    LEFT JOIN locations l ON l.id = fb.erp_location_id
    WHERE fb.company_id = ${companyId}
      AND fb.status = 'IN_STOCK'
      AND (
        LOWER(COALESCE(c.name, '')) LIKE '%garbage%'
        OR LOWER(COALESCE(c.name, '')) LIKE '%wiper%'
        OR COALESCE(p.article_code, '') ILIKE 'HMD16%'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM customer_order_bales cob
        INNER JOIN customer_orders co ON co.id = cob.order_id
        WHERE cob.bale_id = fb.id
          AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
          AND co.company_id = ${companyId}
      )
      ${searchClause}
  `;
}

function mapWasteBale(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    productId: Number(row.productId),
    referenceNumber: String(row.referenceNumber || ""),
    productName: String(row.productName || "Unknown"),
    articleCode: String(row.articleCode || ""),
    categoryName: String(row.categoryName || "—"),
    locationName: String(row.locationName || "No Location"),
    weightKg: Number(row.weightKg || 0),
    totalCost: Number(row.totalCost || 0),
  };
}

export function registerWasteDispatchBandwidthRoutes(app: Express) {
  // Lightweight grouped summary. The old /bales route is intentionally left
  // untouched for compatibility; the optimized client uses this endpoint.
  app.get("/api/factory/waste-dispatch/summary", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const search = getSearch(req);
      const page = positiveInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
      const limit = positiveInt(req.query.limit, DEFAULT_GROUP_PAGE_SIZE, MAX_GROUP_PAGE_SIZE);
      const offset = (page - 1) * limit;
      const eligible = eligibleWasteBalesSql(companyId, search);

      const raw = await db.execute(sql`
        WITH eligible AS (${eligible}),
        grouped AS (
          SELECT
            "productId",
            "productName",
            "categoryName",
            COUNT(*)::int AS "baleCount",
            COALESCE(SUM("weightKg"), 0)::float AS "totalWeight",
            COALESCE(SUM("totalCost"), 0)::float AS "totalCost"
          FROM eligible
          GROUP BY "productId", "productName", "categoryName"
        )
        SELECT
          grouped.*,
          COUNT(*) OVER()::int AS "totalGroups",
          COALESCE(SUM("baleCount") OVER(), 0)::int AS "overallBales",
          COALESCE(SUM("totalWeight") OVER(), 0)::float AS "overallWeight",
          COALESCE(SUM("totalCost") OVER(), 0)::float AS "overallCost"
        FROM grouped
        ORDER BY "productName" ASC, "categoryName" ASC, "productId" ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      const first = rows[0];
      const totalGroups = Number(first?.totalGroups || 0);
      const totalPages = totalGroups > 0 ? Math.ceil(totalGroups / limit) : 1;
      const groups = rows.map((row) => {
        const baleCount = Number(row.baleCount || 0);
        const totalCost = Number(row.totalCost || 0);
        return {
          productId: Number(row.productId),
          productName: String(row.productName || "Unknown"),
          categoryName: String(row.categoryName || "—"),
          baleCount,
          totalWeight: Number(row.totalWeight || 0),
          totalCost,
          avgRate: baleCount > 0 ? totalCost / baleCount : 0,
        };
      });

      res.json({
        groups,
        pagination: {
          page,
          limit,
          total: totalGroups,
          totalPages,
        },
        totals: {
          bales: Number(first?.overallBales || 0),
          weight: Number(first?.overallWeight || 0),
          cost: Number(first?.overallCost || 0),
        },
      });
    } catch (error: unknown) {
      logger.error("Error fetching optimized waste dispatch summary", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bale rows are loaded only when a product group is expanded. Keep the same
  // server-side search filter as the summary so an expanded searched group
  // cannot reveal or select non-matching bales.
  app.get("/api/factory/waste-dispatch/group-bales/:productId", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const productId = Number(req.params.productId);
      if (!Number.isFinite(productId) || productId < 1) {
        return res.status(400).json({ message: "Invalid product id" });
      }
      const search = getSearch(req);

      const raw = await db.execute(sql`
        WITH eligible AS (${eligibleWasteBalesSql(companyId, search)})
        SELECT *
        FROM eligible
        WHERE "productId" = ${productId}
        ORDER BY id DESC
      `);
      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      res.json({ bales: rows.map(mapWasteBale) });
    } catch (error: unknown) {
      logger.error("Error fetching waste dispatch group bales", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Exact-reference lookup keeps barcode/manual scanning functional even when
  // the scanned bale is not on the currently visible summary page.
  app.get("/api/factory/waste-dispatch/scan", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const reference = String(req.query.ref || "")
        .trim()
        .slice(0, 120);
      if (!reference) return res.status(400).json({ message: "Reference is required" });

      const raw = await db.execute(sql`
        WITH eligible AS (${eligibleWasteBalesSql(companyId, "")})
        SELECT *
        FROM eligible
        WHERE UPPER("referenceNumber") = UPPER(${reference})
        LIMIT 1
      `);
      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      if (rows.length === 0) return res.status(404).json({ message: `No eligible waste bale with ref "${reference}"` });
      res.json({ bale: mapWasteBale(rows[0]) });
    } catch (error: unknown) {
      logger.error("Error scanning waste dispatch bale", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Explicit user action only. This preserves the old "Select All" behavior
  // without transferring every bale during normal page load.
  app.get("/api/factory/waste-dispatch/select-all", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const search = getSearch(req);

      const raw = await db.execute(sql`
        WITH eligible AS (${eligibleWasteBalesSql(companyId, search)})
        SELECT *
        FROM eligible
        ORDER BY id DESC
      `);
      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      res.json({ bales: rows.map(mapWasteBale) });
    } catch (error: unknown) {
      logger.error("Error selecting all waste dispatch bales", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // History summaries use stored dispatch totals and do not embed every linked bale.
  app.get("/api/factory/waste-dispatch/history-summary", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const page = positiveInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
      const limit = positiveInt(req.query.limit, DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE);
      const offset = (page - 1) * limit;

      const raw = await db.execute(sql`
        SELECT
          id,
          dispatch_number AS "dispatchNumber",
          dispatch_date AS "dispatchDate",
          notes,
          COALESCE(total_bales, 0)::int AS "totalBales",
          COALESCE(total_weight_kg, 0)::float AS "totalWeightKg",
          COALESCE(total_cost_written_off, 0)::float AS "totalCostWrittenOff",
          created_by AS "createdBy",
          created_at AS "createdAt",
          COUNT(*) OVER()::int AS "totalRows"
        FROM factory_bale_waste_dispatches
        WHERE company_id = ${companyId}
        ORDER BY id DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `);
      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      const total = Number(rows[0]?.totalRows || 0);
      const totalPages = total > 0 ? Math.ceil(total / limit) : 1;

      res.json({
        items: rows.map(({ totalRows: _totalRows, ...row }) => ({
          ...row,
          id: Number(row.id),
          totalBales: Number(row.totalBales || 0),
          totalWeightKg: Number(row.totalWeightKg || 0),
          totalCostWrittenOff: Number(row.totalCostWrittenOff || 0),
        })),
        pagination: { page, limit, total, totalPages },
      });
    } catch (error: unknown) {
      logger.error("Error fetching optimized waste dispatch history", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bale details are fetched only for the single dispatch the user expands or prints.
  app.get("/api/factory/waste-dispatch/history/:id/bales", requireAuth, async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dispatchId = Number(req.params.id);
      if (!Number.isFinite(dispatchId) || dispatchId < 1) {
        return res.status(400).json({ message: "Invalid dispatch id" });
      }

      const dispatchRaw = await db.execute(sql`
        SELECT id
        FROM factory_bale_waste_dispatches
        WHERE id = ${dispatchId} AND company_id = ${companyId}
        LIMIT 1
      `);
      const dispatchRows = (Array.isArray(dispatchRaw) ? dispatchRaw : resultRows(dispatchRaw)) as Record<
        string,
        unknown
      >[];
      if (dispatchRows.length === 0) return res.status(404).json({ message: "Dispatch not found" });

      const raw = await db.execute(sql`
        SELECT
          id,
          reference_number AS "referenceNumber",
          product_name AS "productName",
          COALESCE(weight_kg, 0)::float AS "weightKg",
          COALESCE(total_cost, 0)::float AS "totalCost"
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND waste_dispatch_id = ${dispatchId}
        ORDER BY id ASC
      `);
      const rows = (Array.isArray(raw) ? raw : resultRows(raw)) as Record<string, unknown>[];
      res.json({
        bales: rows.map((row) => ({
          id: Number(row.id),
          referenceNumber: String(row.referenceNumber || ""),
          productName: String(row.productName || ""),
          weightKg: Number(row.weightKg || 0),
          totalCost: Number(row.totalCost || 0),
        })),
      });
    } catch (error: unknown) {
      logger.error("Error fetching waste dispatch history details", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
