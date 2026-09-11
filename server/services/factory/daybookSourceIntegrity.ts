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

// ── Source group definition ─────────────────────────────────────────────────

interface SourceGroup {
  /** All txTypes that map to this source table */
  txTypes: string[];
  /** Actual DB table holding the source record */
  sourceTable: string;
  /** Column for company isolation; null = no company check */
  companyCol: string | null;
  /** Column for soft-delete check; null = hard-delete only */
  deletedAtCol: string | null;
  /**
   * When true: a NULL referenceId is itself invalid (the row is excluded).
   * When false: NULL referenceId rows pass through (legacy entries without an ID).
   */
  requireReferenceId: boolean;
}

/**
 * Canonical source groups.  Each entry produces one SQL integrity condition and
 * one batch-lookup in the legacy filter.
 *
 * NOT included: PAYMENT / RECEIPT / JOURNAL (voucher-backed — handled by the
 * LEFT JOIN on live_voucher in the paginated endpoint and by the validVoucherIds
 * set with live-data enrichment in the legacy endpoint).
 */
export const SOURCE_GROUPS: SourceGroup[] = [
  {
    txTypes: ["SUPPLIER_FX_TRANSFER"],
    sourceTable: "factory_supplier_fx_transfers",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["SUPPLIER_PAYMENT"],
    sourceTable: "factory_supplier_payments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["PAYROLL_PAYMENT", "PAYROLL_GENERATED"],
    sourceTable: "factory_payrolls",
    companyCol: "company_id",
    deletedAtCol: null,
    // Legacy PAYROLL_GENERATED entries written by payrollCoreRoutes were not given
    // a referenceId (bulk-generate over many workers).  Allow NULL so they stay visible.
    requireReferenceId: false,
  },
  {
    txTypes: ["ADVANCE_GIVEN", "ADVANCE_CASH_UPDATED"],
    sourceTable: "factory_worker_advances",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["ADVANCE_REPAYMENT"],
    sourceTable: "factory_advance_repayments",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    // FREIGHT / DUTY / FREIGHT_PAYMENT / OTHER_CHARGE all store the container id
    // as referenceId.  CONTAINER_IMPORT and PURCHASE store the container id too.
    txTypes: ["CONTAINER_IMPORT", "PURCHASE", "FREIGHT", "DUTY", "FREIGHT_PAYMENT", "OTHER_CHARGE"],
    sourceTable: "factory_containers",
    companyCol: "company_id",
    deletedAtCol: "deleted_at",
    requireReferenceId: true,
  },
  {
    txTypes: ["MIX_BATCH_CREATED", "MIX_BATCH_TOPUP"],
    sourceTable: "factory_mix_batches",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["INVOICE", "LOADING_CREATED"],
    sourceTable: "customer_orders",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["BALE_PRESSING"],
    sourceTable: "factory_pressing_batches",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["WASTE_DISPOSAL"],
    sourceTable: "factory_bale_waste_dispatches",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["COMMISSION"],
    sourceTable: "factory_container_commissions",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
  {
    txTypes: ["OPENING_BALANCE_RAW", "OFFLOAD_RAW_STOCK"],
    sourceTable: "factory_raw_stock",
    companyCol: "company_id",
    deletedAtCol: null,
    requireReferenceId: true,
  },
];

// ── Flat lookup maps ────────────────────────────────────────────────────────

/** txType → SourceGroup for O(1) lookup */
const REGISTRY_BY_TXTYPE = new Map<string, SourceGroup>();
/** sourceTable → SourceGroup for batch-query lookup */
const REGISTRY_BY_TABLE = new Map<string, SourceGroup>();

for (const group of SOURCE_GROUPS) {
  for (const txType of group.txTypes) {
    REGISTRY_BY_TXTYPE.set(txType, group);
  }
  REGISTRY_BY_TABLE.set(group.sourceTable, group);
}

// ── Auto-fill map ───────────────────────────────────────────────────────────

/**
 * What to write to `reference_table` when a writeDaybookEntry caller omits it.
 * Only covers txTypes where the source table is unambiguously determined by
 * txType alone (i.e., every call site uses the same source table).
 */
export const AUTO_FILL_REF_TABLE: Record<string, string> = {
  SUPPLIER_FX_TRANSFER: "factory_supplier_fx_transfers",
  SUPPLIER_PAYMENT: "factory_supplier_payments",
  PAYROLL_PAYMENT: "factory_payrolls",
  PAYROLL_GENERATED: "factory_payrolls",
  ADVANCE_GIVEN: "factory_worker_advances",
  ADVANCE_CASH_UPDATED: "factory_worker_advances",
  ADVANCE_REPAYMENT: "factory_advance_repayments",
  CONTAINER_IMPORT: "factory_containers",
  PURCHASE: "factory_containers",
  FREIGHT: "factory_containers",
  DUTY: "factory_containers",
  FREIGHT_PAYMENT: "factory_containers",
  OTHER_CHARGE: "factory_containers",
  MIX_BATCH_CREATED: "factory_mix_batches",
  MIX_BATCH_TOPUP: "factory_mix_batches",
  INVOICE: "customer_orders",
  LOADING_CREATED: "customer_orders",
  BALE_PRESSING: "factory_pressing_batches",
  WASTE_DISPOSAL: "factory_bale_waste_dispatches",
  COMMISSION: "factory_container_commissions",
  OPENING_BALANCE_RAW: "factory_raw_stock",
  OFFLOAD_RAW_STOCK: "factory_raw_stock",
};

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
