/**
 * Editable, company-scoped recurring WhatsApp text messages.
 * Table creation is idempotent and deliberately separate from the hash-pinned
 * legacy startupMigrations array. All send claims are persisted before a POST
 * to Green API, avoiding duplicate sends on overlapping Render workers.
 */
import { pool } from "../db";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";
import { getWaSettings, sendWhatsAppTextToChatId } from "./whatsappService";

const schemaStatements = [
  "CREATE TABLE IF NOT EXISTS whatsapp_message_schedules (" +
    "id bigserial PRIMARY KEY, company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE, " +
    "title varchar(120) NOT NULL, message text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Beirut', " +
    "weekly_times jsonb NOT NULL DEFAULT '{}'::jsonb, start_date date, end_date date, " +
    "enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), " +
    "updated_at timestamptz NOT NULL DEFAULT now(), " +
    "CONSTRAINT whatsapp_message_schedules_message_nonempty CHECK (char_length(trim(message)) > 0))",
  "CREATE INDEX IF NOT EXISTS whatsapp_message_schedules_company_idx ON whatsapp_message_schedules (company_id, enabled)",
  "CREATE TABLE IF NOT EXISTS whatsapp_message_schedule_recipients (" +
    "schedule_id bigint NOT NULL REFERENCES whatsapp_message_schedules(id) ON DELETE CASCADE, " +
    "recipient_id integer NOT NULL REFERENCES whatsapp_recipients(id) ON DELETE CASCADE, " +
    "PRIMARY KEY (schedule_id, recipient_id))",
  "CREATE TABLE IF NOT EXISTS whatsapp_message_schedule_deliveries (" +
    "id bigserial PRIMARY KEY, schedule_id bigint NOT NULL REFERENCES whatsapp_message_schedules(id) ON DELETE CASCADE, " +
    "recipient_id integer REFERENCES whatsapp_recipients(id) ON DELETE SET NULL, " +
    "recipient_name text NOT NULL, local_date date NOT NULL, message_snapshot text NOT NULL, " +
    "status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed')), " +
    "error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, " +
    "UNIQUE (schedule_id, recipient_id, local_date))",
  "CREATE INDEX IF NOT EXISTS whatsapp_message_schedule_deliveries_company_idx ON whatsapp_message_schedule_deliveries (schedule_id, created_at DESC)"
];

let ensuring: Promise<void> | null = null;
export function ensureScheduledWhatsAppMessageSchema(): Promise<void> {
  if (!ensuring) {
    ensuring = (async () => {
      for (const sql of schemaStatements) await pool.query(sql);
    })().catch((error) => {
      ensuring = null; // allow recovery if database was temporarily unavailable
      throw error;
    });
  }
  return ensuring;
}

export type WeeklyTimes = Record<string, string | null>;

export function parseWeeklyTimes(value: unknown): WeeklyTimes {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose at least one day and time");
  }
  const input = value as Record<string, unknown>;
  const result: WeeklyTimes = {};
  for (let day = 0; day < 7; day++) {
    const time = input[String(day)];
    if (time === null || time === undefined || time === "") continue;
    if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new Error("Each enabled day must have a valid 24-hour send time");
    }
    result[String(day)] = time;
  }
  if (Object.keys(result).length === 0) throw new Error("Enable at least one weekday");
  return result;
}

const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function getScheduledMessageLocalParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    localDate: [map.get("year"), map.get("month"), map.get("day")].join("-"),
    dayOfWeek: weekdays[map.get("weekday") || "Sun"] ?? 0,
    localTime: (map.get("hour") || "00") + ":" + (map.get("minute") || "00"),
  };
}

