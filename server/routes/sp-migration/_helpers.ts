/**
 * Shared helpers for the Supplier-Partner (SP) migration routes.
 *
 * Extracted from the former single-file server/routes/spMigrationRoutes.ts.
 * `ensureTargetLocation` was previously nested inside the registration function;
 * it is hoisted here because only the stock step uses it and a nested definition
 * cannot be shared across modules.
 */
/**
 * SP Migration Rehearsal Routes
 *
 * Safety guarantees enforced here (server-side):
 * 1. Source company must be type 'erp' — never supplier_partner
 * 2. Target company must be type 'supplier_partner'
 * 3. Source ≠ Target
 * 4. Typed confirmation "REHEARSE" required for any write
 * 5. Source name must match typed companyNameConfirm exactly
 * 6. Every attempt is logged to sp_migration_rehearsal_runs
 * 7. Rollback only deletes rows tracked in sp_migration_run_rows
 * 8. NO /cutover endpoint exists — blocked by absence
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import {
  GC_PROFIT_ACCOUNTS,
  LEGACY_GC_PROFIT_SUBTYPES,
  SP_ACCOUNTS,
  getCompanyRow,
  pn,
  trackRow,
} from "./_helpersEnsureSpAccounts";
export {
  ALL_ACCOUNT_DEFS,
  GC_PROFIT_ACCOUNTS,
  LEGACY_GC_PROFIT_SUBTYPES,
  MIGRATION_ACTION_DEPENDENCIES,
  SP_ACCOUNTS,
  ensureGcProfitAccounts,
  ensureSpAccounts,
  getCompanyRow,
  logRun,
  pn,
  requireCompletedMigrationAction,
  trackRow,
} from "./_helpersEnsureSpAccounts";
export { ensureTargetStockItems } from "./_helpersEnsureTargetStockItems";

// ── Shared read-only preview builder ────────────────────────────────────────
// Used by both /gc-preview (canonical) and /preview (legacy alias, same shape).
// NO writes. Returns what WOULD be migrated by the staged flow.
export async function buildGcMigrationPreview(sourceId: number, targetId: number) {
  const sourceComp = await getCompanyRow(sourceId);
  const targetComp = await getCompanyRow(targetId);
  if (!sourceComp) return { status: 404, body: { message: "Source company not found" } };
  if (!targetComp) return { status: 404, body: { message: "Target company not found" } };
  if (sourceComp.company_type !== "erp") return { status: 400, body: { message: "Source company must be type 'erp'" } };
  if (targetComp.company_type !== "supplier_partner")
    return { status: 400, body: { message: "Target company must be type 'supplier_partner'" } };

  // Stock items with positive inventory in source, valued by the stored
  // total_value (wave 11: quantity x average_rate drifts by the rounding of
  // every issue).
  const stockRows = (
    await db.execute(sql`
    SELECT si.id AS stock_item_id, si.code, si.name, inv.quantity, inv.average_rate,
           COALESCE(inv.total_value, 0) AS total_value
    FROM stock_items si
    JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
    WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0
    ORDER BY si.code
  `)
  ).rows;

  // aliasExists is a per-item display flag only — NOT the mapping check (see below).
  const existingAliases = (
    await db.execute(sql`
    SELECT alias_code FROM stock_item_code_aliases WHERE company_id = ${targetId}
  `)
  ).rows;
  const existingAliasCodes = new Set(existingAliases.map((r) => r.alias_code));

  // Real mapping check: has this source stock item already been linked to a target
  // stock item by a prior staged migration run (sp_migration_source_links)?
  let mappedSourceIds = new Set<number>();
  if (stockRows.length > 0) {
    const linkedRows = (
      await db.execute(sql`
      SELECT DISTINCT l.source_id
      FROM sp_migration_source_links l
      JOIN stock_items ti ON ti.id = l.target_id AND ti.company_id = ${targetId} AND ti.deleted_at IS NULL
      WHERE l.source_table = 'stock_items' AND l.target_table = 'stock_items'
        AND l.source_id IN (${sql.join(
          stockRows.map((r) => sql`${pn(r.stock_item_id)}`),
          sql`, `
        )})
    `)
    ).rows;
    mappedSourceIds = new Set(linkedRows.map((r) => pn(r.source_id)));
  }

  const stockItems = stockRows.map((r) => ({
    code: r.code,
    name: r.name,
    quantity: pn(r.quantity),
    averageCostUsd: pn(r.average_rate),
    totalValueUsd: pn(r.total_value),
    aliasExists: existingAliasCodes.has(r.code),
  }));

  // Sale vouchers in source (support 'Sales' and legacy 'Sale')
  const voucherRow = (
    await db.execute(sql`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total
    FROM vouchers
    WHERE company_id = ${sourceId} AND voucher_type IN ('Sales', 'Sale') AND deleted_at IS NULL
  `)
  ).rows[0];

  // Already-migrated vouchers in target: linked from a source sale voucher, OR
  // carrying the migration-only marker (prefix + source_module).
  const migratedRow = (
    await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM vouchers v
    WHERE v.company_id = ${targetId} AND v.deleted_at IS NULL
      AND (
        v.id IN (
          SELECT target_id FROM sp_migration_source_links
          WHERE source_table = 'vouchers' AND target_table = 'vouchers'
        )
        OR v.voucher_number LIKE 'MIG-GC-%'
        OR v.source_module = 'SP_MIGRATION_READONLY'
      )
  `)
  ).rows[0];

  // SP accounts status
  const spAcctRows = (
    await db.execute(sql`
    SELECT sub_type FROM ledger_accounts
    WHERE company_id = ${targetId} AND deleted_at IS NULL AND sub_type LIKE 'sp_%'
  `)
  ).rows;
  const existingSpSubTypes = new Set(spAcctRows.map((r) => r.sub_type));
  const spAccountsStatus = SP_ACCOUNTS.map((a) => ({
    subType: a.subType,
    name: a.name,
    exists: existingSpSubTypes.has(a.subType),
  }));

  // GC profit accounts status (current subtypes + legacy ones from earlier tool versions)
  const gcAllSubTypes = [...GC_PROFIT_ACCOUNTS.map((a) => a.subType), ...LEGACY_GC_PROFIT_SUBTYPES];
  const gcAcctRows = (
    await db.execute(sql`
    SELECT sub_type, name FROM ledger_accounts
    WHERE company_id = ${targetId} AND deleted_at IS NULL AND sub_type = ANY(${sqlArray(gcAllSubTypes)})
  `)
  ).rows;
  const existingGcSubTypes = new Map(gcAcctRows.map((r) => [r.sub_type, r.name]));

  const totalQty = stockItems.reduce((s: number, i) => s + i.quantity, 0);
  const totalValue = stockItems.reduce((s: number, i) => s + i.totalValueUsd, 0);
  const alreadyMapped = mappedSourceIds.size;

  const warnings: string[] = [];
  if (stockItems.length === 0) warnings.push("No stock items with positive inventory found in source company.");
  if (alreadyMapped > 0)
    warnings.push(
      `${alreadyMapped} stock item(s) already have source-to-target migration links and will be reused by staged steps.`
    );
  if (pn(migratedRow.cnt) > 0)
    warnings.push(
      `${pn(migratedRow.cnt)} voucher(s) already migrated in target — re-running will create duplicates. Rollback first.`
    );
  warnings.push("Open/OTW containers can be migrated in the Containers step. Review OTW accounting after migration.");
  warnings.push(
    "Duty/surcharge/fumigation/other charges are not auto-posted unless safely mapped; review warnings after the Containers step."
  );
  warnings.push("Cash and bank balances must be posted separately if needed.");
  warnings.push("This preview is read-only. No data has been written.");

  return {
    status: 200,
    body: {
      sourceCompany: { id: sourceComp.id, code: sourceComp.code, name: sourceComp.name },
      targetCompany: { id: targetComp.id, code: targetComp.code, name: targetComp.name },
      stockSummary: {
        itemCount: stockItems.length,
        totalQty: Math.round(totalQty * 1000) / 1000,
        totalValueUsd: Math.round(totalValue * 100) / 100,
        alreadyMapped,
      },
      stockItems,
      voucherSummary: {
        sourceCount: pn(voucherRow.cnt),
        totalAmount: pn(voucherRow.total),
        alreadyMigrated: pn(migratedRow.cnt),
      },
      spAccountsStatus,
      gcProfitAccountsStatus: GC_PROFIT_ACCOUNTS.map((a) => ({
        subType: a.subType,
        name: existingGcSubTypes.get(a.subType) ?? a.name,
        exists: existingGcSubTypes.has(a.subType),
      })),
      warnings,
    },
  };
}

// ── Location-aware stock opening ────────────────────────────────────────
// Copies source per-location inventory into matching target locations
// (matched by code, then name, then created), instead of dumping everything
// into a single "Main Warehouse". Idempotent per (target stock item, target
// location): a prior sp_stock_movements 'opening_stock' row for that pair
// blocks a duplicate re-add.
export async function ensureTargetLocation(
  sourceLoc: { id: number; code: string; name: string },
  targetId: number,
  runId: string,
  locMap: Map<number, number>
): Promise<number> {
  const srcId = pn(sourceLoc.id);
  if (locMap.has(srcId)) return locMap.get(srcId)!;

  let targetLocId: number | undefined;
  const byCode = (
    await db.execute(sql`
    SELECT id FROM locations WHERE company_id = ${targetId} AND code = ${sourceLoc.code} AND deleted_at IS NULL LIMIT 1
  `)
  ).rows[0];
  if (byCode) targetLocId = pn(byCode.id);

  if (!targetLocId) {
    const byName = (
      await db.execute(sql`
      SELECT id FROM locations WHERE company_id = ${targetId} AND name = ${sourceLoc.name} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];
    if (byName) targetLocId = pn(byName.id);
  }

  if (!targetLocId) {
    const [row] = (
      await db.execute(sql`
      INSERT INTO locations (company_id, code, name, active)
      VALUES (${targetId}, ${sourceLoc.code}, ${sourceLoc.name}, true)
      RETURNING id
    `)
    ).rows;
    targetLocId = pn(row.id);
    await trackRow(runId, "locations", targetLocId);
  }

  locMap.set(srcId, targetLocId);
  return targetLocId;
}
