import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { fetchAllCompanies } from "../services/export-data";
import { registerExportRoutesStep1, registerExportRoutesStep2 } from "./registerExportRoutesStep2";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const cleanupStuckRunsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerExportRoutes(app: Express) {
  const { guard } = registerExportRoutesStep1(app);
  registerExportRoutesStep2({ guard }, app);
  registerExportRoutesStep3({ guard }, app);
}

function registerExportRoutesStep3(
  { guard }: Pick<Awaited<ReturnType<typeof registerExportRoutesStep1>>, "guard">,
  app: Express
) {
  // ── Companies list for UI ───────────────────────────────────────────────────

  app.get("/api/export/companies", guard, async (_req: Request, res: Response) => {
    try {
      const companies = await fetchAllCompanies();
      res.json(companies);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Force-cleanup stuck export runs ─────────────────────────────────────────
  // Marks ALL 'running' rows as failed regardless of age. The UI only shows the
  // button when a run has been running >5 min client-side, so this is safe.
  app.post(
    "/api/export/cleanup-stuck-runs",
    guard,
    validateRequest(cleanupStuckRunsInput),
    async (_req: Request, res: Response) => {
      try {
        const r = await pool.query(`
        UPDATE daily_export_runs
           SET status         = 'failed',
               finished_at    = NOW(),
               skipped_reason = 'Manually dismissed — export did not complete (server restart or timeout)'
         WHERE status = 'running'
        RETURNING id, run_type
      `);
        const count = r.rowCount ?? 0;
        logger.info(`[ExportRun] Manual dismiss: cleared ${count} stuck run(s)`);
        res.json({ cleared: count, ids: r.rows.map((x) => x.id) });
      } catch (e: unknown) {
        logger.error("[ExportRun] Manual dismiss failed:", { error: getErrorMessage(e) });
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ── Backup status ───────────────────────────────────────────────────────────

  app.get("/api/export/backup-status", guard, async (_req: Request, res: Response) => {
    try {
      // Latest run
      const latestQ = await pool
        .query(
          `
        SELECT * FROM daily_export_runs ORDER BY created_at DESC LIMIT 1
      `
        )
        .catch(() => ({ rows: [] }));

      // Recent runs — full detail for all 10 so UI can render each independently
      const recentQ = await pool
        .query(
          `
        SELECT * FROM daily_export_runs ORDER BY created_at DESC LIMIT 10
      `
        )
        .catch(() => ({ rows: [] }));

      // Readiness data
      const esQ = await pool
        .query(`SELECT gmail_user, gmail_app_password, schedule_enabled FROM export_settings WHERE id = 1`)
        .catch(() => ({ rows: [] }));
      const rcQ = await pool
        .query(`SELECT COUNT(*)::int AS cnt FROM export_recipients WHERE active = true`)
        .catch(() => ({ rows: [{ cnt: 0 }] }));
      const wsQ = await pool
        .query(`SELECT enabled, daily_auto_send, daily_recipient_id FROM whatsapp_settings WHERE id = 1`)
        .catch(() => ({ rows: [] }));
      const coQ = await pool.query(`SELECT COUNT(*)::int AS cnt FROM companies`).catch(() => ({ rows: [{ cnt: 0 }] }));

      const es = esQ.rows[0] ?? {};
      const ws = wsQ.rows[0] ?? {};
      const recipientCount = rcQ.rows[0]?.cnt ?? 0;
      const companiesCount = coQ.rows[0]?.cnt ?? 0;

      let waRecipientActive = false;
      if (ws.daily_recipient_id) {
        const rrQ = await pool
          .query(`SELECT active FROM whatsapp_recipients WHERE id = $1`, [ws.daily_recipient_id])
          .catch(() => ({ rows: [] }));
        waRecipientActive = rrQ.rows[0]?.active === true;
      }

      const issues: string[] = [];
      if (!es.schedule_enabled) issues.push("Email schedule is disabled.");
      if (!es.gmail_user || !es.gmail_app_password) issues.push("Gmail credentials are missing.");
      if (recipientCount === 0) issues.push("No email recipients configured.");
      if (!ws.enabled) issues.push("WhatsApp is disabled.");
      if (ws.enabled && !ws.daily_auto_send) issues.push("WhatsApp daily auto-send is off.");
      if (ws.enabled && !ws.daily_recipient_id) issues.push("No WhatsApp daily recipient selected.");
      else if (ws.enabled && ws.daily_recipient_id && !waRecipientActive)
        issues.push("Selected WhatsApp recipient is inactive or missing.");
      if (companiesCount === 0) issues.push("No companies found.");

      const row = latestQ.rows[0];
      res.json({
        latestRun: row
          ? {
              id: row.id,
              runType: row.run_type,
              status: row.status,
              startedAt: row.started_at,
              finishedAt: row.finished_at,
              zipSizeBytes: row.zip_size_bytes,
              companiesCount: row.companies_count,
              companyFilesCount: row.company_files_count,
              skippedCompanies: row.skipped_companies,
              emailAttempted: row.email_attempted,
              emailSuccess: row.email_success,
              emailError: row.email_error,
              emailAttempts: row.email_attempts,
              whatsappAttempted: row.whatsapp_attempted,
              whatsappSuccess: row.whatsapp_success,
              whatsappError: row.whatsapp_error,
              whatsappAttempts: row.whatsapp_attempts,
              skippedReason: row.skipped_reason,
            }
          : null,
        recentRuns: recentQ.rows.map((r) => ({
          id: r.id,
          runType: r.run_type,
          status: r.status,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          zipSizeBytes: r.zip_size_bytes,
          companiesCount: r.companies_count,
          companyFilesCount: r.company_files_count,
          skippedCompanies: r.skipped_companies,
          skippedReason: r.skipped_reason,
          emailAttempted: r.email_attempted,
          emailSuccess: r.email_success,
          emailError: r.email_error,
          emailAttempts: r.email_attempts,
          whatsappAttempted: r.whatsapp_attempted,
          whatsappSuccess: r.whatsapp_success,
          whatsappError: r.whatsapp_error,
          whatsappAttempts: r.whatsapp_attempts,
        })),
        readiness: {
          emailScheduleEnabled: !!es.schedule_enabled,
          gmailConfigured: !!(es.gmail_user && es.gmail_app_password),
          emailRecipientCount: recipientCount,
          whatsappEnabled: !!ws.enabled,
          whatsappDailyAutoSend: !!ws.daily_auto_send,
          whatsappDailyRecipientId: ws.daily_recipient_id ?? null,
          whatsappDailyRecipientActive: waRecipientActive,
          companiesCount,
        },
        issues,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
  return {};
}
