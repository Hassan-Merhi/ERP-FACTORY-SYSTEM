import { normalizeSearchText } from "@shared/searchNormalization";
import type { Express, NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireAuth } from "../../auth";
import { pool } from "../../db";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const ACTIVE_ORDER_STATUSES = ["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"];

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
  const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE));
  if (req.query.offset !== undefined) {
    const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

function queryText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface PageRow {
  articleCode: string;
  productName: string;
  categoryName: string;
  stockAvailable: number;
  totalLoaded: number;
  expectedToLoad: number;
  freeToPromise: number;
  totalKg: number;
  isGarbageOrWipers: boolean;
  proformaDetails: ProformaDetail[];
}

interface ContainerDetail {
  orderId: number;
  containerName: string;
  status: string;
  expectedQty: number;
  loadedQty: number;
  remainingQty: number;
}

interface ProformaDetail {
  proformaId: number;
  proformaName: string;
  customerId: number;
  customerName: string;
  lineQty: number;
  containerCount: number;
  totalExpected: number;
  containers: ContainerDetail[];
}

export function registerFactoryStockAllocationV5PaginationRoutes(app: Express): void {
  app.get("/api/factory/v5/stock-allocation", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    if (!wantsPagination(req)) return next();

    try {
      const session = req.session;
      const companyId = session.factoryCompanyId || session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const productFilter = queryText(req.query.productFilter);
      const customerFilter = queryText(req.query.customerFilter);
      const proformaFilter = queryText(req.query.proformaFilter);
      const containerFilter = queryText(req.query.containerFilter);
      const statusFilter = queryText(req.query.statusFilter).toUpperCase();
      const search = queryText(req.query.search);
      const fromDate = queryText(req.query.fromDate);
      const toDate = queryText(req.query.toDate);
      const hideZero = req.query.hideZero === "true";
      const { page, limit, offset } = parsePagination(req);

      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };

      const companyParam = bind(companyId);
      const activeProformaConditions = [`cp.company_id = ${companyParam}`, `cp.is_active = true`];
      if (fromDate) activeProformaConditions.push(`cp.created_at >= ${bind(fromDate)}::date`);
      if (toDate) activeProformaConditions.push(`cp.created_at < (${bind(toDate)}::date + INTERVAL '1 day')`);

      // Preserve the existing idempotent GET backfill before reading expected quantities.
      // It inserts only missing rows and retains the unique-key race safety net.
      await pool
        .query(
          `
            WITH active_proformas AS (
              SELECT cp.id
              FROM customer_proformas cp
              WHERE ${activeProformaConditions.join(" AND ")}
            )
            INSERT INTO customer_order_expected_lines
              (company_id, order_id, proforma_id, proforma_line_id, article_code, product_name, expected_qty)
            SELECT co.company_id, co.id, co.proforma_id_used, cpl.id,
                   cpl.article_code, cpl.product_name, cpl.quantity
            FROM customer_orders co
            JOIN active_proformas ap ON ap.id = co.proforma_id_used
            JOIN customer_proforma_lines cpl ON cpl.proforma_id = co.proforma_id_used
            WHERE co.company_id = ${companyParam}
              AND co.status IN ('DRAFT', 'LOADING')
              AND co.proforma_id_used IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM customer_order_expected_lines cel
                WHERE cel.order_id = co.id AND cel.article_code = cpl.article_code
              )
            ON CONFLICT (order_id, article_code) DO NOTHING
          `,
          values
        )
        .catch(() => undefined);

      const filterConditions: string[] = [];
      const effectiveProductFilter = productFilter || search;
      if (effectiveProductFilter) {
        const param = bind(`%${effectiveProductFilter}%`);
        const compactParam = bind(`%${normalizeSearchText(effectiveProductFilter)}%`);
        filterConditions.push(`(
          ab.article_code ILIKE ${param}
          OR ab.product_name ILIKE ${param}
          OR regexp_replace(lower(COALESCE(ab.article_code, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactParam}
          OR regexp_replace(lower(COALESCE(ab.product_name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactParam}
        )`);
      }
      if (customerFilter) {
        const param = bind(`%${customerFilter}%`);
        const compactParam = bind(`%${normalizeSearchText(customerFilter)}%`);
        filterConditions.push(`EXISTS (
            SELECT 1
            FROM active_proformas apf
            JOIN customer_proforma_lines cplf ON cplf.proforma_id = apf.id
            LEFT JOIN customers cf ON cf.id = apf.customer_id
            WHERE cplf.article_code = ab.article_code
              AND (
                COALESCE(cf.legal_name, '') ILIKE ${param}
                OR regexp_replace(lower(COALESCE(cf.legal_name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactParam}
              )
          )`);
      }
      if (proformaFilter) {
        const param = bind(`%${proformaFilter}%`);
        const compactParam = bind(`%${normalizeSearchText(proformaFilter)}%`);
        filterConditions.push(`EXISTS (
            SELECT 1
            FROM active_proformas apf
            JOIN customer_proforma_lines cplf ON cplf.proforma_id = apf.id
            WHERE cplf.article_code = ab.article_code
              AND (
                apf.name ILIKE ${param}
                OR regexp_replace(lower(COALESCE(apf.name, '')), '[^[:alnum:]]+', '', 'g') LIKE ${compactParam}
              )
          )`);
      }
      if (containerFilter) {
        const param = bind(`%${containerFilter}%`);
        const compactParam = bind(`%${normalizeSearchText(containerFilter)}%`);
        filterConditions.push(`EXISTS (
            SELECT 1
            FROM active_orders aof
            JOIN customer_proforma_lines cplf ON cplf.proforma_id = aof.proforma_id
            WHERE cplf.article_code = ab.article_code
              AND (
                COALESCE(aof.container_number, 'Order #' || aof.id::text) ILIKE ${param}
                OR regexp_replace(
                  lower(COALESCE(aof.container_number, 'Order #' || aof.id::text)),
                  '[^[:alnum:]]+',
                  '',
                  'g'
                ) LIKE ${compactParam}
              )
          )`);
      }
      if (statusFilter) {
        const param = bind(statusFilter);
        filterConditions.push(`EXISTS (
            SELECT 1
            FROM active_orders aof
            JOIN customer_proforma_lines cplf ON cplf.proforma_id = aof.proforma_id
            WHERE cplf.article_code = ab.article_code AND aof.status = ${param}
          )`);
      }
      if (hideZero) {
        filterConditions.push(`(
            ab.stock_available <> 0
            OR ab.total_loaded <> 0
            OR ab.expected_to_load <> 0
            OR EXISTS (
              SELECT 1
              FROM active_orders aof
              JOIN customer_proforma_lines cplf ON cplf.proforma_id = aof.proforma_id
              WHERE cplf.article_code = ab.article_code
            )
          )`);
      }

      const limitParam = bind(limit);
      const offsetParam = bind(offset);
      const filteredWhere = filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";

      const aggregateQuery = `
          WITH active_proformas AS (
            SELECT cp.id, cp.customer_id, cp.name, cp.created_at
            FROM customer_proformas cp
            WHERE ${activeProformaConditions.join(" AND ")}
          ),
          active_orders AS (
            SELECT co.id,
                   co.proforma_id_used AS proforma_id,
                   co.container_number,
                   co.status,
                   co.customer_id
            FROM customer_orders co
            JOIN active_proformas ap ON ap.id = co.proforma_id_used
            WHERE co.company_id = ${companyParam}
              AND co.status = ANY(${bind(ACTIVE_ORDER_STATUSES)}::text[])
              AND co.proforma_id_used IS NOT NULL
          ),
          product_rows AS (
            SELECT COALESCE(fbp.article_code, fbp.code) AS article_code,
                   fbp.name,
                   COALESCE(fbp.weight_per_bale_kg::numeric, 0) AS weight_kg,
                   COALESCE(fc.name, '') AS category_name,
                   (
                     LOWER(COALESCE(fc.name, '')) LIKE '%wiper%'
                     OR LOWER(COALESCE(fc.name, '')) LIKE '%garbage%'
                     OR LOWER(COALESCE(fc.name, '')) LIKE '%rag%'
                     OR LOWER(COALESCE(fbp.name, '')) LIKE '%wiper%'
                     OR LOWER(COALESCE(fbp.name, '')) LIKE '%garbage%'
                   ) AS excluded
            FROM factory_bale_products fbp
            LEFT JOIN factory_categories fc ON fc.id = fbp.category_id
            WHERE fbp.company_id = ${companyParam} AND fbp.active = true
          ),
          stock AS (
            SELECT fb.article_code, COUNT(*)::int AS count
            FROM factory_bales fb
            WHERE fb.company_id = ${companyParam} AND fb.status = 'IN_STOCK'
            GROUP BY fb.article_code
          ),
          loaded_per_order AS (
            SELECT cob.order_id, fb.article_code, COUNT(*)::int AS count
            FROM customer_order_bales cob
            JOIN factory_bales fb ON fb.id = cob.bale_id
            JOIN active_orders ao ON ao.id = cob.order_id
            GROUP BY cob.order_id, fb.article_code
          ),
          loading AS (
            SELECT lpo.article_code, SUM(lpo.count)::int AS count
            FROM loaded_per_order lpo
            JOIN active_orders ao ON ao.id = lpo.order_id AND ao.status = 'LOADING'
            GROUP BY lpo.article_code
          ),
          expected AS (
            SELECT cel.article_code,
                   SUM(GREATEST(cel.expected_qty - COALESCE(lpo.count, 0), 0))::int AS count
            FROM customer_order_expected_lines cel
            JOIN active_orders ao ON ao.id = cel.order_id AND ao.status IN ('DRAFT', 'LOADING')
            LEFT JOIN loaded_per_order lpo
              ON lpo.order_id = cel.order_id AND lpo.article_code = cel.article_code
            GROUP BY cel.article_code
          ),
          proforma_codes AS (
            SELECT DISTINCT cpl.article_code
            FROM customer_proforma_lines cpl
            JOIN active_proformas ap ON ap.id = cpl.proforma_id
          ),
          all_codes AS (
            SELECT article_code FROM stock WHERE article_code IS NOT NULL
            UNION SELECT article_code FROM loading WHERE article_code IS NOT NULL
            UNION SELECT article_code FROM expected WHERE article_code IS NOT NULL
            UNION SELECT article_code FROM proforma_codes WHERE article_code IS NOT NULL
            UNION SELECT article_code FROM product_rows WHERE article_code IS NOT NULL
          ),
          latest_bale_name AS (
            SELECT DISTINCT ON (fb.article_code) fb.article_code, fb.product_name
            FROM factory_bales fb
            JOIN all_codes ac ON ac.article_code = fb.article_code
            WHERE fb.company_id = ${companyParam}
              AND fb.product_name IS NOT NULL
              AND fb.product_name <> ''
            ORDER BY fb.article_code, fb.created_at DESC
          ),
          proforma_name AS (
            SELECT DISTINCT ON (cpl.article_code) cpl.article_code, cpl.product_name
            FROM customer_proforma_lines cpl
            JOIN active_proformas ap ON ap.id = cpl.proforma_id
            ORDER BY cpl.article_code, cpl.id DESC
          ),
          article_base AS (
            SELECT ac.article_code,
                   COALESCE(pr.name, pn.product_name, lbn.product_name, ac.article_code) AS product_name,
                   COALESCE(pr.category_name, '') AS category_name,
                   COALESCE(s.count, 0)::int AS stock_available,
                   COALESCE(l.count, 0)::int AS total_loaded,
                   COALESCE(e.count, 0)::int AS expected_to_load,
                   (COALESCE(s.count, 0) - COALESCE(e.count, 0) - COALESCE(l.count, 0))::int AS free_to_promise,
                   ROUND(COALESCE(s.count, 0) * COALESCE(pr.weight_kg, 0))::int AS total_kg,
                   COALESCE(pr.excluded, false) AS is_garbage_or_wipers
            FROM all_codes ac
            LEFT JOIN product_rows pr ON pr.article_code = ac.article_code
            LEFT JOIN proforma_name pn ON pn.article_code = ac.article_code
            LEFT JOIN latest_bale_name lbn ON lbn.article_code = ac.article_code
            LEFT JOIN stock s ON s.article_code = ac.article_code
            LEFT JOIN loading l ON l.article_code = ac.article_code
            LEFT JOIN expected e ON e.article_code = ac.article_code
          ),
          filtered AS (
            SELECT ab.* FROM article_base ab ${filteredWhere}
          ),
          page_rows AS (
            SELECT *
            FROM filtered
            ORDER BY product_name ASC, article_code ASC
            LIMIT ${limitParam} OFFSET ${offsetParam}
          )
          SELECT
            (SELECT COUNT(*)::int FROM filtered) AS total,
            COALESCE((SELECT SUM(stock_available)::int FROM filtered), 0) AS "stockAvailable",
            COALESCE((SELECT SUM(total_loaded)::int FROM filtered), 0) AS "totalLoaded",
            COALESCE((SELECT SUM(expected_to_load)::int FROM filtered), 0) AS "expectedToLoad",
            COALESCE((SELECT SUM(free_to_promise)::int FROM filtered), 0) AS "freeToPromise",
            COALESCE((SELECT SUM(total_kg)::int FROM filtered), 0) AS "totalKg",
            COALESCE((SELECT COUNT(*)::int FROM filtered WHERE free_to_promise < 0), 0) AS "shortageCount",
            COALESCE(
              (
                SELECT JSONB_AGG(
                  JSONB_BUILD_OBJECT(
                    'articleCode', article_code,
                    'productName', product_name,
                    'categoryName', COALESCE(category_name, ''),
                    'stockAvailable', stock_available,
                    'totalLoaded', total_loaded,
                    'expectedToLoad', expected_to_load,
                    'freeToPromise', free_to_promise,
                    'totalKg', total_kg,
                    'isGarbageOrWipers', is_garbage_or_wipers
                  )
                  ORDER BY product_name ASC, article_code ASC
                )
                FROM page_rows
              ),
              '[]'::jsonb
            ) AS rows
        `;

      const aggregateResult = await pool.query(aggregateQuery, values);
      const aggregate = aggregateResult.rows[0] ?? {};
      const pageRows: PageRow[] = (Array.isArray(aggregate.rows) ? aggregate.rows : []).map(
        (row: Record<string, unknown>) => ({
          articleCode: String(row.articleCode),
          productName: String(row.productName || row.articleCode),
          categoryName: String(row.categoryName || ""),
          stockAvailable: Number(row.stockAvailable || 0),
          totalLoaded: Number(row.totalLoaded || 0),
          expectedToLoad: Number(row.expectedToLoad || 0),
          freeToPromise: Number(row.freeToPromise || 0),
          totalKg: Number(row.totalKg || 0),
          isGarbageOrWipers: Boolean(row.isGarbageOrWipers),
          proformaDetails: [],
        })
      );

      const pageCodes = pageRows.map((row) => row.articleCode);
      if (pageCodes.length > 0) {
        const detailValues: unknown[] = [companyId, pageCodes, ACTIVE_ORDER_STATUSES];
        const detailConditions = [`cp.company_id = $1`, `cp.is_active = true`];
        if (fromDate) {
          detailValues.push(fromDate);
          detailConditions.push(`cp.created_at >= $${detailValues.length}::date`);
        }
        if (toDate) {
          detailValues.push(toDate);
          detailConditions.push(`cp.created_at < ($${detailValues.length}::date + INTERVAL '1 day')`);
        }

        const detailsResult = await pool.query(
          `
              WITH active_proformas AS (
                SELECT cp.id, cp.customer_id, cp.name
                FROM customer_proformas cp
                WHERE ${detailConditions.join(" AND ")}
              ),
              active_orders AS (
                SELECT co.id,
                       co.proforma_id_used AS proforma_id,
                       co.container_number,
                       co.status,
                       co.customer_id
                FROM customer_orders co
                JOIN active_proformas ap ON ap.id = co.proforma_id_used
                WHERE co.company_id = $1
                  AND co.status = ANY($3::text[])
                  AND co.proforma_id_used IS NOT NULL
              ),
              loaded AS (
                SELECT cob.order_id, fb.article_code, COUNT(*)::int AS loaded_qty
                FROM customer_order_bales cob
                JOIN factory_bales fb ON fb.id = cob.bale_id
                JOIN active_orders ao ON ao.id = cob.order_id
                WHERE fb.article_code = ANY($2::text[])
                GROUP BY cob.order_id, fb.article_code
              )
              SELECT
                cpl.article_code AS "articleCode",
                ap.id AS "proformaId",
                ap.name AS "proformaName",
                ap.customer_id AS "customerId",
                COALESCE(c.legal_name, 'Customer #' || ap.customer_id::text) AS "customerName",
                cpl.quantity::int AS "lineQty",
                ao.id AS "orderId",
                ao.container_number AS "containerNumber",
                ao.status,
                COALESCE(cel.expected_qty, cpl.quantity)::int AS "expectedQty",
                COALESCE(l.loaded_qty, 0)::int AS "loadedQty"
              FROM active_proformas ap
              JOIN customer_proforma_lines cpl ON cpl.proforma_id = ap.id
              LEFT JOIN customers c ON c.id = ap.customer_id
              LEFT JOIN active_orders ao ON ao.proforma_id = ap.id
              LEFT JOIN customer_order_expected_lines cel
                ON cel.order_id = ao.id AND cel.article_code = cpl.article_code
              LEFT JOIN loaded l
                ON l.order_id = ao.id AND l.article_code = cpl.article_code
              WHERE cpl.article_code = ANY($2::text[])
              ORDER BY cpl.article_code, ap.id, ao.id
            `,
          detailValues
        );

        const pageMap = new Map(pageRows.map((row) => [row.articleCode, row]));
        const proformaMaps = new Map<string, Map<number, ProformaDetail>>();

        for (const detail of detailsResult.rows) {
          const articleCode = String(detail.articleCode);
          const target = pageMap.get(articleCode);
          if (!target) continue;

          let articleMap = proformaMaps.get(articleCode);
          if (!articleMap) {
            articleMap = new Map<number, ProformaDetail>();
            proformaMaps.set(articleCode, articleMap);
          }

          const proformaId = Number(detail.proformaId);
          let proforma = articleMap.get(proformaId);
          if (!proforma) {
            proforma = {
              proformaId,
              proformaName: String(detail.proformaName || `Proforma #${proformaId}`),
              customerId: Number(detail.customerId),
              customerName: String(detail.customerName || `Customer #${detail.customerId}`),
              lineQty: Number(detail.lineQty || 0),
              containerCount: 0,
              totalExpected: 0,
              containers: [],
            };
            articleMap.set(proformaId, proforma);
            target.proformaDetails.push(proforma);
          }

          if (detail.orderId != null) {
            const expectedQty = Number(detail.expectedQty || 0);
            const loadedQty = Number(detail.loadedQty || 0);
            proforma.containers.push({
              orderId: Number(detail.orderId),
              containerName: String(detail.containerNumber || `Order #${detail.orderId}`),
              status: String(detail.status),
              expectedQty,
              loadedQty,
              remainingQty: Math.max(expectedQty - loadedQty, 0),
            });
            proforma.totalExpected += expectedQty;
            proforma.containerCount += 1;
          }
        }
      }

      const total = Number(aggregate.total || 0);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      const productNames = Object.fromEntries(pageRows.map((row) => [row.articleCode, row.productName]));
      const totals = {
        stockAvailable: Number(aggregate.stockAvailable || 0),
        totalLoaded: Number(aggregate.totalLoaded || 0),
        expectedToLoad: Number(aggregate.expectedToLoad || 0),
        freeToPromise: Number(aggregate.freeToPromise || 0),
        totalKg: Number(aggregate.totalKg || 0),
        shortageCount: Number(aggregate.shortageCount || 0),
      };

      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("X-Page", String(page));
      res.setHeader("X-Page-Size", String(limit));
      res.setHeader("X-Total-Pages", String(totalPages));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");

      return res.json({
        rows: pageRows,
        totals,
        productNames,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
