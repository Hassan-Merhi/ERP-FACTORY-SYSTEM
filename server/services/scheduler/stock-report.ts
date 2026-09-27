import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { sendExportEmail } from "../emailService";
import { pool } from "../../db";
import { getWaSettings, sendWhatsAppFileToChatId } from "../whatsappService";
import { generateNetPositionExcel } from "../../helpers/generateNetPositionExcel";
import { generateStockPdf } from "../../helpers/generateStockPdf";
import { getExportAttachmentSize, releaseManagedExportAttachment } from "../../helpers/exportAttachmentSource";
import { storage } from "../../storage";
import { buildNetPositionZip, getTodayLabel } from "./daily-export";
import { shouldSendStockReport } from "./whatsapp-send";

const SCHEDULER_PREFLIGHT_TIMEOUT_MS = 20_000;

async function withSchedulerPreflightTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${SCHEDULER_PREFLIGHT_TIMEOUT_MS}ms`)), SCHEDULER_PREFLIGHT_TIMEOUT_MS);
    timer.unref();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkAndRunStockReport(): Promise<void> {
  try {
    const r = await withSchedulerPreflightTimeout(
      "StockReport settings read",
      pool.query(
        `SELECT company_id, recipient_id, auto_send, enabled,
                frequency, send_hour, send_day_of_week, last_sent_at
         FROM whatsapp_stock_settings WHERE id = 1`
      )
    );
    if (!r.rows.length) return;
    const row = r.rows[0];

    if (!row.enabled || !row.auto_send) return;
    if (!row.company_id || !row.recipient_id) return;

    const cfg = {
      frequency: (row.frequency ?? "daily") as string,
      sendHour: (row.send_hour ?? 18) as number,
      sendDayOfWeek: (row.send_day_of_week ?? null) as number | null,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
    };

    if (!shouldSendStockReport(cfg)) return;

    const rq = await pool.query("SELECT chat_id FROM whatsapp_recipients WHERE id = $1 AND active = true", [
      row.recipient_id,
    ]);
    if (!rq.rows.length) {
      logger.info("[StockReport] Recipient inactive — skipping.");
      return;
    }
    const chatId = rq.rows[0].chat_id as string;

    const allCompanies = await storage.getAllCompanies();
    const company = allCompanies.find((candidate) => candidate.id === row.company_id);
    if (!company) {
      logger.info(`[StockReport] Company ${row.company_id} not found.`);
      return;
    }

    const today = getTodayLabel();
    const yearStart = `${new Date().getUTCFullYear()}-01-01`;

    logger.info(`[StockReport] Sending to ${company.name} → ${chatId} (${cfg.frequency})…`);

    const {
      buffer: pdfBuf,
      pageCount: pdfPageCount,
      rowCount: pdfRowCount,
    } = await generateStockPdf(row.company_id, company.name, undefined, undefined, true);

    try {
      const maxAllowedPages = Math.ceil(pdfRowCount / 20) + 5;
      if (pdfPageCount > maxAllowedPages) {
        logger.error(
          `[StockReport] SAFETY GUARD: PDF has ${pdfPageCount} pages for ${pdfRowCount} rows ` +
            `(max allowed: ${maxAllowedPages}). company="${company.name}". Skipping WhatsApp send.`
        );
        return;
      }

      const pdfName = `Stock_${company.name.replace(/[^a-z0-9]/gi, "_")}_${today}.pdf`;
      logger.info(
        `[StockReport] Uploading stock PDF — chatId=${chatId} file=${pdfName} ` +
          `size=${getExportAttachmentSize(pdfBuf)} pageCount=${pdfPageCount} rowCount=${pdfRowCount}`
      );
      const pdfRes = await sendWhatsAppFileToChatId(chatId, pdfBuf, pdfName, "", "application/pdf");
      if (pdfRes.success) {
        logger.info(`[StockReport] PDF sent — chatId=${chatId} file=${pdfName}`);
      } else {
        logger.error(
          `[StockReport] PDF upload failed — chatId=${chatId} file=${pdfName} ` +
            `size=${getExportAttachmentSize(pdfBuf)} pageCount=${pdfPageCount} rowCount=${pdfRowCount} ` +
            `greenApiError="${pdfRes.error}"`
        );
      }
    } finally {
      await releaseManagedExportAttachment(pdfBuf);
    }

    const xlsBuf = await generateNetPositionExcel(row.company_id, company.name, yearStart, today);
    try {
      const xlsName = `NetPosition_${company.name.replace(/[^a-z0-9]/gi, "_")}_${today}.xlsx`;
      const xlsRes = await sendWhatsAppFileToChatId(
        chatId,
        xlsBuf,
        xlsName,
        "",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      logger.info(`[StockReport] Net Position Excel: ${xlsRes.success ? "sent" : xlsRes.error}`);
    } finally {
      await releaseManagedExportAttachment(xlsBuf);
    }

    await pool.query(`UPDATE whatsapp_stock_settings SET last_sent_at = now() WHERE id = 1`);
    logger.info("[StockReport] Done — last_sent_at updated.");
  } catch (err: unknown) {
    logger.error("[StockReport] Error:", { error: getErrorMessage(err) || err });
  }
}

// ─── Net Position Scheduled Export — all companies → WhatsApp group + email ──

export async function checkAndRunNetPositionExport(): Promise<void> {
  try {
    const r = await withSchedulerPreflightTimeout(
      "NetPositionExport settings read",
      pool.query(
        `SELECT recipient_id, frequency, send_hour, send_day_of_week,
                enabled, auto_send, last_sent_at
         FROM net_position_export_settings WHERE id = 1`
      )
    );
    if (!r.rows.length) return;
    const row = r.rows[0];

    if (!row.enabled || !row.auto_send) return;

    const cfg = {
      frequency: (row.frequency ?? "daily") as string,
      sendHour: (row.send_hour ?? 18) as number,
      sendDayOfWeek: (row.send_day_of_week ?? null) as number | null,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
    };

    if (!shouldSendStockReport(cfg)) return;

    const companies = await storage.getAllCompanies();
    if (!companies.length) {
      logger.info("[NetPositionExport] No companies found — skipping.");
      return;
    }

    const today = getTodayLabel();
    const year = new Date().getUTCFullYear();
    const npStart = `${year}-01-01`;
    const npEnd = today;

    logger.info(
      `[NetPositionExport] Building net position ZIP for ${companies.length} companies (${npStart}→${npEnd})…`
    );
    const zipBuf = await buildNetPositionZip(companies, npStart, npEnd);

    try {
      logger.info(`[NetPositionExport] ZIP ready (${(zipBuf.length / 1024).toFixed(0)} KB)`);

      if (row.recipient_id) {
        const rq = await pool.query("SELECT chat_id FROM whatsapp_recipients WHERE id = $1 AND active = true", [
          row.recipient_id,
        ]);
        if (rq.rows.length) {
          const chatId = rq.rows[0].chat_id as string;
          const waSettings = await getWaSettings();
          if (waSettings?.enabled) {
            const waRes = await sendWhatsAppFileToChatId(
              chatId,
              zipBuf,
              `NetPosition_AllCompanies_${today}.zip`,
              "",
              "application/zip"
            );
            logger.info(`[NetPositionExport] WhatsApp: ${waRes.success ? "sent" : waRes.error}`);
          } else {
            logger.info("[NetPositionExport] WhatsApp not enabled — skipping WhatsApp send.");
          }
        } else {
          logger.info(`[NetPositionExport] Recipient id=${row.recipient_id} inactive — skipping WhatsApp.`);
        }
      }

      const emailResult = await sendExportEmail(
        zipBuf,
        today,
        companies.map((company) => company.name)
      );
      logger.info(`[NetPositionExport] Email: ${emailResult.success ? "sent" : emailResult.error}`);

      await pool.query(`UPDATE net_position_export_settings SET last_sent_at = now() WHERE id = 1`);
      logger.info("[NetPositionExport] Done — last_sent_at updated.");
    } finally {
      await releaseManagedExportAttachment(zipBuf);
    }
  } catch (err: unknown) {
    logger.error("[NetPositionExport] Error:", { error: getErrorMessage(err) || err });
  }
}
