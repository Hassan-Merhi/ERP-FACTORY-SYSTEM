/**
 * Pressing Phase 6: server-authoritative production history.
 * GET reports never mutate stock, costing, finalization or accounting.
 */
import type { Express, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { db, pool } from "../../db";
import { requireAuth } from "../../auth";
import { factoryPressingSavedViews, factorySettings } from "@shared/schema";
import { getActiveCompanyPermissionContext, ActiveCompanyPermissionContextError } from "../../services/security/activeCompanyPermissionContext";
import { logger } from "../../lib/logger";
import { pressingReportFiltersSchema, pressingSavedViewSchema, type PressingReportFilters } from "@shared/pressingReportContracts";
import { factoryLocalDate, settingsTimezone } from "../../services/factory/pressingShiftTime";

// Worker history is always restricted to the authenticated user, including Manager and Developer.
const MANAGER_ROLES = new Set(["Admin", "Owner"]);
type QueryCtx = { companyId: number; userId: string; supervisor: boolean };
type Param = string | number;
class ReportPermissionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function handleError(res: Response, error: unknown) {
  if (error instanceof ZodError) {
    return res.status(400).json({ code: "PRESSING_INVALID_REPORT_FILTER", message: "Invalid pressing history filter", issues: error.issues });
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof ReportPermissionError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  const pgErr = error as { code?: string; cause?: { code?: string } };
  if (pgErr?.code === "23505" || pgErr?.cause?.code === "23505") {
    return res.status(409).json({ code: "PRESSING_VIEW_CONFLICT", message: "A conflicting saved view already exists" });
  }
  logger.error("Pressing reporting error", { error });
  return res.status(500).json({ code: "PRESSING_REPORT_FAILED", message: "Unable to load pressing history" });
}
async function context(req: Request): Promise<QueryCtx> {
  const ctx = await getActiveCompanyPermissionContext(req);
  return { companyId: ctx.companyId, userId: ctx.userId,
    supervisor: MANAGER_ROLES.has(ctx.role) && !ctx.posViewOnly };
}
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, c => "\\" + c);
}
function conditions(ctx: QueryCtx, filters: PressingReportFilters) {
  const args: Param[] = [ctx.companyId];
  const where: string[] = ["c.company_id = $1"];
  const push = (fragment: string, value: Param) => {
    args.push(value);
    where.push(fragment.replace("?", "$" + args.length));
  };
  if (!ctx.supervisor) {
    if (filters.userId && filters.userId !== ctx.userId) {
      throw new ReportPermissionError(403, "PRESSING_REPORT_FORBIDDEN", "Operators can view only their own records");
    }
    push("c.user_id = ?", ctx.userId);
  } else if (filters.userId) {
    push("c.user_id = ?", filters.userId);
  }
  if (filters.from) push("c.production_date >= ?::date", filters.from);
  if (filters.to) push("c.production_date <= ?::date", filters.to);
  if (filters.asOf) push("c.confirmed_at <= ?::timestamptz", filters.asOf);
  if (filters.machineId) push("c.machine_id = ?", filters.machineId);
  if (filters.shiftId) push("c.shift_id = ?", filters.shiftId);
  if (filters.articleCode) push("c.article_code ILIKE ?", "%" + escapeLike(filters.articleCode) + "%");
  if (filters.search) {
    args.push("%" + escapeLike(filters.search) + "%");
    const ref = "$" + args.length;
    where.push("(c.reference_number ILIKE " + ref + " OR c.article_code ILIKE " + ref +
      " OR c.product_name ILIKE " + ref + ")");
  }
  return { args, where };
}
function statusPredicate(status: PressingReportFilters["status"]): string | null {
  if (status === "active") return "c.voided_at IS NULL";
  if (status === "voided") return "c.voided_at IS NOT NULL";
  return null;
}

