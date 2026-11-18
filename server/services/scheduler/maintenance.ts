import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { fetchAllCompanies } from "../export-data";
import {} from "../whatsappService";
import { buildFullExportZip } from "../../helpers/buildFullExportZip";
import { retryAsync, isWaConfigError } from "../../helpers/retryAsync";
import { createExportRun, updateExportRun, finishExportRun } from "../../helpers/exportRunTracker";
import { getExportAttachmentSize } from "../../helpers/exportAttachmentSource";

import { getTodayLabel, runDailyExport } from "./daily-export";
import { runDailyWhatsAppSend } from "./whatsapp-send";
import {
  beginScheduledWhatsAppAttachmentAttempt,
  claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence,
  finalizeScheduledWhatsAppOccurrence,
  finishScheduledWhatsAppAttachmentAttempt,
  logScheduledWhatsAppAttachmentResult,
  recordScheduledWhatsAppAttachmentPreparationFailure,
  recordScheduledWhatsAppAttachmentUncertain,
} from "./scheduledWhatsAppDelivery";
export { purgeOldSoftDeletes } from "./maintenancePurgeOldSoftDeletes";

// ── Containers WhatsApp scheduled send ────────────────────────────────────────

export async function checkAndRunContainersWhatsApp(): Promise<void> {
  try {
    const { getContainersWaSettings, sendWhatsAppFileToChatId, markContainersWaSent } =
      await import("../whatsappService");
    const settings = await getContainersWaSettings();

    if (!settings?.scheduleEnabled || !settings?.groupChatId) return;
    if (!settings?.instanceId || !settings?.apiToken || !settings?.enabled) return;

    const recipientKey = `group:${settings.groupChatId}`;
    let claim = await claimRetryableScheduledWhatsAppOccurrence({
      jobType: "containers_report",
      recipientKey,
      recipientChatId: settings.groupChatId,
    });

    if (!claim) {
      const nowInNewYork = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      if (nowInNewYork.getHours() !== settings.scheduleHour) return;

      // Preserve the existing 12-hour duplicate-suppression rule for successful sends.
      if (settings.lastSentAt) {
        const hoursSince = (Date.now() - new Date(settings.lastSentAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 12) {
          logger.info("[ContainersWA] Already sent within 12 h — skipping.");
          return;
        }
      }

      const localDate = [
        nowInNewYork.getFullYear(),
        String(nowInNewYork.getMonth() + 1).padStart(2, "0"),
        String(nowInNewYork.getDate()).padStart(2, "0"),
      ].join("-");

      claim = await claimScheduledWhatsAppOccurrence({
        jobType: "containers_report",
        recipientKey,
        recipientChatId: settings.groupChatId,
        scheduledLocalDate: localDate,
        scheduledLocalHour: settings.scheduleHour,
        attachmentKeys: ["pdf"],
      });
    }

    if (!claim?.acquired) {
      if (claim) {
        logger.info("[ContainersWA] Occurrence already owned or completed — skipping.", {
          occurrenceKey: claim.occurrenceKey,
          recipient: recipientKey,
          result: claim.status,
        });
      }
      return;
    }

    const pdfState = claim.attachments.find((attachment) => attachment.key === "pdf");
    if (pdfState?.status !== "sent") {
      let generated: Awaited<
        ReturnType<(typeof import("../../helpers/generateContainersPdf"))["generateContainersPdf"]>
      > | null = null;
      try {
        const { generateContainersPdf } = await import("../../helpers/generateContainersPdf");
        generated = await generateContainersPdf();
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
      }

      if (generated) {
        const attempt = await beginScheduledWhatsAppAttachmentAttempt(claim, "pdf");
        if (attempt) {
          const fileName = `Containers_${claim.scheduledLocalDate}.pdf`;
          let result: Awaited<ReturnType<typeof sendWhatsAppFileToChatId>> | null = null;
          try {
            result = await sendWhatsAppFileToChatId(
              settings.groupChatId,
              generated.buffer,
              fileName,
              "",
              "application/pdf"
            );
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

          if (result) {
            if (result.deliveryOutcome === "uncertain") {
              await recordScheduledWhatsAppAttachmentUncertain({
                claim,
                attachmentKey: "pdf",
                error: result.error,
              });
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "pdf",
                attempt,
                success: false,
                error: result.error,
              });
            } else {
              await finishScheduledWhatsAppAttachmentAttempt({
                claim,
                attachmentKey: "pdf",
                success: result.success,
                error: result.error,
              });
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "pdf",
                attempt,
                success: result.success,
                error: result.error,
              });
              if (result.success) {
                logger.info("[ContainersWA] PDF sent.", {
                  occurrenceKey: claim.occurrenceKey,
                  recipient: recipientKey,
                  attachment: "pdf",
                  attempt,
                  result: "sent",
                  rowCount: generated.rowCount,
                });
              }
            }
          }
        }
      }
    }

    const final = await finalizeScheduledWhatsAppOccurrence(claim);
    if (final.allSent) {
      await markContainersWaSent();
      logger.info("[ContainersWA] Occurrence complete — last sent timestamp updated.", {
        occurrenceKey: claim.occurrenceKey,
        recipient: recipientKey,
        result: "sent",
      });
    } else {
      logger.warn("[ContainersWA] Occurrence incomplete — known failures may retry; uncertain sends stay blocked.", {
        occurrenceKey: claim.occurrenceKey,
        recipient: recipientKey,
        result: final.status,
        error: final.error,
      });
    }
  } catch (err: unknown) {
    logger.error("[ContainersWA] Error:", { error: getErrorMessage(err) });
  }
}

