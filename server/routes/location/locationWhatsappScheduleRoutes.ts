import { getErrorDetails } from "@shared/errorUtils";
import type { Express, NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { stockCategories, stockGroups } from "@shared/schema";
import { db, pool } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireExportAccess, requireSensitiveAccess } from "../../lib/permissionMiddleware";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";

const LOCATION_WHATSAPP_PERMISSION = "exp_whatsapp_send";
const requireCostPriceAccess = requireSensitiveAccess("fld_cost_price");
const requireTotalValueAccess = requireSensitiveAccess("fld_total_value");
const DEFAULT_TIMEZONE = "Africa/Lubumbashi";
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

function requireCostScheduleAccess(req: Request, res: Response, next: NextFunction): void {
  if (!parseBoolean(req.body?.includeCost)) {
    next();
    return;
  }
  requireCostPriceAccess(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    requireTotalValueAccess(req, res, next);
  });
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeSendTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDays(value: unknown, frequency: string): number[] | null {
  if (frequency === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(value)) return null;
  const days = Array.from(new Set(value.map(Number))).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!days.length) return null;
  return days.sort((a, b) => a - b);
}

async function validateOptionalFilter(
  companyId: number,
  rawId: unknown,
  kind: "group" | "category"
): Promise<number | null> {
  if (rawId === undefined || rawId === null || rawId === "" || rawId === "all") return null;
  const id = Number.parseInt(String(rawId), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`Invalid ${kind} ID`);

  if (kind === "group") {
    const [row] = await db
      .select({ id: stockGroups.id })
      .from(stockGroups)
      .where(and(eq(stockGroups.id, id), eq(stockGroups.companyId, companyId)))
      .limit(1);
    if (!row) throw new Error("Stock group not found for this company");
  } else {
    const [row] = await db
      .select({ id: stockCategories.id })
      .from(stockCategories)
      .where(and(eq(stockCategories.id, id), eq(stockCategories.companyId, companyId)))
      .limit(1);
    if (!row) throw new Error("Stock category not found for this company");
  }
  return id;
}

function localParts(date: Date, timezone: string) {
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
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    weekday: DAY_INDEX[parts.get("weekday") || ""] ?? date.getUTCDay(),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
  };
}

function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const current = localParts(new Date(guess), timezone);
    const represented = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, 0, 0);
    const delta = desired - represented;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}

type WhatsappScheduleRow = {
  enabled?: boolean | null;
  timezone?: string | null;
  send_time?: string | null;
  frequency?: string | null;
  days_of_week?: unknown;
  last_scheduled_for?: unknown;
  include_cost?: boolean | null;
  include_zero_stock?: boolean | null;
  include_negative_stock?: boolean | null;
  stock_group_id?: number | string | null;
  category_id?: number | string | null;
  last_attempt_at?: string | Date | null;
  last_sent_at?: string | Date | null;
  last_status?: string | null;
  last_error?: string | null;
};

function lastScheduledLocalDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function computeNextSendAt(row: WhatsappScheduleRow, now = new Date()): string | null {
  if (!row?.enabled) return null;
  const timezone = row.timezone || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) return null;
  const sendTime = typeof row.send_time === "string" ? row.send_time.slice(0, 5) : "18:00";
  const [sendHour, sendMinute] = sendTime.split(":").map(Number);
  const current = localParts(now, timezone);
  const currentLocalTime = `${String(current.hour).padStart(2, "0")}:${String(current.minute).padStart(2, "0")}`;
  const allowedDays =
    row.frequency === "selected_days"
      ? new Set((Array.isArray(row.days_of_week) ? row.days_of_week : []).map(Number))
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  const already = lastScheduledLocalDate(row.last_scheduled_for);
  const anchor = Date.UTC(current.year, current.month - 1, current.day);

  for (let offset = 0; offset < 8; offset++) {
    const calendar = new Date(anchor + offset * 24 * 60 * 60 * 1000);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    const weekday = calendar.getUTCDay();
    if (!allowedDays.has(weekday)) continue;
    const localDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (offset === 0) {
      if (already === localDate) continue;
      if (currentLocalTime >= sendTime) return now.toISOString();
    }
    return zonedLocalToUtc(year, month, day, sendHour, sendMinute, timezone).toISOString();
  }
  return null;
}

