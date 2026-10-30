/**
 * Company-scoped reconstruction from append-only Factory row history.
 *
 * A complete as-of row state is only possible after the table's atomic
 * baseline. Earlier dates return NOT_READY; never treat the absence of
 * pre-baseline records as proof that a row did not exist.
 *
 * This service reads recorded state, not book-effective state. Calling report
 * code must still apply each source's business/effective date rules.
 */
import { sql } from "drizzle-orm";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { sqlArray } from "../../lib/sqlArray";
import { netPositionRecordedThrough } from "./netPositionAsOf";
import { FACTORY_ROW_HISTORY_TABLES, FACTORY_ROW_HISTORY_VERSION } from "../audit/factoryRowHistory";

export type HistoricalRow = Record<string, unknown>;
export type HistoricalChange = {
  record_id: number | string;
  op: "S" | "I" | "U" | "D";
  old_values: HistoricalRow | null;
  new_values: HistoricalRow | null;
};

/** The event recorder stores deltas for UPDATE, full records for S/I/D. */
export function replayFactoryRowChanges(changes: readonly HistoricalChange[]): Map<number, HistoricalRow> {
  const state = new Map<number, HistoricalRow>();
  for (const change of changes) {
    const id = Number(change.record_id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("HISTORICAL_ROW_HISTORY_INVALID_ID");
    if (change.op === "S" || change.op === "I") {
      if (!change.new_values || typeof change.new_values !== "object" || Array.isArray(change.new_values)) {
        throw new Error("HISTORICAL_ROW_HISTORY_FULL_RECORD_MISSING");
      }
      if (state.has(id)) throw new Error("HISTORICAL_ROW_HISTORY_DUPLICATE_CREATION");
      state.set(id, { ...change.new_values });
    } else if (change.op === "U") {
      const current = state.get(id);
      if (
        !current ||
        !change.new_values ||
        typeof change.new_values !== "object" ||
        Array.isArray(change.new_values) ||
        !change.old_values
      ) {
        throw new Error("HISTORICAL_ROW_HISTORY_UPDATE_WITHOUT_BASE");
      }
      // A missing key means unchanged; a JSON null represents a real SQL NULL.
      state.set(id, { ...current, ...change.new_values });
    } else if (change.op === "D") {
      if (!state.has(id)) throw new Error("HISTORICAL_ROW_HISTORY_DELETE_WITHOUT_BASE");
      state.delete(id);
    } else {
      throw new Error("HISTORICAL_ROW_HISTORY_UNKNOWN_OPERATION");
    }
  }
  return state;
}

export type HistoricalRowRead =
  | { ready: false; reason: "HISTORICAL_ROW_HISTORY_NOT_INSTALLED" | "HISTORICAL_ROW_HISTORY_PRE_BASELINE" }
  | { ready: true; baselineAt: string; rows: Map<number, HistoricalRow> };

const MAX_HISTORY_EVENTS = 250000;

/**
 * Read one allowed source table without touching current-state rows.
 * RLS on factory_row_history is mandatory; the explicit company predicate
 * is a second isolation boundary. Optional record IDs narrow the workload.
 */
export async function loadFactoryRowsKnownAt(
  table: string,
  companyId: number,
  scope: FactoryNetPositionAsOf,
  recordIds?: readonly number[]
): Promise<HistoricalRowRead> {
  if (!scope.isHistorical || !Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("HISTORICAL_ROW_HISTORY_SCOPE_INVALID");
  }
  if (!FACTORY_ROW_HISTORY_TABLES.some(([name]) => name === table)) {
    throw new Error("HISTORICAL_ROW_HISTORY_TABLE_NOT_ALLOWED");
  }
  if (recordIds?.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("HISTORICAL_ROW_HISTORY_INVALID_ID");
  }
  const presence = resultRows<{
    log_ready: boolean;
    baseline_ready: boolean;
    rls_enabled: boolean;
    read_policy_present: boolean;
  }>(
    await db.execute(sql`
      SELECT to_regclass('public.factory_row_history') IS NOT NULL AS log_ready,
             to_regclass('public.factory_row_history_baselines') IS NOT NULL AS baseline_ready,
             COALESCE((SELECT c.relrowsecurity AND c.relforcerowsecurity
                          FROM pg_class c WHERE c.oid = to_regclass('public.factory_row_history')),false)
                          AS rls_enabled,
             EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname='public' AND tablename='factory_row_history'
                        AND policyname='factory_row_history_tenant_read'
                        AND cmd='SELECT') AS read_policy_present
    `)
  )[0];
  if (!presence?.log_ready || !presence.baseline_ready) {
    return { ready: false, reason: "HISTORICAL_ROW_HISTORY_NOT_INSTALLED" };
  }
  if (!presence.rls_enabled || !presence.read_policy_present) {
    throw new Error("HISTORICAL_ROW_HISTORY_RLS_MISSING");
  }

  const metadata = resultRows<{ baseline_at: string; at_or_after_baseline: boolean; triggers_ready: boolean }>(
    await db.execute(sql`
      SELECT b.baseline_at::text AS baseline_at,
             b.baseline_at <
               ((${scope.asOf}::date + INTERVAL '1 day') AT TIME ZONE ${scope.timeZone}) AT TIME ZONE 'UTC'
               AS at_or_after_baseline,
             (SELECT count(*) FROM pg_trigger t
                WHERE t.tgrelid = to_regclass('public.' || ${table}) AND NOT t.tgisinternal
                  AND t.tgenabled = 'O'
                  AND t.tgname IN (${table} || '_row_history_insert',
                                   ${table} || '_row_history_update',
                                   ${table} || '_row_history_delete')) = 3 AS triggers_ready
        FROM factory_row_history_baselines b
       WHERE b.table_name = ${table} AND b.version = ${FACTORY_ROW_HISTORY_VERSION}
    `)
  )[0];
  if (!metadata?.triggers_ready) {
    return { ready: false, reason: "HISTORICAL_ROW_HISTORY_NOT_INSTALLED" };
  }
  if (!metadata.at_or_after_baseline) {
    return { ready: false, reason: "HISTORICAL_ROW_HISTORY_PRE_BASELINE" };
  }

  if (recordIds?.length === 0) return { ready: true, baselineAt: metadata.baseline_at, rows: new Map() };

  const rows = resultRows<HistoricalChange>(
    await db.execute(sql`
      SELECT record_id, op, old_values, new_values
        FROM factory_row_history h
       WHERE h.table_name = ${table} AND h.company_id = ${companyId}
         AND ${netPositionRecordedThrough(sql`h.recorded_at`, scope, "utc-naive-timestamp")}
         ${recordIds ? sql`AND h.record_id = ANY(${sqlArray([...recordIds])})` : sql``}
       ORDER BY h.record_id, h.id
       LIMIT ${MAX_HISTORY_EVENTS + 1}
    `)
  );
  if (rows.length > MAX_HISTORY_EVENTS) throw new Error("HISTORICAL_ROW_HISTORY_RESULT_TOO_LARGE");
  return { ready: true, baselineAt: metadata.baseline_at, rows: replayFactoryRowChanges(rows) };
}
