import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import { getWaSettings, getActiveRecipients, sendWhatsAppFile, sendWhatsAppText } from "../whatsappService";
import { generateNetPositionExcel } from "../../helpers/generateNetPositionExcel";
import { storage } from "../../storage";
import { getTodayLabel } from "./daily-export";
import { loadOverdueCustomerBalances, type OverdueCustomerBalanceRow } from "./overdueCustomerQuery";
import { toMoney } from "../../lib/money";

export async function isScheduleEnabled(): Promise<boolean> {
  try {
    const res = await pool.query(`SELECT schedule_enabled FROM export_settings WHERE id = 1`);
    if (!res.rows || res.rows.length === 0) return false;
    return res.rows[0].schedule_enabled === true;
  } catch {
    return false;
  }
}

// ─── Monthly WhatsApp net-position send ───────────────────────────────────────

export async function runMonthlyWhatsAppNetPosition() {
  logger.info("[WhatsApp] Starting monthly net-position send…");
  try {
    const settings = await getWaSettings();
    if (!settings?.enabled || !settings?.monthlyAutoSend) {
      logger.info("[WhatsApp] Monthly auto-send is disabled — skipping.");
      return;
    }
    const recipients = await getActiveRecipients();
    if (!recipients.length) {
      logger.info("[WhatsApp] No active recipients — skipping.");
      return;
    }

    const companies = await storage.getAllCompanies();
    const endDate = getTodayLabel();
    const startDate = (() => {
      const d = new Date(endDate);
      d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().split("T")[0];
    })();

    for (const company of companies) {
      try {
        logger.info(`[WhatsApp] Generating net-position Excel for ${company.name}…`);
        const buffer = await generateNetPositionExcel(company.id, company.name, startDate, endDate);
        const safe = company.name.replace(/[^a-z0-9]/gi, "_");
        const fileName = `NetPosition_${safe}_${endDate}.xlsx`;
        const caption = "";
        const result = await sendWhatsAppFile(buffer, fileName, caption);
        logger.info(`[WhatsApp] ${company.name}: sent=${result.sent} failed=${result.failed}`);
      } catch (compErr: unknown) {
        logger.error(`[WhatsApp] Failed for ${company.name}:`, { error: getErrorMessage(compErr) });
      }
    }
    logger.info("[WhatsApp] Monthly net-position send complete.");
  } catch (err: unknown) {
    logger.error("[WhatsApp] Monthly send error:", { error: err });
  }
}

/**
 * Customers with an open invoice past its due date (accounting audit phase 25,
 * AR-4/AR-13): the aging's open items (overdueCustomerQuery.ts) — invoices
 * settled through the allocation table, due their booked date + the
 * customer's payment terms — in each company's book currency, exact amounts.
 * Sends a single consolidated WhatsApp text message listing all overdue customers.
 */
export async function checkOverdueCustomers(): Promise<void> {
  logger.info("[OverdueCheck] Running overdue customer payment check...");

  const waSettings = await getWaSettings();
  if (!waSettings?.enabled) {
    logger.info("[OverdueCheck] WhatsApp disabled — skipping.");
    return;
  }

  try {
    const overdue = await loadOverdueCustomerBalances();
    if (overdue.length === 0) {
      logger.info("[OverdueCheck] No overdue customers today.");
      return;
    }

    const message = formatOverdueReminder(overdue);
    const waRes = await sendWhatsAppText(message);
    if (waRes.success) {
      logger.info(`[OverdueCheck] Reminder sent for ${overdue.length} overdue customer(s).`);
    } else {
      logger.error("[OverdueCheck] Failed to send WhatsApp reminder:", { error: waRes.errors });
    }
  } catch (err: unknown) {
    logger.error("[OverdueCheck] Error during overdue check:", { error: getErrorMessage(err) });
  }
}

/** The reminder text: each customer's overdue amount and balance in its company's currency (no float). */
export function formatOverdueReminder(rows: readonly OverdueCustomerBalanceRow[]): string {
  const amount = (value: string, currency: string) => `${currency} ${formatMoneyGrouped(value)}`;
  const lines = rows.map(
    (c) =>
      `• ${c.legal_name}: ${amount(c.overdue_amount, c.currency)} overdue of ${amount(c.net_balance, c.currency)} — due ${c.due_date} (${c.days_overdue}d overdue)`
  );
  return `*Payment Reminder*\n\nThe following customers have outstanding balances past their due date:\n\n${lines.join("\n")}\n\nPlease follow up.`;
}

/** 1234567.5 → "1,234,567.50" from the exact string. */
function formatMoneyGrouped(value: string): string {
  const fixed = toMoney(value).toFixed(2);
  const negative = fixed.startsWith("-");
  const [whole, cents] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${cents}`;
}

/**
 * Reads the configured schedule_hour + schedule_timezone from export_settings
 * and runs the daily export if the current local hour matches and it hasn't run today.
 * Called every hour by the main hourly cron.
 */
