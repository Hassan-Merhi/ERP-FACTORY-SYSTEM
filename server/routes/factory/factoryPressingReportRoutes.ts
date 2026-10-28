/**
 * Pressing Phase 6: server-authoritative production history.
 * GET reports never mutate stock, costing, finalization or accounting.
 */
import type { Express, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { ZodError, z } from "zod";
import { db, pool } from "../../db";
import { requireAuth } from "../../auth";
import { factoryPressingSavedViews } from "@shared/schema";
import { getActiveCompanyPermissionContext, ActiveCompanyPermissionContextError } from "../../services/security/activeCompanyPermissionContext";
import { logger } from "../../lib/logger";
import { pressingReportFiltersSchema, pressingSavedViewSchema, type PressingReportFilters } from "@shared/pressingReportContracts";
import { factoryLocalDate } from "../../services/factory/pressingShiftTime";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";

// Individual worker history stays scoped; Admin, Owner and Developer can view company reports.
const MANAGER_ROLES = new Set(["Admin", "Owner", "Developer"]);
type QueryCtx = { companyId: number; userId: string; supervisor: boolean; canCorrect: boolean };
type Param = string | number;
// All report dates are Beirut wall-clock dates derived from the immutable UTC
// confirmed_at instant, including historical rows recorded with UTC snapshots.
const PRESSING_LOCAL_DATE_SQL = "(c.confirmed_at AT TIME ZONE '" + PRESSING_TIME_ZONE + "')::date";
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
    supervisor: MANAGER_ROLES.has(ctx.role) && !ctx.posViewOnly,
    canCorrect: (ctx.role === "Admin" || ctx.role === "Owner") && !ctx.posViewOnly };
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
  // Calculate inclusive Beirut dates with timezone-aware boundaries. These
  // remain correct across the winter UTC+2 / summer UTC+3 DST transition
  // and preserve use of the confirmed_at index for large histories.
  if (filters.from) {
    if (filters.fromTime) {
      push("c.confirmed_at >= (?::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "')",
        filters.from + " " + filters.fromTime);
    } else {
      push("c.confirmed_at >= (?::date::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "')", filters.from);
    }
  }
  if (filters.to) {
    if (filters.toTime) {
      // Inclusive ending minute: 14:30 includes scans through 14:30:59.999.
      push("c.confirmed_at < ((?::timestamp + interval '1 minute') AT TIME ZONE '" + PRESSING_TIME_ZONE + "')",
        filters.to + " " + filters.toTime);
    } else {
      push("c.confirmed_at < ((?::date + 1)::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "')", filters.to);
    }
  }
  if (filters.asOf) push("c.confirmed_at <= ?::timestamptz", filters.asOf);
  if (filters.machineId) push("c.machine_id = ?", filters.machineId);
  if (filters.weightKg !== undefined) push("c.weight_kg = ?::numeric", filters.weightKg);
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
function invalidDateTimeRange(filters: PressingReportFilters): boolean {
  return Boolean(
    (filters.fromTime && !filters.from) ||
    (filters.toTime && !filters.to) ||
    (filters.from && filters.to && (filters.from > filters.to ||
      (filters.from === filters.to && filters.fromTime && filters.toTime &&
        filters.fromTime > filters.toTime)))
  );
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
    'c.shift_id AS "shiftId"', PRESSING_LOCAL_DATE_SQL + '::text AS "productionDate"',
    'c.confirmed_at AS "confirmedAt"', 'c.device_captured_at AS "deviceCapturedAt"',
    'c.voided_at AS "voidedAt"', "'" + PRESSING_TIME_ZONE + "' AS \"timezoneName\"",
    '(c.voided_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM factory_pressing_confirmations active ' +
      'WHERE active.company_id = c.company_id AND active.bale_id = c.bale_id ' +
      'AND active.voided_at IS NULL)) AS "canReturn"',
    // Previous accepted bale on the same machine is independent of current
    // date/employee/article filters; voided confirmations are excluded.
    '(SELECT FLOOR(EXTRACT(EPOCH FROM (c.confirmed_at - p.confirmed_at)))::bigint ' +
      'FROM factory_pressing_confirmations p WHERE p.company_id = c.company_id ' +
      'AND p.machine_id = c.machine_id AND p.voided_at IS NULL ' +
      'AND (p.confirmed_at,p.id) < (c.confirmed_at,c.id) ' +
      'ORDER BY p.confirmed_at DESC,p.id DESC LIMIT 1) AS "secondsSincePrevious"',
  ].join(", ");
  const condensed = [
    PRESSING_LOCAL_DATE_SQL + '::text AS "productionDate"', 'c.machine_id AS "machineId"',
    'MAX(c.machine_name_snapshot) AS "machineName"', 'c.user_id AS "operatorUserId"',
    'MAX(c.user_name_snapshot) AS "operatorName"', 'c.shift_id AS "shiftId"',
    'c.article_code AS "articleCode"', 'c.product_name AS "productName"',
    "'" + PRESSING_TIME_ZONE + "' AS \"timezoneName\"",
    '(c.voided_at IS NOT NULL) AS "voided"',
    'COUNT(*)::integer AS "bales"', 'COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS "weightKg"',
    'MIN(c.confirmed_at) AS "firstScanAt"', 'MAX(c.confirmed_at) AS "lastScanAt"',
  ].join(", ");
  // Keep distinct bale names separate, even when they share an article code.
  const group = ' GROUP BY ' + PRESSING_LOCAL_DATE_SQL + ',c.machine_id,c.user_id,c.shift_id,c.article_code,c.product_name,(c.voided_at IS NOT NULL)';
  const detailed = filters.mode === "detailed";
  const selectSql = detailed
    ? 'SELECT ' + detail + from + ' ORDER BY c.confirmed_at DESC,c.id DESC'
    : 'SELECT ' + condensed + from + group +
      ' ORDER BY ' + PRESSING_LOCAL_DATE_SQL + ' DESC,c.machine_id,c.user_id,c.product_name NULLS LAST,c.article_code NULLS LAST,' +
      'c.shift_id NULLS LAST,(c.voided_at IS NOT NULL) ASC';
  const countSql = detailed
    ? 'SELECT COUNT(*)::integer AS total' + from
    : 'SELECT COUNT(*)::integer AS total FROM (SELECT 1' + from + group + ') t';
  const pageArgs = [...args, filters.limit, (filters.page - 1) * filters.limit];
  const sqlPage = selectSql + " LIMIT $" + (args.length + 1) + " OFFSET $" + (args.length + 2);

  // Production KPIs count only non-voided records even when the history
  // filter displays voided audit rows.
  const sumConditions = conditions(ctx, filters);
  const sumSqlFor = (where: string[]) =>
    'SELECT COUNT(*) FILTER (WHERE c.voided_at IS NULL)::integer AS "totalBales",' +
    'COALESCE(SUM(c.weight_kg) FILTER (WHERE c.voided_at IS NULL),0)::numeric(18,3) AS "totalKg",' +
    'COUNT(*) FILTER (WHERE c.voided_at IS NOT NULL)::integer AS "voidedBales"' +
    ' FROM factory_pressing_confirmations c WHERE ' + where.join(" AND ");
  // Always aggregate server-side across all matching records, never the 50
  // current groups on screen. Voided confirmations do not inflate the KPIs.
  const byOperatorSqlFor = (where: string[]) =>
    'SELECT c.user_id AS "userId",' +
    'MAX(c.user_name_snapshot) AS "name",' +
    'COUNT(*)::integer AS "totalBales",' +
    'COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS "totalKg"' +
    ' FROM factory_pressing_confirmations c WHERE ' + where.join(" AND ") +
    ' AND c.voided_at IS NULL GROUP BY c.user_id ORDER BY c.user_id';
  const sumSql = sumSqlFor(sumConditions.where);
  const perOperatorSql = byOperatorSqlFor(sumConditions.where);
  const [rows, count, summary, byOperator] = await Promise.all([
    pool.query(sqlPage, pageArgs),
    pool.query(countSql, args),
    pool.query(sumSql, sumConditions.args),
    pool.query(perOperatorSql, sumConditions.args),
  ]);
  const filteredSummary = { ...(summary.rows[0] ?? { totalBales: 0, totalKg: "0", voidedBales: 0 }),
    byOperator: byOperator.rows };
  // Filtering the table to P2 should not make P1/P3 or ALL WORKERS show
  // zero. Keep the dashboard across all operators for the selected date,
  // barcode, status and KG, while the history/export obey userId.
  let overview = filteredSummary;
  if (ctx.supervisor && filters.userId) {
    const allConditions = conditions(ctx, { ...filters, userId: undefined });
    const [allSummary, allOperators] = await Promise.all([
      pool.query(sumSqlFor(allConditions.where), allConditions.args),
      pool.query(byOperatorSqlFor(allConditions.where), allConditions.args),
    ]);
    overview = { ...(allSummary.rows[0] ?? { totalBales: 0, totalKg: "0", voidedBales: 0 }),
      byOperator: allOperators.rows };
  }
  // Resolve current company-scoped display names for every historical row and
  // summary, so renamed workers are shown correctly without rewriting evidence.
  const operatorIds = [...new Set([
    ...rows.rows.map(row => row.operatorUserId),
    ...filteredSummary.byOperator.map(row => row.userId),
    ...overview.byOperator.map(row => row.userId),
  ].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const profiles = operatorIds.length
    ? await pool.query(
      'SELECT user_id AS "userId", NULLIF(BTRIM(display_name), \'\') AS "displayName" ' +
        'FROM factory_user_profiles WHERE company_id = $1 AND user_id = ANY($2::varchar[])',
      [ctx.companyId, operatorIds],
    )
    : { rows: [] };
  const names = new Map<string, string>(
    profiles.rows.map(row => [row.userId, String(row.displayName || "").trim()]),
  );
  const displayName = (id: string) => names.get(id) || "Display name not set";
  return {
    rows: rows.rows.map(row => ({ ...row, operatorName: displayName(row.operatorUserId) })),
    total: Number(count.rows[0]?.total || 0),
    summary: { ...filteredSummary, byOperator: filteredSummary.byOperator.map(row => ({
      ...row, name: displayName(row.userId),
    })) },
    overview: { ...overview, byOperator: overview.byOperator.map(row => ({
      ...row, name: displayName(row.userId),
    })) },
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
          COALESCE(NULLIF(BTRIM(MAX(p.display_name)), ''), 'Display name not set') AS "name",
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


  // Uses the same three dedicated P1/P2/P3 accounts as the worker scoreboard.
  // An hour is measured by server-confirmed UTC instants. The generated
  // Beirut-local day is 23/24/25 hours as appropriate across DST changes.
  app.get("/api/factory/pressing-machines/report/hourly-targets", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const value = typeof req.query.day === "string" ? req.query.day : factoryLocalDate(new Date(), PRESSING_TIME_ZONE);
      const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(date =>
        !Number.isNaN(Date.parse(date + "T00:00:00Z")) &&
        new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
      ).parse(value);
      const workersResult = await pool.query(
        'SELECT u.id AS "userId", UPPER(BTRIM(u.username)) AS "slot", ' +
        'COALESCE(NULLIF(BTRIM(MAX(p.display_name)), \'\'), \'Display name not set\') AS name ' +
        'FROM users u LEFT JOIN factory_user_profiles p ON p.company_id=$1 AND p.user_id=u.id ' +
        "WHERE UPPER(BTRIM(u.username)) IN ('P1','P2','P3') AND EXISTS (" +
        "SELECT 1 FROM user_company_roles r WHERE r.company_id=$1 AND r.user_id=u.id " +
        "AND r.role IN ('User','Normal User')) " +
        'GROUP BY u.id,u.username ORDER BY UPPER(BTRIM(u.username))',
        [ctx.companyId],
      );
      const settings = await pool.query(
        "SELECT extra_settings->'pressingWorkerTargetsKg' AS targets FROM factory_settings WHERE company_id=$1",
        [ctx.companyId],
      );
      const raw = settings.rows[0]?.targets;
      const targets = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown> : {};
      const workers = workersResult.rows.map(row => {
        const configured = Number(targets[String(row.userId)]);
        return {
          ...row,
          targetKgPerHour: Number.isFinite(configured) && configured > 0 && configured <= 100000
            ? configured : 850,
        };
      });
      const result = await pool.query(
        'WITH hours AS (SELECT generate_series(' +
          "($2::date::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "'), " +
          "(($2::date + 1)::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "') - interval '1 hour', " +
          "interval '1 hour') AS hour_start), " +
        'scans AS (SELECT c.user_id, ' +
          "date_trunc('hour', c.confirmed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour_start, " +
          'COUNT(*)::integer AS bales, COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS kg ' +
          'FROM factory_pressing_confirmations c WHERE c.company_id=$1 AND c.voided_at IS NULL ' +
          "AND c.confirmed_at >= ($2::date::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "') " +
          "AND c.confirmed_at < (($2::date + 1)::timestamp AT TIME ZONE '" + PRESSING_TIME_ZONE + "') " +
          "GROUP BY c.user_id,date_trunc('hour', c.confirmed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') " +
        'SELECT h.hour_start AS "hourStart", w.user_id AS "userId", ' +
          'COALESCE(s.bales,0)::integer AS bales, COALESCE(s.kg,0)::numeric(18,3) AS kg ' +
          'FROM hours h CROSS JOIN (SELECT u.id AS user_id FROM users u ' +
          "WHERE UPPER(BTRIM(u.username)) IN ('P1','P2','P3') " +
          "AND EXISTS (SELECT 1 FROM user_company_roles r WHERE r.company_id=$1 AND r.user_id=u.id " +
          "AND r.role IN ('User','Normal User'))) w " +
          'LEFT JOIN scans s ON s.user_id=w.user_id AND s.hour_start=h.hour_start ' +
          'ORDER BY h.hour_start DESC,w.user_id',
        [ctx.companyId, day],
      );
      res.set("Cache-Control", "private, no-store");
      return res.json({ day, serverNow: new Date().toISOString(), canEdit: ctx.canCorrect,
        workers, hours: result.rows });
    } catch (error) { return handleError(res, error); }
  });

  // Store targets in existing company-scoped Factory settings, with an atomic
  // JSONB update so unrelated flags and other workers' targets are not lost.
  // Only Admin / Owner may edit; workers may not change their own targets.
  app.put("/api/factory/pressing-machines/report/hourly-targets", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      if (!ctx.canCorrect) throw new ReportPermissionError(403, "PRESSING_TARGET_FORBIDDEN", "Only Admin or Owner may edit pressing targets");
      const input = z.object({
        userId: z.string().trim().min(1).max(255),
        targetKgPerHour: z.number().finite().positive().max(100000),
      }).strict().parse(req.body);
      const eligible = await pool.query(
        "SELECT 1 FROM users u WHERE u.id=$2 AND UPPER(BTRIM(u.username)) IN ('P1','P2','P3') " +
        "AND EXISTS (SELECT 1 FROM user_company_roles r WHERE r.company_id=$1 AND r.user_id=u.id " +
        "AND r.role IN ('User','Normal User'))",
        [ctx.companyId, input.userId],
      );
      if (!eligible.rowCount) return res.status(404).json({ code: "PRESSING_WORKER_NOT_FOUND", message: "Pressing worker not found in this company" });
      await pool.query(
        "INSERT INTO factory_settings (company_id,extra_settings,updated_at) " +
        "VALUES ($1,jsonb_build_object('pressingWorkerTargetsKg',jsonb_build_object($2::text,$3::numeric)),now()) " +
        "ON CONFLICT (company_id) DO UPDATE SET " +
        "extra_settings=COALESCE(factory_settings.extra_settings,'{}'::jsonb) || " +
        "jsonb_build_object('pressingWorkerTargetsKg', " +
        "COALESCE(factory_settings.extra_settings->'pressingWorkerTargetsKg','{}'::jsonb) || " +
        "jsonb_build_object($2::text,$3::numeric)),updated_at=now()",
        [ctx.companyId, input.userId, input.targetKgPerHour],
      );
      return res.json({ saved: true, userId: input.userId, targetKgPerHour: input.targetKgPerHour });
    } catch (error) { return handleError(res, error); }
  });

  app.get("/api/factory/pressing-machines/report", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const filters = pressingReportFiltersSchema.parse(req.query);
      if (invalidDateTimeRange(filters)) {
        return res.status(400).json({ code: "PRESSING_INVALID_DATES",
          message: "Start date/time cannot exceed end date/time; time filters require a date" });
      }
      return res.json(await report(ctx, filters));
    } catch (error) { return handleError(res, error); }
  });

  app.get("/api/factory/pressing-machines/report/options", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      // Include assigned operators with zero scans so P1/P2/P3 filters are usable
      // before any production is recorded.
      const operators = ctx.supervisor
        ? (await pool.query(
          'WITH operator_ids AS (SELECT a.user_id FROM factory_pressing_assignments a WHERE a.company_id = $1 ' +
          'UNION SELECT c.user_id FROM factory_pressing_confirmations c WHERE c.company_id = $1 ' +
          'UNION SELECT u.id FROM users u JOIN user_company_roles r ON r.user_id = u.id ' +
          "AND r.company_id = $1 AND r.role IN ('User', 'Normal User') " +
          "WHERE UPPER(BTRIM(u.username)) IN ('P1', 'P2', 'P3')) " +
          'SELECT o.user_id AS "userId", MAX(u.username) AS username, ' +
          'NULLIF(BTRIM(MAX(p.display_name)), \'\') AS "displayName", ' +
          "EXISTS (SELECT 1 FROM user_company_roles r WHERE r.company_id = $1 " +
          "AND r.user_id = o.user_id AND r.role IN ('User', 'Normal User')) AS \"isPressingWorker\", " +
          "COALESCE(NULLIF(BTRIM(MAX(p.display_name)), ''), 'Display name not set') AS name " +
          'FROM operator_ids o LEFT JOIN users u ON u.id = o.user_id ' +
          'LEFT JOIN factory_user_profiles p ON p.company_id = $1 AND p.user_id = o.user_id ' +
          'LEFT JOIN factory_pressing_confirmations c ON c.company_id = $1 AND c.user_id = o.user_id ' +
          'GROUP BY o.user_id ORDER BY name LIMIT 1500', [ctx.companyId]
        )).rows
        : [];
      const weights = await pool.query(
        'SELECT DISTINCT c.weight_kg AS kg FROM factory_pressing_confirmations c ' +
        'WHERE c.company_id = $1 AND c.voided_at IS NULL' +
        (ctx.supervisor ? '' : ' AND c.user_id = $2') +
        ' ORDER BY kg ASC LIMIT 200',
        ctx.supervisor ? [ctx.companyId] : [ctx.companyId, ctx.userId],
      );
      // The pressing scanner uses the same fixed IANA timezone as its report.
      const timeZone = PRESSING_TIME_ZONE;
      const serverToday = factoryLocalDate(new Date(), timeZone);
      return res.json({ operators, canViewAll: ctx.supervisor, canCorrect: ctx.canCorrect,
        weightsKg: weights.rows.map(row => String(row.kg)), serverToday, timeZone });
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
      if (invalidDateTimeRange(body.filters)) {
        return res.status(400).json({ code: "PRESSING_INVALID_DATES",
          message: "Saved view has an invalid date/time range" });
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
