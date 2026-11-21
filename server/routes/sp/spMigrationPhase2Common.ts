import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows, firstRow } from "../../lib/queryResult";
import {
  pn,
  getCompany,
  DEPENDENCIES,
  type MigrationCompanyRow,
  type SuspenseReviewItem,
  type SuspenseReview,
} from "./spMigrationPhase2CommonHelpers";
export {
  pn,
  failRun,
  loadTargetAccounts,
  mapTargetAccount,
  resolveSupplier,
  type MigrationCompanyRow,
  type SuspenseReviewItem,
  type SuspenseReview,
} from "./spMigrationPhase2CommonHelpers";

export const money = (value: unknown): string => pn(value).toFixed(4);

export async function validateMigrationPair(
  req: import("express").Request,
  res: import("express").Response,
  requireConfirmation = true
): Promise<{
  sourceId: number;
  targetId: number;
  sourceCompany: MigrationCompanyRow;
  targetCompany: MigrationCompanyRow;
} | null> {
  const sourceId = Number.parseInt(String(req.body?.sourceCompanyId ?? req.query?.sourceCompanyId ?? ""), 10);
  const targetId = Number.parseInt(String(req.body?.targetCompanyId ?? req.query?.targetCompanyId ?? ""), 10);

  if (!sourceId || !targetId) {
    res.status(400).json({ message: "sourceCompanyId and targetCompanyId are required" });
    return null;
  }
  if (sourceId === targetId) {
    res.status(400).json({ message: "Source and target companies must be different" });
    return null;
  }

  const sourceCompany = await getCompany(sourceId);
  const targetCompany = await getCompany(targetId);
  if (!sourceCompany) {
    res.status(404).json({ message: "Source company not found" });
    return null;
  }
  if (!targetCompany) {
    res.status(404).json({ message: "Target company not found" });
    return null;
  }
  if (sourceCompany.company_type !== "erp") {
    res.status(400).json({ message: "Source company must be type 'erp'" });
    return null;
  }
  if (targetCompany.company_type !== "supplier_partner") {
    res.status(400).json({ message: "Target company must be type 'supplier_partner'" });
    return null;
  }

  if (requireConfirmation) {
    if (req.body?.confirmation !== "MIGRATE") {
      res.status(400).json({ message: 'Requires confirmation = "MIGRATE"' });
      return null;
    }
    if (!req.body?.companyNameConfirm || req.body.companyNameConfirm.trim() !== sourceCompany.name) {
      res.status(400).json({ message: `Company name confirmation must match exactly: "${sourceCompany.name}"` });
      return null;
    }
  }

  return { sourceId, targetId, sourceCompany, targetCompany };
}

