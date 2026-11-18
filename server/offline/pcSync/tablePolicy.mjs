// Full offline mode (Phase A): which rows of each table a PC may hold.
//
// resolvePcSyncPolicy(policy, schema) turns config/pc-sync-table-policy.json and
// the live schema (table name -> column names) into one rule per table, and
// lists every problem that must be fixed before the change feed is installed:
// an unclassified table, a parent link that does not resolve to a company, a
// stale rule, or a secret-looking column that is not redacted.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PC_SYNC_POLICY_PATH = fileURLToPath(new URL("../../../config/pc-sync-table-policy.json", import.meta.url));

/** Column names that must never reach a PC unless explicitly redacted or the table is excluded. */
export const SECRET_COLUMN_PATTERN =
  /(password|secret|api_token|api_key|token_hash|claim_token|credential_id|private_key|refresh_token|access_token)/i;

export function loadPcSyncPolicy(path = PC_SYNC_POLICY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function excludedReason(policy, table) {
  if (Object.prototype.hasOwnProperty.call(policy.excluded ?? {}, table)) return policy.excluded[table];
  for (const [prefix, reason] of Object.entries(policy.excludedPrefixes ?? {})) {
    if (table.startsWith(prefix)) return reason;
  }
  return null;
}

/**
 * @param {object} policy parsed config/pc-sync-table-policy.json
 * @param {Map<string, Set<string>>} schema table -> column names
 * @returns {{ rules: Map<string, object>, problems: string[] }}
 */
export function resolvePcSyncPolicy(policy, schema) {
  const rules = new Map();
  const problems = [];
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

  for (const [table, columns] of schema) {
    const reason = excludedReason(policy, table);
    const explicit = ["self", "members", "companyColumns", "parents", "shared"].filter((key) =>
      has(policy[key], table)
    );
    const redact = policy.redact?.[table] ?? [];

    if (reason) {
      if (explicit.length) problems.push(`${table} is excluded but also has a ${explicit.join(", ")} rule.`);
      rules.set(table, { mode: "excluded", reason });
      continue;
    }
    for (const column of redact) {
      if (!columns.has(column)) problems.push(`${table}.${column} is listed for redaction but does not exist.`);
    }
    for (const column of columns) {
      if (SECRET_COLUMN_PATTERN.test(column) && !redact.includes(column)) {
        problems.push(`${table}.${column} looks secret: redact it or exclude the table.`);
      }
    }

    if (has(policy.self, table)) {
      rules.set(table, { mode: "self", column: policy.self[table], redact });
    } else if (has(policy.members, table)) {
      rules.set(table, { mode: "members", ...policy.members[table], redact });
    } else if (columns.has("company_id")) {
      if (explicit.length) problems.push(`${table} has company_id; remove its ${explicit.join(", ")} rule.`);
      rules.set(table, { mode: "company", redact });
    } else if (has(policy.shared, table)) {
      rules.set(table, { mode: "shared", reason: policy.shared[table], redact });
    } else if (has(policy.companyColumns, table) || has(policy.parents, table)) {
      const companyColumns = policy.companyColumns?.[table] ?? [];
      const parents = policy.parents?.[table] ?? [];
      for (const column of companyColumns) {
        if (!columns.has(column)) problems.push(`${table}.${column} (company column) does not exist.`);
      }
      for (const parent of parents) {
        if (!columns.has(parent.column)) problems.push(`${table}.${parent.column} (parent link) does not exist.`);
      }
      if (!companyColumns.length && !parents.length) problems.push(`${table} has an empty rule.`);
      rules.set(table, { mode: "derived", companyColumns, parents, redact });
    } else {
      problems.push(`${table} has no company_id and no rule: add it to config/pc-sync-table-policy.json.`);
    }
  }

  // Rules for tables that no longer exist. An exclusion may name a table the
  // app creates at runtime (the session store), so it is never stale.
  for (const key of ["self", "members", "companyColumns", "parents", "shared", "redact"]) {
    for (const table of Object.keys(policy[key] ?? {})) {
      if (!schema.has(table)) problems.push(`${key}.${table} names a table that does not exist.`);
    }
  }

  // Every parent link must reach a company, without cycles.
  const reaches = new Map();
  const resolves = (table, trail) => {
    if (reaches.has(table)) return reaches.get(table);
    const rule = rules.get(table);
    if (!rule || rule.mode === "excluded" || rule.mode === "shared") return false;
    if (rule.mode !== "derived") return true;
    if (trail.includes(table)) {
      problems.push(`Parent links loop: ${[...trail, table].join(" -> ")}.`);
      return false;
    }
    const ok =
      rule.companyColumns.length > 0 ||
      rule.parents.some((parent) => {
        const parentColumns = schema.get(parent.table);
        if (!parentColumns) return false;
        if (!parentColumns.has("id")) {
          problems.push(`${table} -> ${parent.table}: the parent table has no id column.`);
          return false;
        }
        return resolves(parent.table, [...trail, table]);
      });
    reaches.set(table, ok);
    return ok;
  };
  for (const [table, rule] of rules) {
    if (rule.mode === "derived" && !resolves(table, [])) {
      problems.push(`${table} does not resolve to a company through its parent links.`);
    }
    if (rule.mode === "derived") {
      for (const parent of rule.parents) {
        const parentRule = rules.get(parent.table);
        if (parentRule?.mode === "excluded")
          problems.push(`${table} -> ${parent.table}: the parent table is excluded.`);
      }
    }
    if (rule.mode === "members") {
      const membership = schema.get(rule.table);
      if (!membership?.has(rule.column) || !membership.has("company_id")) {
        problems.push(`${table}: membership table ${rule.table}.${rule.column} with company_id does not exist.`);
      }
    }
  }

  return { rules, problems: [...new Set(problems)].sort() };
}

/** The live schema of the public tables, as resolvePcSyncPolicy expects it. */
export async function readPublicSchema(client) {
  const { rows } = await client.query(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN pg_tables t ON t.schemaname = c.table_schema AND t.tablename = c.table_name
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position`
  );
  const schema = new Map();
  for (const row of rows) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set());
    schema.get(row.table_name).add(row.column_name);
  }
  return schema;
}
