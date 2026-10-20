/**
 * Merge proforma articles created after a loading's expected-plan snapshot.
 *
 * Existing per-loading expected quantities remain authoritative (particularly
 * for remaining-only continuation loadings). Only entirely new article codes
 * are supplied from the current master proforma for unfinished loadings.
 * Finalized/cancelled loadings keep their historical snapshot.
 */
export function mergeNewProformaArticles<T extends {
  article_code?: string | null;
  articleCode?: string | null;
}>(
  savedLines: readonly T[],
  masterLines: readonly T[],
  allowNewArticles: boolean
): T[] {
  if (savedLines.length === 0) return [...masterLines];
  if (!allowNewArticles) return [...savedLines];

  const normalize = (line: T) => String(line.article_code ?? line.articleCode ?? "").trim().toLowerCase();
  const seen = new Set(savedLines.map(normalize).filter(Boolean));
  const missing = masterLines.filter((line) => {
    const code = normalize(line);
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
  return [...savedLines, ...missing];
}


import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import type { ProformaCapacityExecutor } from "./proformaCapacity";

/**
 * A continuation keeps the remaining-only plan saved when the prior loading
 * was finalized. Its LOADING_CREATED daybook event uniquely labels it, unlike
 * ordinary loads whose editable targets follow the current master proforma.
 */
export async function isContinuationLoading(
  executor: ProformaCapacityExecutor,
  companyId: number,
  orderId: number
): Promise<boolean> {
  const result = resultRows<{ isContinuation: boolean }>(await executor.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM factory_daybook_entries e
      WHERE e.company_id = ${companyId}
        AND e.reference_table = 'customer_orders'
        AND e.reference_id = ${orderId}
        AND e.tx_type = 'LOADING_CREATED'
        AND e.description LIKE 'Continuation of loading #%'
    ) AS "isContinuation"
  `));
  return result[0]?.isContinuation === true;
}

export function usesLiveMasterProforma(status: string | null | undefined, isContinuation: boolean): boolean {
  return !isContinuation && ["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(status || "");
}
