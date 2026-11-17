// Extracted from ./exportRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { pool } from "../db";
import { requireAuth, requireRole } from "../auth";
import { logger } from "../lib/logger";
import { fetchAllCompanies } from "../services/export-data";
import { sendExportEmail } from "../services/emailService";
import {
  addStep,
  createJob,
  failJob,
  finishJob,
  finishJobWithFile,
  getJob,
  releaseJobArchive,
} from "../services/exportJobManager";
import { createTemporaryExportArchive, streamTemporaryExportArchive } from "../helpers/temporaryExportArchive";
import { invalidExportDateRange } from "../services/export-excel/workbook";
import { createScheduledExportArtifact } from "../helpers/scheduledExportArtifact";
import { isEmailConfigError, retryAsync } from "../helpers/retryAsync";
import { createExportRun, finishExportRun, updateExportRun } from "../helpers/exportRunTracker";

const ALLOWED_ROLES = ["Admin", "Owner", "Developer"];

export function registerExportRoutesStep1(app: Express) {
  const guard = [requireAuth, requireRole(...ALLOWED_ROLES)];

  // ── Recipients ─────────────────────────────────────────────────────────────

  app.get("/api/export/recipients", guard, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(`SELECT id, email, active, created_at FROM export_recipients ORDER BY id`);
      res.json(result.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.post("/api/export/recipients", guard, async (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ message: "Valid email required" });
    }
    try {
      const result = await pool.query(`INSERT INTO export_recipients (email, active) VALUES ($1, true) RETURNING *`, [
        email.trim().toLowerCase(),
      ]);
      res.json(result.rows[0]);
    } catch (err: unknown) {
      if (getErrorMessage(err)?.includes("unique") || getErrorMessage(err)?.includes("duplicate")) {
        return res.status(409).json({ message: "Email already exists" });
      }
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.delete("/api/export/recipients/:id", guard, async (req: Request, res: Response) => {
    try {
      await pool.query(`DELETE FROM export_recipients WHERE id = $1`, [req.params.id]);
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  app.get("/api/export/settings", guard, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, gmail_user, schedule_enabled, last_run_at, schedule_hour, schedule_timezone FROM export_settings WHERE id = 1`
      );
      if (!result.rows || result.rows.length === 0) {
        return res.json({
          gmailUser: "",
          scheduleEnabled: false,
          lastRunAt: null,
          scheduleHour: 18,
          scheduleTimezone: "America/New_York",
        });
      }
      const row = result.rows[0];
      res.json({
        gmailUser: row.gmail_user || "",
        scheduleEnabled: row.schedule_enabled || false,
        lastRunAt: row.last_run_at || null,
        scheduleHour: row.schedule_hour ?? 18,
        scheduleTimezone: row.schedule_timezone || "America/New_York",
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  app.put("/api/export/settings", guard, async (req: Request, res: Response) => {
    const { gmailUser, gmailAppPassword, scheduleEnabled, scheduleHour, scheduleTimezone } = req.body;
    try {
      const existing = await pool.query(`SELECT id FROM export_settings WHERE id = 1`);
      if (!existing.rows || existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO export_settings (id, gmail_user, gmail_app_password, schedule_enabled, schedule_hour, schedule_timezone) VALUES (1, $1, $2, $3, $4, $5)`,
          [
            gmailUser || "",
            gmailAppPassword || "",
            scheduleEnabled ?? false,
            scheduleHour ?? 18,
            scheduleTimezone || "America/New_York",
          ]
        );
      } else {
        const setParts: string[] = [];
        const params = [];
        let idx = 1;
        if (gmailUser !== undefined) {
          setParts.push(`gmail_user = $${idx++}`);
          params.push(gmailUser);
        }
        if (gmailAppPassword !== undefined && gmailAppPassword !== "") {
          setParts.push(`gmail_app_password = $${idx++}`);
          params.push(gmailAppPassword);
        }
        setParts.push(`schedule_enabled = $${idx++}`);
        params.push(scheduleEnabled ?? false);
        if (scheduleHour !== undefined) {
          setParts.push(`schedule_hour = $${idx++}`);
          params.push(scheduleHour);
        }
        if (scheduleTimezone !== undefined) {
          setParts.push(`schedule_timezone = $${idx++}`);
          params.push(scheduleTimezone);
        }
        params.push(1);
        await pool.query(`UPDATE export_settings SET ${setParts.join(", ")} WHERE id = $${idx}`, params);
      }
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
  return { guard };
}

export function registerExportRoutesStep2(
  { guard }: Pick<Awaited<ReturnType<typeof registerExportRoutesStep1>>, "guard">,
  app: Express
) {
  // ── Async export job: start ────────────────────────────────────────────────

  app.post("/api/export/start", guard, async (req: Request, res: Response) => {
    const { mode, fromDate, toDate } = req.body;
    if (mode !== "download" && mode !== "email") {
      return res.status(400).json({ message: "mode must be 'download' or 'email'" });
    }
    const invalidDate = invalidExportDateRange(fromDate, toDate);
    if (invalidDate) return res.status(400).json({ message: invalidDate });
    const _t = Date.now();
    logger.info("Export start requested", { module: "export", action: "start", status: mode });

    const job = createJob(mode);
    res.json({ jobId: job.id });

    // Run async without blocking the response.
    (async () => {
      const runType = mode === "email" ? "manual_email" : "manual_download";
      const runId = await createExportRun(runType);

      try {
        addStep(job, "Fetching company list...", "info");
        const companies = await fetchAllCompanies();
        if (!companies || companies.length === 0) {
          failJob(job, "No companies found");
          await finishExportRun(runId, { status: "failed", skippedReason: "No companies found." });
          return;
        }
        addStep(job, `Found ${companies.length} company/companies to export`, "success");

        const dateLabel = new Date().toISOString().substring(0, 10);

        if (mode === "download") {
          const { filePath, names, skipped, bytesWritten } = await createTemporaryExportArchive(
            job.id,
            companies,
            fromDate,
            toDate,
            (msg, level) => addStep(job, msg, level ?? "info")
          );

          if (names.length === 0) {
            const msg = "ZIP is empty — no companies exported successfully. Nothing will be downloaded.";
            failJob(job, msg);
            await finishExportRun(runId, { status: "failed", skippedReason: msg, companiesCount: companies.length });
            return;
          }

          if (skipped.length > 0) {
            addStep(job, `Skipped ${skipped.length} companies: ${skipped.join(", ")}`, "warning");
          }

          const sizeMB = (bytesWritten / 1024 / 1024).toFixed(1);
          addStep(job, `ZIP archive ready — ${sizeMB} MB, ${names.length} companies`, "success");

          await updateExportRun(runId, {
            companiesCount: companies.length,
            companyFilesCount: names.length,
            zipSizeBytes: bytesWritten,
            skippedCompanies: skipped.join(", ") || null,
          });

          finishJobWithFile(job, filePath, bytesWritten);
          addStep(job, "Ready to download — starting download now", "success");
          logger.info("Export job completed", {
            module: "export",
            action: "start",
            status: "download_ready",
            durationMs: Date.now() - _t,
          });
          await finishExportRun(runId, { status: "success" });
          return;
        }

        const artifact = await createScheduledExportArtifact(
          `manual-email-${job.id}`,
          companies,
          fromDate,
          toDate,
          (message, level) => addStep(job, message, level ?? "info")
        );

        try {
          const { attachment, names, skipped, sizeBytes } = artifact;
          if (names.length === 0 || sizeBytes <= 0) {
            const message = "ZIP is empty — no companies exported successfully. Nothing will be sent.";
            failJob(job, message);
            await finishExportRun(runId, {
              status: "failed",
              skippedReason: message,
              companiesCount: companies.length,
            });
            return;
          }

          if (skipped.length > 0) {
            addStep(job, `Skipped ${skipped.length} companies: ${skipped.join(", ")}`, "warning");
          }

          const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
          addStep(job, `ZIP archive ready — ${sizeMB} MB, ${names.length} companies`, "success");

          await updateExportRun(runId, {
            companiesCount: companies.length,
            companyFilesCount: names.length,
            zipSizeBytes: sizeBytes,
            skippedCompanies: skipped.join(", ") || null,
          });

          await updateExportRun(runId, { emailAttempted: true });
          addStep(job, "Sending email (up to 3 attempts, 30 s between retries)...", "info");

          const emailRes = await retryAsync({
            label: "ManualEmail",
            attempts: 3,
            delayMs: 30 * 1000,
            fn: () => sendExportEmail(attachment, dateLabel, names),
            isSuccess: (result) => result.success,
            shouldRetry: (result) => !result.error || !isEmailConfigError(result.error),
            onAttempt: (attempt) => {
              if (attempt > 1) addStep(job, `Retry attempt ${attempt}/3...`, "info");
            },
          });

          if (emailRes.result.success) {
            addStep(job, `Email sent successfully to all recipients (attempt ${emailRes.attempts})`, "success");
            finishJob(job);
            logger.info("Export job completed", {
              module: "export",
              action: "start",
              status: "success",
              durationMs: Date.now() - _t,
            });
            await finishExportRun(runId, {
              status: "success",
              emailSuccess: true,
              emailAttempts: emailRes.attempts,
            });
          } else {
            const errorMessage = emailRes.result.error || "Email send failed";
            failJob(job, errorMessage);
            logger.warn("Export job email failed", {
              module: "export",
              action: "start",
              status: "emailFailed",
              durationMs: Date.now() - _t,
            });
            await finishExportRun(runId, {
              status: "failed",
              emailSuccess: false,
              emailError: errorMessage,
              emailAttempts: emailRes.attempts,
            });
          }
        } finally {
          await artifact.dispose();
        }
      } catch (err: unknown) {
        logger.error("Export job failed", {
          module: "export",
          action: "start",
          durationMs: Date.now() - _t,
          error: err,
        });
        failJob(job, getErrorMessage(err) || "Unexpected error");
        await finishExportRun(runId, {
          status: "failed",
          skippedReason: getErrorMessage(err) || "Unexpected error",
        }).catch(() => {});
      }
    })();
  });

  // ── Async export job: poll status ──────────────────────────────────────────

  app.get("/api/export/job/:jobId", guard, (req: Request, res: Response) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json({
      status: job.status,
      steps: job.steps,
      error: job.error,
      hasZip: Boolean(job.zipFilePath || job.zipBuffer),
      zipSizeBytes: job.zipSizeBytes,
    });
  });

  // ── Async export job: download zip ─────────────────────────────────────────

  app.get("/api/export/download/:jobId", guard, async (req: Request, res: Response) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    if (!job.zipFilePath) return res.status(400).json({ message: "ZIP not ready" });

    const dateLabel = new Date().toISOString().substring(0, 10);
    try {
      await streamTemporaryExportArchive(res, job.zipFilePath, `DailyExport_${dateLabel}.zip`);
    } catch (err: unknown) {
      logger.error("Export archive download failed", {
        module: "export",
        action: "download",
        jobId: job.id,
        error: err,
      });
      if (!res.headersSent) {
        res.status(500).json({ message: getErrorMessage(err) || "Export archive is unavailable" });
      } else if (!res.writableEnded) {
        res.destroy(err instanceof Error ? err : undefined);
      }
    } finally {
      // A completed archive is single-use. Remove it after success, disconnect,
      // or stream failure so large temporary files cannot accumulate on disk.
      releaseJobArchive(job);
    }
  });
  return {};
}
