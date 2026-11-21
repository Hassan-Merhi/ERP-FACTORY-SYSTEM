import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  linkSourceRow,
  loadSourceAccounts,
  loadStockItemMap,
  loadTargetAccounts,
  pn,
  trackRow,
} from "./spMigrationPhase2Common";
import { resultRows, firstRow } from "../../lib/queryResult";
import { numericEqual, buildSalesAccountMap, existingSourceLinks } from "./spMigrationPhase4ReconcileHelpers";
export { reconcileMigrationOwnedContainers } from "./spMigrationPhase4ReconcileHelpers";

export async function reconcileHistoricalSalesCopy(params: { runId: string; sourceId: number; targetId: number }) {
  const { runId, sourceId, targetId } = params;
  const stockMap = await loadStockItemMap(sourceId, targetId);
  const sourceAccounts = await loadSourceAccounts(sourceId);
  const targetAccounts = await loadTargetAccounts(targetId);
  const accountMap = buildSalesAccountMap(sourceAccounts, targetAccounts);
  const voucherLinks = await existingSourceLinks(sourceId, targetId, "vouchers", "vouchers");
  const itemLinks = await existingSourceLinks(sourceId, targetId, "sales_items", "sales_items");
  const entryLinks = await existingSourceLinks(sourceId, targetId, "voucher_entries", "voucher_entries");

  const sourceVouchersResult = await db.execute(sql`
    SELECT id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, exchange_rate
    FROM vouchers
    WHERE company_id = ${sourceId}
      AND voucher_type IN ('Sales', 'Sale')
      AND deleted_at IS NULL
    ORDER BY voucher_date ASC, id ASC
  `);

  let vouchersUpdated = 0;
  let itemsInserted = 0;
  let itemsUpdated = 0;
  let itemLinksAdded = 0;
  let entriesInserted = 0;
  let entriesUpdated = 0;
  let entryLinksAdded = 0;
  const blockers: string[] = [];

  for (const sourceVoucher of resultRows(sourceVouchersResult)) {
    let targetVoucherId = voucherLinks.get(pn(sourceVoucher.id)) ?? null;
    if (!targetVoucherId) {
      const deterministic = `MIG-GC-${sourceVoucher.voucher_number}`.slice(0, 100);
      const targetResult = await db.execute(sql`
        SELECT id FROM vouchers
        WHERE company_id = ${targetId} AND voucher_number = ${deterministic}
        LIMIT 1
      `);
      targetVoucherId = pn(firstRow(targetResult)?.id) || null;
      if (targetVoucherId) {
        await linkSourceRow(runId, "vouchers", pn(sourceVoucher.id), "vouchers", targetVoucherId);
        voucherLinks.set(pn(sourceVoucher.id), targetVoucherId);
      }
    }
    if (!targetVoucherId) {
      blockers.push(`Sale voucher ${sourceVoucher.voucher_number} has no migrated target voucher.`);
      continue;
    }

    // Header and entry repairs commit together; run tracking/links are recorded after commit.
    const afterCommit: Array<() => Promise<void>> = [];
    await db.transaction(async (tx) => {
      await tx.execute(sql`
      UPDATE vouchers
      SET voucher_type = ${sourceVoucher.voucher_type},
          voucher_date = ${sourceVoucher.voucher_date},
          description = ${sourceVoucher.description ?? "Migrated read-only sale"},
          total_amount = ${sourceVoucher.total_amount},
          currency = ${sourceVoucher.currency ?? "USD"},
          exchange_rate = ${sourceVoucher.exchange_rate ?? null},
          source_module = 'SP_MIGRATION_READONLY'
      WHERE id = ${targetVoucherId} AND company_id = ${targetId}
    `);
      vouchersUpdated++;

      const sourceItemsResult = await tx.execute(sql`
      SELECT id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price
      FROM sales_items WHERE voucher_id = ${pn(sourceVoucher.id)} ORDER BY id ASC
    `);
      const targetItemsResult = await tx.execute(sql`
      SELECT id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price
      FROM sales_items WHERE voucher_id = ${targetVoucherId} ORDER BY id ASC
    `);
      const targetItems = resultRows(targetItemsResult);
      const linkedTargetItemIds = new Set(Array.from(itemLinks.values()));

      for (const sourceItem of resultRows(sourceItemsResult)) {
        const targetStockItemId = stockMap.get(pn(sourceItem.stock_item_id));
        if (!targetStockItemId) {
          blockers.push(`Sale item ${sourceItem.id} has no target stock-item mapping.`);
          continue;
        }
        const linkedTargetItemId = itemLinks.get(pn(sourceItem.id));
        if (linkedTargetItemId) {
          await tx.execute(sql`
          UPDATE sales_items
          SET stock_item_id = ${targetStockItemId}, quantity = ${sourceItem.quantity},
              selling_price = ${sourceItem.selling_price}, cost_price = ${sourceItem.cost_price},
              total_sales = ${sourceItem.total_sales}, total_cost = ${sourceItem.total_cost},
              profit = ${sourceItem.profit ?? "0"}, configured_price = ${sourceItem.configured_price ?? null}
          WHERE id = ${linkedTargetItemId} AND voucher_id = ${targetVoucherId}
        `);
          itemsUpdated++;
          continue;
        }
        const candidates = targetItems.filter(
          (targetItem) =>
            !linkedTargetItemIds.has(pn(targetItem.id)) &&
            pn(targetItem.stock_item_id) === targetStockItemId &&
            numericEqual(targetItem.quantity, sourceItem.quantity) &&
            numericEqual(targetItem.selling_price, sourceItem.selling_price) &&
            numericEqual(targetItem.cost_price, sourceItem.cost_price) &&
            numericEqual(targetItem.total_sales, sourceItem.total_sales, 0.01) &&
            numericEqual(targetItem.total_cost, sourceItem.total_cost, 0.01)
        );
        let targetItemId: number;
        if (candidates.length === 1) {
          targetItemId = pn(candidates[0].id);
          itemLinksAdded++;
        } else if (candidates.length === 0) {
          const inserted = await tx.execute(sql`
          INSERT INTO sales_items
            (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price)
          VALUES
            (${targetVoucherId}, ${targetStockItemId}, ${sourceItem.quantity}, ${sourceItem.selling_price},
             ${sourceItem.cost_price}, ${sourceItem.total_sales}, ${sourceItem.total_cost},
             ${sourceItem.profit ?? "0"}, ${sourceItem.configured_price ?? null})
          RETURNING id
        `);
          targetItemId = pn(resultRows(inserted)[0].id);
          afterCommit.push(() => trackRow(runId, "sales_items", targetItemId));
          itemsInserted++;
        } else {
          blockers.push(`Sale item ${sourceItem.id} has ${candidates.length} ambiguous target matches.`);
          continue;
        }
        afterCommit.push(() => linkSourceRow(runId, "sales_items", pn(sourceItem.id), "sales_items", targetItemId));
        itemLinks.set(pn(sourceItem.id), targetItemId);
        linkedTargetItemIds.add(targetItemId);
      }

      const sourceEntriesResult = await tx.execute(sql`
      SELECT id, ledger_account_id, debit_amount, credit_amount, narration
      FROM voucher_entries WHERE voucher_id = ${pn(sourceVoucher.id)} ORDER BY id ASC
    `);
      const targetEntriesResult = await tx.execute(sql`
      SELECT id, ledger_account_id, debit_amount, credit_amount, narration
      FROM voucher_entries WHERE voucher_id = ${targetVoucherId} ORDER BY id ASC
    `);
      const sourceEntries = resultRows(sourceEntriesResult);
      const targetEntries = resultRows(targetEntriesResult);
      for (const sourceEntry of sourceEntries) {
        const linkedTargetEntryId = entryLinks.get(pn(sourceEntry.id));
        if (!linkedTargetEntryId) continue;
        await tx.execute(sql`
        UPDATE voucher_entries
        SET debit_amount = ${sourceEntry.debit_amount ?? "0"},
            credit_amount = ${sourceEntry.credit_amount ?? "0"},
            narration = ${sourceEntry.narration ?? null}
        WHERE id = ${linkedTargetEntryId} AND voucher_id = ${targetVoucherId}
      `);
        entriesUpdated++;
      }
      const unlinkedSources = sourceEntries.filter((entry) => !entryLinks.has(pn(entry.id)));
      const linkedTargetEntryIds = new Set(Array.from(entryLinks.values()));
      const unlinkedTargets = targetEntries.filter((entry) => !linkedTargetEntryIds.has(pn(entry.id)));

      if (
        unlinkedSources.length > 0 &&
        sourceEntries.length === targetEntries.length &&
        unlinkedSources.length === unlinkedTargets.length
      ) {
        for (let index = 0; index < unlinkedSources.length; index++) {
          const sourceEntryId = pn(unlinkedSources[index].id);
          const targetEntryId = pn(unlinkedTargets[index].id);
          afterCommit.push(() =>
            linkSourceRow(runId, "voucher_entries", sourceEntryId, "voucher_entries", targetEntryId)
          );
          entryLinks.set(sourceEntryId, targetEntryId);
          entryLinksAdded++;
        }
      } else if (unlinkedSources.length > 0 && targetEntries.length < sourceEntries.length) {
        const missingCount = sourceEntries.length - targetEntries.length;
        if (missingCount !== unlinkedSources.length) {
          blockers.push(`Voucher ${sourceVoucher.voucher_number} has an ambiguous entry-count mismatch.`);
        } else {
          for (const sourceEntry of unlinkedSources) {
            const targetLedgerAccountId = sourceEntry.ledger_account_id
              ? (accountMap.map.get(pn(sourceEntry.ledger_account_id)) ?? accountMap.suspenseId)
              : accountMap.suspenseId;
            const inserted = await tx.execute(sql`
            INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
            VALUES (${targetVoucherId}, ${targetLedgerAccountId}, ${sourceEntry.debit_amount ?? "0"},
                    ${sourceEntry.credit_amount ?? "0"}, ${sourceEntry.narration ?? null})
            RETURNING id
          `);
            const targetEntryId = pn(resultRows(inserted)[0].id);
            afterCommit.push(() => trackRow(runId, "voucher_entries", targetEntryId));
            afterCommit.push(() =>
              linkSourceRow(runId, "voucher_entries", pn(sourceEntry.id), "voucher_entries", targetEntryId)
            );
            entryLinks.set(pn(sourceEntry.id), targetEntryId);
            entriesInserted++;
          }
        }
      } else if (unlinkedSources.length > 0) {
        blockers.push(`Voucher ${sourceVoucher.voucher_number} has unlinked entries that cannot be paired safely.`);
      }
    });
    for (const record of afterCommit) await record();
  }

  const createdRows = itemsInserted + entriesInserted;
  if (createdRows > 0) {
    await db.execute(sql`
      UPDATE sp_migration_rehearsal_runs
      SET rows_created = rows_created + ${createdRows},
          notes = trim(COALESCE(notes, '') || ' | Phase 4 repaired ' || ${createdRows} || ' readonly child row(s)')
      WHERE id = ${runId}
    `);
  }

  return {
    vouchersUpdated,
    itemsInserted,
    itemsUpdated,
    itemLinksAdded,
    entriesInserted,
    entriesUpdated,
    entryLinksAdded,
    blockers,
  };
}
