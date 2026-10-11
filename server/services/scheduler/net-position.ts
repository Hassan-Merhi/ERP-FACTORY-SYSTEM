import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import { getWaSettings, getActiveRecipients, sendWhatsAppFile, sendWhatsAppText } from "../whatsappService";
import { generateNetPositionExcel } from "../../helpers/generateNetPositionExcel";
import { storage } from "../../storage";
import { getTodayLabel } from "./daily-export";
import { loadOverdueCustomerBalances } from "./overdueCustomerQuery";
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
 * Check all factory customers who have payment terms set and an outstanding debit balance
 * whose oldest unpaid invoice has passed its due date (invoice_date + payment_terms_days).
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
    // Find customers with payment terms set, their net balance (debit = they owe us),
    // and the earliest finalized invoice date per customer.
    const customerBalances = await loadOverdueCustomerBalances();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdue: { name: string; balance: number; dueDate: string; daysOverdue: number }[] = [];

    for (const row of customerBalances) {
      const earliestInvoiceDate = row.earliest_invoice_date ? new Date(row.earliest_invoice_date) : null;
      if (!earliestInvoiceDate) continue;

      const dueDate = new Date(earliestInvoiceDate);
      dueDate.setDate(dueDate.getDate() + Number(row.payment_terms_days));
      dueDate.setHours(0, 0, 0, 0);

      if (dueDate <= today) {
        const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
        overdue.push({
          name: row.legal_name,
          balance: toMoney(row.net_balance).toNumber(),
          dueDate: dueDate.toISOString().substring(0, 10),
          daysOverdue,
        });
      }
    }

    if (overdue.length === 0) {
      logger.info("[OverdueCheck] No overdue customers today.");
      return;
    }

    const lines = overdue.map(
      (c) =>
        `• ${c.name}: $${c.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} — due ${c.dueDate} (${c.daysOverdue === 0 ? "due today" : `${c.daysOverdue}d overdue`})`
    );

    const message = `*Payment Reminder*\n\nThe following customers have outstanding balances past their due date:\n\n${lines.join("\n")}\n\nPlease follow up.`;

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

/**
 * Reads the configured schedule_hour + schedule_timezone from export_settings
 * and runs the daily export if the current local hour matches and it hasn't run today.
 * Called every hour by the main hourly cron.
 */
