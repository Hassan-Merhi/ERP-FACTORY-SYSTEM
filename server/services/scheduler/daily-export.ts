import { getErrorMessage, getErrorStack } from "../../lib/httpHandlers";
import { ZipArchive } from "archiver";
import { PassThrough } from "stream";
import { logger } from "../../lib/logger";
import { fetchAllCompanies } from "../export-data";
import { sendExportEmail } from "../emailService";
import { pool } from "../../db";
import { getWaSettings } from "../whatsappService";
import { generateNetPositionExcel } from "../../helpers/generateNetPositionExcel";
import { retryAsync, isEmailConfigError, isWaConfigError } from "../../helpers/retryAsync";
import { createExportRun, updateExportRun, finishExportRun } from "../../helpers/exportRunTracker";
import { createScheduledExportArtifact } from "../../helpers/scheduledExportArtifact";
import { runWithDatabaseMaintenanceScope } from "../security/databaseScopeRuntimeContext";

import { isScheduleEnabled } from "./net-position";
import { runDailyWhatsAppSend } from "./whatsapp-send";

export const WHATSAPP_ATTACHMENT_LIMIT_MB = 15;

export function getTodayLabel(): string {
  return new Date().toISOString().substring(0, 10);
}

/**
 * Build a ZIP containing per-company net position Excel files.
 */
export async function buildNetPositionZip(
  companies: Array<{ id: number; name: string }>,
  startDate: string,
  endDate: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const arc = new ZipArchive({ zlib: { level: 6 } });
    arc.on("data", (chunk: Buffer) => chunks.push(chunk));
    arc.on("end", () => resolve(Buffer.concat(chunks)));
    arc.on("error", reject);

    void (async () => {
      for (const company of companies) {
        const safe = company.name.replace(/[^a-z0-9]/gi, "_");
        const pass = new PassThrough();
        arc.append(pass, { name: `NetPosition_${safe}_${endDate}.xlsx` });
        try {
          await generateNetPositionExcel(company.id, company.name, startDate, endDate, pass);
          if (!pass.destroyed) pass.end();
          logger.info(`[NetPositionExport] Added ${company.name}`);
        } catch (e: unknown) {
          logger.error(`[NetPositionExport] Failed for ${company.name}:`, { error: getErrorMessage(e) });
          if (!pass.destroyed) pass.destroy(e instanceof Error ? e : undefined);
        }
      }

      await arc.finalize();
    })().catch(reject);
  });
}

// ── Helpers: check today's scheduled export state (UTC-agnostic: last 23 h) ───

