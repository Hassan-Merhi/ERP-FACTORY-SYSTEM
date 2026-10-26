/**
 * Supplier/stock-group sales-to-landed-cost reconciliation.
 * Read-only, current snapshot only. Historical POS COGS and vouchers are immutable.
 * A stock group is a reporting proxy for a supplier; it is not proof of batch
 * attribution when several suppliers or opening balances share item codes.
 */
import Decimal from "decimal.js";
import type { Express } from "express";

import { requireAuth, requireNonPOS } from "../../auth";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requirePageAccess } from "../../lib/permissionMiddleware";

const PAGE = requirePageAccess("page_sales_report");
const ZERO = new Decimal(0);

function decimal(value: unknown): Decimal {
  return value == null || value === "" ? ZERO : new Decimal(String(value));
}

function amount(value: Decimal): number {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

function qty(value: Decimal): number {
  return value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toNumber();
}

function positiveId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

interface ReconciliationRow {
  stockItemId: number;
  code: string;
  name: string;
  purchasedQty: string;
  landedCost: string;
  soldQty: string;
  revenue: string;
  soldCost: string;
  storedProfit: string;
  missingReliefCount: string;
  salesLineCount: string;
  mathMismatchCount: string;
  stockQty: string;
  stockValue: string;
  stockRateValue: string;
  negativeQty: string;
  adjustmentQty: string;
  adjustmentValue: string;
  canonicalQty: string;
}

const RECONCILIATION_SQL = [
  "WITH items AS (",
  "  SELECT id, code, name FROM stock_items",
  "  WHERE company_id = $1 AND stock_group_id = $3 AND deleted_at IS NULL",
  "), receipts AS (",
  "  SELECT coi.stock_item_id,",
  "    SUM(coi.quantity::numeric) AS quantity,",
  "    SUM(coi.total_value::numeric) AS value",
  "  FROM container_offload_items coi",
  "  JOIN container_offloads off ON off.id = coi.offload_id",
  "  JOIN containers c ON c.id = off.container_id",
  "  JOIN items it ON it.id = coi.stock_item_id",
  "  WHERE c.company_id = $1 AND c.supplier_id = $2",
  "    AND c.status = 'OFFLOADED' AND c.deleted_at IS NULL",
  "    AND off.optional = false",
  "  GROUP BY coi.stock_item_id",
  "), sales AS (",
  "  SELECT s.stock_item_id, SUM(s.quantity::numeric) AS quantity,",
  "    SUM(s.total_sales::numeric) AS revenue,",
  "    SUM(s.total_cost::numeric) AS cost,",
  "    SUM(s.profit::numeric) AS stored_profit,",
  "    COUNT(*) AS sales_line_count,",
  "    COUNT(*) FILTER (WHERE s.value_moved IS NULL) AS missing_relief_count,",
  "    COUNT(*) FILTER (WHERE ABS(s.total_sales::numeric - s.total_cost::numeric - s.profit::numeric) > 0.001) AS math_mismatch_count",
  "  FROM sales_items s",
  "  JOIN vouchers v ON v.id = s.voucher_id",
  "  JOIN items it ON it.id = s.stock_item_id",
  "  WHERE v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL",
  "  GROUP BY s.stock_item_id",
  "), stock AS (",
  "  SELECT i.stock_item_id,",
  "    SUM(i.quantity::numeric) AS quantity,",
  "    SUM(i.total_value::numeric) AS value,",
  "    SUM(i.quantity::numeric * i.average_rate::numeric) AS rate_value,",
  "    SUM(CASE WHEN i.quantity < 0 THEN i.quantity::numeric ELSE 0 END) AS negative_qty",
  "  FROM inventory i JOIN items it ON it.id = i.stock_item_id",
  "  WHERE i.company_id = $1 GROUP BY i.stock_item_id",
  "), movements AS (",
  "  SELECT cm.stock_item_id,",
  "    SUM(cm.quantity_delta::numeric) AS canonical_qty,",
  "    SUM(CASE WHEN cm.source_type IN",
  "      ('stock-adjustment', 'stock_adjustment_edit_apply',",
  "       'stock_adjustment_edit_reverse', 'credit-note', 'voucher_delete_pos_sale')",
  "      THEN cm.quantity_delta::numeric ELSE 0 END) AS adjustment_qty,",
  "    SUM(CASE WHEN cm.source_type IN",
  "      ('stock-adjustment', 'stock_adjustment_edit_apply',",
  "       'stock_adjustment_edit_reverse', 'credit-note', 'voucher_delete_pos_sale')",
  "      THEN cm.quantity_delta::numeric * cm.unit_cost::numeric ELSE 0 END) AS adjustment_value",
  "  FROM canonical_stock_movements cm",
  "  JOIN items it ON it.id = cm.stock_item_id",
  "  WHERE cm.company_id = $1 GROUP BY cm.stock_item_id",
  ")",
  "SELECT it.id AS \"stockItemId\", it.code, it.name,",
  "  COALESCE(r.quantity, 0)::text AS \"purchasedQty\",",
  "  COALESCE(r.value, 0)::text AS \"landedCost\",",
  "  COALESCE(s.quantity, 0)::text AS \"soldQty\",",
  "  COALESCE(s.revenue, 0)::text AS revenue,",
  "  COALESCE(s.cost, 0)::text AS \"soldCost\",",
  "  COALESCE(s.stored_profit, 0)::text AS \"storedProfit\",",
  "  COALESCE(s.missing_relief_count, 0)::text AS \"missingReliefCount\",",
  "  COALESCE(s.sales_line_count, 0)::text AS \"salesLineCount\",",
  "  COALESCE(s.math_mismatch_count, 0)::text AS \"mathMismatchCount\",",
  "  COALESCE(st.quantity, 0)::text AS \"stockQty\",",
  "  COALESCE(st.value, 0)::text AS \"stockValue\",",
  "  COALESCE(st.rate_value, 0)::text AS \"stockRateValue\",",
  "  COALESCE(st.negative_qty, 0)::text AS \"negativeQty\",",
  "  COALESCE(m.adjustment_qty, 0)::text AS \"adjustmentQty\",",
  "  COALESCE(m.adjustment_value, 0)::text AS \"adjustmentValue\",",
  "  COALESCE(m.canonical_qty, 0)::text AS \"canonicalQty\"",
  "FROM items it",
  "LEFT JOIN receipts r ON r.stock_item_id = it.id",
  "LEFT JOIN sales s ON s.stock_item_id = it.id",
  "LEFT JOIN stock st ON st.stock_item_id = it.id",
  "LEFT JOIN movements m ON m.stock_item_id = it.id",
  "ORDER BY it.code, it.id"
].join("\n");

export function registerSupplierCostReconciliationRoutes(app: Express): void {
  app.get("/api/sales-report/supplier-reconciliation/options", requireAuth, requireNonPOS, PAGE, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const [suppliers, groups] = await Promise.all([
        pool.query(
          "SELECT id, legal_name AS name FROM suppliers WHERE company_id = $1 AND deleted_at IS NULL ORDER BY legal_name, id",
          [companyId]
        ),
        pool.query(
          "SELECT id, name FROM stock_groups WHERE company_id = $1 AND deleted_at IS NULL ORDER BY name, id",
          [companyId]
        ),
      ]);
      return res.json({ suppliers: suppliers.rows, stockGroups: groups.rows });
    } catch (error: unknown) {
      logger.error("Supplier reconciliation options failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sales-report/supplier-reconciliation", requireAuth, requireNonPOS, PAGE, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = positiveId(req.query.supplierId);
      const stockGroupId = positiveId(req.query.stockGroupId);
      if (!supplierId || !stockGroupId) {
        return res.status(400).json({ message: "Valid supplierId and stockGroupId are required" });
      }

      const [selection, containerTotals, result] = await Promise.all([
        pool.query(
          "SELECT s.legal_name AS \"supplierName\", g.name AS \"groupName\" FROM suppliers s CROSS JOIN stock_groups g WHERE s.company_id = $1 AND s.id = $2 AND s.deleted_at IS NULL AND g.company_id = $1 AND g.id = $3 AND g.deleted_at IS NULL",
          [companyId, supplierId, stockGroupId]
        ),
        pool.query(
          "SELECT COUNT(*)::int AS \"containerCount\", COALESCE(SUM(grand_total::numeric), 0)::text AS \"containerTotal\" FROM containers WHERE company_id = $1 AND supplier_id = $2 AND status = 'OFFLOADED' AND deleted_at IS NULL",
          [companyId, supplierId]
        ),
        pool.query<ReconciliationRow>(RECONCILIATION_SQL, [companyId, supplierId, stockGroupId]),
      ]);
      if (selection.rows.length !== 1) return res.status(404).json({ message: "Supplier or stock group not found in current company" });
      // Fail closed rather than silently produce a misleading partial report.
      if (result.rows.length > 5000) return res.status(413).json({ message: "Too many stock items for this report" });

      const total = {
        landedCost: ZERO, revenue: ZERO, soldCost: ZERO, storedProfit: ZERO,
        stockValue: ZERO, stockRateValue: ZERO, stockQty: ZERO,
        purchasedQty: ZERO, soldQty: ZERO, adjustmentQty: ZERO,
        salesLineCount: 0, missingReliefCount: 0, mathMismatchCount: 0,
        negativeStockItems: 0, qtyGapItems: 0, afterAdjustmentGapItems: 0,
      };
      const rows = result.rows.map((raw) => {
        const received = decimal(raw.purchasedQty);
        const sold = decimal(raw.soldQty);
        const inStock = decimal(raw.stockQty);
        const adjusted = decimal(raw.adjustmentQty);
        const purchaseCost = decimal(raw.landedCost);
        const soldCost = decimal(raw.soldCost);
        const stockValue = decimal(raw.stockValue);
        const qtyGap = received.minus(sold).minus(inStock);
        const afterAdjustmentQtyGap = qtyGap.plus(adjusted);
        const costGap = purchaseCost.minus(soldCost).minus(stockValue);

        total.landedCost = total.landedCost.plus(purchaseCost);
        total.revenue = total.revenue.plus(decimal(raw.revenue));
        total.soldCost = total.soldCost.plus(soldCost);
        total.storedProfit = total.storedProfit.plus(decimal(raw.storedProfit));
        total.stockValue = total.stockValue.plus(stockValue);
        total.stockRateValue = total.stockRateValue.plus(decimal(raw.stockRateValue));
        total.purchasedQty = total.purchasedQty.plus(received);
        total.soldQty = total.soldQty.plus(sold);
        total.stockQty = total.stockQty.plus(inStock);
        total.adjustmentQty = total.adjustmentQty.plus(adjusted);
        total.salesLineCount += Number(raw.salesLineCount);
        total.missingReliefCount += Number(raw.missingReliefCount);
        total.mathMismatchCount += Number(raw.mathMismatchCount);
        if (decimal(raw.negativeQty).isNegative()) total.negativeStockItems++;
        if (!qtyGap.isZero()) total.qtyGapItems++;
        if (!afterAdjustmentQtyGap.isZero()) total.afterAdjustmentGapItems++;
        return {
          stockItemId: raw.stockItemId, code: raw.code, name: raw.name,
          receivedQty: qty(received), soldQty: qty(sold), stockQty: qty(inStock),
          qtyGap: qty(qtyGap), adjustedQtyGap: qty(afterAdjustmentQtyGap),
          stockAdjustmentQty: qty(adjusted), canonicalMovementQty: qty(decimal(raw.canonicalQty)),
          landedCost: amount(purchaseCost), soldCost: amount(soldCost),
          stockValue: amount(stockValue), costGap: amount(costGap),
          missingReliefCount: Number(raw.missingReliefCount),
          mathMismatchCount: Number(raw.mathMismatchCount),
          negativeStockQty: qty(decimal(raw.negativeQty)),
        };
      });

      const manualCostOfSales = total.landedCost.minus(total.stockRateValue);
      const bookedProfit = total.revenue.minus(total.soldCost);
      const manualProfit = total.revenue.minus(manualCostOfSales);
      return res.json({
        readOnly: true,
        completeness: "partial",
        generatedAt: new Date().toISOString(),
        supplierId, stockGroupId,
        supplierName: selection.rows[0].supplierName,
        stockGroupName: selection.rows[0].groupName,
        basis: "Current inventory snapshot vs cumulative offloaded receipts and posted sales; not a historical as-of valuation",
        warnings: [
          "Stock group does not prove historical supplier attribution. Check opening stock and mixed-source products.",
          "Prior inventory receipts/reversals, stock adjustments, returns and historical cost changes may affect the gaps.",
          "Older sale lines without value_moved cannot be independently certified from their stored sale costs.",
          "Do not treat movement ledger totals as complete physical history without confirming legacy coverage.",
          "Manual profit uses current quantity × rounded average rate solely to match a manual worksheet; stored inventory uses total_value.",
        ],
        summary: {
          containerCount: Number(containerTotals.rows[0].containerCount),
          containerTotal: amount(decimal(containerTotals.rows[0].containerTotal)),
          receivedQty: qty(total.purchasedQty), soldQty: qty(total.soldQty), stockQty: qty(total.stockQty),
          landedCost: amount(total.landedCost),
          stockValue: amount(total.stockValue),
          stockRateValue: amount(total.stockRateValue),
          revenue: amount(total.revenue),
          recordedCostOfSales: amount(total.soldCost),
          storedProfit: amount(total.storedProfit),
          bookedProfit: amount(bookedProfit),
          storedProfitDifference: amount(total.storedProfit.minus(bookedProfit)),
          manualCostOfSales: amount(manualCostOfSales),
          manualProfit: amount(manualProfit),
          costGapUsingStoredInventory: amount(total.landedCost.minus(total.soldCost).minus(total.stockValue)),
          costGapUsingRateValuation: amount(total.landedCost.minus(total.soldCost).minus(total.stockRateValue)),
          adjustedQtyNet: qty(total.adjustmentQty),
          salesLineCount: total.salesLineCount,
          salesLinesMissingHistoricalRelief: total.missingReliefCount,
          arithmeticMismatchLines: total.mathMismatchCount,
          negativeStockItems: total.negativeStockItems,
          qtyGapItems: total.qtyGapItems,
          afterAdjustmentGapItems: total.afterAdjustmentGapItems,
        },
        items: rows,
      });
    } catch (error: unknown) {
      logger.error("Supplier cost reconciliation failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
