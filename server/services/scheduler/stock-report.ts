import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { sendExportEmail } from "../emailService";
import { pool } from "../../db";
import { getWaSettings, sendWhatsAppFileToChatId } from "../whatsappService";
import { generateNetPositionExcel } from "../../helpers/generateNetPositionExcel";
import { generateStockPdf } from "../../helpers/generateStockPdf";
import { releaseManagedExportAttachment } from "../../helpers/exportAttachmentSource";
import { storage } from "../../storage";
import { buildNetPositionZip, getTodayLabel } from "./daily-export";
import { shouldSendStockReport } from "./whatsapp-send";
import {
  beginScheduledWhatsAppAttachmentAttempt,
  claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence,
  finalizeScheduledWhatsAppOccurrence,
  finishScheduledWhatsAppAttachmentAttempt,
  logScheduledWhatsAppAttachmentResult,
  recordScheduledWhatsAppAttachmentPreparationFailure,
} from "./scheduledWhatsAppDelivery";

const SCHEDULER_PREFLIGHT_TIMEOUT_MS = 20_000;

function getNewYorkLocalDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

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

    const rq = await pool.query(
      "SELECT chat_id FROM whatsapp_recipients WHERE id = $1 AND active = true",
      [row.recipient_id]
    );
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

    const recipientKey = `recipient:${row.recipient_id}:chat:${chatId}`;
    let claim = await claimRetryableScheduledWhatsAppOccurrence({
      jobType: "stock_report",
      companyId: row.company_id,
      recipientKey,
      recipientChatId: chatId,
    });

    if (!claim) {
      if (!shouldSendStockReport(cfg)) return;
      claim = await claimScheduledWhatsAppOccurrence({
        jobType: "stock_report",
        companyId: row.company_id,
        recipientKey,
        recipientChatId: chatId,
        scheduledLocalDate: getNewYorkLocalDate(),
        scheduledLocalHour: cfg.sendHour,
        attachmentKeys: ["pdf", "excel"],
      });
    }

    if (!claim?.acquired) {
      if (claim) {
        logger.info("[StockReport] Occurrence already owned or completed — skipping.", {
          occurrenceKey: claim.occurrenceKey,
          recipient: recipientKey,
          result: claim.status,
        });
      }
      return;
    }

    const reportDate = claim.scheduledLocalDate;
    const yearStart = `${reportDate.slice(0, 4)}-01-01`;
    logger.info("[StockReport] Scheduled occurrence claimed.", {
      occurrenceKey: claim.occurrenceKey,
      recipient: recipientKey,
      companyId: row.company_id,
      localScheduledDate: claim.scheduledLocalDate,
      localScheduledHour: claim.scheduledLocalHour,
    });

    const pdfState = claim.attachments.find((attachment) => attachment.key === "pdf");
    if (pdfState?.status !== "sent") {
      let pdfBuf: Awaited<ReturnType<typeof generateStockPdf>>["buffer"] | null = null;
      try {
        let generated: Awaited<ReturnType<typeof generateStockPdf>>;
        try {
          generated = await generateStockPdf(row.company_id, company.name, undefined, undefined, true);
          pdfBuf = generated.buffer;
        } catch (error) {
          const attempt = await recordScheduledWhatsAppAttachmentPreparationFailure({
            claim,
            attachmentKey: "pdf",
            error,
          });
          if (attempt) {
            await logScheduledWhatsAppAttachmentResult({
              claim,
              recipient: recipientKey,
              attachment: "pdf",
              attempt,
              success: false,
              error,
            });
          }
          generated = null as never;
        }

        if (pdfBuf && generated) {
          const maxAllowedPages = Math.ceil(generated.rowCount / 20) + 5;
          if (generated.pageCount > maxAllowedPages) {
            const error =
              `PDF safety guard rejected ${generated.pageCount} pages for ${generated.rowCount} rows`;
            const attempt = await recordScheduledWhatsAppAttachmentPreparationFailure({
              claim,
              attachmentKey: "pdf",
              error,
            });
            if (attempt) {
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "pdf",
                attempt,
                success: false,
                error,
              });
            }
          } else {
            const attempt = await beginScheduledWhatsAppAttachmentAttempt(claim, "pdf");
            if (attempt) {
              const pdfName = `Stock_${company.name.replace(/[^a-z0-9]/gi, "_")}_${reportDate}.pdf`;
              try {
                const pdfRes = await sendWhatsAppFileToChatId(
                  chatId,
                  pdfBuf,
                  pdfName,
                  "",
                  "application/pdf"
                );
                await finishScheduledWhatsAppAttachmentAttempt({
                  claim,
                  attachmentKey: "pdf",
                  success: pdfRes.success,
                  error: pdfRes.error,
                });
                await logScheduledWhatsAppAttachmentResult({
                  claim,
                  recipient: recipientKey,
                  attachment: "pdf",
                  attempt,
                  success: pdfRes.success,
                  error: pdfRes.error,
                });
              } catch (error) {
                await finishScheduledWhatsAppAttachmentAttempt({
                  claim,
                  attachmentKey: "pdf",
                  success: false,
                  error: getErrorMessage(error),
                });
                await logScheduledWhatsAppAttachmentResult({
                  claim,
                  recipient: recipientKey,
                  attachment: "pdf",
                  attempt,
                  success: false,
                  error,
                });
              }
            }
          }
        }
      } finally {
        if (pdfBuf) await releaseManagedExportAttachment(pdfBuf);
      }
    }

    const excelState = claim.attachments.find((attachment) => attachment.key === "excel");
    if (excelState?.status !== "sent") {
      let xlsBuf: Awaited<ReturnType<typeof generateNetPositionExcel>> | null = null;
      try {
        try {
          xlsBuf = await generateNetPositionExcel(row.company_id, company.name, yearStart, reportDate);
        } catch (error) {
          const attempt = await recordScheduledWhatsAppAttachmentPreparationFailure({
            claim,
            attachmentKey: "excel",
            error,
          });
          if (attempt) {
            await logScheduledWhatsAppAttachmentResult({
              claim,
              recipient: recipientKey,
              attachment: "excel",
              attempt,
              success: false,
              error,
            });
          }
        }

        if (xlsBuf) {
          const attempt = await beginScheduledWhatsAppAttachmentAttempt(claim, "excel");
          if (attempt) {
            const xlsName = `NetPosition_${company.name.replace(/[^a-z0-9]/gi, "_")}_${reportDate}.xlsx`;
            try {
              const xlsRes = await sendWhatsAppFileToChatId(
                chatId,
                xlsBuf,
                xlsName,
                "",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              );
              await finishScheduledWhatsAppAttachmentAttempt({
                claim,
                attachmentKey: "excel",
                success: xlsRes.success,
                error: xlsRes.error,
              });
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "excel",
                attempt,
                success: xlsRes.success,
                error: xlsRes.error,
              });
            } catch (error) {
              await finishScheduledWhatsAppAttachmentAttempt({
                claim,
                attachmentKey: "excel",
                success: false,
                error: getErrorMessage(error),
              });
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "excel",
                attempt,
                success: false,
                error,
              });
            }
          }
        }
      } finally {
        if (xlsBuf) await releaseManagedExportAttachment(xlsBuf);
      }
    }

    const final = await finalizeScheduledWhatsAppOccurrence(claim);
    if (final.allSent) {
      await pool.query(`UPDATE whatsapp_stock_settings SET last_sent_at = now() WHERE id = 1`);
      logger.info("[StockReport] Occurrence complete — last_sent_at updated.", {
        occurrenceKey: claim.occurrenceKey,
        recipient: recipientKey,
        result: "sent",
      });
    } else {
      logger.warn("[StockReport] Occurrence incomplete — failed attachments remain retryable.", {
        occurrenceKey: claim.occurrenceKey,
        recipient: recipientKey,
        result: final.status,
        error: final.error,
      });
    }
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
