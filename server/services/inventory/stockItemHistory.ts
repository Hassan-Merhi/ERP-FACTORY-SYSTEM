/**
 * A stock item's history (wave 15, M9).
 *
 * A stock item named on any stock document line, stock movement, shortage
 * layer or valuation record keeps its row: those rows are what a value-exact
 * reversal, the as-of replay and the audit trail read. The permanent delete
 * (Deleted Items) refuses such an item and the 30-day purge keeps it; both
 * used to delete the item's document lines with it.
 */
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../db";

/** Stock document lines that name a stock item (a merge repoints these). */
export const STOCK_ITEM_DOCUMENT_LINE_TABLES = [
  "sales_items",
  "stock_adjustment_items",
  "stock_transfer_items",
  "stock_transfer_revision_items",
  "credit_note_items",
  "container_offload_items",
  "waste_dispatch_items",
  "stock_group_location_archive_items",
] as const;

/** Every table whose rows are a stock item's history. */
export const STOCK_ITEM_HISTORY_TABLES: readonly string[] = [
  ...STOCK_ITEM_DOCUMENT_LINE_TABLES,
  "po_line_items",
  "canonical_stock_movements",
  "inventory_negative_layers",
  "inventory_valuation_overrides",
  "phase3_inventory_valuation_baselines",
];

export const STOCK_ITEM_HAS_HISTORY_MESSAGE =
  "This stock item is named on stock documents, stock movements or valuation records, so it cannot be permanently deleted. Keep it in Deleted Items.";

/** The history tables this database has (some are created at startup). */
export async function presentStockItemHistoryTables(executor: DatabaseOrTransaction): Promise<string[]> {
  const present = await executor.execute(sql`
    SELECT name FROM unnest(${`{${STOCK_ITEM_HISTORY_TABLES.join(",")}}`}::text[]) AS name
     WHERE to_regclass(name) IS NOT NULL
  `);
  return (present.rows as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => STOCK_ITEM_HISTORY_TABLES.includes(name));
}

/**
 * SQL text (for a raw `pg` query) that finds history of the stock item whose
 * id is the column `itemColumn` (e.g. `si.id`) in the given tables; a row of
 * stock (any quantity or value) counts as history too. Table names come only
 * from STOCK_ITEM_HISTORY_TABLES.
 */
export function stockItemHistorySqlText(tables: readonly string[], itemColumn: string): string {
  const checks = tables
    .filter((table) => STOCK_ITEM_HISTORY_TABLES.includes(table))
    .map((table) => `SELECT 1 FROM ${table} h WHERE h.stock_item_id = ${itemColumn}`);
  // The item's own company: a stock_items row and its inventory rows share it.
  checks.push(
    `SELECT 1 FROM inventory inv JOIN stock_items own ON own.id = inv.stock_item_id AND own.company_id = inv.company_id WHERE inv.stock_item_id = ${itemColumn}` +
      " AND (ABS(COALESCE(inv.quantity, 0)) > 0 OR ABS(COALESCE(inv.total_value, 0)) > 0)"
  );
  return checks.join(" UNION ALL ");
}

/** True when the stock item has any history (see stockItemHistorySqlText). */
export async function stockItemHasHistory(
  executor: DatabaseOrTransaction,
  companyId: number,
  stockItemId: number
): Promise<boolean> {
  const tables = await presentStockItemHistoryTables(executor);
  const checks = tables.map(
    (table) => sql`SELECT 1 FROM ${sql.identifier(table)} h WHERE h.stock_item_id = ${stockItemId}`
  );
  checks.push(sql`
    SELECT 1 FROM inventory inv WHERE inv.company_id = ${companyId} AND inv.stock_item_id = ${stockItemId}
       AND (ABS(COALESCE(inv.quantity, 0)) > 0 OR ABS(COALESCE(inv.total_value, 0)) > 0)
  `);
  const result = await executor.execute(sql`SELECT EXISTS (${sql.join(checks, sql` UNION ALL `)}) AS found`);
  return (result.rows[0] as { found?: boolean } | undefined)?.found === true;
}
