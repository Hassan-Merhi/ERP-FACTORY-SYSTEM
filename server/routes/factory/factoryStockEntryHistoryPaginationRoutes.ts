import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireAuth } from "../../auth";
import { pool } from "../../db";
import { getClientDate } from "../../lib/dateUtils";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const SCREEN_FULL_LOAD_LIMIT = 9999;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function wantsPagination(req: Request): boolean {
  return (
    req.query.pagination === "1" ||
    req.query.page !== undefined ||
    req.query.limit !== undefined ||
    req.query.pageSize !== undefined ||
    req.query.offset !== undefined
  );
}

function parsePagination(req: Request): { page: number; limit: number; offset: number } {
  const requestedLimit = parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE);
  const limit =
    requestedLimit === SCREEN_FULL_LOAD_LIMIT ? SCREEN_FULL_LOAD_LIMIT : Math.min(MAX_PAGE_SIZE, requestedLimit);
  if (req.query.offset !== undefined) {
    const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

function parseCsvPositiveIds(value: unknown): number[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const seen = new Set<number>();
  for (const raw of value.split(",")) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) seen.add(parsed);
  }
  return [...seen];
}

function parseCsvStrings(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];
}

export function registerFactoryStockEntryHistoryPaginationRoutes(app: Express): void {
  app.get(
    "/api/factory/bales/stock-entry-history",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      if (!wantsPagination(req)) return next();

      try {
        const session = req.session;
        const companyId = session.factoryCompanyId || session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const userRole = String(session.currentRole || session.factoryRole || "");
        const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(userRole);
        const today = getClientDate(req);
        const startDate = typeof req.query.startDate === "string" && req.query.startDate ? req.query.startDate : today;
        const endDate = typeof req.query.endDate === "string" && req.query.endDate ? req.query.endDate : today;
        const workerIds = parseCsvPositiveIds(req.query.workerId);
        const workerCategoryIds = parseCsvPositiveIds(req.query.workerCategoryId);
        const productIds = parseCsvPositiveIds(req.query.productId);
        const locationIds = parseCsvPositiveIds(req.query.locationId);
        const categoryIds = parseCsvPositiveIds(req.query.categoryId);
        const statuses = parseCsvStrings(req.query.status);
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const includeUnassigned = req.query.includeUnassigned !== "false";
        const lite = req.query.lite === "1";
        const { page, limit, offset } = parsePagination(req);

        const values: unknown[] = [];
        const bind = (value: unknown): string => {
          values.push(value);
          return `$${values.length}`;
        };

        const companyParam = bind(companyId);
        const conditions = [
          `fb.company_id = ${companyParam}`,
          `fb.stock_entry_date IS NOT NULL`,
          `fb.stock_entry_date >= ${bind(startDate)}::date`,
          `fb.stock_entry_date <= ${bind(endDate)}::date`,
        ];

        if (!(isPrivileged && search)) conditions.push(`fb.status NOT IN ('DELETED', 'REMOVED')`);
        if (workerIds.length > 0) {
          const placeholders = workerIds.map((id) => bind(id)).join(", ");
          conditions.push(`fb.finalized_by IN (${placeholders})`);
        }
        if (workerCategoryIds.length > 0) {
          const workerCategoryPlaceholders = workerCategoryIds.map((id) => bind(id)).join(", ");
          conditions.push(`fb.finalized_by IN (
            SELECT category_worker.id
            FROM factory_worker_categories fwc
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(fwc.worker_ids, '[]'::jsonb)) AS category_ids(worker_id)
            INNER JOIN factory_workers category_worker
              ON category_worker.id = category_ids.worker_id::int
              AND category_worker.company_id = ${companyParam}
              AND category_worker.active = TRUE
            WHERE fwc.id IN (${workerCategoryPlaceholders})
              AND fwc.company_id = ${companyParam}
          )`);
        }
        if (productIds.length > 0) {
          const placeholders = productIds.map((id) => bind(id)).join(", ");
          conditions.push(`fb.product_id IN (${placeholders})`);
        }
        if (locationIds.length > 0) {
          const placeholders = locationIds.map((id) => bind(id)).join(", ");
          conditions.push(`fb.erp_location_id IN (${placeholders})`);
        }
        if (categoryIds.length === 1) {
          conditions.push(`fbp.category_id = ${bind(categoryIds[0])}`);
        } else if (categoryIds.length > 1) {
          const placeholders = categoryIds.map((id) => bind(id)).join(", ");
          conditions.push(`fbp.category_id IN (${placeholders})`);
        }
        if (statuses.length > 0) {
          const placeholders = statuses.map((status) => bind(status)).join(", ");
          conditions.push(`fb.status IN (${placeholders})`);
        }
        if (search) {
          const rawParam = bind(`%${search.toLowerCase()}%`);
          const compactParam = bind(`%${normalizeSearchText(search)}%`);
          conditions.push(`(
            LOWER(fb.reference_number) LIKE ${rawParam}
            OR regexp_replace(lower(COALESCE(fb.reference_number, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactParam}
          )`);
        }
        if (!includeUnassigned) conditions.push(`fb.finalized_by IS NOT NULL`);

        const limitParam = bind(limit);
        const offsetParam = bind(offset);
        // Stock Entry historically copied entryDate (00:00) into finalized_at. For rows
        // created by the Stock Entry flow, created_at is the real action timestamp.
        // Keep historical/imported data untouched by requiring its attribution snapshot.
        const effectiveFinalizedAtSql = `CASE
          WHEN fb.finalized_at IS NOT NULL
            AND fb.stock_entry_date IS NOT NULL
            AND fb.finalized_at = fb.stock_entry_date::timestamp
            AND fb.created_at IS NOT NULL
            AND fb.created_at <> fb.finalized_at
            AND EXISTS (
              SELECT 1
              FROM factory_bale_production_attributions fbpa
              WHERE fbpa.bale_id = fb.id
                AND fbpa.company_id = ${companyParam}
            )
          THEN fb.created_at
          ELSE fb.finalized_at
        END`;
        // factory_bales timestamps are stored as UTC clock values without a timezone.
        // Attach UTC explicitly so browsers convert them to the user's local time correctly.
        const finalizedAtJsonSql = `(${effectiveFinalizedAtSql}) AT TIME ZONE 'UTC'`;
        const balesProjection = lite
          ? `'[]'::jsonb AS bales`
          : `JSONB_AGG(JSONB_BUILD_OBJECT(
              'id', fb.id,
              'referenceNumber', fb.reference_number,
              'weightKg', fb.weight_kg,
              'status', fb.status,
              'finalizedAt', ${finalizedAtJsonSql},
              'stockEntryDate', fb.stock_entry_date::text,
              'locationName', COALESCE(l.name, 'Unknown'),
              'workerName', fw.full_name,
              'productName', fbp.name,
              'articleCode', fbp.article_code
            ) ORDER BY ${effectiveFinalizedAtSql} ASC) AS bales`;

        const query = `
          WITH grouped AS (
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
              ROUND(SUM(CAST(fb.weight_kg AS numeric)), 3)::text AS "totalWeight",
              ROUND(AVG(CAST(fb.weight_kg AS numeric)), 3)::text AS "avgWeight",
              (MIN(${effectiveFinalizedAtSql}) AT TIME ZONE 'UTC') AS "firstFinalizedAt",
              (MAX(${effectiveFinalizedAtSql}) AT TIME ZONE 'UTC') AS "lastFinalizedAt",
              ${balesProjection}
            FROM factory_bales fb
            LEFT JOIN factory_workers fw ON fb.finalized_by = fw.id AND fw.company_id = ${companyParam}
            LEFT JOIN factory_bale_products fbp ON fb.product_id = fbp.id AND fbp.company_id = ${companyParam}
            LEFT JOIN locations l ON fb.erp_location_id = l.id AND l.company_id = ${companyParam}
            WHERE ${conditions.join(" AND ")}
            GROUP BY
              fb.stock_entry_date,
              fb.erp_location_id,
              l.name,
              fb.finalized_by,
              fw.full_name,
              fb.product_id,
              fbp.name,
              fbp.article_code
          ),
          metadata AS (
            SELECT
              COUNT(*)::int AS total,
              COALESCE(SUM("baleCount"), 0)::int AS "totalBales",
              COALESCE(SUM(("totalWeight")::numeric), 0)::float AS "totalWeight"
            FROM grouped
          ),
          page_rows AS (
            SELECT *
            FROM grouped
            ORDER BY
              "stockEntryDate" DESC,
              "locationName" ASC NULLS LAST,
              "workerName" ASC NULLS LAST,
              "productName" ASC NULLS LAST
            LIMIT ${limitParam} OFFSET ${offsetParam}
          )
          SELECT
            metadata.total,
            metadata."totalBales",
            metadata."totalWeight",
            COALESCE(
              (
                SELECT JSONB_AGG(
                  TO_JSONB(page_rows)
                  ORDER BY
                    "stockEntryDate" DESC,
                    "locationName" ASC NULLS LAST,
                    "workerName" ASC NULLS LAST,
                    "productName" ASC NULLS LAST
                )
                FROM page_rows
              ),
              '[]'::jsonb
            ) AS items
          FROM metadata
        `;

        const result = await pool.query(query, values);
        const total = Number(result.rows[0]?.total || 0);
        const totalBales = Number(result.rows[0]?.totalBales || 0);
        const totalWeight = Number(result.rows[0]?.totalWeight || 0);
        const items = Array.isArray(result.rows[0]?.items) ? result.rows[0].items : [];
        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

        res.setHeader("X-Total-Count", String(total));
        res.setHeader("X-Page", String(page));
        res.setHeader("X-Page-Size", String(limit));
        res.setHeader("X-Total-Pages", String(totalPages));
        res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");

        return res.json({
          items,
          total,
          totalBales,
          totalWeight,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1 && totalPages > 0,
        });
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
