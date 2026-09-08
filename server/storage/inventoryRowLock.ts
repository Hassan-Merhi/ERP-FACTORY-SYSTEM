/**
 * Read one inventory row under a row-level lock.
 *
 * Stock transfers, adjustments and container offloads all read-modify-write the
 * same inventory row, so they must serialize on it. `SELECT ... FOR UPDATE` is
 * not expressible through the query builder, so the read is raw SQL — but the
 * transaction handle supports a typed `execute`, and every call site was
 * casting it to `any` and then indexing an untyped object.
 *
 * Naming the row shape once here means each caller gets the same checked
 * result, and the numeric columns are declared as the decimal strings the
 * driver really returns rather than being assumed to be numbers.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction, RawQueryRow } from "../db";

/**
 * The locked row, keyed by database column name because this is a raw query.
 *
 * All four columns are NOT NULL in the schema, and the three numeric ones are
 * `decimal`, which node-postgres returns as a string to preserve precision.
 */
export interface LockedInventoryRow {
  id: number;
  quantity: string;
  average_rate: string;
  total_value: string;
}

export async function lockInventoryRow(
  tx: DbTransaction,
  locationId: number,
  stockItemId: number
): Promise<LockedInventoryRow | undefined> {
  const result = await tx.execute<RawQueryRow<LockedInventoryRow>>(
    sql`SELECT id, quantity, average_rate, total_value
        FROM inventory
        WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
        FOR UPDATE`
  );
  return result.rows[0];
}
