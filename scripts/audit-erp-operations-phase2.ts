/**
 * ERP Phase 2: company-scoped, nonposting operational integrity audit.
 *
 * npx tsx scripts/audit-erp-operations-phase2.ts --company 9
 * Refuses --apply. Requires existing DATABASE_URL and an authorized ERP
 * company; never invents movements or financial corrections.
 */
import { writeFileSync } from "node:fs";
import { pool } from "../server/db";

function companyArg(): number {
  if (process.argv.includes("--apply") || process.argv.includes("--repair")) {
    throw new Error("Read-only operational audit: apply/repair is forbidden");
  }
  const index = process.argv.indexOf("--company");
  const text = index >= 0 ? process.argv[index + 1] : undefined;
  if (!text || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error("Specify one positive company ID using --company <id>");
  }
  return Number(text);
}

export async function auditErpOperationsPhase2(companyId: number) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("Invalid company ID");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    const company = await client.query(
      "SELECT id, name, company_type, parent_company_id FROM companies WHERE id=$1",
      [companyId]
    );
    if (company.rowCount !== 1 || !["erp", "supplier_partner", "retail"].includes(company.rows[0].company_type)) {
      throw new Error("Company is missing or outside the ERP operational audit scope");
    }

    // An import may have already moved stock even if an old tracking flag is
    // false. Never recommend replay based on inventory_applied alone.
    const transfers = await client.query(
      `WITH journal AS (
         SELECT min(created_at) start_at FROM canonical_stock_movements WHERE company_id=$1
       )
       SELECT t.id transfer_id, v.id voucher_id, v.voucher_date::text voucher_date,
              t.created_at::text recorded_at, t.inventory_applied,
              count(i.id)::int line_count,
              (SELECT count(*)::int FROM canonical_stock_movements m
                WHERE m.company_id=$1 AND
                  ((m.source_type='stock-transfer-import-multi-source' AND m.source_id=v.id::text)
                    OR (m.source_type='stock-transfer' AND m.source_id=t.id::text))) canonical_rows,
              (SELECT start_at::text FROM journal) journal_start
       FROM stock_transfer_vouchers t
       JOIN vouchers v ON v.id=t.voucher_id AND v.company_id=$1
       LEFT JOIN stock_transfer_items i ON i.transfer_id=t.id
       WHERE v.deleted_at IS NULL AND v.optional=false
         AND (t.inventory_applied=false OR NOT EXISTS
             (SELECT 1 FROM stock_transfer_items line WHERE line.transfer_id=t.id))
       GROUP BY t.id,v.id,v.voucher_date,t.created_at,t.inventory_applied
       ORDER BY t.created_at DESC, t.id DESC`,
      [companyId]
    );

    // A null PO.voucher_id does NOT prove that no historic journal exists.
    // Display the linked offload so an operator can trace source provenance.
    const purchaseOrders = await client.query(
      `SELECT p.id, p.po_number, p.created_at::text created_at, p.items_total::text items_total,
              p.container_id, p.supplier_id,
              EXISTS (SELECT 1 FROM container_offloads o WHERE o.container_id=p.container_id) has_offload
         FROM purchase_orders p
        WHERE p.company_id=$1 AND p.voucher_id IS NULL
        ORDER BY p.created_at DESC, p.id DESC`,
      [companyId]
    );

    const ownership = await client.query(
      `SELECT
        (SELECT count(*)::int FROM stock_transfer_vouchers t
           JOIN vouchers v ON v.id=t.voucher_id
           JOIN locations l ON l.id=t.destination_location_id
          WHERE v.company_id=$1 AND v.deleted_at IS NULL AND l.company_id<>$1)
          AS foreign_transfer_destinations,
        (SELECT count(*)::int FROM stock_transfer_items i
           JOIN stock_transfer_vouchers t ON t.id=i.transfer_id
           JOIN vouchers v ON v.id=t.voucher_id
           JOIN stock_items si ON si.id=i.stock_item_id
          WHERE v.company_id=$1 AND v.deleted_at IS NULL AND si.company_id<>$1)
          AS foreign_transfer_stock,
        (SELECT count(*)::int FROM sales_items i
           JOIN vouchers v ON v.id=i.voucher_id
           LEFT JOIN stock_items si ON si.id=i.stock_item_id
          WHERE v.company_id=$1 AND v.deleted_at IS NULL
            AND (si.id IS NULL OR si.company_id<>$1))
          AS missing_or_foreign_sales_stock,
        (SELECT count(*)::int FROM credit_note_items i
           JOIN vouchers v ON v.id=i.voucher_id
           LEFT JOIN stock_items si ON si.id=i.stock_item_id
          WHERE v.company_id=$1 AND v.deleted_at IS NULL
            AND (si.id IS NULL OR si.company_id<>$1))
          AS missing_or_foreign_credit_stock,
        (SELECT coalesce(sum(n-1),0)::int FROM
           (SELECT count(*) n FROM vouchers v WHERE v.company_id=$1
             AND v.deleted_at IS NULL AND v.client_sale_id IS NOT NULL
            GROUP BY v.client_sale_id HAVING count(*)>1) duplicate)
          AS duplicate_pos_client_ids,
        (SELECT count(*)::int FROM purchase_orders p
           JOIN suppliers su ON su.id=p.supplier_id
           JOIN companies c ON c.id=p.company_id
          WHERE p.company_id=$1 AND su.company_id<>p.company_id
            AND su.company_id IS DISTINCT FROM c.parent_company_id)
          AS unexpected_po_supplier_ownership`,
      [companyId]
    );

    await client.query("ROLLBACK");
    const mismatchedTransfers = transfers.rows.filter(
      (row: { inventory_applied: boolean | null; canonical_rows: number; line_count: number }) =>
        row.inventory_applied === false || row.line_count === 0
    );
    return {
      audit: "ERP_PHASE_2_OPERATIONS",
      readOnly: true,
      evidence: "company_scoped_current_snapshot_not_historical_reconstruction",
      company: company.rows[0],
      ownership: ownership.rows[0],
      transfers: {
        flagged: mismatchedTransfers,
        policy: "An unapplied flag with matching canonical stock movements is a tracking/evidence inconsistency, not permission to replay stock.",
      },
      purchaseOrders: {
        unlinkedVoucher: purchaseOrders.rows,
        policy: "A purchase-order link gap requires source voucher, offload, supplier and GL tracing before any backfill.",
      },
      certification: "diagnostic_only_requires_historical_provenance_and_workflow_regression_tests",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const report = await auditErpOperationsPhase2(companyArg());
  const serialized = JSON.stringify(report, null, 2);
  const outIndex = process.argv.indexOf("--out");
  if (outIndex < 0) {
    console.log(serialized);
  } else {
    const path = process.argv[outIndex + 1];
    if (!path) throw new Error("--out requires a file path");
    writeFileSync(path, serialized + "\n");
    console.log("Read-only ERP Phase 2 report saved to " + path);
  }
}

if (process.argv[1]?.endsWith("audit-erp-operations-phase2.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
