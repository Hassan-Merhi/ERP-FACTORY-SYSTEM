/**
 * Company-scoped Properties ledger statements sent via the existing Green API
 * connection. This is a delivery workflow only: never posts to the GL.
 *
 * Every manual/scheduled send is claimed before the provider POST and is not
 * automatically retried after an ambiguous provider result.
 */
import { pool, db } from "../db";
import { and, eq } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { generateAccountStatementPdf } from "../lib/accountStatementPdfGenerator";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { sendWhatsAppFileByUploadPos } from "./whatsappService";
import { createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext } from "./security/databaseScopeRuntimeContext";

export type PropertiesWaFrequency = "daily" | "weekly" | "monthly";
export type PropertiesWaPeriod = "current_month" | "previous_month";

export interface PropertiesWaSchedule {
  company_id: number;
  account_id: number;
  chat_id: string;
  enabled: boolean;
  frequency: PropertiesWaFrequency;
  send_time: string;
  day_of_week: number;
  day_of_month: number;
  timezone: string;
  period_mode: PropertiesWaPeriod;
  updated_at: Date;
}

export const DEFAULT_PROPERTIES_WA_SCHEDULE = {
  chatId: "",
  enabled: false,
  frequency: "monthly" as PropertiesWaFrequency,
  sendTime: "09:00",
  dayOfWeek: 1,
  dayOfMonth: 1,
  timezone: "Asia/Beirut",
  periodMode: "previous_month" as PropertiesWaPeriod,
};

const statements = [
  `CREATE TABLE IF NOT EXISTS properties_account_wa_schedules (
    company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    account_id integer NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,
    chat_id text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    frequency text NOT NULL DEFAULT 'monthly'
      CHECK (frequency IN ('daily','weekly','monthly')),
    send_time varchar(5) NOT NULL DEFAULT '09:00'
      CHECK (send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    day_of_week integer NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
    day_of_month integer NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
    timezone text NOT NULL DEFAULT 'Asia/Beirut',
    period_mode text NOT NULL DEFAULT 'previous_month'
      CHECK (period_mode IN ('current_month','previous_month')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS properties_account_wa_deliveries (
    id bigserial PRIMARY KEY,
    company_id integer NOT NULL REFERENCES companies(id),
    account_id integer NOT NULL REFERENCES ledger_accounts(id),
    attempt_key text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('manual','scheduled')),
    chat_id text NOT NULL,
    statement_from date,
    statement_to date,
    status text NOT NULL DEFAULT 'sending'
      CHECK (status IN ('sending','accepted','failed','uncertain')),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (company_id, account_id, attempt_key)
  )`,
  "CREATE INDEX IF NOT EXISTS properties_account_wa_deliveries_lookup_idx ON properties_account_wa_deliveries(company_id, account_id, created_at DESC)",
];

let ensurePromise: Promise<void> | undefined;
export function ensurePropertiesWaStatementSchema(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      for (const statement of statements) await pool.query(statement);
    })().catch((error) => {
      ensurePromise = undefined;
      throw error;
    });
  }
  return ensurePromise;
}

export function propertiesWaLocalParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: days[get("weekday")] ?? -1,
    monthDay: Number(get("day")),
  };
}

export function propertiesWaDue(schedule: PropertiesWaSchedule, now: Date): string | null {
  if (!schedule.enabled || !schedule.chat_id) return null;
  const local = propertiesWaLocalParts(now, schedule.timezone);
  if (local.time < schedule.send_time) return null;
  if (schedule.frequency === "weekly" && local.weekday !== schedule.day_of_week) return null;
  if (schedule.frequency === "monthly" && local.monthDay !== schedule.day_of_month) return null;
  // Enabling/editing after today's scheduled time must not back-send today.
  const changed = propertiesWaLocalParts(new Date(schedule.updated_at), schedule.timezone);
  if (changed.date === local.date && changed.time > schedule.send_time) return null;
  return local.date;
}

export function propertiesWaDateRange(localDate: string, mode: PropertiesWaPeriod) {
  const year = Number(localDate.slice(0, 4));
  const month = Number(localDate.slice(5, 7));
  const currentFirst = new Date(Date.UTC(year, month - 1, 1));
  const start = mode === "previous_month" ? new Date(Date.UTC(year, month - 2, 1)) : currentFirst;
  const end = mode === "previous_month" ? new Date(Date.UTC(year, month - 1, 0)) : new Date(localDate + "T00:00:00Z");
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return { startDate: day(start), endDate: day(end) };
}

