import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import {
  pn,
  validateMigrationPair,
  requireCompletedAction,
  createRun,
  completeRun,
  failRun,
  trackRow,
  linkSourceRow,
  loadStockItemMap,
  loadTargetAccounts,
  loadSourceAccounts,
  getSuspenseReview,
} from "./spMigrationPhase2Common";
import { resultRows, firstRow } from "../../lib/queryResult";

export async function importHistoricalSales(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, true);
  if (!pair) return;
  const dependencyError = await requireCompletedAction(pair.sourceId, pair.targetId, "gc_sales_readonly");
  if (dependencyError) return res.status(409).json({ message: dependencyError });

  const runId = await createRun(
    pair.sourceId,
    pair.targetId,
    "gc_sales_readonly",
    `Phase 2 | User: ${req.session?.userId ?? "unknown"} | Source: ${pair.sourceCompany.name} | Target: ${pair.targetCompany.name}`
  );

  let rowsCreated = 0;
  const summary: string[] = [];
  const warnings: string[] = [];

  try {
    const targetAccounts = await loadTargetAccounts(pair.targetId);
    const sourceAccounts = await loadSourceAccounts(pair.sourceId);
    const stockItemMap = await loadStockItemMap(pair.sourceId, pair.targetId);

    let suspense = targetAccounts.bySubType.get("gc_mig_suspense");
    if (!suspense) {
      const created = await db.execute(sql`
        INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active, is_hidden)
        VALUES (${pair.targetId}, 'GC-SUSP', 'Migration Suspense', 'Equity', 'gc_mig_suspense', true, true)
        RETURNING id, code, name, account_type, sub_type
      `);
      suspense = resultRows(created)[0];
      targetAccounts.bySubType.set("gc_mig_suspense", suspense);
      targetAccounts.byCode.set("gc-susp", suspense);
      await trackRow(runId, "ledger_accounts", pn(suspense.id));
      rowsCreated++;
    }

    const accountMap = new Map<number, { targetId: number; method: string }>();
    const erpTypeFallback: Record<string, string> = {
      "Direct Income": "sp_sales",
      Income: "sp_sales",
      "Direct Expense": "sp_cogs",
      "Indirect Expense": "sp_shared_charges",
      Expense: "sp_shared_charges",
      Intercompany: "sp_hadi_intercompany",
    };
    for (const [sourceAccountId, sourceAccount] of sourceAccounts.entries()) {
      if (sourceAccount.sub_type && targetAccounts.bySubType.has(String(sourceAccount.sub_type))) {
        accountMap.set(sourceAccountId, {
          targetId: pn(targetAccounts.bySubType.get(String(sourceAccount.sub_type))!.id),
          method: "exact_sub_type",
        });
      } else if (sourceAccount.code && targetAccounts.byCode.has(String(sourceAccount.code).trim().toLowerCase())) {
        accountMap.set(sourceAccountId, {
          targetId: pn(targetAccounts.byCode.get(String(sourceAccount.code).trim().toLowerCase())!.id),
          method: "exact_code",
        });
      } else if (
        erpTypeFallback[String(sourceAccount.account_type)] &&
        targetAccounts.bySubType.has(erpTypeFallback[String(sourceAccount.account_type)])
      ) {
        accountMap.set(sourceAccountId, {
          targetId: pn(targetAccounts.bySubType.get(erpTypeFallback[String(sourceAccount.account_type)])!.id),
          method: "account_type_policy",
        });
      } else {
        accountMap.set(sourceAccountId, { targetId: pn(suspense.id), method: "suspense" });
      }
    }

    const vouchersResult = await db.execute(sql`
      SELECT id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, exchange_rate
      FROM vouchers
      WHERE company_id = ${pair.sourceId}
        AND voucher_type IN ('Sales', 'Sale')
        AND deleted_at IS NULL
      ORDER BY voucher_date ASC, id ASC
    `);

    let vouchersCreated = 0;
    let vouchersReused = 0;
    let entriesCreated = 0;
    let entryLinksBackfilled = 0;
    let saleItemsCreated = 0;
    let saleItemsSkipped = 0;

    for (const sourceVoucher of resultRows(vouchersResult)) {
      const targetVoucherNumber = `MIG-GC-${sourceVoucher.voucher_number}`.slice(0, 100);
      const existingResult = await db.execute(sql`
        SELECT id FROM vouchers
        WHERE company_id = ${pair.targetId} AND voucher_number = ${targetVoucherNumber}
        LIMIT 1
      `);
      let targetVoucherId = pn(firstRow(existingResult)?.id);
      let newlyCreated = false;

      if (!targetVoucherId) {
        const createdVoucher = await db.execute(sql`
          INSERT INTO vouchers
            (company_id, voucher_number, voucher_type, voucher_date, description,
             total_amount, currency, exchange_rate, source_module)
          VALUES
            (${pair.targetId}, ${targetVoucherNumber}, ${sourceVoucher.voucher_type}, ${sourceVoucher.voucher_date},
             ${sourceVoucher.description ?? "Migrated read-only sale"}, ${sourceVoucher.total_amount},
             ${sourceVoucher.currency ?? "USD"}, ${sourceVoucher.exchange_rate ?? null}, 'SP_MIGRATION_READONLY')
          RETURNING id
        `);
        targetVoucherId = pn(resultRows(createdVoucher)[0].id);
        await trackRow(runId, "vouchers", targetVoucherId);
        rowsCreated++;
        vouchersCreated++;
        newlyCreated = true;
      } else {
        vouchersReused++;
      }

      await linkSourceRow(runId, "vouchers", pn(sourceVoucher.id), "vouchers", targetVoucherId);

      if (newlyCreated) {
        const sourceItemsResult = await db.execute(sql`
          SELECT id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price
          FROM sales_items
          WHERE voucher_id = ${pn(sourceVoucher.id)}
          ORDER BY id ASC
        `);
        for (const sourceItem of resultRows(sourceItemsResult)) {
          const targetStockItemId = stockItemMap.get(pn(sourceItem.stock_item_id));
          if (!targetStockItemId) {
            saleItemsSkipped++;
            warnings.push(
              `Voucher ${sourceVoucher.voucher_number}: stock item ${sourceItem.stock_item_id} has no target mapping.`
            );
            continue;
          }
          const inserted = await db.execute(sql`
            INSERT INTO sales_items
              (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit, configured_price)
            VALUES
              (${targetVoucherId}, ${targetStockItemId}, ${sourceItem.quantity}, ${sourceItem.selling_price}, ${sourceItem.cost_price},
               ${sourceItem.total_sales}, ${sourceItem.total_cost}, ${sourceItem.profit ?? "0"}, ${sourceItem.configured_price ?? null})
            RETURNING id
          `);
          const targetItemId = pn(resultRows(inserted)[0].id);
          await trackRow(runId, "sales_items", targetItemId);
          await linkSourceRow(runId, "sales_items", pn(sourceItem.id), "sales_items", targetItemId);
          rowsCreated++;
          saleItemsCreated++;
        }

        const sourceEntriesResult = await db.execute(sql`
          SELECT id, ledger_account_id, debit_amount, credit_amount, narration
          FROM voucher_entries
          WHERE voucher_id = ${pn(sourceVoucher.id)}
          ORDER BY id ASC
        `);
        for (const sourceEntry of resultRows(sourceEntriesResult)) {
          const mapping = sourceEntry.ledger_account_id
            ? (accountMap.get(pn(sourceEntry.ledger_account_id)) ?? { targetId: pn(suspense.id), method: "suspense" })
            : { targetId: pn(suspense.id), method: "suspense" };
          const inserted = await db.execute(sql`
            INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
            VALUES (${targetVoucherId}, ${mapping.targetId}, ${sourceEntry.debit_amount ?? "0"}, ${sourceEntry.credit_amount ?? "0"},
                    ${sourceEntry.narration ?? null})
            RETURNING id
          `);
          const targetEntryId = pn(resultRows(inserted)[0].id);
          await trackRow(runId, "voucher_entries", targetEntryId);
          await linkSourceRow(runId, "voucher_entries", pn(sourceEntry.id), "voucher_entries", targetEntryId);
          rowsCreated++;
          entriesCreated++;
        }
      } else {
        const sourceEntriesResult = await db.execute(sql`
          SELECT id FROM voucher_entries WHERE voucher_id = ${pn(sourceVoucher.id)} ORDER BY id ASC
        `);
        const targetEntriesResult = await db.execute(sql`
          SELECT id FROM voucher_entries WHERE voucher_id = ${targetVoucherId} ORDER BY id ASC
        `);
        const sourceEntries = resultRows(sourceEntriesResult);
        const targetEntries = resultRows(targetEntriesResult);
        if (sourceEntries.length === targetEntries.length) {
          for (let index = 0; index < sourceEntries.length; index++) {
            await linkSourceRow(
              runId,
              "voucher_entries",
              pn(sourceEntries[index].id),
              "voucher_entries",
              pn(targetEntries[index].id)
            );
            entryLinksBackfilled++;
          }
        } else {
          warnings.push(
            `Voucher ${sourceVoucher.voucher_number}: existing migrated entry count (${targetEntries.length}) differs from source (${sourceEntries.length}); source links were not guessed.`
          );
        }
      }
    }

    const suspenseReview = await getSuspenseReview(pair.sourceId, pair.targetId);
    summary.push(`${vouchersCreated} read-only sale voucher(s) created; ${vouchersReused} existing voucher(s) reused.`);
    summary.push(
      `${entriesCreated} voucher entry row(s), ${saleItemsCreated} sale item row(s), ${entryLinksBackfilled} legacy entry link(s) recorded.`
    );
    summary.push(`${suspenseReview.count} suspense entry row(s) require review.`);
    if (saleItemsSkipped) {
      summary.push(`${saleItemsSkipped} sale item row(s) skipped because no stock-item mapping existed.`);
    }

    if (suspenseReview.count > 0) {
      warnings.push(
        `Migration Suspense contains ${suspenseReview.count} entry row(s). Use the suspense review endpoint before cutover.`
      );
    }
    warnings.push("Migrated sales remain read-only and do not move stock.");

    await completeRun(runId, rowsCreated, `Suspense review count: ${suspenseReview.count}`);
    return res.json({
      success: true,
      runId,
      rowsCreated,
      summary,
      warnings: Array.from(new Set(warnings)),
      reconciliation: {
        vouchersCreated,
        vouchersReused,
        entriesCreated,
        saleItemsCreated,
        saleItemsSkipped,
        entryLinksBackfilled,
      },
      suspenseReview,
    });
  } catch (error) {
    await failRun(runId, error);
    logger.error("[SP Phase 2] Historical sales migration failed", {
      error,
      runId,
      sourceId: pair.sourceId,
      targetId: pair.targetId,
    });
    return res.status(500).json({
      message: `Historical sales migration failed: ${error instanceof Error ? error.message : String(error)}`,
      runId,
    });
  }
}
