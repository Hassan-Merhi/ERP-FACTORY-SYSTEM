/** Read-only worker and bale drill-downs for the Monthly Production Matrix.
 * All three levels use the same company/product/month/status predicate.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { logger } from "../../../lib/logger";
import { resultRows } from "../../../lib/queryResult";
import { authorizeFactoryPageAccess, sendFactoryAccessDenied } from "../../../lib/factoryAccessControl";

type Row = Record<string, unknown>;
type Period = { productId: number; months: string[] };
const number = (value: unknown) => Number(value ?? 0);
const companyFor = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId);

function parsePeriod(req: Request): Period | null {
  const rawProduct = req.query.productId;
  const rawMonths = req.query.months;
  if (typeof rawProduct !== "string" || !/^[1-9]\d*$/.test(rawProduct) ||
      typeof rawMonths !== "string") return null;
  const productId = Number(rawProduct);
  const months = [...new Set(rawMonths.split(","))];
  if (!Number.isSafeInteger(productId) || months.length === 0 || months.length > 240 ||
      months.some((m) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) return null;
  return { productId, months };
}

// IMPORTANT: This is deliberately identical to the matrix counting rule.
// One active, non-deleted bale = one produced bale, even if its stock status
// has subsequently changed or it was imported without a worker.
function productionSource(companyId: number, period: Period) {
  const monthParams = sql.join(period.months.map((month) => sql`${month}`), sql`, `);
  return sql`
    FROM factory_bales b
    JOIN factory_bale_products p
      ON p.company_id = b.company_id AND p.deleted_at IS NULL AND p.active = TRUE
      AND (p.id = b.product_id OR (b.product_id IS NULL AND p.article_code = b.article_code))
    WHERE b.company_id = ${companyId}
      AND p.id = ${period.productId}
      AND b.deleted_at IS NULL
      AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')
      AND TO_CHAR(DATE_TRUNC('month', COALESCE(b.stock_entry_date::date, b.created_at::date)), 'YYYY-MM')
          IN (${monthParams})
  `;
}

async function productFor(companyId: number, productId: number) {
  const result = await db.execute(sql`
    SELECT id, name, article_code AS "articleCode"
      FROM factory_bale_products
     WHERE company_id = ${companyId} AND id = ${productId}
       AND deleted_at IS NULL AND active = TRUE
     LIMIT 1
  `);
  const row = resultRows<Row>(result)[0];
  return row ? { id: number(row.id), name: String(row.name), articleCode: String(row.articleCode ?? "") } : null;
}

function readPage(value: unknown): number {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value)) ? Number(value) : 1;
}

export function registerFactoryMonthlyProductionDrilldownRoutes(app: Express): void {
  app.get("/api/factory/monthly-production-matrix/workers", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyFor(req);
    if (!Number.isSafeInteger(companyId) || companyId <= 0)
      return res.status(400).json({ message: "No company selected" });
    const access = await authorizeFactoryPageAccess(req, "factory/monthly-production-matrix");
    if (!access.allowed) return sendFactoryAccessDenied(res, access);
    const period = parsePeriod(req);
    if (!period) return res.status(400).json({ message: "Invalid product or months" });

    try {
      const product = await productFor(companyId, period.productId);
      if (!product) return res.status(404).json({ message: "Item not found" });

      const result = await db.execute(sql`
        SELECT COALESCE(b.finalized_by, 0)::int AS "workerId",
          CASE WHEN b.finalized_by IS NULL THEN 'Unassigned'
            ELSE COALESCE(NULLIF(MAX(b.worker_name), ''), NULLIF(MAX(fw.full_name), ''), 'Unknown worker')
          END AS "workerName",
          COUNT(*)::int AS quantity,
          COALESCE(SUM(b.weight_kg), 0)::text AS "weightKg"
        ${productionSource(companyId, period)}
        LEFT JOIN factory_workers fw ON fw.id = b.finalized_by AND fw.company_id = b.company_id
        GROUP BY b.finalized_by
        ORDER BY quantity DESC, "workerName" ASC
      `);
      const workers = resultRows<Row>(result).map((row) => ({
        workerId: number(row.workerId),
        workerName: String(row.workerName ?? "Unassigned"),
        quantity: number(row.quantity),
        weightKg: String(row.weightKg ?? "0"),
      }));
      res.set("Cache-Control", "private, no-store");
      return res.json({
        product, months: period.months, workers,
        totalBales: workers.reduce((sum, row) => sum + row.quantity, 0),
        totalWeightKg: workers.reduce((sum, row) => sum + number(row.weightKg), 0),
      });
    } catch (error: unknown) {
      logger.error("Monthly production workers failed", { error });
      return res.status(500).json({ message: "Unable to load worker production" });
    }
  });

  app.get("/api/factory/monthly-production-matrix/bales", requireAuth, async (req: Request, res: Response) => {
    const companyId = companyFor(req);
    if (!Number.isSafeInteger(companyId) || companyId <= 0)
      return res.status(400).json({ message: "No company selected" });
    const access = await authorizeFactoryPageAccess(req, "factory/monthly-production-matrix");
    if (!access.allowed) return sendFactoryAccessDenied(res, access);
    const period = parsePeriod(req);
    const rawWorker = req.query.workerId;
    if (!period || typeof rawWorker !== "string" || !/^(0|[1-9]\d*)$/.test(rawWorker) ||
        !Number.isSafeInteger(Number(rawWorker)))
      return res.status(400).json({ message: "Invalid product, months or worker" });
    const workerId = Number(rawWorker);
    const page = Math.min(readPage(req.query.page), 100000);
    const limit = 100;
    const offset = (page - 1) * limit;

    try {
      const product = await productFor(companyId, period.productId);
      if (!product) return res.status(404).json({ message: "Item not found" });
      const workerFilter = workerId === 0 ? sql`b.finalized_by IS NULL` : sql`b.finalized_by = ${workerId}`;
      const [countResult, rowsResult] = await Promise.all([
        db.execute(sql`SELECT COUNT(*)::int AS total ${productionSource(companyId, period)} AND ${workerFilter}`),
        db.execute(sql`
          SELECT b.id, b.bale_code AS "baleCode", b.reference_number AS "referenceNumber",
                 b.article_code AS "articleCode", b.product_name AS "productName",
                 b.weight_kg::text AS "weightKg", b.quantity, b.status,
                 b.stock_entry_date::text AS "stockEntryDate",
                 b.finalized_at AS "finalizedAt",
                 b.category, b.grade, b.worker_name AS "workerName",
                 l.name AS "locationName"
          ${productionSource(companyId, period)}
          LEFT JOIN locations l ON l.id = b.erp_location_id AND l.company_id = b.company_id
          AND ${workerFilter}
          ORDER BY b.stock_entry_date DESC NULLS LAST, b.created_at DESC, b.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
      ]);
      const totalBales = number(resultRows<Row>(countResult)[0]?.total);
      const bales = resultRows<Row>(rowsResult).map((row) => ({
        id: number(row.id),
        baleCode: String(row.baleCode ?? ""),
        referenceNumber: String(row.referenceNumber ?? ""),
        articleCode: String(row.articleCode ?? ""),
        productName: String(row.productName ?? ""),
        weightKg: String(row.weightKg ?? "0"),
        quantity: number(row.quantity),
        status: String(row.status ?? ""),
        stockEntryDate: row.stockEntryDate == null ? null : String(row.stockEntryDate),
        finalizedAt: row.finalizedAt == null ? null : String(row.finalizedAt),
        category: row.category == null ? null : String(row.category),
        grade: row.grade == null ? null : String(row.grade),
        workerName: row.workerName == null ? null : String(row.workerName),
        locationName: row.locationName == null ? null : String(row.locationName),
      }));
      res.set("Cache-Control", "private, no-store");
      return res.json({ product, months: period.months, workerId, page, limit, totalBales, bales });
    } catch (error: unknown) {
      logger.error("Monthly production bale details failed", { error });
      return res.status(500).json({ message: "Unable to load bale details" });
    }
  });
}
