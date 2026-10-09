/**
 * What a stock item merge does to the merged item's history (wave 15, M9).
 *
 * A merge moves the duplicate's inventory rows (quantity and value) onto the
 * kept item. Its document lines used to stay on the duplicate, so reversing
 * one of them later (deleting a sale, unposting a transfer, restoring an
 * archive) moved stock and value back onto the merged item's own row, which
 * no longer held it, while the kept item kept it: a value-exact reversal
 * became two wrong rows. And once the merged item was purged, its lines were
 * deleted with it.
 *
 * Decision: the merge repoints every stock document line and the shortage
 * layers to the kept item, in the merge's transaction, so a reversal or
 * replay finds the stock where the merge put it. Amounts are untouched (only
 * the item reference moves); the merge log keeps which item each line was
 * entered under (snapshot and merged item id). The canonical stock movement
 * journal and the valuation overrides/baselines are evidence and stay on the
 * merged item; because they do, a merged item is never purged or permanently
 * deleted (services/inventory/stockItemHistory.ts).
 */
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../../db";
import { STOCK_ITEM_DOCUMENT_LINE_TABLES } from "../../../services/inventory/stockItemHistory";

/** Stock document lines repointed by a merge (item reference only). */
const DOCUMENT_LINE_TABLES = STOCK_ITEM_DOCUMENT_LINE_TABLES;

/** The line ids a merge repointed, per table (stored in the merge log's snapshotAfter). */
export type RepointedLines = Record<string, number[]>;

const REPOINTED_TABLES: readonly string[] = [...DOCUMENT_LINE_TABLES, "inventory_negative_layers"];

function idsOf(result: { rows?: unknown[] }): number[] {
  return ((result.rows ?? []) as Array<{ id: number | string }>).map((row) => Number(row.id));
}

/** Repoints the duplicate's document lines and shortage layers to the kept item. */
export async function repointMergedItemLinesTx(
  tx: DbTransaction,
  companyId: number,
  duplicateId: number,
  keptId: number
): Promise<RepointedLines> {
  const repointed: RepointedLines = {};
  for (const table of DOCUMENT_LINE_TABLES) {
    const ids = idsOf(
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET stock_item_id = ${keptId} WHERE stock_item_id = ${duplicateId} RETURNING id`
      )
    );
    if (ids.length > 0) repointed[table] = ids;
  }
  const layers = idsOf(
    await tx.execute(sql`
      UPDATE inventory_negative_layers SET stock_item_id = ${keptId}
       WHERE stock_item_id = ${duplicateId} AND company_id = ${companyId}
       RETURNING id
    `)
  );
  if (layers.length > 0) repointed.inventory_negative_layers = layers;
  return repointed;
}

/** An unmerge puts the lines the merge repointed back on the merged item. */
export async function restoreRepointedLinesTx(
  tx: DbTransaction,
  keptId: number,
  mergedId: number,
  repointed: unknown
): Promise<void> {
  if (!repointed || typeof repointed !== "object") return;
  for (const table of REPOINTED_TABLES) {
    const raw = (repointed as Record<string, unknown>)[table];
    if (!Array.isArray(raw)) continue;
    const ids = raw.map(Number).filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) continue;
    await tx.execute(sql`
      UPDATE ${sql.identifier(table)} SET stock_item_id = ${mergedId}
       WHERE stock_item_id = ${keptId} AND id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `
       )})
    `);
  }
}