/** Manually trigger the daily ZIP → WhatsApp send (bypasses the dailyAutoSend schedule toggle).
 *  Pass fromDate / toDate (YYYY-MM-DD) to scope the export; omit for full history.
 *  Retries up to 3 times (30 s between attempts) on actual send failures.
 *  Records the attempt in daily_export_runs.
 *  Throws an Error with a human-readable message if WhatsApp is not configured or the send fails.
 */
export async function triggerDailyWhatsAppSendNow(fromDate?: string, toDate?: string): Promise<{ message: string }> {
  const runId = await createExportRun("manual_whatsapp");
  logger.info(`[ManualWhatsApp] Run id=${runId} started.`);

  const companies = await fetchAllCompanies();
  if (!companies || companies.length === 0) {
    await finishExportRun(runId, { status: "failed", skippedReason: "No companies found." });
    throw new Error("No companies found.");
  }

  const today = getTodayLabel();
  let zip: Buffer, names: string[], skipped: string[];
  try {
    ({ zip, names, skipped } = await buildFullExportZip(companies, fromDate, toDate));
  } catch (err: unknown) {
    await finishExportRun(runId, { status: "failed", skippedReason: getErrorMessage(err) });
    throw err;
  }

  await updateExportRun(runId, {
    companiesCount: companies.length,
    companyFilesCount: names.length,
    zipSizeBytes: getExportAttachmentSize(zip),
    skippedCompanies: skipped.join(", ") || null,
    whatsappAttempted: true,
  });

  const rangeLabel = fromDate || toDate ? ` (${fromDate || "start"} → ${toDate || "today"})` : " (full history)";
  const skippedNote = skipped.length > 0 ? ` (${skipped.length} skipped)` : "";

  // Retry up to 3× with 30-second delays (manual trigger is interactive — shorter delay)
  const waRes = await retryAsync({
    label: "ManualWhatsApp",
    attempts: 3,
    delayMs: 30 * 1000,
    fn: () => runDailyWhatsAppSend(zip, today, companies, { bypassAutoSendCheck: true }),
    isSuccess: (r) => r.sent,
    shouldRetry: (r) => !r.skipped && (!r.error || !isWaConfigError(r.error)),
    onAttempt: (n) => logger.info(`[ManualWhatsApp] Attempt ${n}/3...`),
  });

  const result = waRes.result;

  if (result.skipped) {
    await finishExportRun(runId, {
      status: "failed",
      whatsappSuccess: false,
      whatsappError: result.skipReason,
      whatsappAttempts: waRes.attempts,
    });
    throw new Error(
      `WhatsApp not configured or not ready: ${result.skipReason}. ` +
        `Please enable WhatsApp and select a Daily Export recipient in WhatsApp settings.`
    );
  }

  if (!result.sent) {
    await finishExportRun(runId, {
      status: "failed",
      whatsappSuccess: false,
      whatsappError: result.error || "Unknown error",
      whatsappAttempts: waRes.attempts,
    });
    throw new Error(`WhatsApp send failed after ${waRes.attempts} attempt(s): ${result.error || "Unknown error"}`);
  }

  await finishExportRun(runId, {
    status: "success",
    whatsappSuccess: true,
    whatsappAttempts: waRes.attempts,
  });

  logger.info(`[ManualWhatsApp] Run ${runId} succeeded (attempt ${waRes.attempts}).`);
  return { message: `Daily ZIP sent to WhatsApp — ${names.length} companies${rangeLabel}${skippedNote}.` };
}

export { runDailyExport };
