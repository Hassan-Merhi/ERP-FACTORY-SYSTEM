/**
 * Phase 7: supervisor shift schedules, downtime and measured pressing analytics.
 * No changes to Factory bale valuation, stock, mix cost or accounting.
 */
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import { db, pool } from "../../db";
import { requireAuth } from "../../auth";
import {
  factoryPressingMachines, factoryPressingShifts, factoryPressingDowntime,
  factoryPressingSessions, factorySettings,
} from "@shared/schema";
import {
  ActiveCompanyPermissionContextError, getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { logger } from "../../lib/logger";
import { logAudit } from "../helpers/auditHelpers";
import {
  factoryTimezone, intervalsOverlap, isValidTimezone, matchingShift,
  type PressingShiftDefinition,
} from "../../services/factory/pressingShiftTime";

const MANAGERS = new Set(["Manager", "Admin", "Owner", "Developer"]);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const shiftBase = z.object({
  shiftCode: z.string().trim().min(1).max(50).regex(/^[a-zA-Z0-9_.-]+$/),
  name: z.string().trim().min(1).max(120),
  startLocal: clock,
  endLocal: clock,
  timezoneName: z.string().trim().min(1).max(100).refine(isValidTimezone, "Invalid IANA timezone"),
  active: z.boolean().default(true),
}).strict();
const shiftFields = shiftBase.refine(x => x.startLocal !== x.endLocal, "Shift must have nonzero duration");
const shiftUpdate = shiftBase.partial().strict();
const downtimeStart = z.object({
  machineId: z.number().int().positive(),
  reasonCode: z.enum(["MAINTENANCE","MACHINE_FAULT","MATERIAL_SHORTAGE","POWER_OUTAGE","BREAK","OTHER"]),
  reasonNotes: z.string().trim().max(500).nullable().optional(),
}).strict();
const validReportDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(s => !Number.isNaN(Date.parse(s + "T00:00:00Z")) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0,10) === s,
    "Invalid calendar date");
const analyticsFilters = z.object({
  from: validReportDate,
  to: validReportDate,
  machineId: z.coerce.number().int().positive().optional(),
  userId: z.string().min(1).max(255).optional(),
  shiftId: z.coerce.number().int().positive().optional(),
}).strict();

class PressingOperationsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function problem(res: Response, error: unknown) {
  if (error instanceof ZodError) return res.status(400).json({ code: "PRESSING_INVALID_OPERATION", issues: error.issues });
  if (error instanceof PressingOperationsError) return res.status(error.status).json({ code: error.code, message: error.message });
  if (error instanceof ActiveCompanyPermissionContextError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  const dbErr = error as { code?: string; cause?: { code?: string } };
  if (dbErr?.code === "23505" || dbErr?.cause?.code === "23505")
    return res.status(409).json({ code: "PRESSING_CONFLICT", message: "Shift code or downtime conflicts with another record" });
  logger.error("Pressing machine shift/downtime error", { error });
  return res.status(500).json({ code: "PRESSING_OPERATION_FAILED", message: "Unable to complete pressing operation" });
}
async function context(req: Request, manager = true): Promise<ActiveCompanyPermissionContext> {
  const ctx = await getActiveCompanyPermissionContext(req);
  if (manager && (!MANAGERS.has(ctx.role) || ctx.posViewOnly))
    throw new PressingOperationsError(403, "PRESSING_SUPERVISOR_REQUIRED", "Supervisor permission required");
  return ctx;
}
function id(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PressingOperationsError(400, "INVALID_ID", "Invalid ID");
  return parsed;
}
function shiftShape(row: typeof factoryPressingShifts.$inferSelect): PressingShiftDefinition {
  return {
    id: row.id, shiftCode: row.shiftCode, name: row.name,
    startLocal: row.startLocal, endLocal: row.endLocal,
    timezoneName: row.timezoneName, active: row.active,
  };
}
async function validateSchedule(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], companyId: number,
  shift: PressingShiftDefinition, excludeId?: number) {
  const rows = await tx.select().from(factoryPressingShifts)
    .where(eq(factoryPressingShifts.companyId, companyId));
  for (const other of rows) {
    if (!other.active || !shift.active || other.id === excludeId) continue;
    // A company has one factory wall-clock basis for all active shifts.
    if (other.timezoneName !== shift.timezoneName)
      throw new PressingOperationsError(422, "PRESSING_SHIFT_TIMEZONE_CONFLICT",
        "Active shifts must share one IANA factory timezone");
    if (intervalsOverlap(shift.startLocal, shift.endLocal, other.startLocal, other.endLocal))
      throw new PressingOperationsError(409, "PRESSING_SHIFT_OVERLAP",
        "Shift overlaps existing active shift " + other.name);
  }
}
function audit(req: Request, ctx: ActiveCompanyPermissionContext) {
  return { userId: ctx.userId, username: String(req.session.username || ctx.userId), companyId: ctx.companyId };
}
export function registerFactoryPressingOperationsRoutes(app: Express): void {
  app.get("/api/factory/pressing-machines/shifts/current", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req, false);
      const now = new Date();
      const activeShifts = await db.select().from(factoryPressingShifts)
        .where(and(eq(factoryPressingShifts.companyId, ctx.companyId), eq(factoryPressingShifts.active, true)));
      const current = matchingShift(activeShifts.map(shiftShape), now);
      return res.json({ shift: current, serverTime: now.toISOString() });
    } catch (error) { return problem(res, error); }
  });
  app.get("/api/factory/pressing-machines/shifts", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const rows = await db.select().from(factoryPressingShifts)
        .where(eq(factoryPressingShifts.companyId, ctx.companyId)).orderBy(asc(factoryPressingShifts.startLocal));
      return res.json(rows);
    } catch (error) { return problem(res, error); }
  });
  app.post("/api/factory/pressing-machines/shifts", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const body = shiftFields.parse(req.body);
      const created = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ctx.companyId}::integer, -2026007)`);
        await validateSchedule(tx, ctx.companyId, { ...body, id: 0 });
        const [saved] = await tx.insert(factoryPressingShifts).values({
          companyId: ctx.companyId, ...body, shiftCode: body.shiftCode.toUpperCase(),
          createdBy: ctx.userId,
        }).returning();
        await logAudit({ ...audit(req, ctx), action: "create", tableName: "factory_pressing_shifts",
          recordId: saved.id, recordIdentifier: saved.shiftCode }, tx);
        return saved;
      });
      return res.status(201).json(created);
    } catch (error) { return problem(res, error); }
  });
  app.post("/api/factory/pressing-machines/shifts/:id/update", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const shiftId = id(req.params.id);
      const patch = shiftUpdate.parse(req.body);
      if (!Object.keys(patch).length) throw new PressingOperationsError(400, "EMPTY_CHANGE", "No changes supplied");
      const updated = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ctx.companyId}::integer, -2026007)`);
        const [current] = await tx.select().from(factoryPressingShifts)
          .where(and(eq(factoryPressingShifts.companyId, ctx.companyId),
            eq(factoryPressingShifts.id, shiftId))).for("update");
        if (!current) throw new PressingOperationsError(404, "SHIFT_NOT_FOUND", "Shift not found");
        const next: PressingShiftDefinition = {
          ...shiftShape(current), ...patch, shiftCode: patch.shiftCode?.toUpperCase() ?? current.shiftCode,
        };
        if (next.startLocal === next.endLocal) throw new PressingOperationsError(422,"ZERO_SHIFT","Shift cannot have zero duration");
        await validateSchedule(tx, ctx.companyId, next, shiftId);
        const [saved] = await tx.update(factoryPressingShifts).set({
          ...patch, shiftCode: next.shiftCode, updatedAt: new Date(),
        }).where(and(eq(factoryPressingShifts.companyId, ctx.companyId),
          eq(factoryPressingShifts.id, shiftId))).returning();
        await logAudit({ ...audit(req, ctx), action: "update", tableName: "factory_pressing_shifts",
          recordId: shiftId, recordIdentifier: current.shiftCode,
          changes: { schedule: { old: shiftShape(current), new: shiftShape(saved) } } }, tx);
        return saved;
      });
      return res.json(updated);
    } catch (error) { return problem(res, error); }
  });

  app.get("/api/factory/pressing-machines/downtime", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const machineId = req.query.machineId === undefined ? null : id(String(req.query.machineId));
      const records = await db.select().from(factoryPressingDowntime)
        .where(machineId
          ? and(eq(factoryPressingDowntime.companyId, ctx.companyId),eq(factoryPressingDowntime.machineId,machineId))
          : eq(factoryPressingDowntime.companyId,ctx.companyId))
        // Open machine stops always appear first even after substantial history.
        .orderBy(
          sql`CASE WHEN ${factoryPressingDowntime.endedAt} IS NULL THEN 0 ELSE 1 END`,
          desc(factoryPressingDowntime.startedAt),
        ).limit(200);
      return res.json(records);
    } catch (error) { return problem(res, error); }
  });
  app.post("/api/factory/pressing-machines/downtime/start", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const body = downtimeStart.parse(req.body);
      const saved = await db.transaction(async tx => {
        const [machine] = await tx.select().from(factoryPressingMachines).where(and(
          eq(factoryPressingMachines.companyId, ctx.companyId),eq(factoryPressingMachines.id,body.machineId),
        )).for("update");
        if (!machine?.active) throw new PressingOperationsError(422,"MACHINE_NOT_ACTIVE","Active machine required");
        const [existing] = await tx.select().from(factoryPressingDowntime).where(and(
          eq(factoryPressingDowntime.companyId,ctx.companyId),
          eq(factoryPressingDowntime.machineId,machine.id),
          isNull(factoryPressingDowntime.endedAt),
        ));
        if (existing) throw new PressingOperationsError(409,"DOWNTIME_ALREADY_OPEN","Machine already has active downtime");
        const [session] = await tx.select().from(factoryPressingSessions)
          .where(and(eq(factoryPressingSessions.companyId,ctx.companyId),
            eq(factoryPressingSessions.machineId,machine.id), isNull(factoryPressingSessions.endedAt)))
          .orderBy(desc(factoryPressingSessions.startedAt)).limit(1);
        const [record] = await tx.insert(factoryPressingDowntime).values({
          companyId: ctx.companyId, machineId: machine.id, reportedBy: ctx.userId,
          sessionId: session?.id ?? null, reasonCode: body.reasonCode,
          reasonNotes: body.reasonNotes ?? null, startedAt: new Date(),
        }).returning();
        await logAudit({ ...audit(req, ctx), action: "create", tableName: "factory_pressing_downtime",
          recordId: record.id, recordIdentifier: machine.machineCode }, tx);
        return record;
      });
      return res.status(201).json(saved);
    } catch (error) { return problem(res, error); }
  });
  app.post("/api/factory/pressing-machines/downtime/:id/end", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const downtimeId = id(req.params.id);
      const record = await db.transaction(async tx => {
        const [lookup] = await tx.select({ machineId: factoryPressingDowntime.machineId })
          .from(factoryPressingDowntime).where(and(
            eq(factoryPressingDowntime.companyId,ctx.companyId),eq(factoryPressingDowntime.id,downtimeId),
          ));
        if (!lookup) throw new PressingOperationsError(404,"DOWNTIME_NOT_FOUND","Downtime record not found");
        // Match start/confirmation lock ordering: machine before downtime row.
        const [machine] = await tx.select().from(factoryPressingMachines)
          .where(and(eq(factoryPressingMachines.companyId,ctx.companyId),
            eq(factoryPressingMachines.id,lookup.machineId))).for("update");
        if (!machine) throw new PressingOperationsError(404,"MACHINE_NOT_FOUND","Machine not found");
        const [active] = await tx.select().from(factoryPressingDowntime)
          .where(and(eq(factoryPressingDowntime.companyId,ctx.companyId),
            eq(factoryPressingDowntime.id,downtimeId))).for("update");
        if (!active) throw new PressingOperationsError(404,"DOWNTIME_NOT_FOUND","Downtime not found");
        if (active.endedAt) return active; // safe retry; do not change original evidence
        const [ended] = await tx.update(factoryPressingDowntime).set({ endedAt: new Date() })
          .where(and(eq(factoryPressingDowntime.companyId,ctx.companyId),
            eq(factoryPressingDowntime.id,downtimeId))).returning();
        await logAudit({ ...audit(req, ctx), action: "update", tableName: "factory_pressing_downtime",
          recordId: downtimeId, recordIdentifier: machine.machineCode,
          changes: { endedAt: { old: null, new: ended.endedAt?.toISOString() } } }, tx);
        return ended;
      });
      return res.json(record);
    } catch (error) { return problem(res, error); }
  });
  app.get("/api/factory/pressing-machines/analytics", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const filter = analyticsFilters.parse(req.query);
      if (filter.from > filter.to) throw new PressingOperationsError(400,"INVALID_RANGE","Start after end");
      const days = Math.round((Date.parse(filter.to + "T00:00:00Z") -
        Date.parse(filter.from + "T00:00:00Z")) / 86400000);
      if (!Number.isFinite(days) || days < 0 || days > 90)
        throw new PressingOperationsError(400,"RANGE_TOO_LONG","Select at most 91 calendar days");
      const params: Array<number|string> = [ctx.companyId,filter.from,filter.to];
      const clauses = ["company_id=$1","production_date >= $2::date","production_date <= $3::date",
        "voided_at IS NULL"];
      if(filter.machineId){params.push(filter.machineId);clauses.push("machine_id=$"+params.length);}
      if(filter.userId){params.push(filter.userId);clauses.push("user_id=$"+params.length);}
      if(filter.shiftId){params.push(filter.shiftId);clauses.push("shift_id=$"+params.length);}
      // This query reports only actual server-accepted scans. A gap between two
      // scans is NOT a press cycle or a known period of downtime.
      const data = await pool.query(
        'SELECT production_date::text AS "productionDate", machine_id AS "machineId",' +
        'MAX(machine_name_snapshot) AS "machineName",shift_id AS "shiftId",' +
        'COUNT(*)::integer AS "bales", COALESCE(SUM(weight_kg),0)::numeric(18,3) AS "kg",' +
        'MIN(confirmed_at) AS "firstAt",MAX(confirmed_at) AS "lastAt",' +
        'COUNT(DISTINCT user_id)::integer AS "operators"' +
        ' FROM factory_pressing_confirmations WHERE '+clauses.join(" AND ")+
        ' GROUP BY production_date,machine_id,shift_id' +
        ' ORDER BY production_date DESC,machine_id,shift_id NULLS LAST LIMIT 3001',
        params,
      );
      if (data.rows.length > 3000)
        throw new PressingOperationsError(422, "ANALYTICS_TOO_LARGE",
          "Narrow the date, machine or shift filters; more than 3,000 groups match.");
      const summary = data.rows.reduce((acc,row)=>{
        acc.bales+=Number(row.bales);acc.kg+=Number(row.kg);return acc;
      },{bales:0,kg:0});
      const activeShifts = await db.select().from(factoryPressingShifts)
        .where(and(eq(factoryPressingShifts.companyId, ctx.companyId),
          eq(factoryPressingShifts.active, true)));
      const [settings] = await db.select({ extraSettings: factorySettings.extraSettings })
        .from(factorySettings).where(eq(factorySettings.companyId, ctx.companyId)).limit(1);
      const timezoneName = factoryTimezone(activeShifts, settings?.extraSettings);
      // Filter downtime by overlapping real timestamps; report actual manually
      // logged machine stops separately from observational scan intervals.
      const machineParam = filter.machineId ? " AND d.machine_id=$5" : "";
      const downtimeParams = filter.machineId
        ? [ctx.companyId,filter.from,filter.to,timezoneName,filter.machineId]
        : [ctx.companyId,filter.from,filter.to,timezoneName];
      const downtime = await pool.query(
        'SELECT d.id,d.machine_id AS "machineId",m.name AS "machineName",' +
        'd.reason_code AS "reasonCode",d.started_at AS "startedAt",d.ended_at AS "endedAt",' +
        'GREATEST(0,EXTRACT(EPOCH FROM (LEAST(COALESCE(d.ended_at,NOW()),' +
        "(($3::date+INTERVAL '1 day') AT TIME ZONE $4)) - " +
        "GREATEST(d.started_at,($2::date::timestamp AT TIME ZONE $4)))))::integer AS \"seconds\"" +
        ' FROM factory_pressing_downtime d JOIN factory_pressing_machines m' +
        ' ON m.id=d.machine_id AND m.company_id=d.company_id' +
        " WHERE d.company_id=$1 AND d.started_at < (($3::date+INTERVAL '1 day') AT TIME ZONE $4)" +
        ' AND COALESCE(d.ended_at,NOW()) >= ($2::date::timestamp AT TIME ZONE $4)'+machineParam+
        ' ORDER BY d.started_at DESC LIMIT 3001',downtimeParams
      );
      if (downtime.rows.length > 3000)
        throw new PressingOperationsError(422, "DOWNTIME_TOO_LARGE",
          "Narrow the date or machine filter; more than 3,000 downtime records match.");
      const targets = await db.select({
        id:factoryPressingMachines.id,code:factoryPressingMachines.machineCode,
        targetBalesPerHour:factoryPressingMachines.targetBalesPerHour,
      }).from(factoryPressingMachines).where(eq(factoryPressingMachines.companyId,ctx.companyId));
      const groups = data.rows.map(row => {
        const elapsedSeconds = Math.max(0,
          (new Date(row.lastAt).getTime() - new Date(row.firstAt).getTime()) / 1000);
        const hours = elapsedSeconds / 3600;
        return {
          ...row, observedSeconds: elapsedSeconds,
          balesPerHour: hours > 0 ? Number((Number(row.bales) / hours).toFixed(2)) : null,
          kgPerHour: hours > 0 ? Number((Number(row.kg) / hours).toFixed(2)) : null,
        };
      });
      return res.json({
        groups,summary,recordedDowntime:downtime.rows,
        totalDowntimeSeconds:downtime.rows.reduce((n,r)=>n+Number(r.seconds||0),0),
        machineTargets:targets,rateMethod:"OBSERVED_FIRST_TO_LAST_SCAN",
        downtimeScope:"MACHINE_AND_DATE_ONLY", timezoneName,
        note:"Rates are observed first-to-last confirmation windows, NOT mechanical cycle times. Downtime requires an explicit supervisor record and is filtered by date and machine, not by operator/shift.",
      });
    } catch (error) { return problem(res, error); }
  });
}
