/** ERP supplier-return lookup, preview, history and commit-route composition. */
import { sql } from "drizzle-orm";
import type { Express } from "express";
import { requireAuth, requireRole } from "../auth";
import { db } from "../db";
import { resultRows } from "../lib/queryResult";
import { assertActiveCompanyAccess } from "../security/companyAccessBoundary";
import { allocateSupplierReturnRows } from "./erpSupplierReturnAllocation";
import { ReturnError, quantity, candidates, type Row } from "./erpSupplierReturnCandidates";
import { registerErpSupplierReturnCommitRoute } from "./erpSupplierReturnCommitRoutes";

async function readHistory(companyId: number) {
  return resultRows<Row>(
    await db.execute(sql`
    SELECT b.id, b.return_date::text AS "returnDate", b.file_name AS "fileName",
           b.reason, b.created_by_name AS "createdBy", b.created_at AS "createdAt",
           b.total_quantity::text AS "totalQty", b.supplier_credit_usd::text AS "supplierCreditUsd",
           b.inventory_reduction_usd::text AS "inventoryReductionUsd",
           COUNT(l.id)::int AS "lineCount"
      FROM erp_supplier_return_batches b
      LEFT JOIN erp_supplier_return_lines l ON l.batch_id=b.id
     WHERE b.company_id=${companyId}
     GROUP BY b.id ORDER BY b.id DESC LIMIT 200
  `)
  );
}
export function registerErpSupplierReturnRoutes(app: Express) {
  const guards = [requireAuth, requireRole("Admin", "Developer")] as const;
  // Only suppliers linked to this company's already-offloaded ERP containers appear.
  app.get("/api/erp/supplier-returns/suppliers", ...guards, async (req, res) => {
    try {
      const { activeCompanyId: companyId } = await assertActiveCompanyAccess(req);
      const rows = resultRows<{ id: number; name: string }>(
        await db.execute(sql`
          SELECT DISTINCT s.id, s.legal_name AS name
            FROM suppliers s
            JOIN purchase_orders po ON po.supplier_id=s.id AND po.company_id=${companyId}
            JOIN containers c ON c.id=po.container_id AND c.company_id=${companyId}
            JOIN container_offloads co ON co.container_id=c.id
           WHERE c.status='OFFLOADED' AND co.optional=FALSE
           ORDER BY name, s.id
        `)
      );
      res.json({ rows });
    } catch (error) {
      const err = error as ReturnError;
      res.status(err.status || 500).json({ message: err.message || "Supplier lookup failed" });
    }
  });
  app.post("/api/erp/supplier-returns/preview", ...guards, async (req, res) => {
    try {
      const { activeCompanyId: companyId } = await assertActiveCompanyAccess(req);
      const { rows, supplierId: suppliedSupplierId } =
        (req.body as {
          rows?: unknown;
          supplierId?: unknown;
        }) || {};
      const supplierId = suppliedSupplierId == null ? null : Number(suppliedSupplierId);
      if (supplierId !== null && (!Number.isSafeInteger(supplierId) || supplierId <= 0)) {
        throw new ReturnError(400, "RETURN_SUPPLIER_INVALID", "Choose a valid supplier");
      }
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000)
        throw new ReturnError(400, "RETURN_ROWS_INVALID", "Upload between 1 and 1000 rows");
      // Resolve the full workbook first, then allocate in input order. A source
      // and its shared location/item inventory can be consumed by earlier rows.
      const requested = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index] as { code?: unknown; quantity?: unknown; offloadItemId?: unknown };
        const code = String(row?.code ?? "").trim();
        if (!code || code.length > 50)
          throw new ReturnError(
            400, "RETURN_CODE_INVALID",
            `Row ${index + 2}: article code is required (max 50 characters)`
          );
        const qty = quantity(row?.quantity);
        const selected = row?.offloadItemId == null || row.offloadItemId === ""
          ? null : Number(row.offloadItemId);
        if (selected !== null && (!Number.isSafeInteger(selected) || selected <= 0))
          throw new ReturnError(400, "RETURN_SOURCE_INVALID", `Row ${index + 2}: invalid offload item`);
        const possible = (await candidates(db, companyId, code)).filter(
          (candidate) => supplierId === null || candidate.supplierId === supplierId
        );
        requested.push({ row: index + 2, code, quantity: qty.toFixed(3), offloadItemId: selected, candidates: possible });
      }
      const allocations = allocateSupplierReturnRows(requested);
      const preview = requested.map((row, index) => ({
        row: row.row,
        code: row.code,
        quantity: row.quantity,
        status: allocations[index].status,
        suggestedOffloadItemId: allocations[index].suggestedOffloadItemId,
        allocations: allocations[index].allocations.map(({ offloadItemId, quantity }) => ({
          offloadItemId, quantity,
        })),
        allocatedQty: allocations[index].allocatedQty,
        unallocatedQty: allocations[index].unallocatedQty,
        candidates: row.candidates,
      }));
      res.json({ rows: preview, supplierId, ready: preview.every((r) => r.status === "matched") });
    } catch (error) {
      const err = error as ReturnError;
      res
        .status(err.status || 500)
        .json({ code: err.code || "RETURN_PREVIEW_FAILED", message: err.message || "Return mapping failed" });
    }
  });
  app.get("/api/erp/supplier-returns/history", ...guards, async (req, res) => {
    try {
      const { activeCompanyId } = await assertActiveCompanyAccess(req);
      res.json({ rows: await readHistory(activeCompanyId) });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  });
  app.get("/api/erp/supplier-returns/history/:batchId", ...guards, async (req, res) => {
    try {
      const { activeCompanyId: companyId } = await assertActiveCompanyAccess(req);
      const batchId = Number(req.params.batchId);
      if (!Number.isInteger(batchId) || batchId < 1)
        throw new ReturnError(400, "RETURN_BATCH_ID_INVALID", "Invalid batch");
      const rows = resultRows<Row>(
        await db.execute(sql`
        SELECT l.id,l.article_code AS "articleCode",l.item_name AS "itemName",
               l.quantity::text AS quantity,c.container_number AS "containerNumber",
               l.offload_id AS "offloadId",l.offload_item_id AS "offloadItemId",
               l.source_purchase_rate::text AS "sourcePurchaseRate",
               s.legal_name AS supplier,
               l.supplier_credit_usd::text AS "supplierCreditUsd",
               l.inventory_reduction_usd::text AS "inventoryReductionUsd",
               v.voucher_number AS "voucherNumber",l.voucher_id AS "voucherId",
               COALESCE(mapping.input_rows, '[]'::json) AS "requestedRows"
          FROM erp_supplier_return_lines l
          JOIN erp_supplier_return_batches b ON b.id=l.batch_id AND b.company_id=${companyId}
          JOIN containers c ON c.id=l.container_id AND c.company_id=${companyId}
          JOIN suppliers s ON s.id=l.supplier_id
          LEFT JOIN vouchers v ON v.id=l.voucher_id
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
              'inputRow', ar.input_row,
              'requestedArticleCode', ar.requested_article_code,
              'requestedQuantity', ar.requested_quantity::text,
              'allocatedQuantity', ar.allocated_quantity::text
            ) ORDER BY ar.input_row) AS input_rows
            FROM erp_supplier_return_allocation_rows ar
            WHERE ar.company_id=${companyId} AND ar.batch_id=l.batch_id AND ar.return_line_id=l.id
          ) mapping ON TRUE
         WHERE l.company_id=${companyId} AND l.batch_id=${batchId}
         ORDER BY l.id
      `)
      );
      res.json({ rows });
    } catch (error) {
      const err = error as ReturnError;
      res.status(err.status || 500).json({ code: err.code, message: err.message });
    }
  });
  registerErpSupplierReturnCommitRoute(app);
}
