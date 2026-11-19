// Extracted from ./companyImportRoutes.ts: shared helpers.
import type { ImportRow } from "./companyImportRoutes";

/** Export payloads are untyped JSON, so a row object cannot be checked against the target
 *  table's insert type — the payload format itself is validated before import starts. */
export const asDynamicInsert = (rec: ImportRow): never => rec as never;

/** `inserted.id` is `unknown` when the table is only known as a dynamic `PgTable`. */
export const insertedIdOf = (inserted: { id: unknown } | undefined): number | null =>
  inserted && typeof inserted.id === "number" ? inserted.id : null;