function defaultSchedule(locationId: number) {
  return {
    locationId,
    enabled: false,
    frequency: "daily" as const,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    sendTime: "18:00",
    timezone: DEFAULT_TIMEZONE,
    includeCost: false,
    includeZeroStock: false,
    includeNegativeStock: true,
    stockGroupId: null as number | null,
    categoryId: null as number | null,
    lastAttemptAt: null as string | null,
    lastSentAt: null as string | null,
    lastScheduledFor: null as string | null,
    lastStatus: null as string | null,
    lastError: null as string | null,
    nextSendAt: null as string | null,
  };
}

function serializeSchedule(row: WhatsappScheduleRow, locationId: number) {
  if (!row) return defaultSchedule(locationId);
  const sendTime = typeof row.send_time === "string" ? row.send_time.slice(0, 5) : "18:00";
  return {
    locationId,
    enabled: row.enabled === true,
    frequency: row.frequency === "selected_days" ? "selected_days" : "daily",
    daysOfWeek: Array.isArray(row.days_of_week) ? row.days_of_week.map(Number) : [0, 1, 2, 3, 4, 5, 6],
    sendTime,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    includeCost: row.include_cost === true,
    includeZeroStock: row.include_zero_stock === true,
    includeNegativeStock: row.include_negative_stock !== false,
    stockGroupId: row.stock_group_id == null ? null : Number(row.stock_group_id),
    categoryId: row.category_id == null ? null : Number(row.category_id),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
    lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    lastScheduledFor: lastScheduledLocalDate(row.last_scheduled_for),
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    nextSendAt: computeNextSendAt(row),
  };
}

