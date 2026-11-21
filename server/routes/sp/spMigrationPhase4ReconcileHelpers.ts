// Extracted from ./spMigrationPhase4Reconcile.ts
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { loadStockItemMap, loadTargetAccounts, pn, resolveSupplier, trackRow } from "./spMigrationPhase2Common";
import { getSourceContainerLines } from "./spMigrationPhase2Charges";
import { resultRows, firstRow } from "../../lib/queryResult";

export function numericEqual(left: unknown, right: unknown, tolerance = 0.0001): boolean {
  return Math.abs(pn(left) - pn(right)) <= tolerance;
}

export function buildSalesAccountMap(
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

export async function existingSourceLinks(
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
