// Extracted from ./factoryPressingReportRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../../db";
import { requireAuth } from "../../auth";
import { factoryPressingSavedViews } from "@shared/schema";
import { pressingReportFiltersSchema, pressingSavedViewSchema } from "@shared/pressingReportContracts";
import { factoryLocalDate } from "../../services/factory/pressingShiftTime";
import {
  mergePressingHourlyTargets,
  pressingScheduleHours,
  pressingTargetKgSchema,
  pressingWeeklyScheduleInputSchema,
  savePressingDateHourTarget,
  savePressingWeeklySchedule,
} from "./pressingHourlyTargetRules";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";
import {
  PRESSING_WORKDAYS,
  pressingWeekdayFromDate,
  pressingWeeklyScheduleForDay,
  pressingWeeklyScheduleForWeekday,
} from "./pressingDailySchedule";
import {
  ReportPermissionError,
  context,
  handleError,
  invalidDateTimeRange,
} from "./factoryPressingReportRoutesConditions";
import { report } from "./factoryPressingReportRoutesReport";

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
      // Use the server's Beirut calendar date, not the browser's local timezone.
      // Without a day parameter the endpoint follows today's day after midnight.
      const serverToday = factoryLocalDate(new Date(), PRESSING_TIME_ZONE);
      const value = typeof req.query.day === "string" ? req.query.day : serverToday;
      const day = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine(
          (date) =>
            !Number.isNaN(Date.parse(date + "T00:00:00Z")) &&
            new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
        )
        .parse(value);
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
          AND c.confirmed_at >= ($2::date::timestamp AT TIME ZONE '${PRESSING_TIME_ZONE}')
          AND c.confirmed_at < (($2::date + 1)::timestamp AT TIME ZONE '${PRESSING_TIME_ZONE}')
        WHERE UPPER(BTRIM(u.username)) IN ('P1', 'P2', 'P3')
          AND EXISTS (
            SELECT 1 FROM user_company_roles r
            WHERE r.company_id = $1 AND r.user_id = u.id
              AND r.role IN ('User', 'Normal User')
          )
        GROUP BY u.id, u.username
        ORDER BY UPPER(BTRIM(u.username))`,
        [ctx.companyId, day]
      );
      res.set("Cache-Control", "private, no-store");
      return res.json({ day, serverToday, workers: result.rows });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // Uses the same three dedicated P1/P2/P3 accounts as the worker scoreboard.
  // An hour is measured by server-confirmed UTC instants. The generated
  // Beirut-local day is 23/24/25 hours as appropriate across DST changes.
  app.get("/api/factory/pressing-machines/report/hourly-targets", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const value =
        typeof req.query.day === "string" ? req.query.day : factoryLocalDate(new Date(), PRESSING_TIME_ZONE);
      const day = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine(
          (date) =>
            !Number.isNaN(Date.parse(date + "T00:00:00Z")) &&
            new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
        )
        .parse(value);
      const workersResult = await pool.query(
        'SELECT u.id AS "userId", UPPER(BTRIM(u.username)) AS "slot", ' +
          "COALESCE(NULLIF(BTRIM(MAX(p.display_name)), ''), 'Display name not set') AS name " +
          "FROM users u LEFT JOIN factory_user_profiles p ON p.company_id=$1 AND p.user_id=u.id " +
          "WHERE UPPER(BTRIM(u.username)) IN ('P1','P2','P3') AND EXISTS (" +
          "SELECT 1 FROM user_company_roles r WHERE r.company_id=$1 AND r.user_id=u.id " +
          "AND r.role IN ('User','Normal User')) " +
          "GROUP BY u.id,u.username ORDER BY UPPER(BTRIM(u.username))",
        [ctx.companyId]
      );
      const settings = await pool.query(
        "SELECT extra_settings->'pressingWorkerTargetsKg' AS targets, " +
          "extra_settings->'pressingHourlyTargetsByDateKg'->($2::text) AS \"hourlyTargets\", " +
          "extra_settings->'pressingHourlyDailySchedulesKg' AS \"dailySchedules\", " +
          "extra_settings->'pressingHourlyWeeklySchedulesKg' AS \"weeklySchedules\" " +
          "FROM factory_settings WHERE company_id=$1",
        [ctx.companyId, day]
      );
      const raw = settings.rows[0]?.targets;
      const targets = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const rawHourly = settings.rows[0]?.hourlyTargets;
      // A reusable daily schedule is effective from its save date onward.
      // Single-day overrides remain highest priority; older days are unchanged.
      const weeklySchedules = settings.rows[0]?.weeklySchedules;
      const legacySchedules = settings.rows[0]?.dailySchedules;
      const dailySchedule = pressingWeeklyScheduleForDay(weeklySchedules, legacySchedules, day);
      const serverToday = factoryLocalDate(new Date(), PRESSING_TIME_ZONE);
      const editableWeeklySchedulesKg: Record<string, Record<string, number>> = {};
      const editableWeeklyScheduleEffectiveDays: Record<string, string | null> = {};
      for (const weekday of PRESSING_WORKDAYS) {
        const template = pressingWeeklyScheduleForWeekday(weeklySchedules, legacySchedules, serverToday, weekday);
        editableWeeklySchedulesKg[String(weekday)] = template.hours;
        editableWeeklyScheduleEffectiveDays[String(weekday)] = template.effectiveDay;
      }
      // Date-specific overrides (including explicit 0 KG) win over the recurring schedule.
      const hourlyTargetsKg = mergePressingHourlyTargets(dailySchedule.hours, rawHourly);
      const workers = workersResult.rows.map((row) => {
        const configured = Number(targets[String(row.userId)]);
        return {
          ...row,
          targetKgPerHour:
            targets[String(row.userId)] !== undefined &&
            targets[String(row.userId)] !== null &&
            targets[String(row.userId)] !== "" &&
            Number.isFinite(configured) &&
            configured >= 0 &&
            configured <= 100000
              ? configured
              : 850,
        };
      });
      const result = await pool.query(
        "WITH hours AS (SELECT generate_series(" +
          "($2::date::timestamp AT TIME ZONE '" +
          PRESSING_TIME_ZONE +
          "'), " +
          "(($2::date + 1)::timestamp AT TIME ZONE '" +
          PRESSING_TIME_ZONE +
          "') - interval '1 hour', " +
          "interval '1 hour') AS hour_start), " +
          "scans AS (SELECT c.user_id, " +
          "date_trunc('hour', c.confirmed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour_start, " +
          "COUNT(*)::integer AS bales, COALESCE(SUM(c.weight_kg),0)::numeric(18,3) AS kg " +
          "FROM factory_pressing_confirmations c WHERE c.company_id=$1 AND c.voided_at IS NULL " +
          "AND c.confirmed_at >= ($2::date::timestamp AT TIME ZONE '" +
          PRESSING_TIME_ZONE +
          "') " +
          "AND c.confirmed_at < (($2::date + 1)::timestamp AT TIME ZONE '" +
          PRESSING_TIME_ZONE +
          "') " +
          "GROUP BY c.user_id,date_trunc('hour', c.confirmed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') " +
          'SELECT h.hour_start AS "hourStart", w.user_id AS "userId", ' +
          "COALESCE(s.bales,0)::integer AS bales, COALESCE(s.kg,0)::numeric(18,3) AS kg " +
          "FROM hours h CROSS JOIN (SELECT u.id AS user_id FROM users u " +
          "WHERE UPPER(BTRIM(u.username)) IN ('P1','P2','P3') " +
          "AND EXISTS (SELECT 1 FROM user_company_roles r WHERE r.company_id=$1 AND r.user_id=u.id " +
          "AND r.role IN ('User','Normal User'))) w " +
          "LEFT JOIN scans s ON s.user_id=w.user_id AND s.hour_start=h.hour_start " +
          "ORDER BY h.hour_start DESC,w.user_id",
        [ctx.companyId, day]
      );
      res.set("Cache-Control", "private, no-store");
      return res.json({
        day,
        serverNow: new Date().toISOString(),
        canEdit: ctx.canCorrect,
        workers,
        hours: result.rows,
        hourlyTargetsKg,
        dailyScheduleKg: dailySchedule.hours,
        dailyScheduleEffectiveDay: dailySchedule.effectiveDay,
        editableWeeklySchedulesKg,
        editableWeeklyScheduleEffectiveDays,
        scheduledWorkday: pressingWeekdayFromDate(day) !== 0 || Object.keys(dailySchedule.hours).length > 0,
      });
    } catch (error) {
      return handleError(res, error);
    }
  });

  // Each Monday–Saturday template stores all ten hourly slots together.
  // Each selected weekday has its own effective-dated version from today onward.
  // Sundays are excluded. Only Admin/Owner (not POS view-only) can update.
  app.put(
    "/api/factory/pressing-machines/report/hourly-targets/daily-schedule",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const ctx = await context(req);
        if (!ctx.canCorrect)
          throw new ReportPermissionError(
            403,
            "PRESSING_TARGET_FORBIDDEN",
            "Only Admin or Owner may edit pressing targets"
          );
        const input = pressingWeeklyScheduleInputSchema.parse(req.body);
        const effectiveDay = factoryLocalDate(new Date(), PRESSING_TIME_ZONE);
        const hours = pressingScheduleHours(input.targetsKg);
        // One atomic JSONB patch preserves schedules for all other weekdays,
        // prior effective dates, and unrelated company settings.
        await savePressingWeeklySchedule(pool, {
          companyId: ctx.companyId,
          effectiveDay,
          weekday: input.weekday,
          hours,
        });
        res.set("Cache-Control", "private, no-store");
        return res.json({ saved: true, effectiveDay, weekday: input.weekday, hourlyTargetsKg: hours });
      } catch (error) {
        return handleError(res, error);
      }
    }
  );

  // Store targets in existing company-scoped Factory settings, with an atomic
  // JSONB update so unrelated flags and other workers' targets are not lost.
  // Only Admin / Owner may edit; workers may not change their own targets.
  app.put("/api/factory/pressing-machines/report/hourly-targets", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      if (!ctx.canCorrect)
        throw new ReportPermissionError(
          403,
          "PRESSING_TARGET_FORBIDDEN",
          "Only Admin or Owner may edit pressing targets"
        );
      const kgSchema = pressingTargetKgSchema;
      const input = z
        .union([
          z
            .object({
              day: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .refine(
                  (date) =>
                    !Number.isNaN(Date.parse(date + "T00:00:00Z")) &&
                    new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
                ),
              hour: z.number().int().min(7).max(16),
              targetKgPerHour: kgSchema,
            })
            .strict(),
          z
            .object({
              userId: z.string().trim().min(1).max(255),
              targetKgPerHour: kgSchema,
            })
            .strict(),
        ])
        .parse(req.body);
      if ("hour" in input) {
        // Date-scoped hourly targets preserve historical comparisons. Each
        // hour applies to all three workers and overrides their legacy defaults.
        // A single atomic JSONB upsert preserves unrelated settings and dates.
        await savePressingDateHourTarget(pool, {
          companyId: ctx.companyId,
          day: input.day,
          hour: input.hour,
          targetKgPerHour: input.targetKgPerHour,
        });
        return res.json({ saved: true, day: input.day, hour: input.hour, targetKgPerHour: input.targetKgPerHour });
      }
      const eligible = await pool.query(
        "SELECT 1 FROM users u WHERE u.id=$2 AND UPPER(BTRIM(u.username)) IN ('P1','P2','P3') " +
          "AND EXISTS (SELECT 1 FROM user_company_roles r WHERE r.company_id=$1 AND r.user_id=u.id " +
          "AND r.role IN ('User','Normal User'))",
        [ctx.companyId, input.userId]
      );
      if (!eligible.rowCount)
        return res
          .status(404)
          .json({ code: "PRESSING_WORKER_NOT_FOUND", message: "Pressing worker not found in this company" });
      await pool.query(
        "INSERT INTO factory_settings (company_id,extra_settings,updated_at) " +
          "VALUES ($1,jsonb_build_object('pressingWorkerTargetsKg',jsonb_build_object($2::text,$3::numeric)),now()) " +
          "ON CONFLICT (company_id) DO UPDATE SET " +
          "extra_settings=COALESCE(factory_settings.extra_settings,'{}'::jsonb) || " +
          "jsonb_build_object('pressingWorkerTargetsKg', " +
          "COALESCE(factory_settings.extra_settings->'pressingWorkerTargetsKg','{}'::jsonb) || " +
          "jsonb_build_object($2::text,$3::numeric)),updated_at=now()",
        [ctx.companyId, input.userId, input.targetKgPerHour]
      );
      return res.json({ saved: true, userId: input.userId, targetKgPerHour: input.targetKgPerHour });
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.get("/api/factory/pressing-machines/report", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const filters = pressingReportFiltersSchema.parse(req.query);
      if (invalidDateTimeRange(filters)) {
        return res.status(400).json({
          code: "PRESSING_INVALID_DATES",
          message: "Start date/time cannot exceed end date/time; time filters require a date",
        });
      }
      return res.json(await report(ctx, filters));
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.get("/api/factory/pressing-machines/report/options", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      // Include assigned operators with zero scans so P1/P2/P3 filters are usable
      // before any production is recorded.
      const operators = ctx.supervisor
        ? (
            await pool.query(
              "WITH operator_ids AS (SELECT a.user_id FROM factory_pressing_assignments a WHERE a.company_id = $1 " +
                "UNION SELECT c.user_id FROM factory_pressing_confirmations c WHERE c.company_id = $1 " +
                "UNION SELECT u.id FROM users u JOIN user_company_roles r ON r.user_id = u.id " +
                "AND r.company_id = $1 AND r.role IN ('User', 'Normal User') " +
                "WHERE UPPER(BTRIM(u.username)) IN ('P1', 'P2', 'P3')) " +
                'SELECT o.user_id AS "userId", MAX(u.username) AS username, ' +
                "NULLIF(BTRIM(MAX(p.display_name)), '') AS \"displayName\", " +
                "EXISTS (SELECT 1 FROM user_company_roles r WHERE r.company_id = $1 " +
                "AND r.user_id = o.user_id AND r.role IN ('User', 'Normal User')) AS \"isPressingWorker\", " +
                "COALESCE(NULLIF(BTRIM(MAX(p.display_name)), ''), 'Display name not set') AS name " +
                "FROM operator_ids o LEFT JOIN users u ON u.id = o.user_id " +
                "LEFT JOIN factory_user_profiles p ON p.company_id = $1 AND p.user_id = o.user_id " +
                "LEFT JOIN factory_pressing_confirmations c ON c.company_id = $1 AND c.user_id = o.user_id " +
                "GROUP BY o.user_id ORDER BY name LIMIT 1500",
              [ctx.companyId]
            )
          ).rows
        : [];
      const weights = await pool.query(
        "SELECT DISTINCT c.weight_kg AS kg FROM factory_pressing_confirmations c " +
          "WHERE c.company_id = $1 AND c.voided_at IS NULL" +
          (ctx.supervisor ? "" : " AND c.user_id = $2") +
          " ORDER BY kg ASC LIMIT 200",
        ctx.supervisor ? [ctx.companyId] : [ctx.companyId, ctx.userId]
      );
      // The pressing scanner uses the same fixed IANA timezone as its report.
      const timeZone = PRESSING_TIME_ZONE;
      const serverToday = factoryLocalDate(new Date(), timeZone);
      return res.json({
        operators,
        canViewAll: ctx.supervisor,
        canCorrect: ctx.canCorrect,
        weightsKg: weights.rows.map((row) => String(row.kg)),
        serverToday,
        timeZone,
      });
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.get("/api/factory/pressing-machines/report/views", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const views = await db
        .select()
        .from(factoryPressingSavedViews)
        .where(
          and(eq(factoryPressingSavedViews.companyId, ctx.companyId), eq(factoryPressingSavedViews.userId, ctx.userId))
        )
        .orderBy(asc(factoryPressingSavedViews.name));
      return res.json(views);
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.post("/api/factory/pressing-machines/report/views", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await context(req);
      const body = pressingSavedViewSchema.parse(req.body);
      if (invalidDateTimeRange(body.filters)) {
        return res
          .status(400)
          .json({ code: "PRESSING_INVALID_DATES", message: "Saved view has an invalid date/time range" });
      }
      if (!ctx.supervisor && body.filters.userId && body.filters.userId !== ctx.userId) {
        throw new ReportPermissionError(403, "PRESSING_REPORT_FORBIDDEN", "Cannot save filters for another operator");
      }
      const view = await db.transaction(async (tx) => {
        if (body.isDefault) {
          await tx
            .update(factoryPressingSavedViews)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(factoryPressingSavedViews.companyId, ctx.companyId),
                eq(factoryPressingSavedViews.userId, ctx.userId)
              )
            );
        }
        const [record] = await tx
          .insert(factoryPressingSavedViews)
          .values({
            companyId: ctx.companyId,
            userId: ctx.userId,
            name: body.name,
            reportMode: body.mode,
            filters: body.filters,
            visibleColumns: body.visibleColumns,
            isDefault: body.isDefault,
          })
          .onConflictDoUpdate({
            target: [
              factoryPressingSavedViews.companyId,
              factoryPressingSavedViews.userId,
              factoryPressingSavedViews.name,
            ],
            set: {
              reportMode: body.mode,
              filters: body.filters,
              visibleColumns: body.visibleColumns,
              isDefault: body.isDefault,
              updatedAt: new Date(),
            },
          })
          .returning();
        return record;
      });
      return res.json(view);
    } catch (error) {
      return handleError(res, error);
    }
  });

  app.post(
    "/api/factory/pressing-machines/report/views/:id/remove",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const ctx = await context(req);
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: "Invalid saved view ID" });
        const [removed] = await db
          .delete(factoryPressingSavedViews)
          .where(
            and(
              eq(factoryPressingSavedViews.id, id),
              eq(factoryPressingSavedViews.companyId, ctx.companyId),
              eq(factoryPressingSavedViews.userId, ctx.userId)
            )
          )
          .returning({ id: factoryPressingSavedViews.id });
        if (!removed) return res.status(404).json({ message: "Saved view not found" });
        return res.json(removed);
      } catch (error) {
        return handleError(res, error);
      }
    }
  );
}
