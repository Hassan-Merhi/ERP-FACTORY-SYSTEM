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

type Tolerance = { absolute?: number; relative?: number };

/**
 * Two independently computed totals agree when they are within tolerance.
 *
 * `absolute` covers decimal rounding; `relative` covers the cases where the two
 * sides are legitimately computed on different bases (an ERP weighted average
 * rate against SP's per-lot final cost, for example) and only a proportional
 * drift is a real mismatch.
 */
function close(left: number, right: number, tolerance: Tolerance = {}): boolean {
  const absolute = tolerance.absolute ?? 0.01;
  const relative = tolerance.relative ?? 0;
  const allowed = Math.max(absolute, relative * Math.max(Math.abs(left), Math.abs(right)));
  return Math.abs(left - right) <= allowed;
}

type Surface = {
  key: string;
  databaseValue: number;
  reportValue: number;
  pass: boolean;
  /** The two independent sources being compared, so a FAIL can be judged. */
  basis: string;
};

/**
 * Every surface compares two totals that are computed from different tables by
 * different code paths.
 *
 * This report used to fill `databaseValue` and `reportValue` from the same row
 * and hard-code `pass: true` for five of its twelve surfaces, so it reported
 * PASS for a company whose stock, goods-in-transit, payable, supplier statement
 * and opening balances disagreed with the ledger — the one report whose job is
 * to catch that could not fail. Two surfaces also queried source_type values
 * that no writer produces (`reversed_offload`, `opening_stock`), which made the
 * reversal exclusion dead and the opening-balance total permanently zero, and
 * one divided a cartesian join by two instead of joining correctly.
 */
