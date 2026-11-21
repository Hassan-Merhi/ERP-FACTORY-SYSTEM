// Extracted from ./spMigrationPhase2Common.ts
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows, firstRow } from "../../lib/queryResult";
import { parseMoneyInput } from "../../lib/money";

export const pn = (value: unknown): number => {
  const parsed = parseMoneyInput(String(value ?? "0"))?.toNumber() ?? NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A company row as the migration pair validator reads it. */
export type MigrationCompanyRow = {
  id: number;
  code: string;
  name: string;
  company_type: string | null;
};

export async function getCompany(companyId: number): Promise<MigrationCompanyRow | null> {
  const result = await db.execute(sql`
    SELECT id, code, name, company_type
    FROM companies
    WHERE id = ${companyId}
    LIMIT 1
  `);
  return firstRow<MigrationCompanyRow>(result) ?? null;
}

export const DEPENDENCIES: Record<string, string[]> = {
  gc_sales_readonly: ["gc_stock_opening"],
  gc_containers: ["gc_stock_opening"],
};

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
