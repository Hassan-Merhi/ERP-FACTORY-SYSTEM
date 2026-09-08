/**
 * The shape of a tenant-scoped table.
 *
 * Several company-isolation checks need to answer "does row N of table T belong
 * to company C?". Before this type they took the table and its `id`/`companyId`
 * columns as three separate `any` parameters, which erased the schema and let a
 * caller pair one table with another table's columns — a silent tenant-isolation
 * hole rather than a compile error.
 *
 * Constraining the table to one that carries both columns lets a helper read
 * them off the table itself, so the pairing cannot be wrong.
 *
 * Column data types stay unconstrained on purpose: Drizzle's column config is
 * driver-specific, and the values that come back still have to be validated
 * before use rather than trusted from the type.
 */
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type CompanyScopedTable = PgTable & {
  id: PgColumn;
  companyId: PgColumn;
};
