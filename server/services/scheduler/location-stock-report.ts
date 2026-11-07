import { getErrorDetails } from "@shared/errorUtils";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { chooseActiveCompanyRole } from "../security/activeCompanyPermissionPolicy";
import {
  deliverLocationStockWhatsApp,
  recordLocationStockDeliveryFailure,
  recoverStaleLocationStockDeliveries,
} from "../locationStockWhatsAppDelivery";

interface ScheduleRow {
  location_id: number;
  company_id: number;
  enabled: boolean;
  frequency: "daily" | "selected_days";
  days_of_week: number[] | null;
  send_time: string;
  timezone: string;
  include_cost: boolean;
  include_zero_stock: boolean;
  include_negative_stock: boolean;
  stock_group_id: number | null;
  category_id: number | null;
  last_scheduled_for: string | Date | null;
  updated_by_user_id: string | null;
}

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localScheduleParts(date: Date, timezone: string): { localDate: string; dayOfWeek: number; localTime: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = values.get("year")!;
  const month = values.get("month")!;
  const day = values.get("day")!;
  const weekday = values.get("weekday")!;
  const hour = values.get("hour")!;
  const minute = values.get("minute")!;
  return {
    localDate: `${year}-${month}-${day}`,
    dayOfWeek: DAY_INDEX[weekday] ?? date.getUTCDay(),
    localTime: `${hour}:${minute}`,
  };
}

function alreadyScheduledFor(row: ScheduleRow, localDate: string): boolean {
  if (!row.last_scheduled_for) return false;
  if (typeof row.last_scheduled_for === "string") return row.last_scheduled_for.slice(0, 10) === localDate;
  return row.last_scheduled_for.toISOString().slice(0, 10) === localDate;
}

function isDue(row: ScheduleRow, now: Date): { due: boolean; localDate: string } {
  let parts: ReturnType<typeof localScheduleParts>;
  try {
    parts = localScheduleParts(now, row.timezone || "UTC");
  } catch {
    return { due: false, localDate: "" };
  }

  if (alreadyScheduledFor(row, parts.localDate)) return { due: false, localDate: parts.localDate };
  const scheduledTime = String(row.send_time || "18:00").slice(0, 5);
  // Catch-up semantics are deliberate: if the service was redeploying at the
  // exact minute, the first scheduler tick later that local day still sends once.
  if (parts.localTime < scheduledTime) return { due: false, localDate: parts.localDate };

  if (row.frequency === "selected_days") {
    const days = Array.isArray(row.days_of_week) ? row.days_of_week.map(Number) : [];
    if (!days.includes(parts.dayOfWeek)) return { due: false, localDate: parts.localDate };
  }

  return { due: true, localDate: parts.localDate };
}

function permissionAllowed(role: string, explicit: boolean | undefined): boolean {
  if (role === "Developer" || role === "Admin") return true;
  if (role === "Normal User") return explicit === true;
  return explicit !== false;
}

async function scheduleAuthorStillAuthorized(row: ScheduleRow): Promise<boolean> {
  if (!row.updated_by_user_id) return false;

  // Match the same canonical company-role selection used by request permission
  // middleware. In particular, a Developer role grants the intentional global
  // developer bypass even when there is no explicit role row for this company.
  // The old scheduler queried only the target company, so schedules saved by a
  // developer could work manually but fail later with "owner no longer has permission".
  const userResult = await pool.query<{ active: boolean; company_id: number; role: string }>(
    `SELECT u.active, ucr.company_id, ucr.role
       FROM users u
       JOIN user_company_roles ucr ON ucr.user_id = u.id
      WHERE u.id = $1
      ORDER BY ucr.id DESC`,
    [row.updated_by_user_id]
  );
  const rows = userResult.rows;
  if (!rows.length || rows[0].active !== true) return false;

  const selected = chooseActiveCompanyRole(
    row.company_id,
    rows.map((userRole) => ({ companyId: userRole.company_id, role: userRole.role }))
  );
  if (!selected || selected.role === "POS" || selected.role === "View Only" || selected.role === "Create Only")
    return false;
  if (selected.developerBypass || selected.role === "Admin") return true;

  const role = selected.role;
  const keys = row.include_cost ? ["exp_whatsapp_send", "fld_cost_price", "fld_total_value"] : ["exp_whatsapp_send"];
  const permissions = await pool.query<{ feature_key: string; enabled: boolean }>(
    `SELECT feature_key, enabled
       FROM role_feature_permissions
      WHERE company_id = $1 AND role = $2 AND feature_key = ANY($3::text[])`,
    [row.company_id, role, keys]
  );
  const permissionMap = new Map(permissions.rows.map((permission) => [permission.feature_key, permission.enabled]));
  return keys.every((key) => permissionAllowed(role, permissionMap.get(key)));
}

async function finishSchedule(locationId: number, status: string, error: string | null, sent: boolean): Promise<void> {
  await pool.query(
    `UPDATE location_whatsapp_stock_schedules
        SET last_status = $2,
            last_error = $3,
            last_sent_at = CASE WHEN $4::boolean THEN now() ELSE last_sent_at END,
            updated_at = now()
      WHERE location_id = $1`,
    [locationId, status, error ? error.slice(0, 1000) : null, sent]
  );
}

