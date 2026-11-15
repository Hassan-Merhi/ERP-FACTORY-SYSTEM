// Extracted from ./company-deletion.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";

type TableColumnRow = {
  table_name: string;
  column_name: string;
  not_null: boolean;
};

type ForeignKeyRow = {
  constraint_name: string;
  child_table: string;
  parent_table: string;
  child_columns: string[];
  parent_columns: string[];
  delete_action: string;
};

export type ForeignKey = {
  constraintName: string;
  childTable: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
  deleteAction: string;
};

export type PendingCondition = {
  table: string;
  condition: string;
  path: string[];
};

export type NullableReference = {
  table: string;
  column: string;
};

export type PgLikeError = Error & {
  code?: string;
  constraint?: string;
  detail?: string;
};

export const RESTRICTIVE_DELETE_ACTIONS = new Set(["a", "r"]);

// NO ACTION / RESTRICT

/**
 * Tables company deletion never touches. audit_log is append-only (wave 12,
 * owner decision 3): the company's audit rows, including the row recording
 * this deletion, outlive the company and keep its id as a retained reference
 * (audit_log.company_id has no foreign key). factory_row_history is append-only
 * for the same reason (server/services/audit/factoryRowHistory.ts) and records
 * the deleted rows themselves.
 */
export const RETAINED_TABLES: ReadonlySet<string> = new Set(["audit_log", "factory_row_history"]);

/**
 * Wave 12 (owner decision 4): a company with accounting history can never be
 * erased. Each check names what it found (a machine code returned as
 * `blockers` in the 409 body); any hit refuses the delete with 409
 * and the company should be deactivated instead. Tables a database may not
 * have yet are skipped.
 */
const COMPANY_HISTORY_CHECKS: readonly { table: string; blocker: string; where: string }[] = [
  { table: "vouchers", blocker: "vouchers", where: "company_id = $1" },
  { table: "fiscal_period_closures", blocker: "fiscal_period_closures", where: "company_id = $1" },
  {
    table: "inventory",
    blocker: "inventory_stock",
    where: "company_id = $1 AND (COALESCE(quantity, 0) <> 0 OR COALESCE(total_value, 0) <> 0)",
  },
  { table: "factory_raw_stock", blocker: "factory_raw_stock", where: "company_id = $1" },
  { table: "factory_bales", blocker: "factory_bales", where: "company_id = $1" },
  {
    table: "ledger_accounts",
    blocker: "ledger_account_openings",
    where: "company_id = $1 AND COALESCE(opening_balance, 0) <> 0",
  },
  {
    table: "bank_accounts",
    blocker: "bank_account_openings",
    where: "company_id = $1 AND COALESCE(opening_balance, 0) <> 0",
  },
  {
    table: "customers",
    blocker: "customer_openings",
    where: "company_id = $1 AND COALESCE(opening_balance, 0) <> 0",
  },
  { table: "customer_balances", blocker: "customer_balances", where: "company_id = $1 AND COALESCE(balance, 0) <> 0" },
  {
    table: "suppliers",
    blocker: "supplier_openings",
    where: "company_id = $1 AND COALESCE(opening_balance, 0) <> 0",
  },
  {
    table: "factory_suppliers",
    blocker: "factory_supplier_openings",
    where: "company_id = $1 AND COALESCE(opening_balance, 0) <> 0",
  },
  {
    table: "employees",
    blocker: "employee_balances",
    where: "company_id = $1 AND (COALESCE(opening_balance, 0) <> 0 OR COALESCE(current_balance, 0) <> 0)",
  },
  {
    table: "fixed_assets",
    blocker: "fixed_asset_openings",
    where: "company_id = $1 AND COALESCE(opening_balance, 0) <> 0",
  },
];

export const COMPANY_HAS_HISTORY_MESSAGE =
  "This company has accounting history (vouchers, stock, fiscal closures or balances) and cannot be deleted. Deactivate it instead.";

export class CompanyHasHistoryError extends Error {
  readonly status = 409;
  readonly code = "COMPANY_HAS_HISTORY";
  constructor(readonly blockers: string[]) {
    super(COMPANY_HAS_HISTORY_MESSAGE);
    this.name = "CompanyHasHistoryError";
  }
}

export type CompanyDeletionActor = { userId?: string | null; username?: string | null };

export async function findCompanyHistory(
  client: PoolClient,
  columnsByTable: Map<string, Map<string, { notNull: boolean }>>,
  companyId: number
): Promise<string[]> {
  const found: string[] = [];
  for (const check of COMPANY_HISTORY_CHECKS) {
    if (!columnsByTable.get(check.table)?.has("company_id")) continue;
    const result = await client.query(`SELECT 1 FROM ${quoteIdent(check.table)} WHERE ${check.where} LIMIT 1`, [
      companyId,
    ]);
    if (result.rowCount && result.rowCount > 0) found.push(check.blocker);
  }
  return found;
}

