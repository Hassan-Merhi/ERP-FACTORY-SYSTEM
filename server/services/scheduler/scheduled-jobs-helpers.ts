// Extracted from ./scheduled-jobs.ts
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";

function nowInNewYork(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function sameIsoWeek(left: Date, right: Date): boolean {
  const monday = (value: Date) => {
    const copy = new Date(value);
    const day = copy.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    copy.setDate(copy.getDate() + diff);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  return monday(left).getTime() === monday(right).getTime();
}

export function scheduledReportIsDue(row: {
  enabled: boolean | null;
  auto_send: boolean | null;
  frequency: string | null;
  send_hour: number | null;
  send_day_of_week: number | null;
  last_sent_at: Date | string | null;
}): boolean {
  if (!row.enabled || !row.auto_send) return false;

  const now = nowInNewYork();
  const sendHour = row.send_hour ?? 18;
  if (now.getHours() !== sendHour) return false;

  const frequency = row.frequency ?? "daily";
  if (row.last_sent_at) {
    const last = new Date(new Date(row.last_sent_at).toLocaleString("en-US", { timeZone: "America/New_York" }));
    if (frequency === "daily" && last.toDateString() === now.toDateString()) return false;
    if (frequency === "weekly" && sameIsoWeek(last, now)) return false;
    if (frequency === "monthly" && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()) {
      return false;
    }
  }

  if (frequency === "daily") return true;
  if (frequency === "weekly") return now.getDay() === (row.send_day_of_week ?? 1);
  if (frequency === "monthly") return now.getDate() === 1;
  return false;
}

async function hasRetryableWhatsAppOccurrence(jobType: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1
         FROM scheduled_whatsapp_occurrences o
        WHERE o.job_type = $1
          AND o.created_at >= now() - interval '36 hours'
          AND (
            (
              o.status IN ('partial', 'failed')
              AND (o.claim_token IS NULL OR o.claim_expires_at < now())
            )
            OR (
              o.status = 'claimed'
              AND o.claim_expires_at < now()
            )
            OR (
              o.status = 'delivering'
              AND o.claim_expires_at < now()
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM scheduled_whatsapp_attachments a
             WHERE a.occurrence_id = o.id
               AND a.status = 'sending'
          )
        LIMIT 1`,
      [jobType]
    );
    return Boolean(result.rowCount);
  } catch (error: unknown) {
    // During a rolling deployment the code can briefly run before the startup
    // migration has created the durable delivery tables. Fall back to the
    // existing due-time check for that short window.
    if ((error as { code?: string })?.code === "42P01") return false;
    throw error;
  }
}

export async function shouldLoadStockReportModule(): Promise<boolean> {
  const { rows } = await pool.query<{
    company_id: number | null;
    recipient_id: number | null;
    enabled: boolean | null;
    auto_send: boolean | null;
    frequency: string | null;
    send_hour: number | null;
    send_day_of_week: number | null;
    last_sent_at: Date | string | null;
  }>(
    `SELECT company_id, recipient_id, enabled, auto_send, frequency,
            send_hour, send_day_of_week, last_sent_at
       FROM whatsapp_stock_settings
      WHERE id = 1`
  );
  const row = rows[0];
  if (!row?.company_id || !row?.recipient_id || !row.enabled || !row.auto_send) return false;
  if (await hasRetryableWhatsAppOccurrence("stock_report")) return true;
  return scheduledReportIsDue(row);
}

export async function shouldLoadContainersWhatsAppModule(): Promise<boolean> {
  const { rows } = await pool.query<{
    instance_id: string | null;
    api_token: string | null;
    enabled: boolean | null;
    group_chat_id: string | null;
    schedule_enabled: boolean | null;
    schedule_hour: number | null;
    last_sent_at: Date | string | null;
  }>(
    `SELECT instance_id, api_token, enabled,
            containers_wa_group_chat_id AS group_chat_id,
            containers_wa_schedule_enabled AS schedule_enabled,
            containers_wa_schedule_hour AS schedule_hour,
            containers_wa_last_sent_at AS last_sent_at
       FROM whatsapp_settings
      WHERE id = 1`
  );
  const row = rows[0];
  if (!row?.enabled || !row.instance_id || !row.api_token || !row.group_chat_id || !row.schedule_enabled) {
    return false;
  }

  if (await hasRetryableWhatsAppOccurrence("containers_report")) return true;

  const now = nowInNewYork();
  if (now.getHours() !== (row.schedule_hour ?? 8)) return false;

  if (row.last_sent_at) {
    const hoursSince = (Date.now() - new Date(row.last_sent_at).getTime()) / (60 * 60 * 1000);
    if (hoursSince < 12) return false;
  }

  return true;
}

export async function checkAndRunScheduledDailyExport(): Promise<void> {
  try {
    const { hasTodayExportSucceeded, isTodayExportRunning } = await import("./daily-export-state");
    const r = await pool.query(
      `SELECT schedule_enabled, schedule_hour, schedule_timezone FROM export_settings WHERE id = 1`
    );
    if (!r.rows.length) return;
    const row = r.rows[0];

    if (!row.schedule_enabled) return;

    const configuredHour: number = row.schedule_hour ?? 18;
    const tz: string = row.schedule_timezone || "America/New_York";

    const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const currentHour = nowInTz.getHours();

    if (currentHour !== configuredHour) return;

    if (await hasTodayExportSucceeded()) {
      logger.info("[DailyExport] Scheduled check: today's export already succeeded — skipping.");
      return;
    }
    if (await isTodayExportRunning()) {
      logger.info("[DailyExport] Scheduled check: export is currently running — skipping.");
      return;
    }

    logger.info(`[DailyExport] Scheduled check: time matches (${configuredHour}:00 ${tz}) — starting export attempt.`);
    const { runDailyExport } = await import("./daily-export");
    const ok = await runDailyExport();
    if (!ok) {
      logger.warn("[DailyExport] Attempt failed; the next scheduled tick will retry within this hour.");
    }
  } catch (err: unknown) {
    logger.error("[DailyExport] checkAndRunScheduledDailyExport error:", { error: getErrorMessage(err) || err });
  }
}
