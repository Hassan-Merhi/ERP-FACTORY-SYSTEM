import type { PoolClient } from "pg";

import { pool } from "../db";
import { logger } from "../lib/logger";
import { getParentCompanyId, setParentCompanyId } from "./auth";

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

type ForeignKey = {
  constraintName: string;
  childTable: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
  deleteAction: string;
};

type PendingCondition = {
  table: string;
  condition: string;
  path: string[];
};

type NullableReference = {
  table: string;
  column: string;
};

type PgLikeError = Error & {
  code?: string;
  constraint?: string;
  detail?: string;
};

const RESTRICTIVE_DELETE_ACTIONS = new Set(["a", "r"]); // NO ACTION / RESTRICT

/**
 * Tables company deletion never touches. audit_log is append-only (wave 12,
 * owner decision 3): the company's audit rows, including the row recording
 * this deletion, outlive the company and keep its id as a retained reference
 * (audit_log.company_id has no foreign key).
 */
const RETAINED_TABLES: ReadonlySet<string> = new Set(["audit_log"]);

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

async function findCompanyHistory(
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
const MAX_DERIVED_CONDITIONS = 10_000;

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isSemanticCompanyReference(columnName: string): boolean {
  return columnName !== "company_id" && columnName.endsWith("_company_id");
}

function addCondition(
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

function tableWhere(conditions: Map<string, Map<string, string[]>>, table: string): string | null {
  const entries = conditions.get(table);
  if (!entries || entries.size === 0) return null;
  return [...entries.keys()].map((condition) => `(${condition})`).join(" OR ");
}

function foreignKeyMatchCondition(foreignKey: ForeignKey, parentWhere: string): string {
  const childColumns = foreignKey.childColumns.map(quoteIdent);
  const parentColumns = foreignKey.parentColumns.map(quoteIdent);
  const parentTable = quoteIdent(foreignKey.parentTable);

  if (childColumns.length === 1) {
    return `${childColumns[0]} IN (SELECT ${parentColumns[0]} FROM ${parentTable} WHERE (${parentWhere}))`;
  }

  return `(${childColumns.join(", ")}) IN (SELECT ${parentColumns.join(", ")} FROM ${parentTable} WHERE (${parentWhere}))`;
}

async function loadSchemaMetadata(client: PoolClient): Promise<{
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

function buildDeletionConditions(
  columnsByTable: Map<string, Map<string, { notNull: boolean }>>,
  foreignKeys: ForeignKey[]
): {
  conditions: Map<string, Map<string, string[]>>;
  nullableReferences: NullableReference[];
} {
  const conditions = new Map<string, Map<string, string[]>>();
  const nullableReferences = new Map<string, NullableReference>();
  const queue: PendingCondition[] = [];
  let derivedCount = 0;

  const rememberNullableReference = (table: string, column: string) => {
    nullableReferences.set(`${table}.${column}`, { table, column });
  };

  for (const [table, columns] of columnsByTable) {
    if (RETAINED_TABLES.has(table)) continue;
    if (table !== "companies" && columns.has("company_id")) {
      addCondition(conditions, queue, table, `${quoteIdent("company_id")} = $1`, [table]);
    }

    for (const [column, metadata] of columns) {
      if (!isSemanticCompanyReference(column)) continue;
      if (metadata.notNull) {
        if (table !== "companies") {
          addCondition(conditions, queue, table, `${quoteIdent(column)} = $1`, [table]);
        }
      } else {
        rememberNullableReference(table, column);
      }
    }
  }

  // Also honor direct company foreign keys whose column happens not to use the
  // conventional *_company_id naming pattern.
  for (const foreignKey of foreignKeys) {
    if (
      foreignKey.parentTable !== "companies" ||
      foreignKey.parentColumns.length !== 1 ||
      foreignKey.parentColumns[0] !== "id" ||
      foreignKey.childColumns.length !== 1
    ) {
      continue;
    }

    const childColumn = foreignKey.childColumns[0];
    if (childColumn === "company_id") continue;
    const metadata = columnsByTable.get(foreignKey.childTable)?.get(childColumn);
    if (!metadata) continue;

    if (metadata.notNull) {
      addCondition(conditions, queue, foreignKey.childTable, `${quoteIdent(childColumn)} = $1`, [
        foreignKey.childTable,
      ]);
    } else {
      rememberNullableReference(foreignKey.childTable, childColumn);
    }
  }

  const childrenByParent = new Map<string, ForeignKey[]>();
  for (const foreignKey of foreignKeys) {
    if (!RESTRICTIVE_DELETE_ACTIONS.has(foreignKey.deleteAction)) continue;
    const children = childrenByParent.get(foreignKey.parentTable) ?? [];
    children.push(foreignKey);
    childrenByParent.set(foreignKey.parentTable, children);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor];
    for (const foreignKey of childrenByParent.get(item.table) ?? []) {
      if (foreignKey.childTable === foreignKey.parentTable) continue;

      // A table with its own company_id is tenant-owned. Never widen its delete
      // predicate through an FK to another company's row. Nullable cross-company
      // references are detached later; non-null references fail closed.
      if (columnsByTable.get(foreignKey.childTable)?.has("company_id")) continue;
      if (item.path.includes(foreignKey.childTable)) continue;

      const condition = foreignKeyMatchCondition(foreignKey, item.condition);
      if (addCondition(conditions, queue, foreignKey.childTable, condition, [...item.path, foreignKey.childTable])) {
        derivedCount += 1;
        if (derivedCount > MAX_DERIVED_CONDITIONS) {
          throw new Error("Company deletion dependency graph is too complex to resolve safely.");
        }
      }
    }
  }

  return { conditions, nullableReferences: [...nullableReferences.values()] };
}

async function detachNullableCompanyReferences(
  client: PoolClient,
  columnsByTable: Map<string, Map<string, { notNull: boolean }>>,
  references: NullableReference[],
  companyId: number
): Promise<void> {
  for (const reference of references) {
    if (!columnsByTable.has(reference.table)) continue;
    await client.query(
      `UPDATE ${quoteIdent(reference.table)}
       SET ${quoteIdent(reference.column)} = NULL
       WHERE ${quoteIdent(reference.column)} = $1`,
      [companyId]
    );
  }
}

async function detachOrRejectExternalRestrictiveReferences(
  client: PoolClient,
  columnsByTable: Map<string, Map<string, { notNull: boolean }>>,
  foreignKeys: ForeignKey[],
  conditions: Map<string, Map<string, string[]>>,
  companyId: number
): Promise<void> {
  for (const foreignKey of foreignKeys) {
    if (!RESTRICTIVE_DELETE_ACTIONS.has(foreignKey.deleteAction)) continue;
    if (foreignKey.childTable === foreignKey.parentTable) continue;

    const parentWhere = tableWhere(conditions, foreignKey.parentTable);
    if (!parentWhere) continue;

    const referenceMatch = foreignKeyMatchCondition(foreignKey, parentWhere);
    const childWhere = tableWhere(conditions, foreignKey.childTable);
    const outsideDeleteScope = childWhere
      ? `(${referenceMatch}) AND NOT COALESCE((${childWhere}), FALSE)`
      : referenceMatch;
    const childColumns = columnsByTable.get(foreignKey.childTable);
    if (!childColumns) continue;

    const nullableChildColumns = foreignKey.childColumns.filter(
      (column) => childColumns.get(column)?.notNull === false
    );

    if (nullableChildColumns.length > 0) {
      const assignments = nullableChildColumns.map((column) => `${quoteIdent(column)} = NULL`).join(", ");
      await client.query(`UPDATE ${quoteIdent(foreignKey.childTable)} SET ${assignments} WHERE ${outsideDeleteScope}`, [
        companyId,
      ]);
      continue;
    }

    const blocker = await client.query(
      `SELECT 1 FROM ${quoteIdent(foreignKey.childTable)} WHERE ${outsideDeleteScope} LIMIT 1`,
      [companyId]
    );
    if (blocker.rowCount && blocker.rowCount > 0) {
      throw new Error(
        `Company deletion is blocked by ${foreignKey.childTable} (${foreignKey.constraintName}). ` +
          "That record belongs outside the company being deleted and cannot be removed automatically. No data was deleted."
      );
    }
  }
}

async function findTablesWithRows(
  client: PoolClient,
  conditions: Map<string, Map<string, string[]>>,
  companyId: number
): Promise<Set<string>> {
  const active = new Set<string>();
  for (const table of conditions.keys()) {
    const where = tableWhere(conditions, table);
    if (!where) continue;
    const result = await client.query(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${where} LIMIT 1`, [companyId]);
    if (result.rowCount && result.rowCount > 0) active.add(table);
  }
  return active;
}

function buildDeletionOrder(activeTables: Set<string>, foreignKeys: ForeignKey[]): string[] {
  const indegree = new Map<string, number>();
  const parentsByChild = new Map<string, Set<string>>();
  for (const table of activeTables) {
    indegree.set(table, 0);
    parentsByChild.set(table, new Set<string>());
  }

  for (const foreignKey of foreignKeys) {
    if (!RESTRICTIVE_DELETE_ACTIONS.has(foreignKey.deleteAction)) continue;
    if (foreignKey.childTable === foreignKey.parentTable) continue;
    if (!activeTables.has(foreignKey.childTable) || !activeTables.has(foreignKey.parentTable)) continue;

    const parents = parentsByChild.get(foreignKey.childTable)!;
    if (parents.has(foreignKey.parentTable)) continue;
    parents.add(foreignKey.parentTable);
    indegree.set(foreignKey.parentTable, (indegree.get(foreignKey.parentTable) ?? 0) + 1);
  }

  const queue = [...activeTables].filter((table) => (indegree.get(table) ?? 0) === 0).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const table = queue.shift()!;
    order.push(table);
    for (const parent of parentsByChild.get(table) ?? []) {
      const next = (indegree.get(parent) ?? 0) - 1;
      indegree.set(parent, next);
      if (next === 0) {
        queue.push(parent);
        queue.sort();
      }
    }
  }

  if (order.length !== activeTables.size) {
    const unresolved = [...activeTables].filter((table) => !order.includes(table)).sort();
    throw new Error(
      `Company deletion stopped because restrictive foreign keys form a cycle across: ${unresolved.join(", ")}. No data was deleted.`
    );
  }

  return order;
}

function mapDeletionError(error: unknown): Error {
  if (error instanceof CompanyHasHistoryError) return error;
  const pgError = error as PgLikeError;
  if (pgError?.code !== "23503") {
    return error instanceof Error ? error : new Error(String(error));
  }

  const constraint = pgError.constraint ? ` (${pgError.constraint})` : "";
  const detail = pgError.detail ? ` ${pgError.detail}` : "";
  return new Error(
    `Company deletion is blocked by a remaining cross-company reference${constraint}.${detail} ` +
      "No data was deleted. Remove or reassign that reference and try again."
  );
}

/**
 * Permanently removes one EMPTY company and its configuration rows.
 *
 * Wave 12 (owner decision 4): refused with CompanyHasHistoryError (409) while
 * the company has any voucher, stock, fiscal closure or non-zero opening or
 * balance (COMPANY_HISTORY_CHECKS); such a company is deactivated instead.
 * The deletion is audited in the same transaction, before anything is
 * removed, and audit_log is never deleted (RETAINED_TABLES).
 *
 * The deletion plan is derived from the live PostgreSQL FK graph so newly added
 * child tables do not silently make this endpoint stale. All work happens in a
 * single transaction and restrictive links outside the target company are
 * detached only when nullable; otherwise the operation fails closed.
 */
export async function deleteCompany(id: number, actor: CompanyDeletionActor = {}): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Company ID must be a positive integer.");
  }

  const legacyParentCompanyId = await getParentCompanyId();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");

    const company = await client.query<Record<string, unknown>>("SELECT * FROM companies WHERE id = $1 FOR UPDATE", [
      id,
    ]);
    if (company.rowCount !== 1) {
      throw new Error("Company not found.");
    }

    const { columnsByTable, foreignKeys } = await loadSchemaMetadata(client);

    const history = await findCompanyHistory(client, columnsByTable, id);
    if (history.length > 0) throw new CompanyHasHistoryError(history);

    // Audited first, in this transaction: if the audit row cannot be written
    // nothing is deleted. It keeps the company id and survives the delete.
    await client.query(
      `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
       VALUES ($1, $2, $3, 'delete', 'companies', $3, $4, $5::jsonb)`,
      [
        String(actor.userId ?? "system"),
        String(actor.username || "system"),
        id,
        String(company.rows[0].code ?? company.rows[0].name ?? id),
        JSON.stringify({ company: { old: company.rows[0] }, permanentDelete: { new: true } }),
      ]
    );
    const { conditions, nullableReferences } = buildDeletionConditions(columnsByTable, foreignKeys);

    // Child companies are configuration, not owned transaction rows. Preserve
    // them and detach the deleted parent instead of recursively deleting them.
    if (columnsByTable.get("companies")?.has("parent_company_id")) {
      await client.query("UPDATE companies SET parent_company_id = NULL WHERE parent_company_id = $1", [id]);
    }

    await detachNullableCompanyReferences(client, columnsByTable, nullableReferences, id);
    await detachOrRejectExternalRestrictiveReferences(client, columnsByTable, foreignKeys, conditions, id);

    const activeTables = await findTablesWithRows(client, conditions, id);
    const deletionOrder = buildDeletionOrder(activeTables, foreignKeys);

    for (const table of deletionOrder) {
      const where = tableWhere(conditions, table);
      if (!where) continue;
      await client.query(`DELETE FROM ${quoteIdent(table)} WHERE ${where}`, [id]);
    }

    if (legacyParentCompanyId === id && columnsByTable.get("system_settings")?.has("key")) {
      await client.query(
        "UPDATE system_settings SET value = NULL, updated_at = NOW() WHERE key = 'parentCompanyId' AND value = $1",
        [String(id)]
      );
    }

    const deletedCompany = await client.query("DELETE FROM companies WHERE id = $1", [id]);
    if (deletedCompany.rowCount !== 1) {
      throw new Error("Company could not be deleted.");
    }

    await client.query("COMMIT");
  } catch (error: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError: unknown) {
      logger.error("Company deletion rollback failed", { companyId: id, error: rollbackError });
    }
    throw mapDeletionError(error);
  } finally {
    client.release();
  }

  if (legacyParentCompanyId === id) {
    // The transaction above already cleared the persisted setting. Calling the
    // existing setter also invalidates its five-minute in-memory cache.
    try {
      await setParentCompanyId(null);
    } catch (error: unknown) {
      logger.warn("Company deleted but legacy parent-company cache refresh failed", { companyId: id, error });
    }
  }
}
