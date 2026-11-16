import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { ownKey } from "../lib/sqlTextGuards";

/** Maps camelCase field names to their snake_case DB column names. */
const FIELD_MAP: Record<string, string> = {
  status: "status",
  finishedAt: "finished_at",
  zipSizeBytes: "zip_size_bytes",
  companiesCount: "companies_count",
  companyFilesCount: "company_files_count",
  skippedCompanies: "skipped_companies",
  emailAttempted: "email_attempted",
  emailSuccess: "email_success",
  emailError: "email_error",
  emailAttempts: "email_attempts",
  whatsappAttempted: "whatsapp_attempted",
  whatsappSuccess: "whatsapp_success",
  whatsappError: "whatsapp_error",
  whatsappAttempts: "whatsapp_attempts",
  skippedReason: "skipped_reason",
};

/**
 * Insert a new daily_export_runs row with status='running'.
 * Returns the new row id, or 0 on failure (tracking is best-effort).
 */
export async function createExportRun(
  runType: "scheduled" | "manual_email" | "manual_whatsapp" | "manual_download"
): Promise<number> {
  try {
    const r = await pool.query(`INSERT INTO daily_export_runs (run_type, status) VALUES ($1, 'running') RETURNING id`, [
      runType,
    ]);
    return r.rows[0].id as number;
  } catch (err: unknown) {
    logger.warn("[ExportRun] Failed to create run record:", { error: getErrorMessage(err) });
    return 0;
  }
}

/**
 * Update arbitrary fields on a run row.
 * Keys must be camelCase names from FIELD_MAP above; unknown keys are silently ignored.
 */
export async function updateExportRun(id: number, data: { finishedAt: Date; } | ({ companiesCount: number; companyFilesCount: number; zipSizeBytes: number; skippedCompanies: string | null; }) | { emailAttempted: boolean; } | { whatsappAttempted: boolean; } | ({ companiesCount: number; companyFilesCount: number; zipSizeBytes: number; skippedCompanies: string | null; whatsappAttempted: boolean; })): Promise<void> {
  if (!id) return;
  const entries = Object.entries(data).filter(([k]) => ownKey(FIELD_MAP, k));
  if (!entries.length) return;
  const setClauses = entries.map(([k], i) => `${FIELD_MAP[k]} = $${i + 1}`);
  const values = [...entries.map(([, v]) => v), id];
  try {
    await pool.query(`UPDATE daily_export_runs SET ${setClauses.join(", ")} WHERE id = $${values.length}`, values);
  } catch (err: unknown) {
    logger.warn(`[ExportRun] Failed to update run ${id}:`, { error: getErrorMessage(err) });
  }
}

/**
 * Finish a run: merges data and sets finished_at = now().
 */
export async function finishExportRun(id: number, data: Record<string, unknown>): Promise<void> {
  return updateExportRun(id, { ...data, finishedAt: new Date() });
}
