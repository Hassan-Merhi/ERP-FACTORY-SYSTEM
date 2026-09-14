import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSpCompany } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";
import { buildFinalMigrationVerification } from "./spMigrationPhase4Verification";

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type Tolerance = { absolute?: number; relative?: number };
type EvidenceStatus = "PASS" | "WARN" | "FAIL" | "NOT_APPLICABLE" | "UNAVAILABLE";

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
  /** Used when a surface has evidence semantics beyond a simple numeric pass/fail. */
  evidenceStatus?: EvidenceStatus;
  detail?: string;
};

type MigrationEvidence = {
  pass: boolean;
  status: EvidenceStatus;
  issueCount: number;
  detail: string;
};

/**
 * Migration verification must never silently pass because a query failed.
 *
 * The old closeout queried sp_migration_verification_results, a table no current
 * migration path writes, and converted every query failure into 0 failures. We
 * now discover the latest real rehearsal run and invoke the same final verifier
 * used by Phase 4. A company with no migration history is explicitly N/A; a
 * schema/query failure is UNAVAILABLE and makes the report NOT_VERIFIED.
 */
async function loadMigrationEvidence(companyId: number): Promise<MigrationEvidence> {
  try {
    const runs = await db.execute(sql`
      SELECT source_company_id, action, status
      FROM sp_migration_rehearsal_runs
      WHERE target_company_id = ${companyId}
        AND status <> 'rolled_back'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const latest = resultRows(runs)[0];
    if (!latest) {
      return {
        pass: true,
        status: "NOT_APPLICABLE",
        issueCount: 0,
        detail: "No non-rolled-back migration rehearsal exists for this target company.",
      };
    }

    const sourceCompanyId = num(latest.source_company_id);
    const runStatus = String(latest.status ?? "").toLowerCase();
    if (!sourceCompanyId || runStatus !== "completed") {
      return {
        pass: false,
        status: "FAIL",
        issueCount: 1,
        detail: `Latest migration rehearsal action ${String(latest.action ?? "unknown")} is ${runStatus || "unknown"}.`,
      };
    }

    const verification = await buildFinalMigrationVerification(sourceCompanyId, companyId);
    const blockerCount = verification.blockers?.length ?? 0;
    const deltaCount = verification.deltas?.length ?? 0;
    const status = verification.overall as "PASS" | "WARN" | "FAIL";
    return {
      pass: status === "PASS",
      status,
      issueCount: blockerCount + deltaCount,
      detail: `Phase 4 final verification for source ${sourceCompanyId}: ${blockerCount} blocker(s), ${deltaCount} delta(s).`,
    };
  } catch (error: unknown) {
    return {
      pass: false,
      status: "UNAVAILABLE",
      issueCount: 1,
      detail: `Migration evidence unavailable: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Every accounting surface compares totals derived from different rows, tables,
 * or source-document paths. A surface is not allowed to compare a formula with
 * itself and call that reconciliation.
 */
async function buildFullReconciliation(companyId: number) {
  const [
    stock,
    inventory,
    otw,
    otwAsset,
    otwClearing,
    payable,
    payableCounterparty,
    saleRegister,
    saleVoucherCredits,
    statements,
    statementCounterparty,
    profit,
    saleVoucherHeaders,
    splits,
    openings,
    openingVouchers,
    containers,
    offloadCosts,
    prepaid,
    prepaidPosted,
    parentAgent,
    parentAgentPosted,
  ] = await Promise.all([
    // SP lot ledger: what is still on hand, at SP's own final unit cost.
    db.execute(sql`
        SELECT COALESCE(SUM(qty_remaining::numeric), 0) qty,
               COALESCE(SUM(qty_remaining::numeric * final_unit_cost_usd::numeric), 0) value
        FROM sp_stock_movements
        WHERE company_id = ${companyId}
          AND COALESCE(source_type, 'offload') NOT IN ('reversed_offload', 'offload_reversed')
      `),
    // ERP inventory for the stock items touched by SP.
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
    // Goods in transit per the general ledger.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId} AND la.sub_type = 'sp_goods_otw'
      `),
    // Liability leg posted opposite Goods OTW.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId} AND la.sub_type = 'sp_otw_clearing'
      `),
    // Complete Supplier Cash Payable control balance, including both credits and payments/debits.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.sub_type = 'sp_payable' AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
      `),
    // Independently derive the same payable balance from every *other* line on
    // vouchers that touch sp_payable. Balanced vouchers require the counterparty
    // net debit to equal the payable's credit-normal balance.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND COALESCE(la.sub_type, '') <> 'sp_payable'
          AND EXISTS (
            SELECT 1
            FROM voucher_entries pe
            JOIN ledger_accounts pla ON pla.id = pe.ledger_account_id AND pla.deleted_at IS NULL
            WHERE pe.voucher_id = v.id AND pla.sub_type = 'sp_payable'
          )
      `),
    // Source-document total for SP sales.
    db.execute(sql`
        SELECT COALESCE(SUM(total_sale_price_usd::numeric), 0) register_total,
               COUNT(*) sale_count
        FROM sp_sales
        WHERE company_id = ${companyId} AND status = 'posted' AND voucher_id IS NOT NULL
      `),
    // Ledger credits restricted to exactly the posted SP sale vouchers.
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
    // Supplier statement side: entries explicitly tagged to a supplier.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) balance,
               COUNT(DISTINCT ve.supplier_id) supplier_count
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId} AND ve.supplier_id IS NOT NULL
      `),
    // Counterparty side of those same supplier-tagged vouchers. This is derived
    // from different rows, so a missing/altered supplier statement line can fail.
    db.execute(sql`
        SELECT COALESCE(SUM(ve.debit_amount::numeric - ve.credit_amount::numeric), 0) balance
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
        WHERE v.company_id = ${companyId}
          AND ve.supplier_id IS NULL
          AND EXISTS (
            SELECT 1 FROM voucher_entries se
            WHERE se.voucher_id = v.id AND se.supplier_id IS NOT NULL
          )
      `),
    // Sales-item revenue/cost is intentionally isolated from voucher headers.
    db.execute(sql`
        SELECT COALESCE(SUM(si.total_sales::numeric), 0) revenue,
               COALESCE(SUM(si.total_cost::numeric), 0) cogs,
               COALESCE(SUM(si.total_sales::numeric - si.total_cost::numeric), 0) gross_profit
        FROM sales_items si
        JOIN vouchers v ON v.id = si.voucher_id
        WHERE v.company_id = ${companyId} AND v.voucher_type = 'Sales' AND v.deleted_at IS NULL
      `),
    // Each Sales voucher header is counted once, regardless of how many item
    // lines it owns. The previous joined SUM(v.total_amount) multiplied headers.
    db.execute(sql`
        SELECT COALESCE(SUM(v.total_amount::numeric), 0) voucher_total
        FROM vouchers v
        WHERE v.company_id = ${companyId}
          AND v.voucher_type = 'Sales'
          AND v.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM sales_items si WHERE si.voucher_id = v.id)
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
    // Offload cost as recorded against its independently recomputed components.
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
    // Prepaid operational register.
    db.execute(sql`
        SELECT COALESCE(SUM(amount_paid_usd::numeric), 0) paid,
               COALESCE(SUM(amount_used_usd::numeric), 0) used,
               COALESCE(SUM(amount_paid_usd::numeric - amount_used_usd::numeric), 0) balance,
               COUNT(*) FILTER (WHERE amount_used_usd::numeric < 0 OR amount_used_usd::numeric > amount_paid_usd::numeric) invalid_count
        FROM sp_prepaid_charges WHERE company_id = ${companyId}
      `),
    // Independent accounting evidence for prepaid paid/used amounts. Paid comes
    // from debit entries on each linked prepaid voucher (and therefore supports a
    // permitted custom debit account); used comes from credits to the canonical
    // sp_prepaid account on actual offload stock vouchers.
    db.execute(sql`
        SELECT
          COALESCE((
            SELECT SUM(ve.debit_amount::numeric)
            FROM sp_prepaid_charges p
            JOIN vouchers v ON v.id = p.voucher_id AND v.deleted_at IS NULL
            JOIN voucher_entries ve ON ve.voucher_id = v.id
            WHERE p.company_id = ${companyId} AND ve.debit_amount::numeric > 0
          ), 0) paid,
          COALESCE((
            SELECT SUM(ve.credit_amount::numeric)
            FROM voucher_entries ve
            JOIN vouchers v ON v.id = ve.voucher_id AND v.deleted_at IS NULL
            JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.deleted_at IS NULL
            JOIN sp_offloads o ON o.voucher_id_stock = v.id AND o.company_id = v.company_id
            WHERE v.company_id = ${companyId} AND la.sub_type = 'sp_prepaid'
          ), 0) used
      `),
    // Parent-agent source register.
    db.execute(sql`
        SELECT COALESCE(SUM(oc.amount_usd::numeric), 0) charge_total
        FROM sp_offload_charges oc
        WHERE oc.company_id = ${companyId} AND oc.charge_type = 'parent_agent'
      `),
    // Matching credits to Prepaid Expenses on offload stock vouchers.
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
  ]);

  const migration = await loadMigrationEvidence(companyId);

  const stockRow = resultRows(stock)[0] ?? {};
  const inventoryRow = resultRows(inventory)[0] ?? {};
  const otwRow = resultRows(otw)[0] ?? {};
  const otwAssetRow = resultRows(otwAsset)[0] ?? {};
  const otwClearingRow = resultRows(otwClearing)[0] ?? {};
  const payableRow = resultRows(payable)[0] ?? {};
  const payableCounterpartyRow = resultRows(payableCounterparty)[0] ?? {};
  const saleRegisterRow = resultRows(saleRegister)[0] ?? {};
  const saleCreditRow = resultRows(saleVoucherCredits)[0] ?? {};
  const statementRow = resultRows(statements)[0] ?? {};
  const statementCounterpartyRow = resultRows(statementCounterparty)[0] ?? {};
  const profitRow = resultRows(profit)[0] ?? {};
  const saleVoucherHeaderRow = resultRows(saleVoucherHeaders)[0] ?? {};
  const splitRow = resultRows(splits)[0] ?? {};
  const openingRow = resultRows(openings)[0] ?? {};
  const openingVoucherRow = resultRows(openingVouchers)[0] ?? {};
  const containerRow = resultRows(containers)[0] ?? {};
  const offloadCostRow = resultRows(offloadCosts)[0] ?? {};
  const prepaidRow = resultRows(prepaid)[0] ?? {};
  const prepaidPostedRow = resultRows(prepaidPosted)[0] ?? {};
  const parentRow = resultRows(parentAgent)[0] ?? {};
  const parentPostedRow = resultRows(parentAgentPosted)[0] ?? {};

  const stockValue = num(stockRow.value);
  const inventoryValue = num(inventoryRow.value);
  const openOtw = num(otwRow.open_total);
  const otwAssetBalance = num(otwAssetRow.balance);
  const saleRegisterTotal = num(saleRegisterRow.register_total);
  const lineGrossProfit = num(profitRow.gross_profit);
  const lineCost = num(profitRow.cogs);
  const saleVoucherTotal = num(saleVoucherHeaderRow.voucher_total);
  const splitGrossProfit = num(splitRow.gross_profit);
  const openingValue = num(openingRow.opening_value);
  const recordedOffloadCost = num(offloadCostRow.recorded_cost);
  const recomputedOffloadCost = num(offloadCostRow.recomputed_cost);
  const prepaidPaid = num(prepaidRow.paid);
  const prepaidUsed = num(prepaidRow.used);
  const prepaidPostedPaid = num(prepaidPostedRow.paid);
  const prepaidPostedUsed = num(prepaidPostedRow.used);
  const parentChargeTotal = num(parentRow.charge_total);
  const parentPostedTotal = num(parentPostedRow.posted_total);

  const surfaces: Surface[] = [
    {
      key: "stock_on_hand",
      databaseValue: stockValue,
      reportValue: inventoryValue,
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
      // Kept for response compatibility; the canonical supplier-entry check is
      // supplier_statement_control below.
      key: "supplier_statements",
      databaseValue: num(otwClearingRow.balance),
      reportValue: otwAssetBalance,
      pass: close(num(otwClearingRow.balance), otwAssetBalance),
      basis: "Goods OTW Clearing liability vs the Goods OTW asset — compatibility surface for the paired OTW posting",
    },
    {
      key: "supplier_statement_control",
      databaseValue: num(statementRow.balance),
      reportValue: num(statementCounterpartyRow.balance),
      pass: close(num(statementRow.balance), num(statementCounterpartyRow.balance)),
      basis: "supplier-tagged voucher-entry net balance vs the non-supplier counterparty entries on those same vouchers",
    },
    {
      // Source-document check for SP sales specifically.
      key: "supplier_payable",
      databaseValue: saleRegisterTotal,
      reportValue: num(saleCreditRow.credited),
      pass: close(saleRegisterTotal, num(saleCreditRow.credited)),
      basis: "posted sp_sales total vs credits to Supplier Cash Payable on exactly those sale vouchers",
    },
    {
      // Full control-account check, including payments and non-sp_sales origins.
      key: "supplier_payable_control",
      databaseValue: num(payableRow.balance),
      reportValue: num(payableCounterpartyRow.balance),
      pass: close(num(payableRow.balance), num(payableCounterpartyRow.balance)),
      basis: "complete sp_payable credit-normal balance vs net debit of all non-payable lines on every voucher that touches sp_payable",
    },
    {
      key: "gross_profit",
      databaseValue: lineGrossProfit,
      reportValue: saleVoucherTotal - lineCost,
      pass: close(lineGrossProfit, saleVoucherTotal - lineCost),
      basis: "sales_items revenue less cost vs each distinct Sales voucher header counted once less the same item costs",
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
      pass:
        close(recordedOffloadCost, recomputedOffloadCost, { absolute: 0.01, relative: 0.001 }) &&
        num(containerRow.status_mismatches) === 0,
      basis:
        "sp_offloads recorded final cost vs container lines at the invoice discount plus landed charges; also fails when an offloaded container is not marked offloaded",
    },
    {
      key: "prepaid_balances",
      databaseValue: prepaidPaid - prepaidUsed,
      reportValue: prepaidPostedPaid - prepaidPostedUsed,
      pass:
        close(prepaidPaid, prepaidPostedPaid) &&
        close(prepaidUsed, prepaidPostedUsed) &&
        close(prepaidPaid - prepaidUsed, prepaidPostedPaid - prepaidPostedUsed) &&
        num(prepaidRow.invalid_count) === 0,
      basis: "sp_prepaid_charges paid/used register vs debit entries on linked prepaid vouchers and credits on actual offload stock vouchers",
      detail: `register paid/used ${prepaidPaid.toFixed(2)}/${prepaidUsed.toFixed(2)}; accounting paid/used ${prepaidPostedPaid.toFixed(2)}/${prepaidPostedUsed.toFixed(2)}`,
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
      databaseValue: migration.issueCount,
      reportValue: 0,
      pass: migration.pass,
      evidenceStatus: migration.status,
      basis: "latest real sp_migration_rehearsal_runs evidence evaluated through the Phase 4 final migration verifier",
      detail: migration.detail,
    },
  ];

  const mismatchCount = surfaces.filter((surface) => !surface.pass).length;
  const unavailableCount = surfaces.filter((surface) => surface.evidenceStatus === "UNAVAILABLE").length;
  return {
    status: unavailableCount > 0 ? "NOT_VERIFIED" : mismatchCount === 0 ? "PASS" : "FAIL",
    companyId,
    generatedAt: new Date().toISOString(),
    mismatchCount,
    unavailableCount,
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
      prepaidBalance: prepaidPaid - prepaidUsed,
      supplierCount: num(statementRow.supplier_count),
      migrationEvidence: migration.status,
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
          ["surface", "database_value", "independent_value", "status", "evidence_status", "basis", "detail"].join(","),
          ...report.surfaces.map((surface) =>
            [
              surface.key,
              surface.databaseValue,
              surface.reportValue,
              surface.pass ? "PASS" : "FAIL",
              surface.evidenceStatus ?? "",
              surface.basis,
              surface.detail ?? "",
            ]
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
