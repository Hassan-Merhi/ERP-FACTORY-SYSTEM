/**
 * daybookSourceIntegrity.ts
 *
 * Central registry for Factory Daybook source-backed transaction types.
 *
 * Responsibilities:
 * 1. AUTO_FILL_REF_TABLE — canonical reference_table value for each source-backed txType,
 *    used by writeDaybookEntry to fill the column when the caller omits it.
 *
 * 2. buildPaginationIntegrityConditions — SQL WHERE fragments for the paginated
 *    daybook endpoint; replaces the per-type ad-hoc EXISTS checks.
 *
 * 3. buildLegacyValidSourceIds + isRowIntegrityValid — in-memory filter for the
 *    legacy (non-paginated) daybook endpoint; batch-fetches valid IDs per source
 *    table so we avoid N+1 queries.
 *
 * 4. removeDaybookEntriesForSource — helper called by delete/undo routes to proactively
 *    clean the original transaction entry when the source record is removed.
 */

import { pool } from "../../db";
import { factoryDaybookEntries } from "@shared/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { assertBindPlaceholder } from "../../lib/sqlTextGuards";
import { SOURCE_GROUPS, REGISTRY_BY_TXTYPE, REGISTRY_BY_TABLE } from "./daybookSourceIntegrityModel";
export { SOURCE_GROUPS, AUTO_FILL_REF_TABLE } from "./daybookSourceIntegrityModel";

// ── Source group definition ─────────────────────────────────────────────────

// ── Flat lookup maps ────────────────────────────────────────────────────────

for (const group of SOURCE_GROUPS) {
  for (const txType of group.txTypes) {
    REGISTRY_BY_TXTYPE.set(txType, group);
  }
  REGISTRY_BY_TABLE.set(group.sourceTable, group);
}

// ── Auto-fill map ───────────────────────────────────────────────────────────

// ── SQL condition generator (pagination route) ──────────────────────────────

/**
 * Returns an array of SQL condition strings suitable for appending to a
 * `realConditions` array in a raw-SQL parameterised query.
 *
 * @param companyParam  Already-bound parameter placeholder (e.g. `"$1"`) whose
 *                      value is the current company ID.
 *
 * Each condition follows the pattern:
 *   NOT (typeCheck AND (referenceId IS NULL OR NOT EXISTS (SELECT 1 FROM source …)))
 *
 * The typeCheck uses COALESCE to match both modern rows (reference_table set)
 * and legacy rows (reference_table IS NULL, matched by tx_type).
 */
export function buildPaginationIntegrityConditions(companyParam: string): string[] {
  assertBindPlaceholder(companyParam, "daybook_integrity_company_param");
  return SOURCE_GROUPS.map((group) => {
    const txList = group.txTypes.map((t) => `'${t}'`).join(", ");
    const typeCheck =
      group.txTypes.length === 1
        ? `(COALESCE(f.reference_table = '${group.sourceTable}', false) OR f.tx_type = ${txList})`
        : `(COALESCE(f.reference_table = '${group.sourceTable}', false) OR f.tx_type IN (${txList}))`;

    let existsClause = `SELECT 1 FROM ${group.sourceTable} t WHERE t.id = f.reference_id`;
    if (group.companyCol) existsClause += ` AND t.${group.companyCol} = ${companyParam}`;
    if (group.deletedAtCol) existsClause += ` AND t.${group.deletedAtCol} IS NULL`;

    if (group.requireReferenceId) {
      // Also exclude rows with NULL referenceId — they can never be verified.
      return `NOT (${typeCheck} AND (f.reference_id IS NULL OR NOT EXISTS (${existsClause})))`;
    } else {
      // Only exclude rows where referenceId IS set but source no longer exists.
      return `NOT (${typeCheck} AND f.reference_id IS NOT NULL AND NOT EXISTS (${existsClause}))`;
    }
  });
}

// ── Batch validity fetch + row check (legacy/non-paginated route) ───────────

/**
 * Batch-fetches the set of live referenceIds for every source table that appears
 * in `rows`.  Returns a Map<sourceTable, Set<id>> which can be passed to
 * `isRowIntegrityValid`.
 *
 * Does NOT handle voucher-backed rows — those use their own live-data fetch with
 * description/amount enrichment in the legacy daybook route.
 */
