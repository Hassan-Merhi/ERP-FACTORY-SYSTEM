/**
 * Read-only ERP supplier profit bridge. Sales use the same recorded sales_items
 * figures and voucher dates as Sales Report. Receipt provenance is NOT proof
 * that a sale of a shared SKU came from one particular supplier.
 *
 * Stock / OTW are CURRENT snapshots, never reconstructed historical balances.
 * No write endpoints, accounting adjustments, or automatic balancing entries.
 */
import type { Express } from "express";
import { requireAuth, requireNonPOS } from "../../auth";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

const positiveId = (value: unknown): number | null =>
  typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const validDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const money = (value: unknown) => Number(Number(value ?? 0).toFixed(2));

type ItemRow = {
  id: number;
  code: string;
  name: string;
  group_name: string | null;
  qty_sold: string;
  revenue: string;
  cogs: string;
  stored_profit: string;
  received: string;
  quantity_received: string;
  stock: string;
  stock_qty: string;
  other_suppliers: number;
};

export function registerSupplierProfitReconciliationRoutes(app: Express) {
  app.get("/api/supplier-profit-reconciliation/options", requireAuth, requireNonPOS, async (req, res) => {
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
      const suppliers = await client.query(
        `
        SELECT DISTINCT s.id, s.legal_name AS name, s.stock_group_id
        FROM suppliers s JOIN containers c ON c.supplier_id = s.id
        WHERE c.company_id = $1 AND s.deleted_at IS NULL
        ORDER BY name, s.id
      `,
        [companyId]
      );
      const groups = await client.query(
        `
        SELECT id, name FROM stock_groups
        WHERE company_id = $1 AND deleted_at IS NULL ORDER BY name, id
      `,
        [companyId]
      );
      await client.query("ROLLBACK");
      return res.json({ suppliers: suppliers.rows, groups: groups.rows });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("Supplier profit options failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });

  app.get("/api/supplier-profit-reconciliation/report", requireAuth, requireNonPOS, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    const supplierId = positiveId(req.query.supplierId);
    const groupId = req.query.groupId === undefined || req.query.groupId === "" ? null : positiveId(req.query.groupId);
    if (!supplierId || (req.query.groupId && !groupId)) {
      return res.status(400).json({ message: "Choose a valid supplier and stock group" });
    }
    const from = req.query.startDate === undefined || req.query.startDate === "" ? null : req.query.startDate;
    const to = req.query.endDate === undefined || req.query.endDate === "" ? null : req.query.endDate;
    if (
      (from !== null && !validDate(from)) ||
      (to !== null && !validDate(to)) ||
      (typeof from === "string" && typeof to === "string" && from > to)
    ) {
      return res.status(400).json({ message: "Invalid date range" });
    }
    const grouping = req.query.grouping === "monthly" || req.query.grouping === "yearly" ? req.query.grouping : "daily";
    const bucketSql =
      grouping === "yearly"
        ? "TO_CHAR(v.voucher_date::date, 'YYYY')"
        : grouping === "monthly"
          ? "TO_CHAR(v.voucher_date::date, 'YYYY-MM')"
          : "TO_CHAR(v.voucher_date::date, 'YYYY-MM-DD')";
    const params = [companyId, supplierId, groupId, from, to];
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
      const owner = await client.query(
        `
        SELECT s.id, s.legal_name AS name
        FROM suppliers s WHERE s.id=$2 AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM containers c WHERE c.company_id=$1 AND c.supplier_id=s.id)
      `,
        [companyId, supplierId]
      );
      if (owner.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Supplier has no containers in this company" });
      }
      if (groupId) {
        const group = await client.query(
          "SELECT id FROM stock_groups WHERE id=$2 AND company_id=$1 AND deleted_at IS NULL",
          [companyId, groupId]
        );
        if (group.rowCount !== 1) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Stock group not in active company" });
        }
      }
      // Deliberately restrict to an item received from this supplier; no
      // fabricated attribution via the supplier's current default group.
      const eligible = `
        SELECT i.id, i.code, i.name, g.name AS group_name
        FROM stock_items i
        LEFT JOIN stock_groups g ON g.id=i.stock_group_id AND g.company_id=$1
        WHERE i.company_id=$1
          AND ($3::integer IS NULL OR i.stock_group_id=$3)
          AND EXISTS (
            SELECT 1 FROM container_offload_items oi
            JOIN container_offloads o ON o.id=oi.offload_id AND o.optional=false
            JOIN containers c ON c.id=o.container_id
            WHERE oi.stock_item_id=i.id AND c.company_id=$1 AND c.supplier_id=$2
          )
      `;
      const salesWhere = `
        v.company_id=$1 AND v.optional=false AND v.deleted_at IS NULL
        AND ($4::date IS NULL OR v.voucher_date::date >= $4::date)
        AND ($5::date IS NULL OR v.voucher_date::date <= $5::date)
      `;
      // All seven datasets share the same read-only transaction snapshot and active-company scope.
      const [summary, periods, saleDetails, offloads, otw, inventory, itemBreakdown] = await Promise.all([
        client.query(
          `
          WITH eligible AS MATERIALIZED (${eligible})
          SELECT COUNT(*)::int AS lines,
            COALESCE(SUM(s.total_sales::numeric),0)::text AS revenue,
            COALESCE(SUM(s.total_cost::numeric),0)::text AS cogs,
            COALESCE(SUM(s.profit::numeric),0)::text AS stored_profit,
            COALESCE(SUM(s.quantity::numeric),0)::text AS quantity
          FROM sales_items s JOIN vouchers v ON v.id=s.voucher_id
          JOIN eligible i ON i.id=s.stock_item_id WHERE v.company_id=$1 AND ${salesWhere}
        `,
          params
        ),
        client.query(
          `
          WITH eligible AS MATERIALIZED (${eligible})
          SELECT ${bucketSql} AS period,
            COUNT(*)::int AS lines,
            COALESCE(SUM(s.total_sales::numeric),0)::text AS revenue,
            COALESCE(SUM(s.total_cost::numeric),0)::text AS cogs,
            COALESCE(SUM(s.profit::numeric),0)::text AS stored_profit
          FROM sales_items s JOIN vouchers v ON v.id=s.voucher_id
          JOIN eligible i ON i.id=s.stock_item_id WHERE v.company_id=$1 AND ${salesWhere}
          GROUP BY 1 ORDER BY 1 DESC
        `,
          params
        ),
        client.query(
          `
          WITH eligible AS MATERIALIZED (${eligible})
          SELECT s.id, v.id AS voucher_id, v.voucher_number,
            v.voucher_date::date::text AS date, i.code, i.name,
            s.quantity::text AS quantity, s.total_sales::text AS revenue,
            s.total_cost::text AS cogs, s.profit::text AS stored_profit
          FROM sales_items s JOIN vouchers v ON v.id=s.voucher_id
          JOIN eligible i ON i.id=s.stock_item_id WHERE v.company_id=$1 AND ${salesWhere}
          ORDER BY v.voucher_date DESC, v.id DESC, s.id DESC LIMIT 300
        `,
          params
        ),
        client.query(
          `
          WITH eligible AS MATERIALIZED (${eligible})
          SELECT c.id, c.container_number, c.status,
            COALESCE(c.offload_date,o.offloaded_at::date)::text AS date,
            o.id AS offload_id,
            SUM(oi.quantity::numeric)::text AS quantity,
            SUM(oi.total_value::numeric)::text AS landed,
            (CASE WHEN COALESCE(o.total_bales::numeric,0)>0
              THEN (o.total_charges::numeric-COALESCE(c.charges_total::numeric,0))*SUM(oi.quantity::numeric)/o.total_bales::numeric
              ELSE 0 END)::text AS allocated_charges,
            (o.total_charges::numeric-COALESCE(c.charges_total::numeric,0))::text AS full_offload_charges
          FROM container_offload_items oi
          JOIN eligible i ON i.id=oi.stock_item_id
          JOIN container_offloads o ON o.id=oi.offload_id AND o.optional=false
          JOIN containers c ON c.id=o.container_id
          WHERE c.company_id=$1 AND c.supplier_id=$2 AND c.status='OFFLOADED'
          AND ($4::date IS NULL OR COALESCE(c.offload_date,o.offloaded_at::date) >= $4::date)
          AND ($5::date IS NULL OR COALESCE(c.offload_date,o.offloaded_at::date) <= $5::date)
          GROUP BY c.id,o.id
          ORDER BY date DESC,c.id DESC
        `,
          params
        ),
        client.query(
          `
          SELECT c.id, c.container_number, c.status, c.import_date::text AS date,
            COALESCE(NULLIF(c.grand_total::numeric,0),COALESCE(c.items_total,0)::numeric+COALESCE(c.charges_total,0)::numeric)::text AS base_amount
          FROM containers c
          WHERE c.company_id=$1 AND c.supplier_id=$2
            AND UPPER(c.status) IN ('OTW','PENDING')
          ORDER BY c.import_date DESC,c.id DESC
        `,
          params.slice(0, 2)
        ),
        client.query(
          `
          WITH eligible AS MATERIALIZED (${eligible})
          SELECT COALESCE(SUM(inv.quantity::numeric),0)::text AS quantity,
            COALESCE(SUM(inv.total_value::numeric),0)::text AS value
          FROM inventory inv JOIN eligible i ON i.id=inv.stock_item_id
          WHERE inv.company_id=$1
        `,
          params.slice(0, 3)
        ),
        client.query(
          `
          WITH eligible AS MATERIALIZED (${eligible}),
          sold AS (
            SELECT s.stock_item_id, SUM(s.quantity::numeric) qty, SUM(s.total_sales::numeric) revenue,
                   SUM(s.total_cost::numeric) cogs, SUM(s.profit::numeric) stored_profit
            FROM sales_items s JOIN vouchers v ON v.id=s.voucher_id
            JOIN eligible i ON i.id=s.stock_item_id WHERE v.company_id=$1 AND ${salesWhere}
            GROUP BY s.stock_item_id
          ), received AS (
            SELECT oi.stock_item_id, SUM(oi.quantity::numeric) qty, SUM(oi.total_value::numeric) cost
            FROM container_offload_items oi
            JOIN container_offloads o ON o.id=oi.offload_id AND o.optional=false
            JOIN containers c ON c.id=o.container_id
            JOIN eligible i ON i.id=oi.stock_item_id
            WHERE c.company_id=$1 AND c.supplier_id=$2 AND c.status='OFFLOADED'
            AND ($4::date IS NULL OR COALESCE(c.offload_date,o.offloaded_at::date)>=$4::date)
            AND ($5::date IS NULL OR COALESCE(c.offload_date,o.offloaded_at::date)<=$5::date)
            GROUP BY oi.stock_item_id
          ), stock AS (
            SELECT inv.stock_item_id, SUM(inv.quantity::numeric) qty, SUM(inv.total_value::numeric) val
            FROM inventory inv JOIN eligible i ON i.id=inv.stock_item_id
            WHERE inv.company_id=$1 GROUP BY inv.stock_item_id
          ), sources AS (
            SELECT oi.stock_item_id, COUNT(DISTINCT c.supplier_id)::int AS total
            FROM container_offload_items oi JOIN container_offloads o ON o.id=oi.offload_id AND o.optional=false
            JOIN containers c ON c.id=o.container_id AND c.company_id=$1
            JOIN eligible i ON i.id=oi.stock_item_id GROUP BY oi.stock_item_id
          )
          SELECT i.id, i.code, i.name, i.group_name,
            COALESCE(s.qty,0)::text qty_sold, COALESCE(s.revenue,0)::text revenue,
            COALESCE(s.cogs,0)::text cogs, COALESCE(s.stored_profit,0)::text stored_profit,
            COALESCE(r.cost,0)::text received, COALESCE(r.qty,0)::text quantity_received,
            COALESCE(st.val,0)::text stock, COALESCE(st.qty,0)::text stock_qty,
            GREATEST(COALESCE(src.total,0)-1,0)::int other_suppliers
          FROM eligible i LEFT JOIN sold s ON s.stock_item_id=i.id
          LEFT JOIN received r ON r.stock_item_id=i.id
          LEFT JOIN stock st ON st.stock_item_id=i.id
          LEFT JOIN sources src ON src.stock_item_id=i.id
          ORDER BY ABS(COALESCE(r.cost,0)-COALESCE(s.cogs,0)-COALESCE(st.val,0)) DESC,i.code
          LIMIT 1000
        `,
          params
        ),
      ]);
      await client.query("ROLLBACK");
      const totals = summary.rows[0] ?? {};
      const inStock = inventory.rows[0] ?? {};
      const offloadRows = offloads.rows.map((r) => ({
        offloadId: r.offload_id,
        containerId: r.id,
        number: r.container_number,
        date: r.date,
        status: r.status,
        quantity: Number(r.quantity),
        landed: money(r.landed),
        offloadingCost: money(r.allocated_charges),
        baseCost: money(Number(r.landed) - Number(r.allocated_charges)),
        fullOffloadCharges: money(r.full_offload_charges),
      }));
      const landed = money(offloadRows.reduce((sum, r) => sum + r.landed, 0));
      const expenses = money(offloadRows.reduce((sum, r) => sum + r.offloadingCost, 0));
      const revenue = money(totals.revenue),
        cogs = money(totals.cogs),
        storedProfit = money(totals.stored_profit),
        stockValue = money(inStock.value);
      const itemRows = (itemBreakdown.rows as ItemRow[]).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        group: r.group_name,
        soldQty: Number(r.qty_sold),
        revenue: money(r.revenue),
        cogs: money(r.cogs),
        storedProfit: money(r.stored_profit),
        receivedQty: Number(r.quantity_received),
        received: money(r.received),
        stockQty: Number(r.stock_qty),
        currentStockValue: money(r.stock),
        supplierCount: Number(r.other_suppliers) + 1,
        gap: money(Number(r.received) - Number(r.cogs) - Number(r.stock)),
      }));
      return res.json({
        readOnly: true,
        companyId,
        supplier: owner.rows[0],
        groupId,
        dateRange: { from, to },
        grouping,
        sourceBasis: {
          sales: "Saved sales_items amounts with Sales Report voucher_date and current stock-item group mapping",
          offloads:
            "Saved container_offload_items.total_value; offloading charges exclude supplier PO charges and allocate by received-bale share",
          inventory: "Current inventory.total_value, never reconstructed as historical",
          otw:
            "Current containers.grand_total (or item plus PO charges) for OTW/PENDING; never included in realized profit",
          attribution:
            "Item appeared in receipts from this supplier; mixed-source SKUs cannot prove which supplier sold units came from",
        },
        totals: {
          salesRevenue: revenue,
          recordedCogs: cogs,
          storedProfit,
          salesReportProfit: money(revenue - cogs),
          roundingGap: money(revenue - cogs - storedProfit),
          quantitySold: Number(totals.quantity ?? 0),
          saleLines: Number(totals.lines ?? 0),
          offloadedLanded: landed,
          offloadingCharges: expenses,
          offloadedBase: money(landed - expenses),
          currentStock: stockValue,
          currentStockQuantity: Number(inStock.quantity ?? 0),
          otwBase: money(otw.rows.reduce((sum, r) => sum + Number(r.base_amount ?? 0), 0)),
          otwContainers: otw.rows.length,
          offloadedContainers: offloadRows.length,
          modeledProfit: money(revenue - landed + stockValue),
          modeledVsRecordedGap: money(revenue - landed + stockValue - storedProfit),
        },
        periods: periods.rows.map((r) => ({
          period: r.period,
          revenue: money(r.revenue),
          cogs: money(r.cogs),
          salesReportProfit: money(Number(r.revenue) - Number(r.cogs)),
          storedProfit: money(r.stored_profit),
          lines: Number(r.lines),
        })),
        saleDetails: saleDetails.rows.map((r) => ({
          id: r.id,
          voucherId: r.voucher_id,
          voucher: r.voucher_number,
          date: r.date,
          code: r.code,
          name: r.name,
          qty: Number(r.quantity),
          revenue: money(r.revenue),
          cogs: money(r.cogs),
          storedProfit: money(r.stored_profit),
        })),
        detailsTruncated: Number(totals.lines ?? 0) > 300,
        offloads: offloadRows,
        otw: otw.rows.map((r) => ({
          id: r.id,
          number: r.container_number,
          date: r.date,
          status: r.status,
          base: money(r.base_amount),
        })),
        items: itemRows,
        itemsTruncated: itemRows.length === 1000,
        warnings: [
          "Item-level supplier attribution is based on goods received, not traceable sale lots; profit is a comparison, not a certified supplier figure.",
          ...(itemRows.some((r) => r.supplierCount > 1)
            ? [
                "Some stock items have receipts from more than one supplier. Their sales cannot be attributed definitively without a historical lot link.",
              ]
            : []),
          ...(from || to
            ? [
                "Profit uses selected sale dates. Stock and OTW are current snapshots; modeled profit must NOT be compared to a filtered period.",
              ]
            : []),
          "The modeled all-time bridge excludes opening stock, transfers, returns, edits and non-supplier receipts; inspect item gaps before treating it as final.",
          "Supplier payable is an independent ledger balance, not the sum of OTW or container purchase amounts.",
        ],
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      logger.error("Supplier profit reconciliation failed", { error });
      return res.status(500).json({ message: getErrorMessage(error) });
    } finally {
      client.release();
    }
  });
}