export async function hasTodayExportSucceeded(): Promise<boolean> {
  try {
    const r = await pool.query(`
      SELECT id FROM daily_export_runs
       WHERE run_type = 'scheduled'
         AND status   IN ('success', 'partial_failed')
         AND started_at >= NOW() - INTERVAL '23 hours'
       LIMIT 1
    `);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function isTodayExportRunning(): Promise<boolean> {
  try {
    const r = await pool.query(`
      SELECT id FROM daily_export_runs
       WHERE run_type = 'scheduled'
         AND status   = 'running'
         AND started_at >= NOW() - INTERVAL '23 hours'
       LIMIT 1
    `);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Re-runs the daily export if today's scheduled run hasn't succeeded yet.
 * Called at startup (after server restart) as well as from the scheduler.
 * Will NOT fire before the configured schedule hour to avoid early-restart surprises.
 *
 * Startup has no request-owned tenant identity, so this function establishes
 * the same explicit maintenance capability used by cron ticks before touching
 * any potentially tenant-scoped export/report data.
 */
export async function checkAndRecoverDailyExport(): Promise<void> {
  return runWithDatabaseMaintenanceScope("daily-export-recovery", async () => {
    try {
      // Read schedule config first — only recover if the scheduled hour has already passed today.
      const r = await pool.query(
        `SELECT schedule_enabled, schedule_hour, schedule_timezone FROM export_settings WHERE id = 1`
      );
      if (!r.rows.length) return;
      const row = r.rows[0];

      if (!row.schedule_enabled) {
        logger.info("[DailyExport] Recovery check: schedule is disabled — skipping.");
        return;
      }

      const configuredHour: number = row.schedule_hour ?? 18;
      const tz: string = row.schedule_timezone || "America/New_York";
      const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
      const currentHour = nowInTz.getHours();

      // Don't trigger recovery before the scheduled time has even arrived today.
      if (currentHour < configuredHour) {
        logger.info(
          `[DailyExport] Recovery check: current hour (${currentHour}:xx ${tz}) is before scheduled hour (${configuredHour}:00) — skipping.`
        );
        return;
      }

      if (await hasTodayExportSucceeded()) {
        logger.info("[DailyExport] Recovery check: today's export already succeeded — nothing to do.");
        return;
      }
      if (await isTodayExportRunning()) {
        logger.info("[DailyExport] Recovery check: export is currently running — skipping.");
        return;
      }
      logger.info("[DailyExport] Recovery check: re-running today's failed/missed export...");
      await runDailyExport();
    } catch (e: unknown) {
      logger.error("[DailyExport] Recovery check error:", { error: getErrorMessage(e) || e });
    }
  });
}

export async function runDailyExport(): Promise<boolean> {
  const cronFiredAt = new Date().toISOString();
  logger.info(`[DailyExport] Scheduled run triggered at ${cronFiredAt}`);

  const emailEnabled = await isScheduleEnabled();
  const waSettings = await getWaSettings();
  const whatsappReady = !!(waSettings?.enabled && waSettings?.dailyAutoSend && waSettings?.dailyRecipientId);

  logger.info(`[DailyExport] Email enabled: ${emailEnabled} | WhatsApp ready: ${whatsappReady}`);

  if (!emailEnabled && !whatsappReady) {
    logger.info("[DailyExport] Email schedule and WhatsApp daily auto-send are both disabled. Nothing to send.");
    const rid = await createExportRun("scheduled");
    await finishExportRun(rid, {
      status: "skipped",
      skippedReason: "Email schedule and WhatsApp daily auto-send are both disabled.",
    });
    return true;
  }

  const runId = await createExportRun("scheduled");
  logger.info(`[DailyExport] Run id=${runId} started.`);

  try {
    const companies = await fetchAllCompanies();
    if (!companies || companies.length === 0) {
      logger.info("[DailyExport] No companies found — skipping export.");
      await finishExportRun(runId, { status: "failed", skippedReason: "No companies found." });
      return false;
    }

    const today = getTodayLabel();
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const exportFromDate = threeYearsAgo.toISOString().substring(0, 10);

    logger.info(
      `[DailyExport] Building export for ${companies.length} company/companies (label: ${today}, from: ${exportFromDate})`
    );

    const artifact = await createScheduledExportArtifact(`daily-${runId}`, companies, exportFromDate, undefined);

    try {
      const { attachment, names, skipped, sizeBytes } = artifact;
      if (!names.length || sizeBytes <= 0) {
        logger.error("[DailyExport] ZIP is empty — no companies exported successfully. Nothing will be sent.");
        await finishExportRun(runId, {
          status: "failed",
          companiesCount: companies.length,
          skippedReason: "Export ZIP is empty — no companies exported successfully.",
        });
        return false;
      }

      const zipSizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
      logger.info(
        `[DailyExport] Run ${runId} — ZIP ready: ${zipSizeMb} MB, ${names.length} companies${
          skipped.length ? `, ${skipped.length} skipped: ${skipped.join(", ")}` : ""
        }`
      );

      await updateExportRun(runId, {
        companiesCount: companies.length,
        companyFilesCount: names.length,
        zipSizeBytes: sizeBytes,
        skippedCompanies: skipped.join(", ") || null,
      });

      let emailSuccess = false;
      let emailError: string | undefined;
      let emailAttempts = 0;

      if (emailEnabled) {
        await updateExportRun(runId, { emailAttempted: true });
        logger.info("[DailyExport] Sending email (up to 3 attempts, 2 min delay)...");

        const emailRes = await retryAsync({
          label: "DailyExport/Email",
          attempts: 3,
          delayMs: 2 * 60 * 1000,
          fn: () => sendExportEmail(attachment, today, names),
          isSuccess: (result) => result.success,
          shouldRetry: (result) => !result.error || !isEmailConfigError(result.error),
          onAttempt: (attempt) => {
            emailAttempts = attempt;
            logger.info(`[DailyExport] Email attempt ${attempt}/3...`);
          },
        });

        emailSuccess = emailRes.result.success;
        emailAttempts = emailRes.attempts;
        emailError = emailRes.result.error;

        if (emailSuccess) {
          logger.info(`[DailyExport] Email sent successfully (attempt ${emailAttempts}).`);
          await pool.query(`UPDATE export_settings SET last_run_at = now() WHERE id = 1`).catch(() => {});
        } else {
          logger.error(`[DailyExport] Email failed after ${emailAttempts} attempt(s): ${emailError}`);
        }
      } else {
        logger.info("[DailyExport] Email schedule is disabled — skipping email.");
      }

      let waSuccess = false;
      let waError: string | undefined;
      let waAttempts = 0;

      if (whatsappReady) {
        await updateExportRun(runId, { whatsappAttempted: true });
        logger.info("[DailyExport] Sending via WhatsApp (up to 3 attempts, 2 min delay)...");

        const waRes = await retryAsync({
          label: "DailyExport/WhatsApp",
          attempts: 3,
          delayMs: 2 * 60 * 1000,
          fn: () => runDailyWhatsAppSend(attachment, today, companies),
          isSuccess: (result) => result.sent,
          shouldRetry: (result) => !result.skipped && (!result.error || !isWaConfigError(result.error)),
          onAttempt: (attempt) => {
            waAttempts = attempt;
            logger.info(`[DailyExport] WhatsApp attempt ${attempt}/3...`);
          },
        });

        waSuccess = waRes.result.sent;
        waAttempts = waRes.attempts;
        waError = waRes.result.error || waRes.result.skipReason;

        if (waSuccess) {
          logger.info(`[DailyExport] WhatsApp sent successfully (attempt ${waAttempts}).`);
        } else if (waRes.result.skipped) {
          logger.info(`[DailyExport] WhatsApp skipped: ${waError}.`);
        } else {
          logger.error(`[DailyExport] WhatsApp failed after ${waAttempts} attempt(s): ${waError}`);
        }
      } else {
        logger.info("[DailyExport] WhatsApp not ready — skipping WhatsApp send.");
      }

      const bothSucceeded = (!emailEnabled || emailSuccess) && (!whatsappReady || waSuccess);
      const atLeastOne = (emailEnabled && emailSuccess) || (whatsappReady && waSuccess);
      const finalStatus = bothSucceeded ? "success" : atLeastOne ? "partial_failed" : "failed";

      logger.info(
        `[DailyExport] Run ${runId} finished — status: ${finalStatus}` +
          ` | email: ${emailEnabled ? (emailSuccess ? "ok" : "failed") : "n/a"}` +
          ` | wa: ${whatsappReady ? (waSuccess ? "ok" : "failed") : "n/a"}`
      );

      await finishExportRun(runId, {
        status: finalStatus,
        emailSuccess,
        emailError: emailError ?? null,
        emailAttempts,
        whatsappSuccess: waSuccess,
        whatsappError: waError ?? null,
        whatsappAttempts: waAttempts,
      });

      return finalStatus !== "failed";
    } finally {
      await artifact.dispose();
    }
  } catch (err: unknown) {
    logger.error(`[DailyExport] Unexpected error in run ${runId}:`, {
      error: getErrorStack(err) || getErrorMessage(err) || err,
    });
    await finishExportRun(runId, {
      status: "failed",
      skippedReason: getErrorMessage(err) || "Unexpected error",
    }).catch(() => {});
    return false;
  }
}

// ─── Daily WhatsApp send (6 PM) ───────────────────────────────────────────────