export async function buildLegacyValidSourceIds(
  rows: Array<{ txType: string; referenceId: number | null }>,
  companyId: number
): Promise<Map<string, Set<number>>> {
  // Collect referenceIds grouped by source table
  const tableIds = new Map<string, Set<number>>();
  for (const row of rows) {
    const { txType, referenceId } = row;
    if (referenceId == null) continue;
    const group = REGISTRY_BY_TXTYPE.get(txType);
    if (!group) continue;
    let bucket = tableIds.get(group.sourceTable);
    if (!bucket) {
      bucket = new Set();
      tableIds.set(group.sourceTable, bucket);
    }
    bucket.add(referenceId);
  }

  // Batch-fetch per source table
  const validIds = new Map<string, Set<number>>();
  await Promise.all(
    [...tableIds.entries()].map(async ([sourceTable, ids]) => {
      const group = REGISTRY_BY_TABLE.get(sourceTable);
      const idArray = [...ids];

      let query = `SELECT id FROM ${sourceTable} WHERE id = ANY($1)`;
      const params: unknown[] = [idArray];
      if (group?.companyCol) {
        query += ` AND ${group.companyCol} = $2`;
        params.push(companyId);
      }
      if (group?.deletedAtCol) {
        query += ` AND ${group.deletedAtCol} IS NULL`;
      }

      const result = await pool.query<{ id: number }>(query, params);
      validIds.set(sourceTable, new Set(result.rows.map((r) => r.id)));
    })
  );

  return validIds;
}

/**
 * Checks whether a single daybook row should be shown in the Transactions tab.
 *
 * - Rows whose txType is not in the registry pass through unchanged (activity
 *   events, voucher-backed rows handled separately, etc.).
 * - Source-backed rows with a live source → true.
 * - Source-backed rows with an orphaned referenceId → false.
 * - Source-backed rows with NULL referenceId → false if requireReferenceId,
 *   true otherwise (legacy payroll entries).
 */
export function isRowIntegrityValid(
  row: { txType: string; referenceId: number | null; referenceTable?: string | null },
  validSourceIds: Map<string, Set<number>>
): boolean {
  const group = REGISTRY_BY_TXTYPE.get(row.txType);
  if (!group) return true; // Not a registered source-backed type → pass through

  const { referenceId } = row;

  if (referenceId == null) {
    return !group.requireReferenceId;
  }

  const validSet = validSourceIds.get(group.sourceTable);
  // If the table wasn't fetched at all (no IDs collected), the row is orphaned.
  return validSet ? validSet.has(referenceId) : false;
}

// ── Cleanup helper (delete routes) ─────────────────────────────────────────

/**
 * Deletes source-backed daybook entries for a given source record.
 *
 * Matches rows where:
 *   reference_id = referenceId AND company_id = companyId AND (
 *     reference_table = referenceTable
 *     OR (reference_table IS NULL AND tx_type IN (txTypes))   ← legacy rows
 *   )
 *
 * Pass `txTypes` as the source-backed txTypes to clean so we never accidentally
 * delete audit/activity entries (e.g. PAYROLL_DELETED) that happen to share
 * the same referenceId.
 *
 * @param dbOrTx  Drizzle db or transaction object.
 */
export async function removeDaybookEntriesForSource(
  dbOrTx: DatabaseOrTransaction,
  opts: {
    companyId: number;
    referenceTable: string;
    referenceId: number;
    /** Source-transaction txTypes to clean (excludes audit entries). */
    txTypes: string[];
  }
): Promise<void> {
  const { companyId, referenceTable, referenceId, txTypes } = opts;

  const tableCondition = or(
    eq(factoryDaybookEntries.referenceTable, referenceTable),
    and(isNull(factoryDaybookEntries.referenceTable), inArray(factoryDaybookEntries.txType, txTypes))
  );

  await dbOrTx
    .delete(factoryDaybookEntries)
    .where(
      and(
        eq(factoryDaybookEntries.companyId, companyId),
        eq(factoryDaybookEntries.referenceId, referenceId),
        tableCondition
      )
    );
}