export function registerLocationWhatsappScheduleRoutes(app: Express) {
  app.get(
    "/api/locations/:locationId/whatsapp-schedule",
    requireAuth,
    requireNonPOS,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (req, res) => {
      try {
        const locationId = Number.parseInt(req.params.locationId, 10);
        if (!Number.isFinite(locationId)) return res.status(400).json({ message: "Invalid location ID" });
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const result = await pool.query(
          `SELECT enabled, frequency, days_of_week, send_time, timezone,
                  include_cost, include_zero_stock, include_negative_stock,
                  stock_group_id, category_id, last_attempt_at, last_sent_at,
                  last_scheduled_for, last_status, last_error
             FROM location_whatsapp_stock_schedules
            WHERE location_id = $1 AND company_id = $2`,
          [locationId, companyId]
        );
        res.json(serializeSchedule(result.rows[0], locationId));
      } catch (error) {
        if (getErrorDetails(error).code === "42P01")
          return res.json(defaultSchedule(Number.parseInt(req.params.locationId, 10)));
        logger.error("[LocationStockSchedule] GET failed", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.put(
    "/api/locations/:locationId/whatsapp-schedule",
    requireAuth,
    requireNonPOS,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    requireCostScheduleAccess,
    async (req, res) => {
      try {
        const locationId = Number.parseInt(req.params.locationId, 10);
        if (!Number.isFinite(locationId)) return res.status(400).json({ message: "Invalid location ID" });
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const enabled = parseBoolean(req.body?.enabled);
        const frequency =
          req.body?.frequency === "selected_days" ? "selected_days" : req.body?.frequency === "daily" ? "daily" : null;
        if (!frequency) return res.status(400).json({ message: "Frequency must be daily or selected_days" });
        const daysOfWeek = normalizeDays(req.body?.daysOfWeek, frequency);
        if (!daysOfWeek) return res.status(400).json({ message: "Select at least one day for this schedule" });
        const sendTime = normalizeSendTime(req.body?.sendTime);
        if (!sendTime) return res.status(400).json({ message: "Invalid send time. Use HH:mm" });
        const timezone = typeof req.body?.timezone === "string" ? req.body.timezone.trim() : "";
        if (!timezone || !isValidTimezone(timezone)) return res.status(400).json({ message: "Invalid IANA timezone" });

        const includeCost = parseBoolean(req.body?.includeCost);
        const includeZeroStock = parseBoolean(req.body?.includeZeroStock);
        const includeNegativeStock = parseBoolean(req.body?.includeNegativeStock, true);
        const stockGroupId = await validateOptionalFilter(companyId, req.body?.stockGroupId, "group");
        const categoryId = await validateOptionalFilter(companyId, req.body?.categoryId, "category");

        const destination = await pool.query<{ whatsapp_group_chat_id: string | null; enabled: boolean }>(
          `SELECT whatsapp_group_chat_id, enabled
             FROM location_whatsapp_stock_reports
            WHERE location_id = $1 AND company_id = $2`,
          [locationId, companyId]
        );
        const destinationRow = destination.rows[0];
        if (enabled && (!destinationRow?.whatsapp_group_chat_id || destinationRow.enabled !== true)) {
          return res
            .status(400)
            .json({ message: "Link and enable the location WhatsApp group before enabling automatic stock reports" });
        }
        if (enabled && !destinationRow.whatsapp_group_chat_id!.endsWith("@g.us")) {
          return res.status(400).json({ message: "The linked WhatsApp destination is not a valid group" });
        }

        const previousResult = await pool.query(
          `SELECT enabled, frequency, days_of_week, send_time, timezone,
                  include_cost, include_zero_stock, include_negative_stock,
                  stock_group_id, category_id
             FROM location_whatsapp_stock_schedules
            WHERE location_id = $1 AND company_id = $2`,
          [locationId, companyId]
        );
        const previous = previousResult.rows[0] ?? null;

        const result = await pool.query(
          `INSERT INTO location_whatsapp_stock_schedules (
              location_id, company_id, enabled, frequency, days_of_week, send_time, timezone,
              include_cost, include_zero_stock, include_negative_stock,
              stock_group_id, category_id, updated_by_user_id, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
            ON CONFLICT (location_id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              enabled = EXCLUDED.enabled,
              frequency = EXCLUDED.frequency,
              days_of_week = EXCLUDED.days_of_week,
              send_time = EXCLUDED.send_time,
              timezone = EXCLUDED.timezone,
              include_cost = EXCLUDED.include_cost,
              include_zero_stock = EXCLUDED.include_zero_stock,
              include_negative_stock = EXCLUDED.include_negative_stock,
              stock_group_id = EXCLUDED.stock_group_id,
              category_id = EXCLUDED.category_id,
              updated_by_user_id = EXCLUDED.updated_by_user_id,
              updated_at = now()
            RETURNING enabled, frequency, days_of_week, send_time, timezone,
                      include_cost, include_zero_stock, include_negative_stock,
                      stock_group_id, category_id, last_attempt_at, last_sent_at,
                      last_scheduled_for, last_status, last_error`,
          [
            locationId,
            companyId,
            enabled,
            frequency,
            daysOfWeek,
            sendTime,
            timezone,
            includeCost,
            includeZeroStock,
            includeNegativeStock,
            stockGroupId,
            categoryId,
            req.session.userId!,
          ]
        );

        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "update_location_whatsapp_stock_schedule",
            tableName: "location_whatsapp_stock_schedules",
            recordId: locationId,
            recordIdentifier: location.name,
            changes: {
              enabled: { old: previous?.enabled ?? false, new: enabled },
              frequency: { old: previous?.frequency ?? null, new: frequency },
              daysOfWeek: { old: previous?.days_of_week ?? null, new: daysOfWeek },
              sendTime: { old: previous?.send_time ?? null, new: sendTime },
              timezone: { old: previous?.timezone ?? null, new: timezone },
              includeCost: { old: previous?.include_cost ?? false, new: includeCost },
              includeZeroStock: { old: previous?.include_zero_stock ?? false, new: includeZeroStock },
              includeNegativeStock: { old: previous?.include_negative_stock ?? true, new: includeNegativeStock },
              stockGroupId: { old: previous?.stock_group_id ?? null, new: stockGroupId },
              categoryId: { old: previous?.category_id ?? null, new: categoryId },
            },
          });
        } catch {
          /* schedule save remains valid if audit persistence is temporarily unavailable */
        }

        res.json(serializeSchedule(result.rows[0], locationId));
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.startsWith("Invalid ") || message.includes("not found for this company"))
          return res.status(400).json({ message });
        logger.error("[LocationStockSchedule] PUT failed", { error });
        res.status(500).json({ message });
      }
    }
  );
}
