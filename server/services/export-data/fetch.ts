import type { QueryResultRow } from "pg";

import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

async function q<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
  try {
    const result = params ? await pool.query(sql, params) : await pool.query(sql);
    return result.rows as T[];
  } catch (err: unknown) {
    logger.warn(`[ExportData] Query warning: ${getErrorMessage(err)}`);
    return [];
  }
}

export async function fetchAllCompanies(): Promise<Array<{ id: number; name: string }>> {
  return q<{ id: number; name: string }>(`SELECT id, name FROM companies ORDER BY id`);
}