/**
 * If the process dies after claiming a schedule date but before creating a
 * delivery ledger row, no WhatsApp call could have started yet. Releasing only
 * those orphaned claims is therefore safe and lets the normal catch-up path run
 * later that day. If ANY delivery row exists for the claimed date, the claim is
 * preserved because the external outcome may be ambiguous and must not auto-send.
 */
async function recoverOrphanedScheduleClaims(): Promise<number> {
  const result = await pool.query<{ location_id: number; company_id: number }>(
    `WITH orphaned AS (
       SELECT s.location_id, s.company_id, s.last_scheduled_for
         FROM location_whatsapp_stock_schedules s
        WHERE s.enabled = true
          AND s.last_status = 'running'
          AND s.last_attempt_at < now() - interval '20 minutes'
          AND s.last_scheduled_for IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM location_whatsapp_stock_deliveries d
             WHERE d.company_id = s.company_id
               AND d.location_id = s.location_id
               AND d.source = 'scheduled'
               AND d.scheduled_for = s.last_scheduled_for
          )
     )
     UPDATE location_whatsapp_stock_schedules s
        SET last_scheduled_for = NULL,
            last_status = 'failed',
            last_error = 'Scheduler interrupted before delivery started; released for safe catch-up',
            updated_at = now()
       FROM orphaned o
      WHERE s.location_id = o.location_id
        AND s.company_id = o.company_id
      RETURNING s.location_id, s.company_id`
  );
  if (result.rowCount) {
    logger.warn("[LocationStockSchedule] recovered orphaned schedule claims", {
      count: result.rowCount,
    });
  }
  return result.rowCount ?? 0;
}

async function runOneLocationSchedule(row: ScheduleRow, localDate: string): Promise<void> {
  // First layer of duplicate protection: atomically claim the local calendar day.
  const claim = await pool.query(
    `UPDATE location_whatsapp_stock_schedules
        SET last_scheduled_for = $2::date,
            last_attempt_at = now(),
            last_status = 'running',
            last_error = NULL,
            updated_at = now()
      WHERE location_id = $1
        AND enabled = true
        AND (last_scheduled_for IS NULL OR last_scheduled_for <> $2::date)
      RETURNING location_id`,
    [row.location_id, localDate]
  );
  if (!claim.rows.length) return;

  const idempotencyKey = `scheduled:${row.company_id}:${row.location_id}:${localDate}`;
  try {
    if (!(await scheduleAuthorStillAuthorized(row))) {
      const message = "Schedule owner no longer has permission to send this report";
      await recordLocationStockDeliveryFailure(
        {
          companyId: row.company_id,
          locationId: row.location_id,
          includeCost: row.include_cost,
          includeZeroStock: row.include_zero_stock,
          includeNegativeStock: row.include_negative_stock,
          stockGroupId: row.stock_group_id ?? undefined,
          categoryId: row.category_id,
          source: "scheduled",
          initiatedByUserId: row.updated_by_user_id,
          scheduledFor: localDate,
          idempotencyKey,
          reportDate: localDate,
        },
        message
      );
      await finishSchedule(row.location_id, "failed", message, false);
      return;
    }

    const delivery = await deliverLocationStockWhatsApp({
      companyId: row.company_id,
      locationId: row.location_id,
      includeCost: row.include_cost,
      includeZeroStock: row.include_zero_stock,
      includeNegativeStock: row.include_negative_stock,
      stockGroupId: row.stock_group_id ?? undefined,
      categoryId: row.category_id,
      source: "scheduled",
      initiatedByUserId: row.updated_by_user_id,
      scheduledFor: localDate,
      idempotencyKey,
      reportDate: localDate,
    });

    await finishSchedule(row.location_id, delivery.status, delivery.error, delivery.status === "sent");
  } catch (error: unknown) {
    const message = getErrorMessage(error) || "Scheduled WhatsApp stock report failed";
    await finishSchedule(row.location_id, "failed", message, false).catch(() => undefined);
    logger.error("[LocationStockSchedule] run failed", {
      companyId: row.company_id,
      locationId: row.location_id,
      error,
    });
  }
}

/**
 * Called every minute by the existing scheduler service. Each row evaluates time
 * in its own IANA timezone, supports selected weekdays, catches up after a brief
 * restart, and atomically claims one local calendar day before sending.
 */
export async function checkAndRunLocationStockReports(now = new Date()): Promise<void> {
  try {
    await recoverStaleLocationStockDeliveries();
    await recoverOrphanedScheduleClaims();
    const result = await pool.query<ScheduleRow>(
      `SELECT s.location_id, s.company_id, s.enabled, s.frequency, s.days_of_week,
              s.send_time::text, s.timezone, s.include_cost, s.include_zero_stock,
              s.include_negative_stock, s.stock_group_id, s.category_id,
              s.last_scheduled_for, s.updated_by_user_id
         FROM location_whatsapp_stock_schedules s
         JOIN locations l ON l.id = s.location_id AND l.company_id = s.company_id
         JOIN companies c ON c.id = s.company_id
        WHERE s.enabled = true
        ORDER BY s.company_id, s.location_id`
    );

    for (const row of result.rows) {
      const due = isDue(row, now);
      if (!due.due || !due.localDate) continue;
      await runOneLocationSchedule(row, due.localDate);
    }
  } catch (error) {
    // During a rolling deployment an older database may briefly precede startup migrations.
    if (getErrorDetails(error).code === "42P01") return;
    logger.error("[LocationStockSchedule] scheduler check failed", { error });
  }
}
