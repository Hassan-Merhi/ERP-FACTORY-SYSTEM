import { sql } from "drizzle-orm";
import { accountTypeNamesOf } from "../../../services/accounting/accountClassification";

export { db } from "../../../db";
export * as schema from "@shared/schema";
export { eq, and, desc, sql, isNull, asc, ilike, or, inArray } from "drizzle-orm";

/**
 * A list for `LOWER(TRIM(la.account_type)) NOT IN (...)`: the ledger types
 * that are never a customer or supplier balance — Cash, Bank and every
 * income, expense and equity type the shared classifier knows (Indirect
 * Income, Revenue, Profit, Government Taxes, mis-cased types included) —
 * plus `extraTypes`.
 */
export function nonPartyAccountTypesSql(extraTypes: readonly string[] = []) {
  const names = new Set([
    "cash",
    "bank",
    ...accountTypeNamesOf("income", "expense", "equity"),
    ...extraTypes.map((type) => type.trim().toLowerCase()),
  ]);
  return sql.join(
    [...names].map((name) => sql`${name}`),
    sql`, `
  );
}

/** A list for `LOWER(TRIM(la.account_type)) IN (...)`: every income and expense type. */
export function profitAndLossAccountTypesSql() {
  return sql.join(
    accountTypeNamesOf("income", "expense").map((name) => sql`${name}`),
    sql`, `
  );
}

/**
 * A list for `LOWER(TRIM(la.account_type)) IN (...)`: every type of the given
 * classifier classes (wave 13: no exact-string type filters in the shards).
 */
export function accountTypesOfClassSql(...classes: Parameters<typeof accountTypeNamesOf>) {
  return sql.join(
    accountTypeNamesOf(...classes).map((name) => sql`${name}`),
    sql`, `
  );
}
