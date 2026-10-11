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
import { ledgerAccounts } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { firstRow } from "../../lib/queryResult";

export const pn = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? 0 : n;
};

// ── SP chart of accounts (same list as spRoutes.ts) ──────────────────────────
export const SP_ACCOUNTS = [
  { code: "SP-OTW", name: "Goods On The Way", accountType: "Asset", subType: "sp_goods_otw" },
  { code: "SP-OTWCLR", name: "Goods OTW Clearing", accountType: "Liability", subType: "sp_otw_clearing" },
  { code: "SP-PREPAID", name: "Prepaid Charges", accountType: "Asset", subType: "sp_prepaid" },
  { code: "SP-STOCK", name: "Stock on Floor", accountType: "Asset", subType: "sp_stock" },
  { code: "SP-COSTCLR", name: "Stock Cost Payable Clearing", accountType: "Liability", subType: "sp_cost_clearing" },
  { code: "SP-PAYDED", name: "Pay Deduction Clearing", accountType: "Liability", subType: "sp_pay_deduction_clearing" },
  { code: "SP-PAY", name: "Supplier Cash Payable", accountType: "Liability", subType: "sp_payable" },
  { code: "SP-SALES", name: "Sales", accountType: "Income", subType: "sp_sales" },
  { code: "SP-COGS", name: "Cost of Goods Sold", accountType: "Direct Expense", subType: "sp_cogs" },
  { code: "SP-SHARED", name: "Shared Charges", accountType: "Direct Expense", subType: "sp_shared_charges" },
  { code: "SP-OPNBAL", name: "Opening Balance Clearing", accountType: "Equity", subType: "sp_opnbal" },
  { code: "SP-PREPEXP", name: "Prepaid Expenses", accountType: "Asset", subType: "sp_prepaid_expenses" },
  { code: "SP-HADIIC", name: "HADI Intercompany", accountType: "Intercompany", subType: "sp_hadi_intercompany" },
];

// GC-specific profit-share accounts (created during the GC migration, not the base SP set)
export const GC_PROFIT_ACCOUNTS = [
  { code: "GC-OURPFT", name: "GC Our Profit Share", accountType: "Equity", subType: "gc_our_profit_share" },
  { code: "GC-SUPPFT", name: "GC Supplier Profit Share", accountType: "Equity", subType: "gc_supplier_profit_share" },
  {
    code: "GC-PROFCLR",
    name: "GC Accumulated Profit Clearing",
    accountType: "Equity",
    subType: "gc_accumulated_profit_clearing",
  },
];

// Legacy subTypes created by earlier versions of this tool — kept for account-mapping
// backward compatibility only; no longer created by default.
export const LEGACY_GC_PROFIT_SUBTYPES = ["gc_owner_profit", "gc_supplier_profit"];

// Whitelist of subTypes the rename/create-accounts endpoint is allowed to create.
export const ALL_ACCOUNT_DEFS = [...SP_ACCOUNTS, ...GC_PROFIT_ACCOUNTS];

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function getCompanyRow(companyId: number) {
  const rows = await db.execute(
    sql`SELECT id, code, name, company_type FROM companies WHERE id = ${companyId} LIMIT 1`
  );
  return firstRow(rows) ?? (rows as unknown as { [key: string]: Record<string, unknown> | undefined })[0] ?? null;
}

export async function logRun(
  sourceId: number,
  targetId: number,
  action: string,
  status: string,
  rowsCreated: number,
  errorMessage: string | null,
  notes: string | null
): Promise<string> {
  const [row] = (
    await db.execute<{ id: string }>(sql`
    INSERT INTO sp_migration_rehearsal_runs
      (source_company_id, target_company_id, action, status, rows_created, error_message, notes)
    VALUES
      (${sourceId}, ${targetId}, ${action}, ${status}, ${rowsCreated}, ${errorMessage}, ${notes})
    RETURNING id
  `)
  ).rows;
  return row.id;
}

