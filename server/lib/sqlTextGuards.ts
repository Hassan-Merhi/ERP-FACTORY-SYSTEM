/**
 * Runtime guards for the few places that still assemble SQL *text* from
 * code-owned pieces (aliases, column references, `$n` placeholders). They turn
 * an "every caller passes a literal" convention into an enforced contract, so a
 * future caller cannot route request data into SQL syntax through these
 * helpers. Values never go through here: they are bound parameters.
 * See docs/security/raw-sql-audit.md.
 */

const SQL_ALIAS = /^(?:[a-z_][a-z0-9_]*|"[a-z_][a-z0-9_]*")$/;
const SQL_COLUMN_REF = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;
const BIND_PLACEHOLDER = /^\$[1-9][0-9]{0,3}$/;

/** A table alias / table name: lower-case identifier, optionally double-quoted. */
export function assertSqlAlias(alias: string, label = "sql_alias"): string {
  if (typeof alias !== "string" || !SQL_ALIAS.test(alias)) throw new Error(`${label}_unsafe`);
  return alias;
}

/** `column` or `alias.column`, lower-case identifiers only. */
export function assertSqlColumnRef(ref: string, label = "sql_column"): string {
  if (typeof ref !== "string" || !SQL_COLUMN_REF.test(ref)) throw new Error(`${label}_unsafe`);
  return ref;
}

/** A positional bind placeholder such as `$1`. */
export function assertBindPlaceholder(placeholder: string, label = "sql_placeholder"): string {
  if (typeof placeholder !== "string" || !BIND_PLACEHOLDER.test(placeholder)) throw new Error(`${label}_unsafe`);
  return placeholder;
}

/** Own-property lookup in a code-owned map; prototype keys ("constructor", "__proto__") never match. */
export function ownKey<T extends object>(map: T, key: unknown): key is keyof T {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key);
}
