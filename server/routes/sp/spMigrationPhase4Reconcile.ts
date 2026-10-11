import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  linkSourceRow,
  loadSourceAccounts,
  loadStockItemMap,
  loadTargetAccounts,
  pn,
  resolveSupplier,
  trackRow,
} from "./spMigrationPhase2Common";
import { getSourceContainerLines } from "./spMigrationPhase2Charges";
import { resultRows, firstRow } from "../../lib/queryResult";

function numericEqual(left: unknown, right: unknown, tolerance = 0.0001): boolean {
  return Math.abs(pn(left) - pn(right)) <= tolerance;
}

function buildSalesAccountMap(
  sourceAccounts: Map<number, Record<string, unknown>>,
  targetAccounts: Awaited<ReturnType<typeof loadTargetAccounts>>
) {
  const suspense = targetAccounts.bySubType.get("gc_mig_suspense");
  if (!suspense) throw new Error("Migration Suspense account is missing.");
  const fallback: Record<string, string> = {
    "Direct Income": "sp_sales",
    Income: "sp_sales",
    "Direct Expense": "sp_cogs",
    "Indirect Expense": "sp_shared_charges",
    Expense: "sp_shared_charges",
    Intercompany: "sp_hadi_intercompany",
  };
  const map = new Map<number, number>();
  for (const [sourceId, account] of sourceAccounts.entries()) {
    const bySubtype = account.sub_type ? targetAccounts.bySubType.get(String(account.sub_type)) : null;
    const byCode = account.code ? targetAccounts.byCode.get(String(account.code).trim().toLowerCase()) : null;
    const fallbackAccount = fallback[String(account.account_type)]
      ? targetAccounts.bySubType.get(fallback[String(account.account_type)])
      : null;
    map.set(sourceId, pn(bySubtype?.id ?? byCode?.id ?? fallbackAccount?.id ?? suspense.id));
  }
  return { map, suspenseId: pn(suspense.id) };
}

