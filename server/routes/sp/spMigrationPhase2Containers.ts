import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import {
  pn,
  money,
  ensurePhase2Schema,
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
  resolveSupplier,
  findExistingContainerLink,
} from "./spMigrationPhase2Common";
import { getContainerChargeCandidates, getSourceContainerLines, upsertChargeMapping } from "./spMigrationPhase2Charges";
import { resultRows, firstRow } from "../../lib/queryResult";

export async function importContainers(req: Request, res: Response): Promise<Response | void> {
  const pair = await validateMigrationPair(req, res, true);
  if (!pair) return;
  const dependencyError = await requireCompletedAction(pair.sourceId, pair.targetId, "gc_containers");
  if (dependencyError) return res.status(409).json({ message: dependencyError });

  await ensurePhase2Schema();
  const runId = await createRun(
    pair.sourceId,
    pair.targetId,
    "gc_containers",
    `Phase 2 | User: ${req.session?.userId ?? "unknown"} | Source: ${pair.sourceCompany.name} | Target: ${pair.targetCompany.name}`
  );

  let rowsCreated = 0;
  const warnings: string[] = [];
  const summary: string[] = [];

  try {
    const stockItemMap = await loadStockItemMap(pair.sourceId, pair.targetId);
    const sourceAccounts = await loadSourceAccounts(pair.sourceId);
    const targetAccounts = await loadTargetAccounts(pair.targetId);
    const otwAssetAccount = targetAccounts.bySubType.get("sp_goods_otw");
    const otwClearingAccount = targetAccounts.bySubType.get("sp_otw_clearing");

    const sourceContainersResult = await db.execute(sql`
      SELECT c.*, s.legal_name AS source_supplier_name
      FROM containers c
      LEFT JOIN suppliers s ON s.id = c.supplier_id
      WHERE c.company_id = ${pair.sourceId}
      ORDER BY c.import_date ASC, c.id ASC
    `);

    let containersCreated = 0;
    let containersUpgraded = 0;
    let linesCreated = 0;
    let linesUnresolved = 0;
    let supplierMatched = 0;
    let supplierUnmatched = 0;
    let otwVouchersCreated = 0;
    let otwVouchersReused = 0;
    let chargeMapped = 0;
    let chargeReview = 0;
    let chargeUnmapped = 0;

    for (const sourceContainer of resultRows<{
      id: number;
      supplier_id: number | null;
      source_supplier_name: string | null;
      container_number: string | null;
      status: string | null;
      items_total: string | null;
      import_date: string | null;
    }>(sourceContainersResult)) {
      const sourceContainerId = pn(sourceContainer.id);
      const supplier = await resolveSupplier(
        sourceContainer.supplier_id ? pn(sourceContainer.supplier_id) : null,
        sourceContainer.source_supplier_name ?? null
      );
      if (supplier.supplierId) supplierMatched++;
      else supplierUnmatched++;
      if (supplier.warning) warnings.push(`Container ${sourceContainer.container_number}: ${supplier.warning}`);

      const poResult = await db.execute(sql`
        SELECT id, po_number, supplier_id, items_total, freight, surcharge, fumigation,
               document_charges, discount, other_charges, freight_paid_by
        FROM purchase_orders
        WHERE container_id = ${sourceContainerId}
        ORDER BY id DESC
        LIMIT 1
      `);
      const po = firstRow(poResult) ?? null;
      const status = ["otw", "open"].includes(String(sourceContainer.status ?? "").toLowerCase())
        ? "open"
        : "offloaded";
      const invoiceTotal = pn(po?.items_total ?? sourceContainer.items_total);
      const freight = pn(po?.freight);
      const invoiceNumber = String(po?.po_number ?? sourceContainer.container_number ?? `GC-${sourceContainerId}`);
      const migrationNote = `Migrated from ${pair.sourceCompany.name} ERP container #${sourceContainer.container_number}; supplier match: ${supplier.method}.`;

      let spContainerId = await findExistingContainerLink(pair.sourceId, pair.targetId, sourceContainerId);
      if (!spContainerId && sourceContainer.container_number) {
        const existingByNumber = await db.execute(sql`
          SELECT id FROM sp_containers
          WHERE company_id = ${pair.targetId}
            AND container_number = ${sourceContainer.container_number}
            AND notes ILIKE '%migrated from%erp container%'
          ORDER BY id ASC
          LIMIT 1
        `);
        spContainerId = pn(firstRow(existingByNumber)?.id);
        if (spContainerId) {
          await linkSourceRow(runId, "containers", sourceContainerId, "sp_containers", spContainerId);
        }
      }

      if (!spContainerId) {
        const inserted = await db.execute(sql`
          INSERT INTO sp_containers
            (company_id, supplier_id, supplier_name, container_number, invoice_number, invoice_date,
             invoice_total_usd, freight_estimate_usd, status, notes)
          VALUES
            (${pair.targetId}, ${supplier.supplierId}, ${supplier.supplierName}, ${sourceContainer.container_number},
             ${invoiceNumber}, ${sourceContainer.import_date}, ${money(invoiceTotal)}, ${money(freight)}, ${status},
             ${migrationNote})
          RETURNING id
        `);
        spContainerId = pn(resultRows(inserted)[0].id);
        await trackRow(runId, "sp_containers", spContainerId);
        await linkSourceRow(runId, "containers", sourceContainerId, "sp_containers", spContainerId);
        rowsCreated++;
        containersCreated++;
      } else {
        await db.execute(sql`
          UPDATE sp_containers
          SET supplier_id = ${supplier.supplierId},
              supplier_name = ${supplier.supplierName},
              notes = CASE
                WHEN COALESCE(notes, '') LIKE '%supplier match:%' THEN notes
                ELSE trim(COALESCE(notes, '') || ' ' || ${migrationNote})
              END
          WHERE id = ${spContainerId} AND company_id = ${pair.targetId}
        `);
        containersUpgraded++;
      }

      if (status === "open") {
        if (!otwAssetAccount || !otwClearingAccount) {
          warnings.push(
            `Container ${sourceContainer.container_number}: Goods-OTW accounts are missing; no OTW voucher was created.`
          );
        } else if (invoiceTotal <= 0) {
          warnings.push(
            `Container ${sourceContainer.container_number}: invoice total is zero; no OTW voucher was created.`
          );
        } else {
          const deterministicNumber = `GC-OTW-${pair.targetId}-${sourceContainerId}`;
          const linkedVoucherResult = await db.execute(sql`
            SELECT goods_otw_voucher_id FROM sp_containers
            WHERE id = ${spContainerId} AND company_id = ${pair.targetId}
          `);
          let voucherId = pn(firstRow(linkedVoucherResult)?.goods_otw_voucher_id);
          if (!voucherId) {
            const existingVoucher = await db.execute(sql`
              SELECT id FROM vouchers
              WHERE company_id = ${pair.targetId} AND voucher_number = ${deterministicNumber}
              LIMIT 1
            `);
            voucherId = pn(firstRow(existingVoucher)?.id);
          }

          if (!voucherId) {
            const insertedVoucher = await db.execute(sql`
              INSERT INTO vouchers
                (company_id, supplier_id, voucher_number, voucher_type, voucher_date, description,
                 total_amount, currency, source_module)
              VALUES
                (${pair.targetId}, ${supplier.supplierId}, ${deterministicNumber}, 'Journal',
                 ${sourceContainer.import_date},
                 ${`GC Migration — Goods OTW for container ${sourceContainer.container_number}`},
                 ${money(invoiceTotal)}, 'USD', 'SP_MIGRATION')
              RETURNING id
            `);
            voucherId = pn(resultRows(insertedVoucher)[0].id);
            await trackRow(runId, "vouchers", voucherId);
            rowsCreated++;
            otwVouchersCreated++;
          } else {
            await db.execute(sql`
              UPDATE vouchers
              SET supplier_id = ${supplier.supplierId},
                  voucher_date = ${sourceContainer.import_date},
                  total_amount = ${money(invoiceTotal)}
              WHERE id = ${voucherId} AND company_id = ${pair.targetId}
            `);
            otwVouchersReused++;
          }

          const debitEntry = await db.execute(sql`
            SELECT id FROM voucher_entries
            WHERE voucher_id = ${voucherId} AND ledger_account_id = ${pn(otwAssetAccount.id)}
            LIMIT 1
          `);
          if (!firstRow(debitEntry)) {
            const inserted = await db.execute(sql`
              INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
              VALUES (${voucherId}, ${pn(otwAssetAccount.id)}, ${money(invoiceTotal)}, '0.0000',
                      ${`Goods OTW — container ${sourceContainer.container_number}`})
              RETURNING id
            `);
            await trackRow(runId, "voucher_entries", pn(resultRows(inserted)[0].id));
            rowsCreated++;
          } else {
            await db.execute(sql`
              UPDATE voucher_entries
              SET debit_amount = ${money(invoiceTotal)}, credit_amount = '0.0000',
                  narration = ${`Goods OTW — container ${sourceContainer.container_number}`}
              WHERE id = ${pn(resultRows(debitEntry)[0].id)}
            `);
          }

          const creditEntry = await db.execute(sql`
            SELECT id FROM voucher_entries
            WHERE voucher_id = ${voucherId} AND ledger_account_id = ${pn(otwClearingAccount.id)}
            LIMIT 1
          `);
          if (!firstRow(creditEntry)) {
            const inserted = await db.execute(sql`
              INSERT INTO voucher_entries
                (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount, narration)
              VALUES (${voucherId}, ${pn(otwClearingAccount.id)}, ${supplier.supplierId}, '0.0000',
                      ${money(invoiceTotal)}, ${`Goods OTW clearing — container ${sourceContainer.container_number}`})
              RETURNING id
            `);
            await trackRow(runId, "voucher_entries", pn(resultRows(inserted)[0].id));
            rowsCreated++;
          } else {
            await db.execute(sql`
              UPDATE voucher_entries
              SET supplier_id = ${supplier.supplierId}, debit_amount = '0.0000',
                  credit_amount = ${money(invoiceTotal)},
                  narration = ${`Goods OTW clearing — container ${sourceContainer.container_number}`}
              WHERE id = ${pn(resultRows(creditEntry)[0].id)}
            `);
          }

          await db.execute(sql`
            UPDATE sp_containers
            SET goods_otw_voucher_id = ${voucherId}, supplier_id = ${supplier.supplierId}
            WHERE id = ${spContainerId} AND company_id = ${pair.targetId}
          `);
        }
      }

      const sourceLines = await getSourceContainerLines(sourceContainer, po);
      if (sourceLines.rows.length === 0) {
        linesUnresolved++;
        warnings.push(
          `Container ${sourceContainer.container_number}: no PO, offload-item, or usable container-summary line data was found.`
        );
      }
      for (const sourceLine of sourceLines.rows) {
        const sourceStockItemId = sourceLine.stock_item_id ? pn(sourceLine.stock_item_id) : null;
        const targetStockItemId = sourceStockItemId ? (stockItemMap.get(sourceStockItemId) ?? null) : null;
        if (sourceStockItemId && !targetStockItemId) {
          warnings.push(
            `Container ${sourceContainer.container_number}: stock item ${sourceStockItemId} has no target mapping.`
          );
        }
        const articleCode = String(sourceLine.article_code ?? sourceLine.description ?? `MIG-${sourceContainerId}`);
        const quantity = pn(sourceLine.quantity);
        const rate = pn(sourceLine.rate);
        const existingLine = await db.execute(sql`
          SELECT id FROM sp_container_lines
          WHERE company_id = ${pair.targetId}
            AND container_id = ${spContainerId}
            AND article_code = ${articleCode}
            AND qty = ${money(quantity)}
            AND unit_rate_usd = ${money(rate)}
          LIMIT 1
        `);
        if (firstRow(existingLine)) continue;

        const insertedLine = await db.execute(sql`
          INSERT INTO sp_container_lines
            (container_id, company_id, article_code, description, qty, unit_rate_usd, stock_item_id)
          VALUES
            (${spContainerId}, ${pair.targetId}, ${articleCode}, ${sourceLine.description ?? articleCode},
             ${money(quantity)}, ${money(rate)}, ${targetStockItemId})
          RETURNING id
        `);
        await trackRow(runId, "sp_container_lines", pn(resultRows(insertedLine)[0].id));
        rowsCreated++;
        linesCreated++;
      }

      const chargeCandidates = await getContainerChargeCandidates(sourceContainer, po);
      for (const candidate of chargeCandidates) {
        const result = await upsertChargeMapping({
          runId,
          sourceId: pair.sourceId,
          targetId: pair.targetId,
          sourceContainerId,
          spContainerId,
          candidate,
          sourceAccounts,
          targetAccounts,
        });
        if (result.inserted) rowsCreated++;
        if (result.reviewStatus === "mapped") chargeMapped++;
        else if (result.reviewStatus === "review") chargeReview++;
        else chargeUnmapped++;
      }
    }

    summary.push(
      `${containersCreated} container(s) created; ${containersUpgraded} existing migrated container(s) upgraded.`
    );
    summary.push(`${supplierMatched} supplier link(s) matched automatically; ${supplierUnmatched} unresolved.`);
    summary.push(
      `${linesCreated} container line(s) created; ${linesUnresolved} container(s) still have no recoverable line source.`
    );
    summary.push(
      `${otwVouchersCreated} OTW voucher(s) created; ${otwVouchersReused} existing OTW voucher(s) linked/reused.`
    );
    summary.push(
      `${chargeMapped} charge mapping(s) exact; ${chargeReview} default/review mapping(s); ${chargeUnmapped} unmapped.`
    );

    if (chargeReview || chargeUnmapped) {
      warnings.push("Review defaulted and unmapped container charges before production cutover.");
    }
    warnings.push(
      "Offloaded container stock remains supplied by Step 5 opening stock; Phase 2 does not duplicate stock movements."
    );

    await completeRun(runId, rowsCreated, `Charge review: ${chargeReview}; unmapped: ${chargeUnmapped}`);
    return res.json({
      success: true,
      runId,
      rowsCreated,
      summary,
      warnings: Array.from(new Set(warnings)),
      reconciliation: {
        containersCreated,
        containersUpgraded,
        supplierMatched,
        supplierUnmatched,
        linesCreated,
        linesUnresolved,
        otwVouchersCreated,
        otwVouchersReused,
        chargeMapped,
        chargeReview,
        chargeUnmapped,
      },
    });
  } catch (error) {
    await failRun(runId, error);
    logger.error("[SP Phase 2] Container migration failed", {
      error,
      runId,
      sourceId: pair.sourceId,
      targetId: pair.targetId,
    });
    return res.status(500).json({
      message: `Container migration failed: ${error instanceof Error ? error.message : String(error)}`,
      runId,
    });
  }
}
