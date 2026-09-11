import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows, firstRow } from "../../lib/queryResult";

export const pn = (value: unknown): number => {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const money = (value: unknown): string => pn(value).toFixed(4);

let phase2SchemaPromise: Promise<void> | null = null;

export function ensurePhase2Schema(): Promise<void> {
  if (!phase2SchemaPromise) {
    phase2SchemaPromise = (async () => {
      await db.execute(
        sql.raw(`
        CREATE TABLE IF NOT EXISTS sp_migration_container_charges (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES sp_migration_rehearsal_runs(id) ON DELETE CASCADE,
          source_company_id INTEGER NOT NULL,
          target_company_id INTEGER NOT NULL,
          source_container_id INTEGER NOT NULL,
          sp_container_id INTEGER NOT NULL REFERENCES sp_containers(id) ON DELETE CASCADE,
          source_key VARCHAR(180) NOT NULL,
          source_kind VARCHAR(40) NOT NULL,
          source_row_id INTEGER,
          charge_type VARCHAR(120) NOT NULL,
          amount_usd NUMERIC(20,4) NOT NULL DEFAULT 0,
          source_ledger_account_id INTEGER,
          target_ledger_account_id INTEGER,
          mapping_method VARCHAR(40) NOT NULL,
          review_status VARCHAR(20) NOT NULL DEFAULT 'review',
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (target_company_id, source_container_id, source_key)
        )
      `)
      );
      await db.execute(
        sql.raw(`
        CREATE INDEX IF NOT EXISTS sp_mig_container_charges_pair_idx
        ON sp_migration_container_charges(source_company_id, target_company_id)
      `)
      );
      await db.execute(
        sql.raw(`
        CREATE INDEX IF NOT EXISTS sp_mig_container_charges_sp_container_idx
        ON sp_migration_container_charges(sp_container_id)
      `)
      );
    })().catch((error) => {
      phase2SchemaPromise = null;
      throw error;
    });
  }
  return phase2SchemaPromise;
}

/** A company row as the migration pair validator reads it. */
export type MigrationCompanyRow = {
  id: number;
  code: string;
  name: string;
  company_type: string | null;
};

/** A ledger account row loaded for target-account mapping. */
export type MigrationLedgerAccountRow = {
  id: number;
  code: string;
  name: string;
  account_type: string;
  sub_type: string | null;
};

async function getCompany(companyId: number): Promise<MigrationCompanyRow | null> {
  const result = await db.execute(sql`
    SELECT id, code, name, company_type
    FROM companies
    WHERE id = ${companyId}
    LIMIT 1
  `);
  return firstRow<MigrationCompanyRow>(result) ?? null;
}

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

const DEPENDENCIES: Record<string, string[]> = {
  gc_sales_readonly: ["gc_stock_opening"],
  gc_containers: ["gc_stock_opening"],
};

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

export async function failRun(runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .execute(
      sql`
    UPDATE sp_migration_rehearsal_runs
    SET status = 'failed', error_message = ${message}, completed_at = now()
    WHERE id = ${runId}
  `
    )
    .catch(() => undefined);
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

export async function loadTargetAccounts(targetId: number): Promise<{
  rows: Record<string, unknown>[];
  bySubType: Map<string, Record<string, unknown>>;
  byCode: Map<string, Record<string, unknown>>;
  byType: Map<string, Record<string, unknown>[]>;
}> {
  const result = await db.execute(sql`
    SELECT id, code, name, account_type, sub_type
    FROM ledger_accounts
    WHERE company_id = ${targetId} AND deleted_at IS NULL
  `);
  const rows = resultRows(result);
  const bySubType = new Map();
  const byCode = new Map();
  const byType = new Map();
  for (const row of rows) {
    if (row.sub_type) bySubType.set(String(row.sub_type), row);
    if (row.code) byCode.set(String(row.code).trim().toLowerCase(), row);
    if (row.account_type) {
      const key = String(row.account_type);
      byType.set(key, [...(byType.get(key) ?? []), row]);
    }
  }
  return { rows, bySubType, byCode, byType };
}

export async function loadSourceAccounts(sourceId: number): Promise<Map<number, Record<string, unknown>>> {
  const result = await db.execute(sql`
    SELECT id, code, name, account_type, sub_type
    FROM ledger_accounts
    WHERE company_id = ${sourceId} AND deleted_at IS NULL
  `);
  return new Map(resultRows(result).map((row) => [pn(row.id), row]));
}

export function mapTargetAccount(
  sourceAccount: Record<string, unknown> | null,
  targetAccounts: Awaited<ReturnType<typeof loadTargetAccounts>>
): {
  targetAccountId: number | null;
  method: string;
  reviewStatus: "mapped" | "review" | "unmapped";
} {
  if (sourceAccount?.sub_type && targetAccounts.bySubType.has(String(sourceAccount.sub_type))) {
    return {
      targetAccountId: pn(targetAccounts.bySubType.get(String(sourceAccount.sub_type))!.id),
      method: "exact_sub_type",
      reviewStatus: "mapped",
    };
  }
  if (sourceAccount?.code && targetAccounts.byCode.has(String(sourceAccount.code).trim().toLowerCase())) {
    return {
      targetAccountId: pn(targetAccounts.byCode.get(String(sourceAccount.code).trim().toLowerCase())!.id),
      method: "exact_code",
      reviewStatus: "mapped",
    };
  }
  if (sourceAccount?.account_type) {
    const sameType = targetAccounts.byType.get(String(sourceAccount.account_type)) ?? [];
    if (sameType.length === 1) {
      return { targetAccountId: pn(sameType[0].id), method: "unique_account_type", reviewStatus: "review" };
    }
  }
  const shared = targetAccounts.bySubType.get("sp_shared_charges");
  if (shared) {
    return { targetAccountId: pn(shared.id), method: "default_shared_charges", reviewStatus: "review" };
  }
  return { targetAccountId: null, method: "unmapped", reviewStatus: "unmapped" };
}

export async function resolveSupplier(
  sourceSupplierId: number | null,
  sourceName: string | null
): Promise<{
  supplierId: number | null;
  supplierName: string;
  method: string;
  warning?: string;
}> {
  if (sourceSupplierId) {
    const byId = await db.execute(sql`SELECT id, legal_name FROM suppliers WHERE id = ${sourceSupplierId} LIMIT 1`);
    const row = firstRow<{ id: number; legal_name: string | null }>(byId);
    if (row) {
      return {
        supplierId: pn(row.id),
        supplierName: row.legal_name ?? sourceName ?? `Supplier #${sourceSupplierId}`,
        method: "source_id",
      };
    }
  }

  const fallbackName = String(sourceName ?? "").trim();
  if (fallbackName) {
    const normalized = await db.execute(sql`
      SELECT id, legal_name
      FROM suppliers
      WHERE regexp_replace(lower(COALESCE(legal_name, '')), '[^a-z0-9]+', '', 'g') =
            regexp_replace(lower(${fallbackName}), '[^a-z0-9]+', '', 'g')
      ORDER BY id ASC
      LIMIT 2
    `);
    const rows = resultRows<{ id: number; legal_name: string | null }>(normalized);
    if (rows.length === 1) {
      return {
        supplierId: pn(rows[0].id),
        supplierName: rows[0].legal_name ?? fallbackName,
        method: "normalized_name",
      };
    }
    if (rows.length > 1) {
      return {
        supplierId: null,
        supplierName: fallbackName,
        method: "ambiguous_name",
        warning: `Supplier "${fallbackName}" matched more than one supplier record.`,
      };
    }
  }

  return {
    supplierId: null,
    supplierName: fallbackName || "Unknown Supplier (GC migration)",
    method: "unmatched",
    warning: `Supplier "${fallbackName || sourceSupplierId || "unknown"}" could not be matched automatically.`,
  };
}

/** One suspense-account entry flagged for manual review. */
export type SuspenseReviewItem = Record<string, unknown> & {
  debit_amount: string | null;
  credit_amount: string | null;
};

/** The suspense review summary returned to the migration console. */
export type SuspenseReview = {
  count: number;
  totalDebit: number;
  totalCredit: number;
  items: SuspenseReviewItem[];
};

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
