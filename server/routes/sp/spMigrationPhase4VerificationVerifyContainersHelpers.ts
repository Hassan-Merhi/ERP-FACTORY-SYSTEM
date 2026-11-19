// Extracted from ./spMigrationPhase4VerificationVerifyContainers.ts
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { pn } from "./spMigrationPhase2Common";
import { type VerificationIssue } from "./spMigrationPhase4Policy";
import { firstRow, resultRows } from "../../lib/queryResult";

export type VerificationArea = {
  area: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  mismatches?: string[];
};

export async function completedPairLinks(sourceId: number, targetId: number, sourceTable: string, targetTable: string) {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (l.source_id) l.source_id, l.target_id
    FROM sp_migration_source_links l
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    WHERE r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
      AND l.source_table = ${sourceTable}
      AND l.target_table = ${targetTable}
    ORDER BY l.source_id, r.created_at DESC
  `);
  return resultRows(result);
}

export async function verifyHistoricalSales(
  sourceId: number,
  targetId: number
): Promise<{
  blockers: VerificationIssue[];
  deltas: VerificationIssue[];
  area: VerificationArea;
  counts: Record<string, number>;
}> {
  const blockers: VerificationIssue[] = [];
  const deltas: VerificationIssue[] = [];
  const voucherLinks = await completedPairLinks(sourceId, targetId, "vouchers", "vouchers");
  const itemLinks = await completedPairLinks(sourceId, targetId, "sales_items", "sales_items");
  const entryLinks = await completedPairLinks(sourceId, targetId, "voucher_entries", "voucher_entries");
  const linkedVoucherIds = new Set(voucherLinks.map((row) => pn(row.source_id)));
  const linkedItemIds = new Set(itemLinks.map((row) => pn(row.source_id)));
  const linkedEntryIds = new Set(entryLinks.map((row) => pn(row.source_id)));

  const sourceVouchersResult = await db.execute(sql`
    SELECT id, voucher_number FROM vouchers
    WHERE company_id = ${sourceId} AND voucher_type IN ('Sales', 'Sale') AND deleted_at IS NULL
    ORDER BY id ASC
  `);
  const sourceItemsResult = await db.execute(sql`
    SELECT si.id
    FROM sales_items si
    JOIN vouchers v ON v.id = si.voucher_id
    WHERE v.company_id = ${sourceId} AND v.voucher_type IN ('Sales', 'Sale') AND v.deleted_at IS NULL
  `);
  const sourceEntriesResult = await db.execute(sql`
    SELECT e.id
    FROM voucher_entries e
    JOIN vouchers v ON v.id = e.voucher_id
    WHERE v.company_id = ${sourceId} AND v.voucher_type IN ('Sales', 'Sale') AND v.deleted_at IS NULL
  `);
  const sourceVouchers = resultRows(sourceVouchersResult);
  const sourceItems = resultRows(sourceItemsResult);
  const sourceEntries = resultRows(sourceEntriesResult);
  const missingVouchers = sourceVouchers.filter((row) => !linkedVoucherIds.has(pn(row.id)));
  const missingItems = sourceItems.filter((row) => !linkedItemIds.has(pn(row.id)));
  const missingEntries = sourceEntries.filter((row) => !linkedEntryIds.has(pn(row.id)));

  if (missingVouchers.length) {
    deltas.push({
      code: "READONLY_SALES_VOUCHER_DELTA",
      message: `${missingVouchers.length} historical sale voucher(s) require migration or provenance repair.`,
      count: missingVouchers.length,
    });
  }
  if (missingItems.length) {
    deltas.push({
      code: "READONLY_SALES_ITEM_DELTA",
      message: `${missingItems.length} historical sale item row(s) require safe backfill or provenance repair.`,
      count: missingItems.length,
    });
  }
  if (missingEntries.length) {
    deltas.push({
      code: "READONLY_SALES_ENTRY_DELTA",
      message: `${missingEntries.length} historical accounting entry row(s) require safe backfill or provenance repair.`,
      count: missingEntries.length,
    });
  }

  const unlinkedTargetsResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM vouchers tv
    WHERE tv.company_id = ${targetId}
      AND tv.source_module = 'SP_MIGRATION_READONLY'
      AND tv.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sp_migration_source_links l
        JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
        WHERE r.source_company_id = ${sourceId}
          AND r.target_company_id = ${targetId}
          AND r.status <> 'rolled_back'
          AND l.target_table = 'vouchers'
          AND l.target_id = tv.id
      )
  `);
  const unlinkedTargets = pn(firstRow(unlinkedTargetsResult)?.count);
  if (unlinkedTargets) {
    blockers.push({
      code: "UNPROVENANCED_TARGET_SALES",
      message: `${unlinkedTargets} target read-only sale voucher(s) have no source provenance and cannot be trusted for cutover.`,
      count: unlinkedTargets,
    });
  }

  const counts = {
    sourceVouchers: sourceVouchers.length,
    linkedVouchers: voucherLinks.length,
    sourceItems: sourceItems.length,
    linkedItems: itemLinks.length,
    sourceEntries: sourceEntries.length,
    linkedEntries: entryLinks.length,
    unlinkedTargetVouchers: unlinkedTargets,
  };
  const status = blockers.length ? "FAIL" : deltas.length ? "WARN" : "PASS";
  return {
    blockers,
    deltas,
    counts,
    area: {
      area: "Historical sales copy",
      status,
      detail:
        `Vouchers ${voucherLinks.length}/${sourceVouchers.length}; items ${itemLinks.length}/${sourceItems.length}; ` +
        `entries ${entryLinks.length}/${sourceEntries.length} linked to their source rows.`,
      mismatches: missingVouchers.slice(0, 50).map((row) => `Missing voucher: ${row.voucher_number}`),
    },
  };
}
