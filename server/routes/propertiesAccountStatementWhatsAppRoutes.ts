/**
 * Properties account ledger: private WhatsApp PDF statement settings, manual
 * sends and scheduled delivery history. No GL or voucher writes.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../auth";
import { db, pool } from "../db";
import { companies, ledgerAccounts } from "@shared/schema";
import { getErrorMessage } from "../lib/httpHandlers";
import { fetchGreenApiChats, getPosWaSettings, normaliseChatId } from "../services/whatsappService";
import {
  DEFAULT_PROPERTIES_WA_SCHEDULE,
  ensurePropertiesWaStatementSchema,
  sendPropertiesWaStatement,
} from "../services/propertiesAccountStatementWhatsApp";

const authorized = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;

async function scopedAccount(req: Request, res: Response) {
  const companyId = Number(req.session.currentCompanyId);
  const accountId = Number(req.params.accountId);
  if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(accountId) || accountId < 1) {
    res.status(400).json({ message: "Select a valid Properties account" });
    return null;
  }
  const [[company], [account]] = await Promise.all([
    db.select({ companyType: companies.companyType }).from(companies).where(eq(companies.id, companyId)).limit(1),
    db
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)))
      .limit(1),
  ]);
  if (company?.companyType?.toLowerCase() !== "properties" || !account) {
    res.status(404).json({ message: "Properties ledger account not found in this company" });
    return null;
  }
  return { companyId, accountId, accountName: account.name };
}

function toChatId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const normalized = normaliseChatId(raw);
  if (/^\d{7,15}@c\.us$/.test(normalized)) return normalized;
  if (/^\d{5,25}(?:-\d{5,25})?@g\.us$/.test(normalized)) return normalized;
  throw new Error("Choose a WhatsApp group or enter an international phone number including country code");
}

function validDate(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(raw + "T00:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === raw;
}

export function registerPropertiesAccountStatementWhatsAppRoutes(app: Express): void {
  const prefix = "/api/properties/accounts/:accountId/whatsapp-statement";

  app.get(prefix, ...authorized, async (req, res) => {
    try {
      const account = await scopedAccount(req, res);
      if (!account) return;
      await ensurePropertiesWaStatementSchema();
      const result = await pool.query(
        "SELECT chat_id, enabled, frequency, send_time, day_of_week, day_of_month, timezone, period_mode " +
          "FROM properties_account_wa_schedules WHERE company_id=$1 AND account_id=$2",
        [account.companyId, account.accountId]
      );
      const saved = result.rows[0];
      res.json(
        saved
          ? {
              chatId: saved.chat_id,
              enabled: saved.enabled,
              frequency: saved.frequency,
              sendTime: saved.send_time,
              dayOfWeek: saved.day_of_week,
              dayOfMonth: saved.day_of_month,
              timezone: saved.timezone,
              periodMode: saved.period_mode,
            }
          : DEFAULT_PROPERTIES_WA_SCHEDULE
      );
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put(prefix, ...authorized, async (req, res) => {
    try {
      const account = await scopedAccount(req, res);
      if (!account) return;
      const input = req.body && typeof req.body === "object" ? req.body : {};
      if (typeof input.enabled !== "boolean") {
        return res.status(400).json({ message: "Enable automatic delivery: true or false" });
      }
      const chatId = toChatId(input.chatId);
      if (input.enabled && !chatId)
        return res.status(400).json({ message: "Choose a WhatsApp recipient before enabling the schedule" });
      const frequency = input.frequency;
      if (!["daily", "weekly", "monthly"].includes(frequency)) {
        return res.status(400).json({ message: "Choose daily, weekly or monthly" });
      }
      const sendTime = String(input.sendTime ?? "");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
        return res.status(400).json({ message: "Invalid 24-hour send time" });
      }
      const dayOfWeek = Number(input.dayOfWeek);
      const dayOfMonth = Number(input.dayOfMonth);
      if (
        !Number.isInteger(dayOfWeek) ||
        dayOfWeek < 0 ||
        dayOfWeek > 6 ||
        !Number.isInteger(dayOfMonth) ||
        dayOfMonth < 1 ||
        dayOfMonth > 28
      ) {
        return res.status(400).json({ message: "Choose a valid schedule day" });
      }
      const timezone = String(input.timezone ?? "Asia/Beirut");
      if (timezone.length > 80) return res.status(400).json({ message: "Invalid timezone" });
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
      } catch {
        return res.status(400).json({ message: "Invalid timezone" });
      }
      const periodMode = input.periodMode;
      if (!["current_month", "previous_month"].includes(periodMode)) {
        return res.status(400).json({ message: "Choose a statement period" });
      }

      // Group IDs are never accepted solely on client assertion: the connected
      // provider must confirm that this group belongs to its accessible chats.
      if (chatId.endsWith("@g.us")) {
        const settings = await getPosWaSettings();
        if (!settings?.enabled || !settings.instanceId || !settings.apiToken) {
          return res.status(503).json({ message: "Connect the WhatsApp instance to select a group" });
        }
        const chats = await fetchGreenApiChats(settings.instanceId, settings.apiToken);
        if (!chats.some((chat) => chat.id === chatId)) {
          return res
            .status(400)
            .json({ message: "Selected WhatsApp group is not accessible from the connected instance" });
        }
      }

      await ensurePropertiesWaStatementSchema();
      await pool.query(
        `INSERT INTO properties_account_wa_schedules
          (company_id, account_id, chat_id, enabled, frequency, send_time,
           day_of_week, day_of_month, timezone, period_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (company_id, account_id) DO UPDATE SET
           chat_id=EXCLUDED.chat_id, enabled=EXCLUDED.enabled,
           frequency=EXCLUDED.frequency, send_time=EXCLUDED.send_time,
           day_of_week=EXCLUDED.day_of_week, day_of_month=EXCLUDED.day_of_month,
           timezone=EXCLUDED.timezone, period_mode=EXCLUDED.period_mode,
           updated_at=now()`,
        [
          account.companyId,
          account.accountId,
          chatId,
          input.enabled,
          frequency,
          sendTime,
          dayOfWeek,
          dayOfMonth,
          timezone,
          periodMode,
        ]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post(prefix + "/send", ...authorized, async (req, res) => {
    try {
      const account = await scopedAccount(req, res);
      if (!account) return;
      await ensurePropertiesWaStatementSchema();
      const setting = await pool.query<{ chat_id: string }>(
        "SELECT chat_id FROM properties_account_wa_schedules WHERE company_id=$1 AND account_id=$2",
        [account.companyId, account.accountId]
      );
      if (!setting.rows[0]?.chat_id) return res.status(400).json({ message: "Save a group or contact before sending" });
      const startDate = req.body?.startDate;
      const endDate = req.body?.endDate;
      if (
        (startDate != null && !validDate(startDate)) ||
        (endDate != null && !validDate(endDate)) ||
        (startDate && endDate && startDate > endDate)
      ) {
        return res.status(400).json({ message: "Invalid statement date range" });
      }
      const requestId = String(req.body?.requestId ?? "");
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) {
        return res.status(400).json({ message: "Missing or invalid unique send request" });
      }
      const result = await sendPropertiesWaStatement({
        companyId: account.companyId,
        accountId: account.accountId,
        chatId: setting.rows[0].chat_id,
        attemptKey: "manual:" + requestId,
        mode: "manual",
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
      });
      if (result.duplicate)
        return res.status(409).json({ message: "This send request was already processed. Check delivery history." });
      if (!result.accepted)
        return res.status(502).json({
          message: result.error || "WhatsApp did not accept this statement",
          status: result.status,
        });
      res.json({ success: true, deliveryStatus: "accepted" });
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get(prefix + "/history", ...authorized, async (req, res) => {
    try {
      const account = await scopedAccount(req, res);
      if (!account) return;
      await ensurePropertiesWaStatementSchema();
      const history = await pool.query(
        `SELECT mode, chat_id, statement_from::text AS from_date,
            statement_to::text AS to_date, status, error, created_at, completed_at
         FROM properties_account_wa_deliveries
         WHERE company_id=$1 AND account_id=$2 ORDER BY created_at DESC LIMIT 30`,
        [account.companyId, account.accountId]
      );
      res.json(history.rows);
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
