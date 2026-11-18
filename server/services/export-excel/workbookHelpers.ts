// Extracted from ./workbook.ts: shared helpers.
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY-SAFE STREAMING WORKBOOK
// Fetches one sheet at a time, discards raw data before querying the next.
// Peak RAM = ExcelJS workbook + one dataset, instead of all datasets at once.
// ─────────────────────────────────────────────────────────────────────────────

export async function qStream(sql: string, params: readonly string[] = []) {
  try {
    const r = await pool.query(sql, params.length ? [...params] : undefined);
    return r.rows;
  } catch (err: unknown) {
    logger.warn(`[ExportStream] Query warning: ${getErrorMessage(err)}`);
    return [];
  }
}

export const EXPORT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** User-facing message (already translated in the client catalogs). */
export const EXPORT_DATE_INVALID_MESSAGE = "Invalid date format. Use YYYY-MM-DD";

/**
 * Accepts only a real YYYY-MM-DD calendar date; anything else is rejected before SQL.
 * `field` names the offending input on the thrown error for logs.
 */
export function assertExportDate(value: string, field: string): string {
  const parsed = typeof value === "string" && EXPORT_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(EXPORT_DATE_INVALID_MESSAGE), { field });
  }
  return value;
}
