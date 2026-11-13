/**
 * ERP supplier returns against an already offloaded container.
 * Original PO/offload/vouchers stay immutable. A matched supplier debit note,
 * stock issue and landed-cost variance are committed together.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import { requireAuth, requireRole } from "../auth";
import { db, type DatabaseOrTransaction } from "../db";
import { resultRows } from "../lib/queryResult";
import { adjustInventory } from "../inventoryHelper";
import { getOrCreateInventoryControlAccount } from "../services/accounting/inventoryControlAccount";
import { ledgerAccountByCodeTx } from "../services/accounting/perpetualInventory/linkedJournal";
import { postFactoryVoucherTx } from "../services/factory/factoryVoucherPosting";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { assertActiveCompanyAccess } from "../security/companyAccessBoundary";

const movementAdapter = createDatabaseStockMovementAdapter();
const qtyPattern = /^\d+(?:\.\d{1,3})?$/;
type Row = Record<string, unknown>;
type Candidate = {
  offloadItemId: number;
  offloadId: number;
  containerId: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
  supplierCount: number;
  currency: string | null;
  currencyCount: number;
  stockItemId: number;
  code: string;
  name: string;
  locationId: number;
  originalQty: string;
  returnedQty: string;
  remainingQty: string;
  availableQty: string;
  unitPurchaseCost: string;
  unitLandedCost: string;
};
class ReturnError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}
function quantity(value: unknown): Decimal {
  const raw = String(value ?? "").trim();
  if (!qtyPattern.test(raw))
    throw new ReturnError(
      400,
      "RETURN_QUANTITY_INVALID",
      "Quantities must be positive numbers with at most 3 decimals"
    );
  const number = new Decimal(raw);
  if (!number.isFinite() || !number.gt(0))
    throw new ReturnError(400, "RETURN_QUANTITY_INVALID", "Quantity must be greater than zero");
  return number;
}
function asNumber(value: unknown): number {
  return Number(value ?? 0);
}
function mapCandidate(row: Row): Candidate {
  const original = new Decimal(String(row.original_qty ?? 0));
  const returned = new Decimal(String(row.returned_qty ?? 0));
  const remaining = Decimal.max(original.minus(returned), 0);
  return {
    offloadItemId: asNumber(row.offload_item_id),
    offloadId: asNumber(row.offload_id),
    containerId: asNumber(row.container_id),
    containerNumber: String(row.container_number ?? ""),
    supplierId: row.supplier_id == null ? null : asNumber(row.supplier_id),
    supplierName: row.supplier_name == null ? null : String(row.supplier_name),
    supplierCount: asNumber(row.supplier_count),
    currency: row.currency == null ? null : String(row.currency),
    currencyCount: asNumber(row.currency_count),
    stockItemId: asNumber(row.stock_item_id),
    code: String(row.code ?? ""),
    name: String(row.item_name ?? ""),
    locationId: asNumber(row.location_id),
    originalQty: original.toFixed(3),
    returnedQty: returned.toFixed(3),
    remainingQty: remaining.toFixed(3),
    availableQty: String(row.available_qty ?? "0"),
    unitPurchaseCost: String(row.purchase_rate ?? "0"),
    unitLandedCost: original.gt(0) ? new Decimal(String(row.landed_total ?? "0")).div(original).toFixed(4) : "0",
  };
}
async function candidates(executor: DatabaseOrTransaction, companyId: number, code: string): Promise<Candidate[]> {
  const rows = resultRows<Row>(
    await executor.execute(sql`
    SELECT coi.id AS offload_item_id, co.id AS offload_id, c.id AS container_id,
           c.container_number, co.location_id, coi.stock_item_id,
           si.code, si.name AS item_name, coi.quantity::text AS original_qty,
           coi.rate::text AS purchase_rate, coi.total_value::text AS landed_total,
           COALESCE(rt.returned, 0)::text AS returned_qty,
           COALESCE(i.quantity, 0)::text AS available_qty,
           sources.supplier_id, sources.supplier_name, sources.supplier_count,
           sources.currency, sources.currency_count
    FROM container_offload_items coi
    JOIN container_offloads co ON co.id = coi.offload_id
    JOIN containers c ON c.id = co.container_id AND c.company_id = ${companyId}
    JOIN stock_items si ON si.id = coi.stock_item_id AND si.company_id = ${companyId}
    LEFT JOIN inventory i ON i.company_id = ${companyId} AND i.location_id = co.location_id
       AND i.stock_item_id = coi.stock_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.quantity), 0) AS returned
        FROM erp_supplier_return_lines l
       WHERE l.company_id = ${companyId} AND l.offload_item_id = coi.id
    ) rt ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(po.supplier_id) AS supplier_id, MIN(s.legal_name) AS supplier_name,
             COUNT(DISTINCT po.supplier_id)::int AS supplier_count,
             MIN(UPPER(po.currency)) AS currency,
             COUNT(DISTINCT UPPER(po.currency))::int AS currency_count
        FROM purchase_orders po
        JOIN po_line_items pli ON pli.po_id = po.id AND pli.stock_item_id = coi.stock_item_id
        JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.company_id = ${companyId} AND po.container_id = c.id
    ) sources ON TRUE
    WHERE c.status = 'OFFLOADED' AND co.optional = FALSE
      AND (UPPER(si.code) = UPPER(${code}) OR EXISTS (
        SELECT 1 FROM stock_item_code_aliases a
         WHERE a.company_id = ${companyId} AND a.stock_item_id = si.id AND UPPER(a.alias_code) = UPPER(${code})
      ))
    ORDER BY co.offloaded_at DESC, c.id DESC, coi.id DESC
  `)
  );
  return rows.map(mapCandidate);
}
async function byId(executor: DatabaseOrTransaction, companyId: number, itemId: number): Promise<Candidate> {
  // Resolve by the authoritative item code, not a client-provided cost or supplier.
  const [ref] = resultRows<{ code: string }>(
    await executor.execute(sql`
    SELECT si.code FROM container_offload_items coi
      JOIN container_offloads co ON co.id=coi.offload_id
      JOIN containers c ON c.id=co.container_id
      JOIN stock_items si ON si.id=coi.stock_item_id
     WHERE coi.id=${itemId} AND c.company_id=${companyId} AND si.company_id=${companyId}
  `)
  );
  if (!ref) throw new ReturnError(404, "RETURN_SOURCE_MISSING", "Offloaded item was not found in this company");
  const matched = await candidates(executor, companyId, ref.code);
  const selected = matched.find((item) => item.offloadItemId === itemId);
  if (!selected)
    throw new ReturnError(409, "RETURN_SOURCE_UNAVAILABLE", "The source container is no longer an active offload");
  return selected;
}
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
      const { rows, supplierId: suppliedSupplierId } = (req.body as {
        rows?: unknown;
        supplierId?: unknown;
      }) || {};
      const supplierId =
        suppliedSupplierId == null ? null : Number(suppliedSupplierId);
      if (supplierId !== null && (!Number.isSafeInteger(supplierId) || supplierId <= 0)) {
        throw new ReturnError(400, "RETURN_SUPPLIER_INVALID", "Choose a valid supplier");
      }
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000)
        throw new ReturnError(400, "RETURN_ROWS_INVALID", "Upload between 1 and 1000 rows");
      const preview = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index] as { code?: unknown; quantity?: unknown; offloadItemId?: unknown };
        const code = String(row?.code ?? "").trim();
        if (!code || code.length > 50)
          throw new ReturnError(
            400,
            "RETURN_CODE_INVALID",
            `Row ${index + 2}: article code is required (max 50 characters)`
          );
        const qty = quantity(row?.quantity);
        const possible = (await candidates(db, companyId, code)).filter(
          (candidate) => supplierId === null || candidate.supplierId === supplierId
        );
        const selected = Number(row?.offloadItemId);
        const matching = selected ? possible.filter((item) => item.offloadItemId === selected) : possible;
        const eligible = matching.filter(
          (item) =>
            new Decimal(item.remainingQty).gte(qty) &&
            new Decimal(item.availableQty).gte(qty) &&
            item.supplierCount === 1 &&
            item.currencyCount === 1 &&
            item.currency === "USD"
        );
        const status = !possible.length
          ? "not-found"
          : selected && !matching.length
            ? "invalid-selection"
            : !eligible.length
              ? "insufficient-or-unsupported"
              : eligible.length === 1
                ? "matched"
                : "needs-selection";
        preview.push({
          row: index + 2,
          code,
          quantity: qty.toFixed(3),
          status,
          suggestedOffloadItemId: status === "matched" ? eligible[0].offloadItemId : null,
          candidates: possible,
        });
      }
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
               l.offload_id AS "offloadId",s.legal_name AS supplier,
               l.supplier_credit_usd::text AS "supplierCreditUsd",
               l.inventory_reduction_usd::text AS "inventoryReductionUsd",
               v.voucher_number AS "voucherNumber",l.voucher_id AS "voucherId"
          FROM erp_supplier_return_lines l
          JOIN erp_supplier_return_batches b ON b.id=l.batch_id AND b.company_id=${companyId}
          JOIN containers c ON c.id=l.container_id AND c.company_id=${companyId}
          JOIN suppliers s ON s.id=l.supplier_id
          LEFT JOIN vouchers v ON v.id=l.voucher_id
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
      };
      if (
        body?.supplierId != null &&
        (!Number.isSafeInteger(body.supplierId) || body.supplierId <= 0)
      ) throw new ReturnError(400, "RETURN_SUPPLIER_INVALID", "Choose a valid supplier");
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
        const demand = new Map<string, Decimal>();
        for (const { source, qty } of matched) {
          const key = `${source.locationId}:${source.stockItemId}`;
          demand.set(key, (demand.get(key) ?? new Decimal(0)).add(qty));
        }
        for (const [key, needed] of demand) {
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
          const inventoryValue = new Decimal(moved.valueDelta).negated().toDecimalPlaces(2);
          if (inventoryValue.isNegative())
            throw new ReturnError(
              409,
              "RETURN_STOCK_VALUE_INVALID",
              "Stock issue created a negative valuation movement"
            );
          const supplierCredit = qty.mul(source.unitPurchaseCost).toDecimalPlaces(2);
          const variance = inventoryValue.minus(supplierCredit);
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
              ...(variance.gt(0)
                ? [
                    {
                      ledgerAccountId: varianceAccountId,
                      debit: variance,
                      narration: "Unrecoverable landing cost / inventory cost difference",
                    },
                  ]
                : variance.lt(0)
                  ? [
                      {
                        ledgerAccountId: varianceAccountId,
                        credit: variance.abs(),
                        narration: "Supplier return valuation difference",
                      },
                    ]
                  : []),
            ],
          });
          await tx.execute(sql`
            UPDATE erp_supplier_return_lines
               SET supplier_credit_usd=${supplierCredit.toFixed(2)},
                   inventory_reduction_usd=${inventoryValue.toFixed(2)},
                   voucher_id=${voucher.voucher.id}
             WHERE id=${returnLine.id} AND company_id=${companyId}
          `);
          totalQty = totalQty.add(qty);
          totalSupplier = totalSupplier.add(supplierCredit);
          totalInventory = totalInventory.add(inventoryValue);
        }
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