export const MAX_DERIVED_CONDITIONS = 10_000;

export function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function isSemanticCompanyReference(columnName: string): boolean {
  return columnName !== "company_id" && columnName.endsWith("_company_id");
}

export function addCondition(
  conditions: Map<string, Map<string, string[]>>,
  queue: PendingCondition[],
  table: string,
  condition: string,
  path: string[]
): boolean {
  let tableConditions = conditions.get(table);
  if (!tableConditions) {
    tableConditions = new Map<string, string[]>();
    conditions.set(table, tableConditions);
  }
  if (tableConditions.has(condition)) return false;
  tableConditions.set(condition, path);
  queue.push({ table, condition, path });
  return true;
}

export function tableWhere(conditions: Map<string, Map<string, string[]>>, table: string): string | null {
  const entries = conditions.get(table);
  if (!entries || entries.size === 0) return null;
  return [...entries.keys()].map((condition) => `(${condition})`).join(" OR ");
}

export function foreignKeyMatchCondition(foreignKey: ForeignKey, parentWhere: string): string {
  const childColumns = foreignKey.childColumns.map(quoteIdent);
  const parentColumns = foreignKey.parentColumns.map(quoteIdent);
  const parentTable = quoteIdent(foreignKey.parentTable);

  if (childColumns.length === 1) {
    return `${childColumns[0]} IN (SELECT ${parentColumns[0]} FROM ${parentTable} WHERE (${parentWhere}))`;
  }

  return `(${childColumns.join(", ")}) IN (SELECT ${parentColumns.join(", ")} FROM ${parentTable} WHERE (${parentWhere}))`;
}

export async function loadSchemaMetadata(client: PoolClient): Promise<{
  columnsByTable: Map<string, Map<string, { notNull: boolean }>>;
  foreignKeys: ForeignKey[];
}> {
  const columnsResult = await client.query<TableColumnRow>(`
    SELECT
      relation.relname AS table_name,
      attribute.attname AS column_name,
      attribute.attnotnull AS not_null
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND NOT relation.relispartition
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `);

  const columnsByTable = new Map<string, Map<string, { notNull: boolean }>>();
  for (const row of columnsResult.rows) {
    let tableColumns = columnsByTable.get(row.table_name);
    if (!tableColumns) {
      tableColumns = new Map<string, { notNull: boolean }>();
      columnsByTable.set(row.table_name, tableColumns);
    }
    tableColumns.set(row.column_name, { notNull: row.not_null === true });
  }

  const foreignKeyResult = await client.query<ForeignKeyRow>(`
    SELECT
      constraint_row.conname AS constraint_name,
      child_relation.relname AS child_table,
      parent_relation.relname AS parent_table,
      array_agg(child_attribute.attname ORDER BY child_key.ordinality)::text[] AS child_columns,
      array_agg(parent_attribute.attname ORDER BY child_key.ordinality)::text[] AS parent_columns,
      constraint_row.confdeltype::text AS delete_action
    FROM pg_constraint constraint_row
    JOIN pg_class child_relation ON child_relation.oid = constraint_row.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child_relation.relnamespace
    JOIN pg_class parent_relation ON parent_relation.oid = constraint_row.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent_relation.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, ordinality) ON TRUE
    JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
      ON parent_key.ordinality = child_key.ordinality
    JOIN pg_attribute child_attribute
      ON child_attribute.attrelid = child_relation.oid AND child_attribute.attnum = child_key.attnum
    JOIN pg_attribute parent_attribute
      ON parent_attribute.attrelid = parent_relation.oid AND parent_attribute.attnum = parent_key.attnum
    WHERE constraint_row.contype = 'f'
      AND child_namespace.nspname = 'public'
      AND parent_namespace.nspname = 'public'
      AND NOT child_relation.relispartition
      AND NOT parent_relation.relispartition
    GROUP BY
      constraint_row.oid,
      constraint_row.conname,
      child_relation.relname,
      parent_relation.relname,
      constraint_row.confdeltype
  `);

  const foreignKeys = foreignKeyResult.rows.map((row) => ({
    constraintName: row.constraint_name,
    childTable: row.child_table,
    parentTable: row.parent_table,
    childColumns: row.child_columns,
    parentColumns: row.parent_columns,
    deleteAction: row.delete_action,
  }));

  return { columnsByTable, foreignKeys };
}