interface ScheduledMessageRow {
  id: string;
  company_id: number;
  message: string;
  timezone: string;
  weekly_times: WeeklyTimes;
  start_date: string | Date | null;
  end_date: string | Date | null;
  updated_at: Date;
  created_at: Date;
}
function dateString(value: string | Date | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export function shouldSendScheduledMessage(row: ScheduledMessageRow, now: Date) {
  const local = getScheduledMessageLocalParts(now, row.timezone);
  const sendTime = row.weekly_times?.[String(local.dayOfWeek)];
  if (!sendTime || local.localTime < sendTime) return null;
  if ((dateString(row.start_date) && local.localDate < dateString(row.start_date)!) ||
      (dateString(row.end_date) && local.localDate > dateString(row.end_date)!)) return null;
  // Creating/changing a schedule after its time today must not unexpectedly send
  // an already elapsed occurrence. Downtime after a legitimately due time CAN catch up.
  const changed = getScheduledMessageLocalParts(new Date(row.updated_at || row.created_at), row.timezone);
  if (changed.localDate === local.localDate && changed.localTime > sendTime) return null;
  return local.localDate;
}

export async function runScheduledWhatsAppMessages(now: Date = new Date()): Promise<void> {
  await ensureScheduledWhatsAppMessageSchema();
  // A process may stop after its provider POST. Never auto-retry that uncertain
  // delivery; mark the claim for investigation without risking a duplicate.
  await pool.query(
    "UPDATE whatsapp_message_schedule_deliveries SET status = 'failed', " +
    "error = 'Delivery outcome uncertain after scheduler interruption; not retried automatically' " +
    "WHERE status = 'sending' AND created_at < now() - interval '10 minutes'"
  );
  const wa = await getWaSettings();
  if (!wa?.enabled || !wa.instanceId || !wa.apiToken) return;

  const schedules = await pool.query<ScheduledMessageRow>(
    "SELECT id, company_id, message, timezone, weekly_times, start_date::text, end_date::text, " +
    "created_at, updated_at FROM whatsapp_message_schedules WHERE enabled = true"
  );
  for (const schedule of schedules.rows) {
    let localDate: string | null = null;
    try {
      localDate = shouldSendScheduledMessage(schedule, now);
    } catch (err) {
      logger.warn("Scheduled WhatsApp message has invalid timezone", { scheduleId: schedule.id, error: getErrorMessage(err) });
      continue;
    }
    if (!localDate) continue;
    const recipients = await pool.query<{ id: number; name: string; chat_id: string }>(
      "SELECT r.id, r.name, r.chat_id FROM whatsapp_message_schedule_recipients sr " +
      "JOIN whatsapp_recipients r ON r.id = sr.recipient_id " +
      "WHERE sr.schedule_id = $1 AND r.company_id = $2 AND r.active = true AND r.is_group = true",
      [schedule.id, schedule.company_id]
    );

    for (const recipient of recipients.rows) {
      // One immutable claim per schedule/group/local date. No blind retries of
      // ambiguous WhatsApp POSTs: provider timeouts might mean the send succeeded.
      const claim = await pool.query(
        "INSERT INTO whatsapp_message_schedule_deliveries " +
        "(schedule_id, recipient_id, recipient_name, local_date, message_snapshot, status) " +
        "VALUES ($1, $2, $3, $4::date, $5, 'sending') " +
        "ON CONFLICT (schedule_id, recipient_id, local_date) DO NOTHING RETURNING id",
        [schedule.id, recipient.id, recipient.name, localDate, schedule.message]
      );
      if (!claim.rowCount) continue;
      const deliveryId = claim.rows[0].id;
      try {
        const sent = await sendWhatsAppTextToChatId(recipient.chat_id, schedule.message);
        await pool.query(
          "UPDATE whatsapp_message_schedule_deliveries SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END WHERE id = $1",
          [deliveryId, sent.success ? "sent" : "failed", sent.success ? null : (sent.error || "Green API rejected the message").slice(0, 1000)]
        );
      } catch (err) {
        const message = getErrorMessage(err) || "Delivery outcome uncertain";
        await pool.query(
          "UPDATE whatsapp_message_schedule_deliveries SET status = 'failed', error = $2 WHERE id = $1",
          [deliveryId, message.slice(0, 1000)]
        );
        logger.error("Scheduled WhatsApp message delivery failed", { scheduleId: schedule.id, deliveryId, error: message });
      }
    }
  }
}
