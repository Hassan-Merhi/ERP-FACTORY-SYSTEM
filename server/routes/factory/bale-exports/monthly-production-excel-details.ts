/**
 * Read-only bulk bale records for a self-contained Monthly Production XLSX.
 * Paged to keep JSON payloads bounded; company/page authorization is mandatory.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import { authorizeFactoryPageAccess, sendFactoryAccessDenied } from "../../../lib/factoryAccessControl";

type Row = Record<string, unknown>;
const PAGE_SIZE = 1500;

function parseIds(raw: unknown): number[] | null {
  if (typeof raw !== "string" || !raw || raw.length > 16000) return null;
  const parts = raw.split(",");
  if (parts.length === 0 || parts.length > 2000 || parts.some((part) => !/^[1-9]\d*$/.test(part))) return null;
  const ids = [...new Set(parts.map(Number))];
  return ids.every((id) => Number.isSafeInteger(id)) ? ids : null;
}

function parseMonths(raw: unknown): string[] | null {
  if (typeof raw !== "string" || !raw) return null;
  const parts = raw.split(",");
  if (parts.length === 0 || parts.length > 240 ||
      parts.some((part) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(part))) return null;
  return [...new Set(parts)];
}

export function registerFactoryMonthlyProductionExcelDetailRoutes(app: Express): void {
  app.get("/api/factory/monthly-production-matrix/export-bales", requireAuth, async (req: Request, res: Response) => {
    const companyId = Number(req.session.factoryCompanyId || req.session.currentCompanyId);
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ message: "No company selected" });
    }
    const access = await authorizeFactoryPageAccess(req, "factory/monthly-production-matrix");
    if (!access.allowed) return sendFactoryAccessDenied(res, access);
    const productIds = parseIds(req.query.productIds);
    const months = parseMonths(req.query.months);
    const rawPage = req.query.page;
    if (!productIds || !months || typeof rawPage !== "string" || !/^[1-9]\d*$/.test(rawPage)) {
      return res.status(400).json({ message: "Invalid export product IDs, months or page" });
    }
    const page = Number(rawPage);
    if (!Number.isSafeInteger(page) || page > 200) {
      return res.status(400).json({ message: "Export page is out of range" });
    }
    const offset = (page - 1) * PAGE_SIZE;
    // Same product fallback / date choice / status exclusions as the live matrix.
    const productSql = sql.join(productIds.map((id) => sql`${id}`), sql`, `);
    const monthSql = sql.join(months.map((month) => sql`${month}`), sql`, `);
    try {
      const response = await db.execute(sql`
        SELECT b.id AS "baleId", p.id AS "productId",
               TO_CHAR(DATE_TRUNC('month', COALESCE(b.stock_entry_date::date, b.created_at::date)), 'YYYY-MM') AS month,
               COALESCE(b.finalized_by, 0)::int AS "workerId",
               COALESCE(NULLIF(b.worker_name, ''), NULLIF(fw.full_name, ''),
                 CASE WHEN b.finalized_by IS NULL THEN 'Unassigned' ELSE 'Unknown worker' END) AS "workerName",
               b.reference_number AS "referenceNumber", b.bale_code AS "baleCode",
               COALESCE(b.stock_entry_date::date, b.created_at::date)::text AS date,
               p.name AS "productName", COALESCE(b.weight_kg, 0)::text AS "weightKg",
               b.status, COALESCE(b.category, '') AS category, COALESCE(b.grade, '') AS grade,
               COALESCE(l.name, '') AS "locationName"
        FROM factory_bales b
        JOIN factory_bale_products p ON p.company_id = b.company_id
          AND p.deleted_at IS NULL AND p.active = TRUE
          AND (p.id = b.product_id OR (b.product_id IS NULL AND p.article_code = b.article_code))
        LEFT JOIN factory_workers fw ON fw.id = b.finalized_by AND fw.company_id = b.company_id
        LEFT JOIN locations l ON l.id = b.erp_location_id AND l.company_id = b.company_id
        WHERE b.company_id = ${companyId}
          AND p.id IN (${productSql})
          AND TO_CHAR(DATE_TRUNC('month', COALESCE(b.stock_entry_date::date, b.created_at::date)), 'YYYY-MM')
            IN (${monthSql})
          AND b.deleted_at IS NULL AND b.status NOT IN ('DELETED', 'REMOVED', 'REPACKED')
        ORDER BY p.id, b.finalized_by NULLS FIRST, b.stock_entry_date DESC NULLS LAST, b.created_at DESC, b.id DESC
        LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}
      `);
      const rows = resultRows<Row>(response);
      const hasMore = rows.length > PAGE_SIZE;
      const bales = rows.slice(0, PAGE_SIZE).map((row) => ({
        baleId: Number(row.baleId),
        productId: Number(row.productId),
        month: String(row.month ?? ""),
        workerId: Number(row.workerId ?? 0),
        workerName: String(row.workerName ?? "Unassigned"),
        referenceNumber: String(row.referenceNumber ?? ""),
        baleCode: String(row.baleCode ?? ""),
        date: String(row.date ?? ""),
        productName: String(row.productName ?? ""),
        weightKg: String(row.weightKg ?? "0"),
        status: String(row.status ?? ""),
        category: String(row.category ?? ""),
        grade: String(row.grade ?? ""),
        locationName: String(row.locationName ?? ""),
      }));
      res.set("Cache-Control", "private, no-store");
      return res.json({ page, hasMore, bales });
    } catch (error: unknown) {
      logger.error("Monthly production workbook details failed", { error });
      return res.status(500).json({ message: "Unable to load production details for Excel" });
    }
  });
}