export interface PropertiesWaSendInput {
  companyId: number;
  accountId: number;
  chatId: string;
  attemptKey: string;
  mode: "manual" | "scheduled";
  startDate?: string;
  endDate?: string;
}

export async function sendPropertiesWaStatement(input: PropertiesWaSendInput) {
  await ensurePropertiesWaStatementSchema();
  const { companyId, accountId, chatId, attemptKey, mode, startDate, endDate } = input;
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO properties_account_wa_deliveries
      (company_id, account_id, attempt_key, mode, chat_id, statement_from, statement_to)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date)
     ON CONFLICT (company_id, account_id, attempt_key) DO NOTHING RETURNING id::text`,
    [companyId, accountId, attemptKey, mode, chatId, startDate ?? null, endDate ?? null]
  );
  if (!claim.rowCount) return { accepted: false, duplicate: true };

  const deliveryId = claim.rows[0].id;
  let status: "accepted" | "failed" | "uncertain";
  let error: string | null = null;
  try {
    // Scoped server reads also protect background-scheduler sends.
    const accountAndPdf = await runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(companyId), async () => {
      const [account] = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
        .limit(1);
      if (!account) throw new Error("Properties account no longer exists");
      const pdf = await generateAccountStatementPdf({
        accountType: "ledger",
        accountId,
        companyId,
        startDate,
        endDate,
        lang: "en",
      });
      return { name: account.name, pdf };
    });
    const safeName = accountAndPdf.name.replace(/[^\w\s.()-]/g, "_").slice(0, 75);
    const suffix = endDate ?? "All-Time";
    const fileName = `${safeName}-Statement-${suffix}.pdf`;
    const result = await sendWhatsAppFileByUploadPos(
      chatId,
      accountAndPdf.pdf,
      fileName,
      `${accountAndPdf.name} — Properties account statement (through ${suffix})`
    );
    if (!result.success) {
      error = result.error || "WhatsApp provider rejected the file";
      status = /timeout|aborted|network|connection reset/i.test(error) ? "uncertain" : "failed";
    } else {
      status = "accepted";
    }
  } catch (caught) {
    error = getErrorMessage(caught).slice(0, 500);
    // A failure before provider upload is definite; a thrown connection error
    // during upload is ambiguous, so never auto-retry that claim.
    status = /timeout|aborted|network|connection/i.test(error) ? "uncertain" : "failed";
  }

  await pool.query(
    `UPDATE properties_account_wa_deliveries SET status=$2, error=$3, completed_at=now()
      WHERE id=$1 AND company_id=$4`,
    [deliveryId, status, error, companyId]
  );
  return { accepted: status === "accepted", status, error, duplicate: false };
}

export async function runScheduledPropertiesWaStatements(now = new Date()) {
  await ensurePropertiesWaStatementSchema();
  const active = await pool.query<PropertiesWaSchedule>(
    "SELECT * FROM properties_account_wa_schedules WHERE enabled = true"
  );
  for (const schedule of active.rows) {
    let localDate: string | null;
    try {
      localDate = propertiesWaDue(schedule, now);
    } catch (error) {
      logger.warn("[properties-wa] invalid statement schedule", {
        accountId: schedule.account_id,
        error: getErrorMessage(error),
      });
      continue;
    }
    if (!localDate) continue;
    const range = propertiesWaDateRange(localDate, schedule.period_mode);
    try {
      const result = await sendPropertiesWaStatement({
        companyId: schedule.company_id,
        accountId: schedule.account_id,
        chatId: schedule.chat_id,
        attemptKey: `scheduled:${localDate}`,
        mode: "scheduled",
        ...range,
      });
      if (result.error)
        logger.warn("[properties-wa] statement delivery not accepted", {
          accountId: schedule.account_id,
          status: result.status,
          error: result.error,
        });
    } catch (error) {
      logger.error("[properties-wa] scheduled send failed", {
        accountId: schedule.account_id,
        error: getErrorMessage(error),
      });
    }
  }
}