async function existingSourceLinks(
  sourceId: number,
  targetId: number,
  sourceTable: string,
  targetTable: string
): Promise<Map<number, number>> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (l.source_id) l.source_id, l.target_id
    FROM sp_migration_source_links l
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    WHERE r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
      AND l.source_table = ${sourceTable}
      AND l.target_table = ${targetTable}
    ORDER BY l.source_id, r.created_at DESC
  `);
  return new Map(resultRows(result).map((row) => [pn(row.source_id), pn(row.target_id)]));
}

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

export async function reconcileMigrationOwnedContainers(params: {
  runId: string;
  sourceId: number;
  targetId: number;
  sourceCompanyName: string;
}) {
  const { runId, sourceId, targetId, sourceCompanyName } = params;
  const stockMap = await loadStockItemMap(sourceId, targetId);
  const linkedResult = await db.execute(sql`
    SELECT DISTINCT ON (c.id)
      c.*, s.legal_name AS source_supplier_name, l.target_id AS sp_container_id
    FROM containers c
    LEFT JOIN suppliers s ON s.id = c.supplier_id
    JOIN sp_migration_source_links l
      ON l.source_table = 'containers' AND l.source_id = c.id AND l.target_table = 'sp_containers'
    JOIN sp_migration_rehearsal_runs r ON r.id = l.run_id
    WHERE c.company_id = ${sourceId}
      AND r.source_company_id = ${sourceId}
      AND r.target_company_id = ${targetId}
      AND r.status <> 'rolled_back'
    ORDER BY c.id, r.created_at DESC
  `);

  let headersUpdated = 0;
  let linesRebuilt = 0;
  let otwVouchersRetired = 0;
  let otwVouchersReactivated = 0;
  const blockers: string[] = [];

  for (const sourceContainer of resultRows(linkedResult)) {
    const sourceContainerId = pn(sourceContainer.id);
    const spContainerId = pn(sourceContainer.sp_container_id);
    const poResult = await db.execute(sql`
      SELECT id, po_number, items_total, freight
      FROM purchase_orders
      WHERE container_id = ${sourceContainerId}
      ORDER BY id DESC LIMIT 1
    `);
    const po = firstRow(poResult) ?? null;
    const supplier = await resolveSupplier(
      sourceContainer.supplier_id ? pn(sourceContainer.supplier_id) : null,
      sourceContainer.source_supplier_name == null ? null : String(sourceContainer.source_supplier_name)
    );
    if (!supplier.supplierId) {
      blockers.push(`Container ${sourceContainer.container_number}: supplier remains unresolved.`);
    }
    const status = ["otw", "open"].includes(String(sourceContainer.status ?? "").toLowerCase()) ? "open" : "offloaded";
    const invoiceTotal = pn(po?.items_total ?? sourceContainer.items_total);
    const freight = pn(po?.freight);
    const invoiceNumber = String(po?.po_number ?? sourceContainer.container_number ?? `GC-${sourceContainerId}`);
    const migrationNote = `Migrated from ${sourceCompanyName} ERP container #${sourceContainer.container_number}; supplier match: ${supplier.method}.`;

    await db.execute(sql`
      UPDATE sp_containers
      SET supplier_id = ${supplier.supplierId},
          supplier_name = ${supplier.supplierName},
          container_number = ${sourceContainer.container_number},
          invoice_number = ${invoiceNumber},
          invoice_date = ${sourceContainer.import_date},
          invoice_total_usd = ${invoiceTotal.toFixed(4)},
          freight_estimate_usd = ${freight.toFixed(4)},
          status = ${status},
          notes = CASE
            WHEN COALESCE(notes, '') ILIKE '%migrated from%erp container%' THEN ${migrationNote}
            ELSE trim(COALESCE(notes, '') || ' ' || ${migrationNote})
          END
      WHERE id = ${spContainerId} AND company_id = ${targetId}
    `);
    headersUpdated++;

    const sourceLines = await getSourceContainerLines(sourceContainer, po);
    if (sourceLines.rows.length === 0) {
      blockers.push(`Container ${sourceContainer.container_number}: no recoverable source line data exists.`);
      continue;
    }
    const trackedLinesResult = await db.execute(sql`
      SELECT rr.row_id
      FROM sp_migration_run_rows rr
      JOIN sp_migration_rehearsal_runs r ON r.id = rr.run_id
      JOIN sp_container_lines line ON line.id = rr.row_id
      WHERE rr.table_name = 'sp_container_lines'
        AND r.source_company_id = ${sourceId}
        AND r.target_company_id = ${targetId}
        AND r.status <> 'rolled_back'
        AND line.company_id = ${targetId}
        AND line.container_id = ${spContainerId}
    `);
    const allLinesResult = await db.execute(sql`
      SELECT id FROM sp_container_lines
      WHERE company_id = ${targetId} AND container_id = ${spContainerId}
      ORDER BY id ASC
    `);
    const trackedLineIds = new Set(resultRows(trackedLinesResult).map((row) => pn(row.row_id)));
    const allLineIds = resultRows(allLinesResult).map((row) => pn(row.id));
    const untrackedLineIds = allLineIds.filter((id: number) => !trackedLineIds.has(id));

    if (untrackedLineIds.length > 0) {
      blockers.push(
        `Container ${sourceContainer.container_number}: ${untrackedLineIds.length} untracked target line(s) prevent automatic line rebuilding.`
      );
    } else {
      for (const lineId of allLineIds) {
        await db.execute(sql`DELETE FROM sp_container_lines WHERE id = ${lineId} AND company_id = ${targetId}`);
      }
      for (const sourceLine of sourceLines.rows) {
        const sourceStockItemId = sourceLine.stock_item_id ? pn(sourceLine.stock_item_id) : null;
        const targetStockItemId = sourceStockItemId ? (stockMap.get(sourceStockItemId) ?? null) : null;
        if (sourceStockItemId && !targetStockItemId) {
          blockers.push(
            `Container ${sourceContainer.container_number}: line item ${sourceStockItemId} has no target mapping.`
          );
          continue;
        }
        const articleCode = String(sourceLine.article_code ?? sourceLine.description ?? `MIG-${sourceContainerId}`);
        const inserted = await db.execute(sql`
          INSERT INTO sp_container_lines
            (container_id, company_id, article_code, description, qty, unit_rate_usd, stock_item_id)
          VALUES
            (${spContainerId}, ${targetId}, ${articleCode}, ${sourceLine.description ?? articleCode},
             ${pn(sourceLine.quantity).toFixed(4)}, ${pn(sourceLine.rate).toFixed(4)}, ${targetStockItemId})
          RETURNING id
        `);
        await trackRow(runId, "sp_container_lines", pn(resultRows(inserted)[0].id));
        linesRebuilt++;
      }
    }

    if (status === "open") {
      const deterministicNumber = `GC-OTW-${targetId}-${sourceContainerId}`;
      const reactivated = await db.execute(sql`
        UPDATE vouchers
        SET deleted_at = NULL
        WHERE company_id = ${targetId}
          AND voucher_number = ${deterministicNumber}
          AND source_module = 'SP_MIGRATION'
        RETURNING id
      `);
      const voucherId = pn(firstRow(reactivated)?.id);
      if (voucherId) {
        await db.execute(sql`
          UPDATE sp_containers SET goods_otw_voucher_id = ${voucherId}
          WHERE id = ${spContainerId} AND company_id = ${targetId}
        `);
        otwVouchersReactivated++;
      }
    } else if (status === "offloaded") {
      const linkedVoucherResult = await db.execute(sql`
        SELECT goods_otw_voucher_id FROM sp_containers
        WHERE id = ${spContainerId} AND company_id = ${targetId}
      `);
      const voucherId = pn(firstRow(linkedVoucherResult)?.goods_otw_voucher_id);
      if (voucherId) {
        const retired = await db.execute(sql`
          UPDATE vouchers
          SET deleted_at = COALESCE(deleted_at, now())
          WHERE id = ${voucherId}
            AND company_id = ${targetId}
            AND source_module = 'SP_MIGRATION'
            AND voucher_number = ${`GC-OTW-${targetId}-${sourceContainerId}`}
          RETURNING id
        `);
        if (firstRow(retired)) {
          await db.execute(sql`
            UPDATE sp_containers SET goods_otw_voucher_id = NULL
            WHERE id = ${spContainerId} AND company_id = ${targetId}
          `);
          otwVouchersRetired++;
        } else {
          blockers.push(
            `Container ${sourceContainer.container_number}: linked OTW voucher is not safely migration-owned.`
          );
        }
      }
    }
  }

  return { headersUpdated, linesRebuilt, otwVouchersRetired, otwVouchersReactivated, blockers };
}
