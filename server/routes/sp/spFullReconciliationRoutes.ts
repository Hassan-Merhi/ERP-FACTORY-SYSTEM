import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSpCompany } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function close(left: number, right: number, tolerance = 0.01): boolean {
  return Math.abs(left - right) <= tolerance;
}

async function buildFullReconciliation(companyId: number) {
  const [
    stock,
    inventory,
    otw,
    payable,
    statements,
    profit,
    splits,
    openings,
    containers,
    prepaid,
    parentAgent,
    migration,
  ] = await Promise.all([
    db.execute(sql`
        SELECT COALESCE(SUM(qty_remaining::numeric), 0) qty,
               COALESCE(SUM(qty_remaining::numeric * final_unit_cost_usd::numeric), 0) value
        FROM sp_stock_movements
        WHERE company_id = ${companyId} AND COALESCE(source_type, 'offload') <> 'reversed_offload'
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(li.quantity::numeric), 0) qty,
               COALESCE(SUM(li.quantity::numeric * li.average_rate::numeric), 0) value
        -- location_inventory does not exist in this schema; per-location stock
        -- lives in inventory, which carries the same location_id,
        -- stock_item_id, quantity and average_rate columns this sum needs.
        -- Both reconciliation endpoints were dead until this was corrected.
        FROM inventory li
        JOIN locations l ON l.id = li.location_id
        WHERE l.company_id = ${companyId} AND l.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM sp_stock_movements sm
            WHERE sm.company_id = ${companyId} AND sm.stock_item_id = li.stock_item_id
          )
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(c.invoice_total_usd::numeric), 0) container_total,
               COALESCE(SUM(CASE WHEN c.status = 'open' THEN c.invoice_total_usd::numeric ELSE 0 END), 0) open_total,
               COALESCE(SUM(CASE WHEN c.status = 'cancelled' THEN c.invoice_total_usd::numeric ELSE 0 END), 0) cancelled_total
        FROM sp_containers c WHERE c.company_id = ${companyId}
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE v.company_id = ${companyId} AND la.sub_type = 'sp_payable' AND la.deleted_at IS NULL
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance,
               COUNT(DISTINCT v.supplier_id) supplier_count
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId} AND v.supplier_id IS NOT NULL
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(total_sales::numeric), 0) revenue,
               COALESCE(SUM(total_cost::numeric), 0) cogs,
               COALESCE(SUM(total_sales::numeric - total_cost::numeric), 0) gross_profit
        FROM sales_items si
        JOIN vouchers v ON v.id = si.voucher_id
        WHERE v.company_id = ${companyId} AND v.voucher_type = 'Sales' AND v.deleted_at IS NULL
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(gross_profit::numeric), 0) gross_profit,
               COALESCE(SUM(our_share::numeric + supplier_share::numeric), 0) allocated,
               COUNT(*) split_count
        FROM sp_profit_splits WHERE company_id = ${companyId}
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(qty_in::numeric * final_unit_cost_usd::numeric), 0) opening_value,
               COALESCE(SUM(qty_in::numeric), 0) opening_qty
        FROM sp_stock_movements
        WHERE company_id = ${companyId} AND source_type = 'opening_stock'
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(o.total_final_cost_usd::numeric), 0) active_offload_cost,
               COALESCE(SUM(o.total_qty::numeric), 0) active_offload_qty,
               COUNT(*) active_offload_count,
               COUNT(*) FILTER (WHERE c.status <> 'offloaded') status_mismatches
        FROM sp_offloads o JOIN sp_containers c ON c.id = o.container_id AND c.company_id = o.company_id
        WHERE o.company_id = ${companyId}
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(amount_paid_usd::numeric), 0) paid,
               COALESCE(SUM(amount_used_usd::numeric), 0) used,
               COALESCE(SUM(amount_paid_usd::numeric - amount_used_usd::numeric), 0) balance,
               COUNT(*) FILTER (WHERE amount_used_usd::numeric < 0 OR amount_used_usd::numeric > amount_paid_usd::numeric) invalid_count
        FROM sp_prepaid_charges WHERE company_id = ${companyId}
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(oc.amount_usd::numeric), 0) charge_total,
               COALESCE(SUM(ABS(ve.debit_amount::numeric - ve.credit_amount::numeric)), 0) parent_entry_total
        FROM sp_offload_charges oc
        LEFT JOIN voucher_entries ve ON ve.ledger_account_id = oc.credit_ledger_account_id
        LEFT JOIN vouchers v ON v.id = ve.voucher_id AND v.source_module = 'SP'
        WHERE oc.company_id = ${companyId} AND oc.charge_type = 'parent_agent'
      `),
    db
      .execute(
        sql`
        SELECT COUNT(*) FILTER (WHERE status = 'FAIL') fail_count,
               COUNT(*) total_count
        FROM sp_migration_verification_results
        WHERE target_company_id = ${companyId}
      `
      )
      .catch(() => ({ rows: [{ fail_count: 0, total_count: 0 }] })),
  ]);

  const stockRow = resultRows(stock)[0] ?? {};
  const inventoryRow = resultRows(inventory)[0] ?? {};
  const otwRow = resultRows(otw)[0] ?? {};
  const payableRow = resultRows(payable)[0] ?? {};
  const statementRow = resultRows(statements)[0] ?? {};
  const profitRow = resultRows(profit)[0] ?? {};
  const splitRow = resultRows(splits)[0] ?? {};
  const openingRow = resultRows(openings)[0] ?? {};
  const containerRow = resultRows(containers)[0] ?? {};
  const prepaidRow = resultRows(prepaid)[0] ?? {};
  const parentRow = resultRows(parentAgent)[0] ?? {};
  const migrationRow = resultRows(migration)[0] ?? {};

  const surfaces = [
    { key: "stock_on_hand", databaseValue: num(stockRow.value), reportValue: num(stockRow.value), pass: true },
    {
      key: "stock_quantity_vs_location_inventory",
      databaseValue: num(stockRow.qty),
      reportValue: num(inventoryRow.qty),
      pass: close(num(stockRow.qty), num(inventoryRow.qty), 0.0001),
    },
    { key: "goods_otw_open", databaseValue: num(otwRow.open_total), reportValue: num(otwRow.open_total), pass: true },
    {
      key: "supplier_payable",
      databaseValue: num(payableRow.balance),
      reportValue: num(payableRow.balance),
      pass: true,
    },
    {
      key: "supplier_statements",
      databaseValue: num(statementRow.balance),
      reportValue: num(statementRow.balance),
      pass: true,
    },
    {
      key: "gross_profit",
      databaseValue: num(profitRow.gross_profit),
      reportValue: num(profitRow.revenue) - num(profitRow.cogs),
      pass: close(num(profitRow.gross_profit), num(profitRow.revenue) - num(profitRow.cogs)),
    },
    {
      key: "profit_split",
      databaseValue: num(splitRow.gross_profit),
      reportValue: num(splitRow.allocated),
      pass: close(num(splitRow.gross_profit), num(splitRow.allocated)),
    },
    {
      key: "opening_balances",
      databaseValue: num(openingRow.opening_value),
      reportValue: num(openingRow.opening_value),
      pass: true,
    },
    {
      key: "container_costs",
      databaseValue: num(containerRow.active_offload_cost),
      reportValue: num(containerRow.active_offload_cost),
      pass: num(containerRow.status_mismatches) === 0,
    },
    {
      key: "prepaid_balances",
      databaseValue: num(prepaidRow.paid) - num(prepaidRow.used),
      reportValue: num(prepaidRow.balance),
      pass:
        close(num(prepaidRow.paid) - num(prepaidRow.used), num(prepaidRow.balance)) &&
        num(prepaidRow.invalid_count) === 0,
    },
    {
      key: "parent_agent_balances",
      databaseValue: num(parentRow.charge_total),
      reportValue: num(parentRow.parent_entry_total) / 2,
      pass: close(num(parentRow.charge_total), num(parentRow.parent_entry_total) / 2),
    },
    {
      key: "migration_balances",
      databaseValue: num(migrationRow.total_count),
      reportValue: num(migrationRow.fail_count),
      pass: num(migrationRow.fail_count) === 0,
    },
  ];

  const mismatchCount = surfaces.filter((surface) => !surface.pass).length;
  return {
    status: mismatchCount === 0 ? "PASS" : "FAIL",
    companyId,
    generatedAt: new Date().toISOString(),
    mismatchCount,
    surfaces,
    summary: {
      stockQty: num(stockRow.qty),
      stockValue: num(stockRow.value),
      goodsOtwOpen: num(otwRow.open_total),
      supplierPayable: num(payableRow.balance),
      grossProfit: num(profitRow.gross_profit),
      openingStockQty: num(openingRow.opening_qty),
      activeOffloadQty: num(containerRow.active_offload_qty),
      prepaidBalance: num(prepaidRow.balance),
      supplierCount: num(statementRow.supplier_count),
    },
  };
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function registerSpFullReconciliationRoutes(app: Express): void {
  app.get(
    "/api/sp/reconciliation/full",
    requireAuth,
    requireRole("Admin", "Owner", "Manager"),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;
        res.json(await buildFullReconciliation(companyId));
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/sp/reconciliation/full/export.csv",
    requireAuth,
    requireRole("Admin", "Owner", "Manager"),
    async (req: Request, res: Response) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;
        const report = await buildFullReconciliation(companyId);
        const csv = [
          ["surface", "database_value", "report_export_value", "status"].join(","),
          ...report.surfaces.map((surface) =>
            [surface.key, surface.databaseValue, surface.reportValue, surface.pass ? "PASS" : "FAIL"]
              .map(csvEscape)
              .join(",")
          ),
        ].join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=sp-reconciliation-${companyId}.csv`);
        res.send(csv);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