export async function requireCompletedAction(
  sourceId: number,
  targetId: number,
  action: string
): Promise<string | null> {
  for (const dependency of DEPENDENCIES[action] ?? []) {
    const result = await db.execute(sql`
      SELECT id
      FROM sp_migration_rehearsal_runs
      WHERE source_company_id = ${sourceId}
        AND target_company_id = ${targetId}
        AND action = ${dependency}
        AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (!firstRow(result)) {
      return `Run ${dependency === "gc_stock_opening" ? "Step 5 — Stock Opening by Location" : dependency} successfully first.`;
    }
  }
  return null;
}

export async function createRun(sourceId: number, targetId: number, action: string, notes: string): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO sp_migration_rehearsal_runs
      (source_company_id, target_company_id, action, status, rows_created, notes)
    VALUES (${sourceId}, ${targetId}, ${action}, 'running', 0, ${notes})
    RETURNING id
  `);
  return String(resultRows(result)[0].id);
}

export async function completeRun(runId: string, rowsCreated: number, notes?: string): Promise<void> {
  if (notes) {
    await db.execute(sql`
      UPDATE sp_migration_rehearsal_runs
      SET status = 'completed', rows_created = ${rowsCreated}, completed_at = now(),
          notes = COALESCE(notes, '') || ' | ' || ${notes}
      WHERE id = ${runId}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE sp_migration_rehearsal_runs
    SET status = 'completed', rows_created = ${rowsCreated}, completed_at = now()
    WHERE id = ${runId}
  `);
}

export async function trackRow(runId: string, tableName: string, rowId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO sp_migration_run_rows (run_id, table_name, row_id)
    VALUES (${runId}, ${tableName}, ${rowId})
  `);
}

export async function linkSourceRow(
  runId: string,
  sourceTable: string,
  sourceId: number,
  targetTable: string,
  targetId: number
): Promise<void> {
  await db.execute(sql`
    INSERT INTO sp_migration_source_links (run_id, source_table, source_id, target_table, target_id)
    SELECT ${runId}, ${sourceTable}, ${sourceId}, ${targetTable}, ${targetId}
    WHERE NOT EXISTS (
      SELECT 1
      FROM sp_migration_source_links
      WHERE run_id = ${runId}
        AND source_table = ${sourceTable}
        AND source_id = ${sourceId}
        AND target_table = ${targetTable}
        AND target_id = ${targetId}
    )
  `);
}

export async function loadStockItemMap(sourceId: number, targetId: number): Promise<Map<number, number>> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (l.source_id) l.source_id, l.target_id
    FROM sp_migration_source_links l
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    WHERE r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status = 'completed'
      AND l.source_table = 'stock_items'
      AND l.target_table = 'stock_items'
    ORDER BY l.source_id, r.created_at DESC
  `);
  return new Map(resultRows(result).map((row) => [pn(row.source_id), pn(row.target_id)]));
}

export async function loadSourceAccounts(sourceId: number): Promise<Map<number, Record<string, unknown>>> {
  const result = await db.execute(sql`
    SELECT id, code, name, account_type, sub_type
    FROM ledger_accounts
    WHERE company_id = ${sourceId} AND deleted_at IS NULL
  `);
  return new Map(resultRows(result).map((row) => [pn(row.id), row]));
}

export async function getSuspenseReview(sourceId: number, targetId: number): Promise<SuspenseReview> {
  const suspenseResult = await db.execute(sql`
    SELECT id FROM ledger_accounts
    WHERE company_id = ${targetId} AND sub_type = 'gc_mig_suspense' AND deleted_at IS NULL
    LIMIT 1
  `);
  const suspenseId = pn(firstRow(suspenseResult)?.id);
  if (!suspenseId) return { count: 0, totalDebit: 0, totalCredit: 0, items: [] };

  const linked = await db.execute(sql`
    SELECT DISTINCT ON (te.id)
      te.id AS target_entry_id,
      tv.id AS target_voucher_id,
      tv.voucher_number AS target_voucher_number,
      tv.voucher_date AS target_voucher_date,
      se.id AS source_entry_id,
      sv.id AS source_voucher_id,
      sv.voucher_number AS source_voucher_number,
      sa.id AS source_account_id,
      sa.code AS source_account_code,
      sa.name AS source_account_name,
      sa.account_type AS source_account_type,
      sa.sub_type AS source_account_sub_type,
      se.debit_amount,
      se.credit_amount,
      se.narration,
      'linked_source_entry' AS review_reason
    FROM sp_migration_source_links l
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    JOIN voucher_entries se ON se.id = l.source_id
    JOIN vouchers sv ON sv.id = se.voucher_id
    JOIN voucher_entries te ON te.id = l.target_id
    JOIN vouchers tv ON tv.id = te.voucher_id
    LEFT JOIN ledger_accounts sa ON sa.id = se.ledger_account_id
    WHERE r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
      AND l.source_table = 'voucher_entries'
      AND l.target_table = 'voucher_entries'
      AND te.ledger_account_id = ${suspenseId}
    ORDER BY te.id, r.created_at DESC
  `);

  const unlinked = await db.execute(sql`
    SELECT
      te.id AS target_entry_id,
      tv.id AS target_voucher_id,
      tv.voucher_number AS target_voucher_number,
      tv.voucher_date AS target_voucher_date,
      NULL::integer AS source_entry_id,
      NULL::integer AS source_voucher_id,
      NULL::text AS source_voucher_number,
      NULL::integer AS source_account_id,
      NULL::text AS source_account_code,
      NULL::text AS source_account_name,
      NULL::text AS source_account_type,
      NULL::text AS source_account_sub_type,
      te.debit_amount,
      te.credit_amount,
      te.narration,
      'legacy_entry_without_source_link' AS review_reason
    FROM voucher_entries te
    JOIN vouchers tv ON tv.id = te.voucher_id
    WHERE tv.company_id = ${targetId}
      AND tv.source_module = 'SP_MIGRATION_READONLY'
      AND te.ledger_account_id = ${suspenseId}
      AND NOT EXISTS (
        SELECT 1
        FROM sp_migration_source_links l
        JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
        WHERE r.source_company_id = ${sourceId}
          AND r.target_company_id = ${targetId}
          AND r.status <> 'rolled_back'
          AND l.target_table = 'voucher_entries'
          AND l.target_id = te.id
      )
  `);

  const items = [...resultRows<SuspenseReviewItem>(linked), ...resultRows<SuspenseReviewItem>(unlinked)];
  return {
    count: items.length,
    totalDebit: items.reduce((sum, item) => sum + pn(item.debit_amount), 0),
    totalCredit: items.reduce((sum, item) => sum + pn(item.credit_amount), 0),
    items,
  };
}

export async function findExistingContainerLink(
  sourceId: number,
  targetId: number,
  sourceContainerId: number
): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT l.target_id
    FROM sp_migration_source_links l
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    WHERE r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
      AND l.source_table = 'containers'
      AND l.source_id = ${sourceContainerId}
      AND l.target_table = 'sp_containers'
    ORDER BY r.created_at DESC
    LIMIT 1
  `);
  return firstRow(result) ? pn(resultRows(result)[0].target_id) : null;
}
