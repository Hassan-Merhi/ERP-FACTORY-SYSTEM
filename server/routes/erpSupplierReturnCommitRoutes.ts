/** Atomic ERP supplier-return posting: transaction and voucher rules unchanged. */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import { requireAuth, requireRole } from "../auth";
import { db } from "../db";
import { resultRows } from "../lib/queryResult";
import { adjustInventory } from "../inventoryHelper";
import { getOrCreateInventoryControlAccount } from "../services/accounting/inventoryControlAccount";
import { ledgerAccountByCodeTx } from "../services/accounting/perpetualInventory/linkedJournal";
import { postFactoryVoucherTx } from "../services/factory/factoryVoucherPosting";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { assertActiveCompanyAccess } from "../security/companyAccessBoundary";
import { validateReturnCommitRows, type ReturnCommitRow } from "./erpSupplierReturnCommitValidation";
import { calculateSupplierReturnFinancials, reconcileSupplierReturnBatch, type SupplierReturnFinancials } from "./erpSupplierReturnFinancials";
import { byId, candidates, quantity, ReturnError, type Candidate, type Row } from "./erpSupplierReturnCandidates";

const movementAdapter = createDatabaseStockMovementAdapter();

export function registerErpSupplierReturnCommitRoute(app: Express) {
  const guards = [requireAuth, requireRole("Admin", "Developer")] as const;
  app.post("/api/erp/supplier-returns/commit", ...guards, async (req, res) => {
    try {
      const { activeCompanyId: companyId } = await assertActiveCompanyAccess(req);
      const body = req.body as {
        requestKey?: string;
        supplierId?: number | null;
        returnDate?: string;
        reason?: string;
        fileName?: string;
        lines?: Array<{ offloadItemId?: number; quantity?: string }>;
        requestedRows?: ReturnCommitRow[];
      };
      if (body?.supplierId != null && (!Number.isSafeInteger(body.supplierId) || body.supplierId <= 0))
        throw new ReturnError(400, "RETURN_SUPPLIER_INVALID", "Choose a valid supplier");
      if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(body?.requestKey ?? ""))
        throw new ReturnError(400, "RETURN_IDEMPOTENCY_KEY_REQUIRED", "A valid unique request key is required");
      const returnDay = String(body?.returnDate ?? "");
      const parsedReturnDay = new Date(returnDay + "T00:00:00Z");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(returnDay) ||
        Number.isNaN(parsedReturnDay.getTime()) ||
        parsedReturnDay.toISOString().slice(0, 10) !== returnDay
      )
        throw new ReturnError(400, "RETURN_DATE_INVALID", "Return date must be a valid YYYY-MM-DD");
      if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 1000)
        throw new ReturnError(400, "RETURN_LINES_INVALID", "Select at least one matched line (max 1000)");
      const input = body.lines
        .map((line) => ({ id: Number(line.offloadItemId), qty: quantity(line.quantity) }))
        .sort((a, b) => a.id - b.id);
      if (
        input.some((x) => !Number.isInteger(x.id) || x.id < 1) ||
        input.some((x, i) => i > 0 && x.id === input[i - 1].id)
      )
        throw new ReturnError(
          400,
          "RETURN_LINES_DUPLICATE",
          "Each offload item may appear only once per return; combine duplicate quantities"
        );
      let requestedTotal: string | null = null;
      if (body.requestedRows !== undefined) {
        try {
          requestedTotal = validateReturnCommitRows(
            body.requestedRows,
            input.map(({ id, qty }) => ({ offloadItemId: id, quantity: qty.toFixed(3) }))
          ).totalQty;
        } catch (error) {
          throw new ReturnError(400, "RETURN_ALLOCATION_INVALID", (error as Error).message);
        }
      }
      const result = await db.transaction(async (tx) => {
        // Serialize the same idempotency key BEFORE reading or changing stock.
        // Concurrent retries cannot both see a missing batch and double-post.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId}, hashtext(${body.requestKey!}))`);
        const [existing] = resultRows<{ id: number }>(
          await tx.execute(sql`
          SELECT id FROM erp_supplier_return_batches
           WHERE company_id=${companyId} AND request_key=${body.requestKey!} FOR UPDATE
        `)
        );
        if (existing) return { id: existing.id, replayed: true };
        // Lock original items in stable order so another return cannot consume the same units.
        const matched: Array<{ source: Candidate; qty: Decimal }> = [];
        for (const line of input) {
          const [lock] = resultRows<{ id: number }>(
            await tx.execute(sql`
            SELECT coi.id FROM container_offload_items coi
              JOIN container_offloads co ON co.id=coi.offload_id
              JOIN containers c ON c.id=co.container_id
             WHERE coi.id=${line.id} AND c.company_id=${companyId} FOR UPDATE OF coi
          `)
          );
          if (!lock) throw new ReturnError(404, "RETURN_SOURCE_MISSING", "An offloaded item no longer exists");
          const source = await byId(tx, companyId, line.id);
          if (
            source.supplierCount !== 1 ||
            !source.supplierId ||
            source.currencyCount !== 1 ||
            source.currency !== "USD"
          )
            throw new ReturnError(
              409,
              "RETURN_SUPPLIER_OR_CURRENCY_AMBIGUOUS",
              `Container ${source.containerNumber} has an ambiguous supplier or non-USD PO; manual review required`
            );
          if (body.supplierId != null && source.supplierId !== body.supplierId)
            throw new ReturnError(
              409,
              "RETURN_SUPPLIER_MISMATCH",
              `Source container ${source.containerNumber} does not belong to the selected supplier`
            );
          if (new Decimal(source.remainingQty).lt(line.qty))
            throw new ReturnError(
              409,
              "RETURN_EXCEEDS_OFFLOAD",
              `Returned qty exceeds remaining offload for ${source.code} on ${source.containerNumber}`
            );
          matched.push({ source, qty: line.qty });
        }
        // Verify submitted row article codes against their original offload sources.
        // The client cannot redirect quantities from one imported article to another.
        if (body.requestedRows) {
          const matchedById = new Map(matched.map(({ source }) => [source.offloadItemId, source]));
          const lookupCache = new Map<string, Set<number>>();
          for (const row of body.requestedRows) {
            const code = row.code.trim().toUpperCase();
            let legal = lookupCache.get(code);
            if (!legal) {
              legal = new Set((await candidates(tx, companyId, row.code.trim())).map((item) => item.offloadItemId));
              lookupCache.set(code, legal);
            }
            let rowSupplierId: number | null = null;
            for (const allocation of row.allocations) {
              const source = matchedById.get(allocation.offloadItemId);
              if (!source || !legal.has(source.offloadItemId))
                throw new ReturnError(409, "RETURN_ARTICLE_SOURCE_MISMATCH",
                  `Source does not belong to article ${row.code}`);
              if (rowSupplierId !== null && source.supplierId !== rowSupplierId)
                throw new ReturnError(409, "RETURN_ROW_SUPPLIER_MIXED",
                  `One article row cannot return quantities to multiple suppliers (${row.code})`);
              rowSupplierId = source.supplierId;
            }
          }
        }
        const demand = new Map<string, Decimal>();
        for (const { source, qty } of matched) {
          const key = `${source.locationId}:${source.stockItemId}`;
          demand.set(key, (demand.get(key) ?? new Decimal(0)).add(qty));
        }
        // Lock the entire inventory demand set in a consistent global order
        // irrespective of which offload IDs a concurrent return happens to select.
        const orderedDemand = [...demand].sort(([left], [right]) => {
          const [ll, li] = left.split(":").map(Number);
          const [rl, ri] = right.split(":").map(Number);
          return ll - rl || li - ri;
        });
        for (const [key, needed] of orderedDemand) {
          const [locationId, stockItemId] = key.split(":").map(Number);
          const [stock] = resultRows<{ quantity: string; total_value: string }>(
            await tx.execute(sql`
            SELECT quantity::text AS quantity,total_value::text AS total_value FROM inventory
             WHERE company_id=${companyId} AND location_id=${locationId}
               AND stock_item_id=${stockItemId} FOR UPDATE
          `)
          );
          if (!stock || new Decimal(stock.quantity).lt(needed))
            throw new ReturnError(
              409,
              "RETURN_INSUFFICIENT_STOCK",
              `Stock at location ${locationId}, item ${stockItemId} is less than the requested total ${needed}`
            );
          if (new Decimal(stock.total_value).isNegative())
            throw new ReturnError(
              409,
              "RETURN_NEGATIVE_STOCK_VALUE",
              "Inventory valuation is negative and requires reconciliation before return"
            );
        }
        const [batch] = resultRows<{ id: number }>(
          await tx.execute(sql`
          INSERT INTO erp_supplier_return_batches
            (company_id,request_key,return_date,file_name,reason,created_by_user_id,created_by_name)
          VALUES (${companyId},${body.requestKey!},${body.returnDate!},${String(body.fileName ?? "").slice(0, 250)},
            ${String(body.reason ?? "").slice(0, 1000)},${String(req.session.userId ?? "")},${String(req.session.username ?? "")})
          RETURNING id
        `)
        );
        if (!batch) throw new ReturnError(500, "RETURN_BATCH_AUDIT_FAILED", "Could not record supplier return batch");
        const inventoryAccount = await getOrCreateInventoryControlAccount(tx, companyId);
        const varianceAccountId = await ledgerAccountByCodeTx(
          tx,
          companyId,
          "SUPPLIER_RETURN_COST_VARIANCE",
          "Supplier Return Landed-Cost Variance",
          "Indirect Expense"
        );
        let totalQty = new Decimal(0),
          totalSupplier = new Decimal(0),
          totalInventory = new Decimal(0);
        const postedFinancials: Array<{ quantity: string; financials: SupplierReturnFinancials }> = [];
        const returnLineIds = new Map<number, number>();
        for (const { source, qty } of matched) {
          const [stock] = resultRows<{ quantity: string; total_value: string }>(
            await tx.execute(sql`
            SELECT quantity::text AS quantity,total_value::text AS total_value FROM inventory
             WHERE company_id=${companyId} AND location_id=${source.locationId}
               AND stock_item_id=${source.stockItemId} FOR UPDATE
          `)
          );
          if (!stock || new Decimal(stock.quantity).lt(qty))
            throw new ReturnError(409, "RETURN_INSUFFICIENT_STOCK", "Stock changed during supplier return");
          const currentCost = new Decimal(stock.quantity).gt(0)
            ? Decimal.max(new Decimal(stock.total_value).div(stock.quantity), 0)
            : new Decimal(0);
          const [returnLine] = resultRows<{ id: number }>(
            await tx.execute(sql`
            INSERT INTO erp_supplier_return_lines
              (batch_id,company_id,offload_item_id,offload_id,container_id,supplier_id,
               stock_item_id,location_id,article_code,item_name,quantity,supplier_credit_usd,inventory_reduction_usd)
            VALUES (${batch.id},${companyId},${source.offloadItemId},${source.offloadId},${source.containerId},
              ${source.supplierId!},${source.stockItemId},${source.locationId},${source.code},${source.name},
              ${qty.toFixed(3)},0,0)
            RETURNING id
          `)
          );
          if (!returnLine)
            throw new ReturnError(500, "RETURN_LINE_AUDIT_FAILED", "Could not record supplier return line");
          returnLineIds.set(source.offloadItemId, returnLine.id);
          await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId: source.stockItemId,
              kind: "issue",
              quantity: qty.toFixed(3),
              unitCost: currentCost.toFixed(7),
              fromLocationId: source.locationId,
              occurredAt: parsedReturnDay.toISOString(),
              source: {
                sourceType: "erp-supplier-return",
                sourceId: String(returnLine.id),
                idempotencyKey: `erp-supplier-return:${companyId}:${returnLine.id}`,
              },
            },
            movementAdapter
          );
          const moved = await adjustInventory(
            tx,
            source.locationId,
            source.stockItemId,
            qty.neg().toNumber(),
            companyId,
            undefined,
            "Supplier Return",
            returnLine.id
          );
          // The canonical issue is the audit record, but only adjustInventory
          // changes the actual stock row. Its persisted 2dp value delta is the
          // single source for the credit to the inventory control account.
          let financials: SupplierReturnFinancials;
          try {
            financials = calculateSupplierReturnFinancials({
              quantity: qty.toFixed(3),
              purchaseRate: source.unitPurchaseCost,
              inventoryValueDelta: moved.valueDelta,
              previousQuantity: moved.previousQuantity,
              newQuantity: moved.newQuantity,
              previousTotalValue: moved.previousTotalValue,
              newTotalValue: moved.newTotalValue,
            });
          } catch (error) {
            throw new ReturnError(409, "RETURN_FINANCIAL_RECONCILIATION_FAILED",
              `Cannot reconcile return for ${source.code}: ${(error as Error).message}`);
          }
          const inventoryValue = new Decimal(financials.inventoryCredit);
          const supplierCredit = new Decimal(financials.supplierDebit);
          const varianceDebit = new Decimal(financials.varianceDebit);
          const varianceCredit = new Decimal(financials.varianceCredit);
          const note = `Supplier return ${source.code} x ${qty.toFixed(3)} from ${source.containerNumber} (offload #${source.offloadId})`;
          const voucher = await postFactoryVoucherTx(tx, {
            companyId,
            voucherType: "Journal",
            voucherDate: body.returnDate!,
            description: note,
            sourceModule: "ERP",
            source: { sourceType: "erp-supplier-return", sourceId: String(returnLine.id) },
            voucherNumber: `SUP-RETURN-${companyId}-${returnLine.id}`,
            lines: [
              { supplierId: source.supplierId!, debit: supplierCredit, narration: `Supplier credit: ${note}` },
              {
                ledgerAccountId: inventoryAccount.id,
                credit: inventoryValue,
                narration: `Inventory shipped back: ${note}`,
              },
              ...(varianceDebit.gt(0)
                ? [{
                    ledgerAccountId: varianceAccountId,
                    debit: varianceDebit,
                    narration: "Inventory relief above supplier purchase credit",
                  }]
                : []),
              ...(varianceCredit.gt(0)
                ? [{
                    ledgerAccountId: varianceAccountId,
                    credit: varianceCredit,
                    narration: "Supplier purchase credit above inventory relief",
                  }]
                : []),
            ],
          });
          await tx.execute(sql`
            UPDATE erp_supplier_return_lines
               SET supplier_credit_usd=${supplierCredit.toFixed(2)},
                   inventory_reduction_usd=${inventoryValue.toFixed(2)},
                   voucher_id=${voucher.voucher.id},
                   source_purchase_rate=${new Decimal(source.unitPurchaseCost).toFixed(7)}
             WHERE id=${returnLine.id} AND company_id=${companyId}
          `);
          totalQty = totalQty.add(qty);
          totalSupplier = totalSupplier.add(supplierCredit);
          totalInventory = totalInventory.add(inventoryValue);
          postedFinancials.push({ quantity: qty.toFixed(3), financials });
        }
        // Preserve each original workbook-row allocation without multiplying the
        // source-level financial postings when the same offload occurs in several rows.
        if (body.requestedRows) {
          for (let index = 0; index < body.requestedRows.length; index++) {
            const requested = body.requestedRows[index];
            for (const allocation of requested.allocations) {
              const returnLineId = returnLineIds.get(allocation.offloadItemId);
              if (!returnLineId)
                throw new ReturnError(409, "RETURN_ALLOCATION_AUDIT_MISSING",
                  "An allocated container has no committed source return line");
              await tx.execute(sql`
                INSERT INTO erp_supplier_return_allocation_rows
                  (company_id,batch_id,return_line_id,input_row,requested_article_code,
                   requested_quantity,allocated_quantity)
                VALUES (${companyId},${batch.id},${returnLineId},${index + 2},
                  ${requested.code.trim()},${requested.quantity},${allocation.quantity})
              `);
            }
          }
        }
        const reconciled = reconcileSupplierReturnBatch(postedFinancials);
        if (!totalQty.eq(reconciled.totalQuantity) ||
            !totalSupplier.eq(reconciled.supplierDebit) ||
            !totalInventory.eq(reconciled.inventoryCredit)) {
          throw new ReturnError(409, "RETURN_BATCH_RECONCILIATION_FAILED",
            "Supplier return inventory, supplier and audit totals are not reconciled");
        }
        if (requestedTotal !== null && !totalQty.eq(requestedTotal))
          throw new ReturnError(409, "RETURN_TOTAL_MISMATCH",
            "Posted quantity does not equal the original requested return quantity");
        await tx.execute(sql`
          UPDATE erp_supplier_return_batches
             SET total_quantity=${totalQty.toFixed(3)},
                 supplier_credit_usd=${totalSupplier.toFixed(2)},
                 inventory_reduction_usd=${totalInventory.toFixed(2)}
           WHERE id=${batch.id} AND company_id=${companyId}
        `);
        return {
          id: batch.id,
          replayed: false,
          totalQty: totalQty.toFixed(3),
          supplierCreditUsd: totalSupplier.toFixed(2),
          inventoryReductionUsd: totalInventory.toFixed(2),
        };
      });
      res.json({ success: true, ...result });
    } catch (error) {
      const err = error as ReturnError;
      const status = err.status || (String((error as { code?: string }).code) === "23505" ? 409 : 500);
      res.status(status).json({
        code: err.code || "RETURN_COMMIT_FAILED",
        message: err.message || "Supplier return could not be posted",
      });
    }
  });
}