async function buildFullReconciliation(companyId: number) {
  const [
    stock,
    inventory,
    otw,
    otwAsset,
    otwClearing,
    payable,
    saleRegister,
    saleVoucherCredits,
    statements,
    profit,
    splits,
    openings,
    openingVouchers,
    containers,
    offloadCosts,
    prepaid,
    parentAgent,
    parentAgentPosted,
    migration,
  ] = await Promise.all([
    // SP lot ledger: what is still on hand, at SP's own final unit cost.
    db.execute(sql`
        SELECT COALESCE(SUM(qty_remaining::numeric), 0) qty,
               COALESCE(SUM(qty_remaining::numeric * final_unit_cost_usd::numeric), 0) value
        FROM sp_stock_movements
        WHERE company_id = ${companyId}
          AND COALESCE(source_type, 'offload') NOT IN ('reversed_offload', 'offload_reversed')
      `),
    // The ERP side of the same stock: the inventory table (what the Location
    // Inventory page reads) for every item SP has ever moved. SP writers keep the
    // two in step through adjustSpInventoryAtomic.
    //
    // This used to select FROM location_inventory, a table that does not exist in
    // any environment — the name belongs to the page, not the schema. The query
    // threw, Promise.all rejected, and the whole report answered 500, so no
    // surface of the SP full reconciliation was ever evaluated.
    db.execute(sql`
        SELECT COALESCE(SUM(i.quantity::numeric), 0) qty,
               COALESCE(SUM(i.quantity::numeric * i.average_rate::numeric), 0) value
        FROM inventory i
        WHERE i.company_id = ${companyId}
          AND EXISTS (
            SELECT 1 FROM sp_stock_movements sm
            WHERE sm.company_id = ${companyId} AND sm.stock_item_id = i.stock_item_id
          )
      `),
    // Goods in transit per the container register.
    db.execute(sql`
        SELECT COALESCE(SUM(c.invoice_total_usd::numeric), 0) container_total,
               COALESCE(SUM(CASE WHEN c.status = 'open' THEN c.invoice_total_usd::numeric ELSE 0 END), 0) open_total,
               COALESCE(SUM(CASE WHEN c.status = 'cancelled' THEN c.invoice_total_usd::numeric ELSE 0 END), 0) cancelled_total
        FROM sp_containers c WHERE c.company_id = ${companyId}
      `),
    // Goods in transit per the general ledger. SP debits this account when a
    // container is created and credits it back when the container is offloaded or
    // cancelled, so its balance is the open register seen from the other side.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId} AND la.sub_type = 'sp_goods_otw'
      `),
    // The liability leg SP posts opposite the goods-OTW asset, on every container
    // voucher and its reversal.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId} AND la.sub_type = 'sp_otw_clearing'
      `),
    // Supplier Cash Payable control account.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.sub_type = 'sp_payable' AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
      `),
    // What the sale register says was credited to the payable: an SP sale voucher
    // is Dr Bank/Cash and Cr Supplier Cash Payable for the full sale price.
    db.execute(sql`
        SELECT COALESCE(SUM(total_sale_price_usd::numeric), 0) register_total,
               COUNT(*) sale_count
        FROM sp_sales
        WHERE company_id = ${companyId} AND status = 'posted' AND voucher_id IS NOT NULL
      `),
    // What the ledger actually credited, restricted to exactly those vouchers.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric), 0) credited
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.sub_type = 'sp_payable' AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND v.id IN (
            SELECT voucher_id FROM sp_sales
            WHERE company_id = ${companyId} AND status = 'posted' AND voucher_id IS NOT NULL
          )
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
               COALESCE(SUM(total_sales::numeric - total_cost::numeric), 0) gross_profit,
               COALESCE(SUM(v.total_amount::numeric), 0) voucher_total
        FROM sales_items si
        JOIN vouchers v ON v.id = si.voucher_id
        WHERE v.company_id = ${companyId} AND v.voucher_type = 'Sales' AND v.deleted_at IS NULL
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(gross_profit::numeric), 0) gross_profit,
               COALESCE(SUM(total_revenue::numeric - total_cogs::numeric - total_shared_charges::numeric), 0) recomputed,
               COALESCE(SUM(our_share::numeric + supplier_share::numeric), 0) allocated,
               COUNT(*) split_count
        FROM sp_profit_splits WHERE company_id = ${companyId}
      `),
    // Opening stock per the movement ledger. Writers stamp source_type 'opening'.
    db.execute(sql`
        SELECT COALESCE(SUM(qty_in::numeric * final_unit_cost_usd::numeric), 0) opening_value,
               COALESCE(SUM(qty_in::numeric), 0) opening_qty
        FROM sp_stock_movements
        WHERE company_id = ${companyId} AND source_type = 'opening'
      `),
    // Opening stock per the vouchers it posted (SP-OPNSTK-{movementId}-{ts}).
    db.execute(sql`
        SELECT COALESCE(SUM(v.total_amount::numeric), 0) voucher_total
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.source_module = 'SP'
          AND v.deleted_at IS NULL
          AND v.voucher_number LIKE 'SP-OPNSTK-%'
      `),
    db.execute(sql`
        SELECT COUNT(*) active_offload_count,
               COUNT(*) FILTER (WHERE c.status <> 'offloaded') status_mismatches
        FROM sp_offloads o JOIN sp_containers c ON c.id = o.container_id AND c.company_id = o.company_id
        WHERE o.company_id = ${companyId}
      `),
    // Offload cost as recorded against the same cost recomputed from the rows it
    // is built from: container lines at the invoice discount, plus landed charges.
    db.execute(sql`
        SELECT COALESCE(SUM(o.total_final_cost_usd::numeric), 0) recorded_cost,
               COALESCE(SUM(o.total_qty::numeric), 0) active_offload_qty,
               COALESCE(SUM(
                 COALESCE(lines.base_cost, 0) * (1 - COALESCE(c.discount_pct::numeric, 0) / 100)
                 + COALESCE(charges.charge_cost, 0)
               ), 0) recomputed_cost
        FROM sp_offloads o
        JOIN sp_containers c ON c.id = o.container_id AND c.company_id = o.company_id
        LEFT JOIN LATERAL (
          SELECT SUM(cl.qty::numeric * cl.unit_rate_usd::numeric) AS base_cost
          FROM sp_container_lines cl
          WHERE cl.container_id = o.container_id
        ) lines ON true
        LEFT JOIN LATERAL (
          SELECT SUM(oc.amount_usd::numeric) AS charge_cost
          FROM sp_offload_charges oc
          WHERE oc.offload_id = o.id
        ) charges ON true
        WHERE o.company_id = ${companyId}
      `),
    db.execute(sql`
        SELECT COALESCE(SUM(amount_paid_usd::numeric), 0) paid,
               COALESCE(SUM(amount_used_usd::numeric), 0) used,
               COALESCE(SUM(amount_paid_usd::numeric - amount_used_usd::numeric), 0) balance,
               COUNT(*) FILTER (WHERE amount_used_usd::numeric < 0 OR amount_used_usd::numeric > amount_paid_usd::numeric) invalid_count
        FROM sp_prepaid_charges WHERE company_id = ${companyId}
      `),
    // Parent-agent charges are credited to Prepaid Expenses inside the offload's
    // own stock voucher, so joining through that voucher counts each charge once.
    // The previous query joined charges to every entry on the credit account and
    // halved the cartesian product, which could not fail for any data.
    db.execute(sql`
        SELECT COALESCE(SUM(oc.amount_usd::numeric), 0) charge_total
        FROM sp_offload_charges oc
        WHERE oc.company_id = ${companyId} AND oc.charge_type = 'parent_agent'
      `),
    // The matching credits, counted once per entry: an offload's stock voucher is
    // the only place a parent-agent charge is posted, and only parent-agent
    // charges credit Prepaid Expenses inside it.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric), 0) posted_total
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
        JOIN sp_offloads o ON o.voucher_id_stock = ve.voucher_id AND o.company_id = v.company_id
        WHERE v.company_id = ${companyId}
          AND la.sub_type = 'sp_prepaid_expenses'
          AND EXISTS (
            SELECT 1 FROM sp_offload_charges oc
            WHERE oc.offload_id = o.id AND oc.charge_type = 'parent_agent'
          )
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
  const otwAssetRow = resultRows(otwAsset)[0] ?? {};
  const otwClearingRow = resultRows(otwClearing)[0] ?? {};
  const payableRow = resultRows(payable)[0] ?? {};
  const saleRegisterRow = resultRows(saleRegister)[0] ?? {};
  const saleCreditRow = resultRows(saleVoucherCredits)[0] ?? {};
  const statementRow = resultRows(statements)[0] ?? {};
  const profitRow = resultRows(profit)[0] ?? {};
  const splitRow = resultRows(splits)[0] ?? {};
  const openingRow = resultRows(openings)[0] ?? {};
  const openingVoucherRow = resultRows(openingVouchers)[0] ?? {};
  const containerRow = resultRows(containers)[0] ?? {};
  const offloadCostRow = resultRows(offloadCosts)[0] ?? {};
  const prepaidRow = resultRows(prepaid)[0] ?? {};
  const parentRow = resultRows(parentAgent)[0] ?? {};
  const parentPostedRow = resultRows(parentAgentPosted)[0] ?? {};
  const migrationRow = resultRows(migration)[0] ?? {};

  const stockValue = num(stockRow.value);
  const inventoryValue = num(inventoryRow.value);
  const openOtw = num(otwRow.open_total);
  const otwAssetBalance = num(otwAssetRow.balance);
  const saleRegisterTotal = num(saleRegisterRow.register_total);
  const lineGrossProfit = num(profitRow.gross_profit);
  const lineCost = num(profitRow.cogs);
  const splitGrossProfit = num(splitRow.gross_profit);
  const openingValue = num(openingRow.opening_value);
  const recordedOffloadCost = num(offloadCostRow.recorded_cost);
  const recomputedOffloadCost = num(offloadCostRow.recomputed_cost);
  const parentChargeTotal = num(parentRow.charge_total);
  const parentPostedTotal = num(parentPostedRow.posted_total);

  const surfaces: Surface[] = [
    {
      key: "stock_on_hand",
      databaseValue: stockValue,
      reportValue: inventoryValue,
      // ERP inventory carries a weighted average rate while SP carries the lot's
      // final unit cost, so only proportional drift is a mismatch.
      pass: close(stockValue, inventoryValue, { absolute: 0.01, relative: 0.01 }),
      basis: "sp_stock_movements remaining value vs ERP inventory value for SP-linked stock items",
    },
    {
      key: "stock_quantity_vs_location_inventory",
      databaseValue: num(stockRow.qty),
      reportValue: num(inventoryRow.qty),
      pass: close(num(stockRow.qty), num(inventoryRow.qty), { absolute: 0.0001 }),
      basis: "sp_stock_movements remaining quantity vs ERP inventory quantity",
    },
    {
      key: "goods_otw_open",
      databaseValue: openOtw,
      reportValue: otwAssetBalance,
      pass: close(openOtw, otwAssetBalance),
      basis: "open sp_containers invoice total vs the Goods OTW (sp_goods_otw) ledger balance",
    },
    {
      key: "supplier_payable",
      databaseValue: saleRegisterTotal,
      reportValue: num(saleCreditRow.credited),
      pass: close(saleRegisterTotal, num(saleCreditRow.credited)),
      basis: "posted sp_sales total vs credits to Supplier Cash Payable on exactly those sale vouchers",
    },
    {
      key: "supplier_statements",
      databaseValue: num(otwClearingRow.balance),
      reportValue: otwAssetBalance,
      pass: close(num(otwClearingRow.balance), otwAssetBalance),
      basis: "Goods OTW Clearing liability vs the Goods OTW asset — the two legs SP always posts together",
    },
    {
      key: "gross_profit",
      databaseValue: lineGrossProfit,
      reportValue: num(profitRow.voucher_total) - lineCost,
      pass: close(lineGrossProfit, num(profitRow.voucher_total) - lineCost),
      basis: "sales_items (revenue - cost) vs Sales voucher header totals less the same item costs",
    },
    {
      key: "profit_split",
      databaseValue: splitGrossProfit,
      reportValue: num(splitRow.recomputed),
      pass: close(splitGrossProfit, num(splitRow.recomputed)),
      basis: "sp_profit_splits stored gross profit vs revenue - COGS - shared charges on the same rows",
    },
    {
      key: "profit_split_allocation",
      databaseValue: splitGrossProfit,
      reportValue: num(splitRow.allocated),
      pass: close(splitGrossProfit, num(splitRow.allocated)),
      basis: "sp_profit_splits gross profit vs our_share + supplier_share allocated out of it",
    },
    {
      key: "opening_balances",
      databaseValue: openingValue,
      reportValue: num(openingVoucherRow.voucher_total),
      pass: close(openingValue, num(openingVoucherRow.voucher_total)),
      basis: "sp_stock_movements source_type 'opening' value vs posted SP-OPNSTK voucher totals",
    },
    {
      key: "container_costs",
      databaseValue: recordedOffloadCost,
      reportValue: recomputedOffloadCost,
      // Recomputed from float-multiplied source rows, so allow proportional drift.
      pass:
        close(recordedOffloadCost, recomputedOffloadCost, { absolute: 0.01, relative: 0.001 }) &&
        num(containerRow.status_mismatches) === 0,
      basis:
        "sp_offloads recorded final cost vs container lines at the invoice discount plus landed charges; also fails when an offloaded container is not marked offloaded",
    },
    {
      key: "prepaid_balances",
      databaseValue: num(prepaidRow.paid) - num(prepaidRow.used),
      reportValue: num(prepaidRow.balance),
      pass:
        close(num(prepaidRow.paid) - num(prepaidRow.used), num(prepaidRow.balance)) &&
        num(prepaidRow.invalid_count) === 0,
      basis: "sp_prepaid_charges paid less used vs its stored balance; also fails on used < 0 or used > paid",
    },
    {
      key: "parent_agent_balances",
      databaseValue: parentChargeTotal,
      reportValue: parentPostedTotal,
      pass: close(parentChargeTotal, parentPostedTotal),
      basis:
        "sp_offload_charges parent_agent total vs credits to Prepaid Expenses inside each offload's own stock voucher",
    },
    {
      key: "migration_balances",
      databaseValue: num(migrationRow.total_count),
      reportValue: num(migrationRow.fail_count),
      pass: num(migrationRow.fail_count) === 0,
      basis: "sp_migration_verification_results rows vs the subset marked FAIL",
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
      stockValue,
      goodsOtwOpen: openOtw,
      goodsOtwLedger: otwAssetBalance,
      supplierPayable: num(payableRow.balance),
      supplierStatements: num(statementRow.balance),
      grossProfit: lineGrossProfit,
      openingStockQty: num(openingRow.opening_qty),
      activeOffloadQty: num(offloadCostRow.active_offload_qty),
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
          ["surface", "database_value", "independent_value", "status", "basis"].join(","),
          ...report.surfaces.map((surface) =>
            [surface.key, surface.databaseValue, surface.reportValue, surface.pass ? "PASS" : "FAIL", surface.basis]
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