export async function trackRow(runId: string, tableName: string, rowId: number) {
  await db.execute(sql`
    INSERT INTO sp_migration_run_rows (run_id, table_name, row_id)
    VALUES (${runId}, ${tableName}, ${rowId})
  `);
}

// Map of dependent action -> action(s) that must have a 'completed' run for this
// target company before the dependent action is allowed to run.
export const MIGRATION_ACTION_DEPENDENCIES: Record<string, string[]> = {
  gc_stock_opening: ["gc_stock_master"],
  gc_sales_readonly: ["gc_stock_opening"],
  gc_containers: ["gc_stock_opening"],
};

// Enforced server-side (not just UI) staged-dependency guard. Returns null if the
// dependency is satisfied, or an error message string describing what must run first.
export async function requireCompletedMigrationAction(
  sourceCompanyId: number,
  targetCompanyId: number,
  actionName: string
): Promise<string | null> {
  const deps = MIGRATION_ACTION_DEPENDENCIES[actionName];
  if (!deps || !deps.length) return null;
  const ACTION_LABELS: Record<string, string> = {
    gc_stock_master: "Step 4 — Stock Master",
    gc_stock_opening: "Step 5 — Stock Opening by Location",
    gc_sales_readonly: "Step 6 — Historical Sales",
    gc_containers: "Step 7 — Containers",
  };
  for (const dep of deps) {
    // Scoped to the exact (source, target) pair — a completed run for a different
    // source company into the same target must NOT satisfy this dependency.
    const row = (
      await db.execute(sql`
      SELECT id FROM sp_migration_rehearsal_runs
      WHERE source_company_id = ${sourceCompanyId} AND target_company_id = ${targetCompanyId}
        AND action = ${dep} AND status = 'completed'
      ORDER BY id DESC LIMIT 1
    `)
    ).rows?.[0];
    if (!row) {
      return `Run ${ACTION_LABELS[dep] ?? dep} successfully before running ${ACTION_LABELS[actionName] ?? actionName}.`;
    }
  }
  return null;
}

export async function ensureSpAccounts(
  targetId: number,
  overrides?: Record<string, { code?: string; name?: string }>
): Promise<{ names: string[]; newIds: number[] }> {
  const names: string[] = [];
  const newIds: number[] = [];
  for (const acct of SP_ACCOUNTS) {
    const existing = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, targetId),
          eq(ledgerAccounts.subType, acct.subType),
          isNull(ledgerAccounts.deletedAt)
        )
      );
    if (!existing.length) {
      const code = overrides?.[acct.subType]?.code?.trim() || acct.code;
      const name = overrides?.[acct.subType]?.name?.trim() || acct.name;
      const [row] = (
        await db.execute(sql`
        INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, is_hidden, active)
        VALUES (${targetId}, ${code}, ${name}, ${acct.accountType}, ${acct.subType},
                ${acct.subType.includes("clearing") || acct.subType === "sp_opnbal"}, true)
        RETURNING id
      `)
      ).rows;
      names.push(name);
      newIds.push(pn(row.id));
    }
  }
  return { names, newIds };
}