async function report(ctx: QueryCtx, filters: PressingReportFilters) {
  // Freeze all pages and summary at a server-derived cutoff, not the phone clock.
  const asOf = filters.asOf ?? new Date().toISOString();
  filters = { ...filters, asOf };
  const { args, where } = conditions(ctx, filters);
  const currentStatus = statusPredicate(filters.status);
  if (currentStatus) where.push(currentStatus);
  const from = " FROM factory_pressing_confirmations c WHERE " + where.join(" AND ");
  const detail = [
    'c.id', 'c.reference_number AS "referenceNumber"', 'c.article_code AS "articleCode"',
    'c.product_name AS "productName"', 'c.weight_kg AS "weightKg"',
    'c.machine_id AS "machineId"', 'c.machine_name_snapshot AS "machineName"',
    'c.user_id AS "operatorUserId"', 'c.user_name_snapshot AS "operatorName"',
    'c.shift_id AS "shiftId"', 'c.production_date::text AS "productionDate"',
    'c.confirmed_at AS "confirmedAt"', 'c.device_captured_at AS "deviceCapturedAt"',
    'c.voided_at AS "voidedAt"', 'c.timezone_name AS "timezoneName"',
    // Previous accepted bale on the same machine is independent of current
    // date/employee/article filters; voided confirmations are excluded.
    '(SELECT FLOOR(EXTRACT(EPOCH FROM (c.confirmed_at - p.confirmed_at)))::bigint ' +
      'FROM factory_pressing_confirmations p WHERE p.company_id = c.company_id ' +
      'AND p.machine_id = c.machine_id AND p.voided_at IS NULL ' +
      'AND (p.confirmed_at,p.id) < (c.confirmed_at,c.id) ' +
      'ORDER BY p.confirmed_at DESC,p.id DESC LIMIT 1) AS "secondsSincePrevious"',
  ].join(", ");
  const condensed = [
    'c.production_date::text AS "productionDate"', 'c.machine_id AS "machineId"',
    'MAX(c.machine_name_snapshot) AS "machineName"', 'c.user_id AS "operatorUserId"',
    'MAX(c.user_name_snapshot) AS "operatorName"', 'c.shift_id AS "shiftId"',
    'c.article_code AS "articleCode"', 'MAX(c.timezone_name) AS "timezoneName"',
    '(c.voided_at IS NOT NULL) AS "voided"',
    'COUNT(*)::integer AS "bales"', 'COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS "weightKg"',
    'MIN(c.confirmed_at) AS "firstScanAt"', 'MAX(c.confirmed_at) AS "lastScanAt"',
  ].join(", ");
  const group = ' GROUP BY c.production_date,c.machine_id,c.user_id,c.shift_id,c.article_code,(c.voided_at IS NOT NULL)';
  const detailed = filters.mode === "detailed";
  const selectSql = detailed
    ? 'SELECT ' + detail + from + ' ORDER BY c.confirmed_at DESC,c.id DESC'
    : 'SELECT ' + condensed + from + group +
      ' ORDER BY c.production_date DESC,c.machine_id,c.user_id,c.article_code NULLS LAST,' +
      'c.shift_id NULLS LAST,(c.voided_at IS NOT NULL) ASC';
  const countSql = detailed
    ? 'SELECT COUNT(*)::integer AS total' + from
    : 'SELECT COUNT(*)::integer AS total FROM (SELECT 1' + from + group + ') t';
  const pageArgs = [...args, filters.limit, (filters.page - 1) * filters.limit];
  const sqlPage = selectSql + " LIMIT $" + (args.length + 1) + " OFFSET $" + (args.length + 2);

  // Production KPIs count only non-voided records even when the history
  // filter displays voided audit rows.
  const sumConditions = conditions(ctx, filters);
  const sumSql = 'SELECT COUNT(*) FILTER (WHERE c.voided_at IS NULL)::integer AS "totalBales",' +
    'COALESCE(SUM(c.weight_kg) FILTER (WHERE c.voided_at IS NULL),0)::numeric(18,3) AS "totalKg",' +
    'COUNT(*) FILTER (WHERE c.voided_at IS NOT NULL)::integer AS "voidedBales"' +
    ' FROM factory_pressing_confirmations c WHERE ' + sumConditions.where.join(" AND ");
  const [rows, count, summary] = await Promise.all([
    pool.query(sqlPage, pageArgs),
    pool.query(countSql, args),
    pool.query(sumSql, sumConditions.args),
  ]);
  return {
    rows: rows.rows,
    total: Number(count.rows[0]?.total || 0),
    summary: summary.rows[0] ?? { totalBales: 0, totalKg: "0", voidedBales: 0 },
    page: filters.page, limit: filters.limit, mode: filters.mode,
    asOf,
  };
}
export function registerFactoryPressingReportRoutes(app: Express): void {
  // Team-wide totals are safe for permitted pressing workers to see. Keep the
  // individual confirmation history endpoint operator-scoped for non-admins.
  app.get("/api/factory/pressing-machines/report/worker-totals", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      // P1/P2/P3 are the dedicated pressing worker logins. Other accounts
      // (including Admin, Manager, Owner and Developer) must never appear in
      // the worker scoreboard, even if they initialized a pressing station.
      // Membership is checked in the active company; no cross-company rows.
      const result = await pool.query(
        `SELECT u.id AS "userId",
          COALESCE(NULLIF(MAX(p.display_name), ''), u.username) AS "name",
          COUNT(c.id)::integer AS "totalBales",
          COALESCE(SUM(c.weight_kg), 0)::numeric(18,3) AS "totalKg"
        FROM users u
        LEFT JOIN factory_user_profiles p
          ON p.company_id = $1 AND p.user_id = u.id
        LEFT JOIN factory_pressing_confirmations c
          ON c.company_id = $1 AND c.user_id = u.id AND c.voided_at IS NULL
        WHERE UPPER(BTRIM(u.username)) IN ('P1', 'P2', 'P3')
          AND EXISTS (
            SELECT 1 FROM user_company_roles r
            WHERE r.company_id = $1 AND r.user_id = u.id
              AND r.role IN ('User', 'Normal User')
          )
        GROUP BY u.id, u.username
        ORDER BY UPPER(BTRIM(u.username))`,
        [ctx.companyId],
      );
      return res.json({ workers: result.rows });
    } catch (error) { return handleError(res, error); }
  });

  app.get("/api/factory/pressing-machines/report", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const filters = pressingReportFiltersSchema.parse(req.query);
      if (filters.from && filters.to && filters.from > filters.to) {
        return res.status(400).json({ code: "PRESSING_INVALID_DATES", message: "From date cannot exceed To date" });
      }
      return res.json(await report(ctx, filters));
    } catch (error) { return handleError(res, error); }
  });

  app.get("/api/factory/pressing-machines/report/options", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const operators = ctx.supervisor
        ? (await pool.query(
          'SELECT c.user_id AS "userId",COALESCE(MAX(c.user_name_snapshot),c.user_id) AS name ' +
          'FROM factory_pressing_confirmations c WHERE c.company_id=$1 ' +
          'GROUP BY c.user_id ORDER BY name LIMIT 1500', [ctx.companyId]
        )).rows
        : [];
      const [settings] = await db.select({ extraSettings: factorySettings.extraSettings })
        .from(factorySettings).where(eq(factorySettings.companyId, ctx.companyId)).limit(1);
      // One production date basis: company settings only; no shifts.
      const timeZone = settingsTimezone(settings?.extraSettings);
      const serverToday = factoryLocalDate(new Date(), timeZone);
      return res.json({ operators, canViewAll: ctx.supervisor, serverToday, timeZone });
    } catch (error) { return handleError(res, error); }
  });

  app.get("/api/factory/pressing-machines/report/views", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const views = await db.select().from(factoryPressingSavedViews)
        .where(and(eq(factoryPressingSavedViews.companyId, ctx.companyId),
          eq(factoryPressingSavedViews.userId, ctx.userId)))
        .orderBy(asc(factoryPressingSavedViews.name));
      return res.json(views);
    } catch (error) { return handleError(res, error); }
  });

  app.post("/api/factory/pressing-machines/report/views", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const body = pressingSavedViewSchema.parse(req.body);
      if (body.filters.from && body.filters.to && body.filters.from > body.filters.to) {
        return res.status(400).json({ code: "PRESSING_INVALID_DATES", message: "Saved view has an invalid date range" });
      }
      if (!ctx.supervisor && body.filters.userId && body.filters.userId !== ctx.userId) {
        throw new ReportPermissionError(403, "PRESSING_REPORT_FORBIDDEN", "Cannot save filters for another operator");
      }
      const view = await db.transaction(async tx => {
        if (body.isDefault) {
          await tx.update(factoryPressingSavedViews).set({ isDefault: false, updatedAt: new Date() })
            .where(and(eq(factoryPressingSavedViews.companyId, ctx.companyId),
              eq(factoryPressingSavedViews.userId, ctx.userId)));
        }
        const [record] = await tx.insert(factoryPressingSavedViews).values({
          companyId: ctx.companyId, userId: ctx.userId, name: body.name, reportMode: body.mode,
          filters: body.filters, visibleColumns: body.visibleColumns, isDefault: body.isDefault,
        }).onConflictDoUpdate({
          target: [factoryPressingSavedViews.companyId,
            factoryPressingSavedViews.userId, factoryPressingSavedViews.name],
          set: { reportMode: body.mode, filters: body.filters,
            visibleColumns: body.visibleColumns, isDefault: body.isDefault, updatedAt: new Date() },
        }).returning();
        return record;
      });
      return res.json(view);
    } catch (error) { return handleError(res, error); }
  });

  app.post("/api/factory/pressing-machines/report/views/:id/remove", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: "Invalid saved view ID" });
      const [removed] = await db.delete(factoryPressingSavedViews).where(and(
        eq(factoryPressingSavedViews.id, id),
        eq(factoryPressingSavedViews.companyId, ctx.companyId),
        eq(factoryPressingSavedViews.userId, ctx.userId),
      )).returning({ id: factoryPressingSavedViews.id });
      if (!removed) return res.status(404).json({ message: "Saved view not found" });
      return res.json(removed);
    } catch (error) { return handleError(res, error); }
  });
}
