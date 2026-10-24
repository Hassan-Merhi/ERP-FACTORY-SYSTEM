/**
 * Read-only recorder readiness shown on Factory Net Position.
 *
 * An installed trigger is not sufficient evidence on its own: it must have
 * an atomic baseline with a timestamp strictly before the selected day's
 * company-local closing instant. A table missing either remains provisional.
 */
import { sql } from "drizzle-orm";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { FACTORY_ROW_HISTORY_TABLES, FACTORY_ROW_HISTORY_VERSION } from "../audit/factoryRowHistory";

export type FactoryRowHistoryCoverage = {
  trackedTables: number;
  readyTables: number;
  unavailableTables: string[];
  preBaselineTables: string[];
  // Every category still needs source-specific effective-date verification.
  certified: false;
};

export async function loadFactoryRowHistoryCoverage(scope: FactoryNetPositionAsOf): Promise<FactoryRowHistoryCoverage> {
  const trackedTables = FACTORY_ROW_HISTORY_TABLES.length;
  const empty = (): FactoryRowHistoryCoverage => ({
    trackedTables,
    readyTables: 0,
    unavailableTables: FACTORY_ROW_HISTORY_TABLES.map(([name]) => name),
    preBaselineTables: [],
    certified: false,
  });
  if (!scope.isHistorical) return empty();
  const tablesExist = resultRows<{ exists: boolean }>(
    await db.execute(sql`SELECT to_regclass('public.factory_row_history_baselines') IS NOT NULL AS exists`)
  )[0]?.exists;
  if (!tablesExist) return empty();
  const rows = resultRows<{
    table_name: string;
    version: string;
    installed_triggers: number | string;
    available_by_date: boolean;
  }>(
    await db.execute(sql`
      SELECT b.table_name, b.version,
             (SELECT COUNT(*)::int FROM pg_trigger t
               WHERE t.tgrelid = to_regclass('public.' || b.table_name) AND NOT t.tgisinternal
                 AND t.tgenabled = 'O'
                 AND t.tgname IN (b.table_name || '_row_history_insert',
                                  b.table_name || '_row_history_update',
                                  b.table_name || '_row_history_delete')) AS installed_triggers,
             b.baseline_at < (
               ((${scope.asOf}::date + INTERVAL '1 day') AT TIME ZONE ${scope.timeZone})
                AT TIME ZONE 'UTC') AS available_by_date
        FROM factory_row_history_baselines b
    `)
  );
  const byName = new Map(rows.map((row) => [row.table_name, row]));
  const unavailableTables: string[] = [];
  const preBaselineTables: string[] = [];
  let readyTables = 0;
  for (const [name] of FACTORY_ROW_HISTORY_TABLES) {
    const status = byName.get(name);
    if (!status || status.version !== FACTORY_ROW_HISTORY_VERSION || Number(status.installed_triggers) !== 3) {
      unavailableTables.push(name);
    } else if (!status.available_by_date) {
      preBaselineTables.push(name);
    } else {
      readyTables += 1;
    }
  }
  return { trackedTables, readyTables, unavailableTables, preBaselineTables, certified: false };
}