// Create the GC profit-share accounts (or reuse existing ones), honoring user renames.
export async function ensureGcProfitAccounts(
  targetId: number,
  overrides?: Record<string, { code?: string; name?: string }>
): Promise<{ names: string[]; newIds: number[] }> {
  const names: string[] = [];
  const newIds: number[] = [];
  for (const acct of GC_PROFIT_ACCOUNTS) {
    const existing = (
      await db.execute(sql`
      SELECT id FROM ledger_accounts
      WHERE company_id = ${targetId} AND sub_type = ${acct.subType} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];
    if (!existing) {
      const code = overrides?.[acct.subType]?.code?.trim() || acct.code;
      const name = overrides?.[acct.subType]?.name?.trim() || acct.name;
      const [row] = (
        await db.execute(sql`
        INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active)
        VALUES (${targetId}, ${code}, ${name}, ${acct.accountType}, ${acct.subType}, true)
        RETURNING id
      `)
      ).rows;
      names.push(name);
      newIds.push(pn(row.id));
    }
  }
  return { names, newIds };
}

// ── Stock master migration (creates REAL target-company stock_items, never reuses source IDs) ──
export async function ensureTargetStockItems(
  sourceId: number,
  targetId: number,
  runId: string
): Promise<{
  map: Map<number, number>;
  groupsCreated: number;
  gradesCreated: number;
  categoriesCreated: number;
  itemsCreated: number;
  itemsReused: number;
}> {
  const map = new Map<number, number>();
  let groupsCreated = 0;
  let gradesCreated = 0;
  let categoriesCreated = 0;
  let itemsCreated = 0;
  let itemsReused = 0;

  // 1. Stock groups — mirror by code
  const groupMap = new Map<number, number>();
  const sourceGroups = (
    await db.execute(sql`
    SELECT id, code, name FROM stock_groups WHERE company_id = ${sourceId} AND deleted_at IS NULL
  `)
  ).rows;
  for (const g of sourceGroups) {
    const existingGroup = (
      await db.execute(sql`
      SELECT id FROM stock_groups WHERE company_id = ${targetId} AND code = ${g.code} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];
    if (existingGroup) {
      groupMap.set(pn(g.id), pn(existingGroup.id));
    } else {
      const [row] = (
        await db.execute(sql`
        INSERT INTO stock_groups (company_id, code, name, active)
        VALUES (${targetId}, ${g.code}, ${g.name}, true)
        RETURNING id
      `)
      ).rows;
      const newGroupId = pn(row.id);
      groupMap.set(pn(g.id), newGroupId);
      await trackRow(runId, "stock_groups", newGroupId);
      await db.execute(sql`
        INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
        VALUES (${runId}, 'stock_groups', ${pn(g.id)}, 'stock_groups', ${newGroupId})
      `);
      groupsCreated++;
    }
  }

  // 1b. Stock grades / categories — mirror by name (both tables are simple name+active lookups)
  const gradeMap = new Map<number, number>();
  const sourceGrades = // Mirror ALL grades referenced by source items with positive inventory (not just active ones) so
    // grade_id on a migrated item never silently drops to null just because the grade was deactivated.
    (
      await db.execute(sql`
      SELECT DISTINCT g.id, g.name FROM stock_grades g
      WHERE g.company_id = ${sourceId}
        AND (g.active = true OR g.id IN (
          SELECT si.grade_id FROM stock_items si
          JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
          WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0 AND si.grade_id IS NOT NULL
        ))
    `)
    ).rows;
  for (const g of sourceGrades) {
    const existingGrade = (
      await db.execute(sql`SELECT id FROM stock_grades WHERE company_id = ${targetId} AND name = ${g.name} LIMIT 1`)
    ).rows[0];
    if (existingGrade) {
      gradeMap.set(pn(g.id), pn(existingGrade.id));
    } else {
      const [row] = (
        await db.execute(
          sql`INSERT INTO stock_grades (company_id, name, active) VALUES (${targetId}, ${g.name}, true) RETURNING id`
        )
      ).rows;
      const newGradeId = pn(row.id);
      gradeMap.set(pn(g.id), newGradeId);
      await trackRow(runId, "stock_grades", newGradeId);
      gradesCreated++;
    }
  }

  const categoryMap = new Map<number, number>();
  const sourceCategories =
    // Same rationale as grades above — include inactive categories still referenced by migratable items.
    (
      await db.execute(sql`
      SELECT DISTINCT c.id, c.name FROM stock_categories c
      WHERE c.company_id = ${sourceId}
        AND (c.active = true OR c.id IN (
          SELECT si.category_id FROM stock_items si
          JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
          WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0 AND si.category_id IS NOT NULL
        ))
    `)
    ).rows;
  for (const c of sourceCategories) {
    const existingCategory = (
      await db.execute(sql`SELECT id FROM stock_categories WHERE company_id = ${targetId} AND name = ${c.name} LIMIT 1`)
    ).rows[0];
    if (existingCategory) {
      categoryMap.set(pn(c.id), pn(existingCategory.id));
    } else {
      const [row] = (
        await db.execute(
          sql`INSERT INTO stock_categories (company_id, name, active) VALUES (${targetId}, ${c.name}, true) RETURNING id`
        )
      ).rows;
      const newCategoryId = pn(row.id);
      categoryMap.set(pn(c.id), newCategoryId);
      await trackRow(runId, "stock_categories", newCategoryId);
      categoriesCreated++;
    }
  }

  // 2. Stock items with positive inventory in source
  const sourceItems = (
    await db.execute(sql`
    SELECT si.id, si.code, si.name, si.uom, si.stock_group_id, si.grade_id, si.category_id,
           si.opening_qty, si.opening_rate, si.opening_value, si.reorder_level, si.selling_price, si.active
    FROM stock_items si
    JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
    WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0
    ORDER BY si.code
  `)
  ).rows;

  for (const item of sourceItems) {
    const srcId = pn(item.id);

    // Already linked by a prior run?
    const priorLink = (
      await db.execute(sql`
      SELECT target_id FROM sp_migration_source_links
      WHERE source_table = 'stock_items' AND source_id = ${srcId} AND target_table = 'stock_items'
      LIMIT 1
    `)
    ).rows[0];
    if (priorLink) {
      // Verify it still exists in target (defensive — should always be true)
      const stillExists = (
        await db.execute(sql`
        SELECT id FROM stock_items WHERE id = ${pn(priorLink.target_id)} AND company_id = ${targetId} AND deleted_at IS NULL LIMIT 1
      `)
      ).rows[0];
      if (stillExists) {
        map.set(srcId, pn(priorLink.target_id));
        itemsReused++;
        continue;
      }
    }

    // Fall back to matching by code (handles manual pre-existing target items)
    const existingByCode = (
      await db.execute(sql`
      SELECT id FROM stock_items WHERE company_id = ${targetId} AND code = ${item.code} AND deleted_at IS NULL LIMIT 1
    `)
    ).rows[0];

    let targetItemId: number;
    if (existingByCode) {
      targetItemId = pn(existingByCode.id);
      itemsReused++;
    } else {
      const targetGroupId = item.stock_group_id ? (groupMap.get(pn(item.stock_group_id)) ?? null) : null;
      const targetGradeId = item.grade_id ? (gradeMap.get(pn(item.grade_id)) ?? null) : null;
      const targetCategoryId = item.category_id ? (categoryMap.get(pn(item.category_id)) ?? null) : null;
      const [row] = (
        await db.execute(sql`
        INSERT INTO stock_items
          (company_id, code, name, uom, stock_group_id, grade_id, category_id,
           opening_qty, opening_rate, opening_value, reorder_level, selling_price, active)
        VALUES
          (${targetId}, ${item.code}, ${item.name}, ${item.uom}, ${targetGroupId}, ${targetGradeId}, ${targetCategoryId},
           ${item.opening_qty ?? "0"}, ${item.opening_rate ?? "0"}, ${item.opening_value ?? "0"},
           ${item.reorder_level ?? "0"}, ${item.selling_price ?? "0"}, ${item.active ?? true})
        RETURNING id
      `)
      ).rows;
      targetItemId = pn(row.id);
      await trackRow(runId, "stock_items", targetItemId);
      itemsCreated++;
    }

    await db.execute(sql`
      INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
      VALUES (${runId}, 'stock_items', ${srcId}, 'stock_items', ${targetItemId})
    `);
    map.set(srcId, targetItemId);
  }

  return { map, groupsCreated, gradesCreated, categoriesCreated, itemsCreated, itemsReused };
}

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
