import type { QueryResultRow } from "pg";

import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

import { CompanyExportData } from "./types";

async function q<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
  try {
    const result = params ? await pool.query(sql, params) : await pool.query(sql);
    return result.rows as T[];
  } catch (err: unknown) {
    logger.warn(`[ExportData] Query warning: ${getErrorMessage(err)}`);
    return [];
  }
}

export async function fetchAllCompanies(): Promise<Array<{ id: number; name: string }>> {
  return q<{ id: number; name: string }>(`SELECT id, name FROM companies ORDER BY id`);
}

export async function fetchCompanyExportData(
  companyId: number,
  fromDate?: string,
  toDate?: string
): Promise<CompanyExportData> {
  const cid = Number(companyId);
  const df = (col: string) => {
    const p: string[] = [];
    if (fromDate) p.push(`AND ${col} >= '${fromDate}'`);
    if (toDate) p.push(`AND ${col} <= '${toDate}'`);
    return p.join(" ");
  };

  const [
    companiesRows,
    companySettings,
    locations,
    ledgerAccounts,
    bankAccounts,
    fixedAssets,
    exchangeRates,
    fiscalPeriodClosures,
    referenceSequences,
    agentAccounts,
    vouchers,
    voucherEntries,
    suppliers,
    supplierTransactions,
    supplierProformas,
    supplierProformaLines,
    supplierContainers,
    supplierContainerLoadedItems,
    customers,
    customerTransactions,
    customerBalances,
    customerOrders,
    customerOrderLines,
    customerOrderBales,
    customerOrderCharges,
    customerProformas,
    customerProformaLines,
    creditNoteItems,
    employees,
    employeePayrollRuns,
    employeePayrollItems,
    employeeAdvances,
    salaryAdvances,
    salaryAdvanceDeductions,
    employeeAdvanceRepayments,
    employeeAttendance,
    employeeBonuses,
    employeeGroups,
    employeeGroupMembers,
    employeeBaleRates,
    employeeBalePercentRates,
    workerDocs,
    factoryWorkers,
    factoryWorkerCategories,
    factoryWorkerDocuments,
    factoryWorkerAdvances,
    factoryAdvanceRepayments,
    factoryPayrolls,
    factoryAttendance,
    workerBonuses,
    factorySettings,
    factoryCategories,
    factoryDaybook,
    factoryDaybookEdits,
    factoryDailyKpiSnapshots,
    factoryDailyUsages,
    factoryAlerts,
    factoryDutyAuditLog,
    factoryRawStock,
    factoryRawMaterialAdjustments,
    factoryPressingBatches,
    pressingBatches,
    factoryMixBatches,
    factoryMixBatchSources,
    mixBatches,
    mixBatchSources,
    productionBales,
    productionRawStock,
    factoryBaleProducts,
    factoryBales,
    factoryBaleSequences,
    factoryBaleCostSnapshots,
    factoryBaleWasteDispatches,
    factoryWasteEntries,
    factoryContainers,
    factoryContainerPlans,
    factoryContainerPlanContainers,
    factoryContainerPlanLines,
    factoryContainerCommissions,
    factoryContainerOtherCharges,
    factoryContainerProfitSnapshots,
    factoryOffloadAdditionalCharges,
    factorySuppliers,
    factorySupplierPayments,
    factorySupplierFxTransfers,
    factorySupplierScoreSnapshots,
    factoryFxRates,
    factoryFxAllocations,
    factoryPosSales,
    factoryPosSaleItems,
    bales,
    baleProducts,
    baleProductCategories,
    baleSequences,
    baleLabelPrints,
    baleTransfers,
    baleTransferItems,
    baleRecodeSessions,
    baleRecodeItems,
    stockGroups,
    stockItems,
    stockItemCodeAliases,
    stockItemLocationPrices,
    inventory,
    inventoryNegativeLayers,
    stockGroupLocationArchives,
    stockGroupLocationArchiveItems,
    stockTransfers,
    stockTransferItems,
    stockTransferRevisions,
    stockTransferRevisionItems,
    stockAdjustments,
    stockAdjustmentItems,
    proformaStockReservations,
    containersDetail,
    containers,
    containerCharges,
    containerOffloads,
    containerOffloadItems,
    containerFreight,
    containerFreightPayments,
    containerDocuments,
    containerSales,
    purchaseOrders,
    poLineItems,
    posShifts,
    salesItems,
    wasteDispatches,
    wasteDispatchItems,
    spreadsheets,
    importLogs,
    auditLog,
    factoryBaleDetail,
    factoryWorkerAdvancesDetail,
    factoryPayrollDetail,
    factoryContainerDetail,
    factorySupplierPaymentsDetail,
    factoryRawStockDetail,
    factoryMixBatchDetail,
    factoryPosSalesDetail,
    voucherLinesDetail,
    poDetail,
    stockTransferDetail,
    supplierBalances,
    supplierTxnDetail,
    customerBalancesDetail,
    customerOrderDetail,
    creditNoteDetail,
    salaryAdvancesDetail,
    employeeTxnDetail,
    locationStockDetail,
  ] = await Promise.all([
    // ── Company ───────────────────────────────────────────────────────────────
    q(`SELECT * FROM companies WHERE id = ${cid}`),
    q(`SELECT * FROM company_settings WHERE company_id = ${cid}`),
    q(`SELECT * FROM locations WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY name`),

    // ── Ledger / Finance ──────────────────────────────────────────────────────
    q(`SELECT * FROM ledger_accounts WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY code`),
    q(`SELECT * FROM bank_accounts WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY name`),
    q(`SELECT * FROM fixed_assets WHERE company_id = ${cid} ORDER BY name`),
    q(
      `SELECT * FROM exchange_rates WHERE company_id = ${cid} ${df("effective_date")} ORDER BY effective_date DESC, id`
    ),
    q(`SELECT * FROM fiscal_period_closures WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM reference_sequences WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM agent_accounts WHERE company_id = ${cid} ORDER BY id`),

    // ── Vouchers ──────────────────────────────────────────────────────────────
    q(`SELECT * FROM vouchers WHERE company_id = ${cid} ${df("voucher_date")} ORDER BY voucher_date, id`),
    q(
      `SELECT ve.* FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY ve.id`
    ),

    // ── Suppliers ─────────────────────────────────────────────────────────────
    q(
      `SELECT s.* FROM suppliers s INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} AND s.deleted_at IS NULL ORDER BY s.legal_name`
    ),
    q(
      `SELECT ve.*, v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} AND ve.supplier_id IS NOT NULL ${df("v.voucher_date")} ORDER BY v.voucher_date, ve.id`
    ),
    q(`SELECT * FROM supplier_proformas WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT spl.* FROM supplier_proforma_lines spl INNER JOIN supplier_proformas sp ON sp.id = spl.proforma_id WHERE sp.company_id = ${cid} ORDER BY spl.id`
    ),
    q(
      `SELECT sc.* FROM supplier_containers sc INNER JOIN suppliers s ON s.id = sc.supplier_id INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} ORDER BY sc.id DESC`
    ),
    q(
      `SELECT scl.* FROM supplier_container_loaded_items scl INNER JOIN supplier_containers sc ON sc.id = scl.container_id INNER JOIN suppliers s ON s.id = sc.supplier_id INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} ORDER BY scl.id`
    ),

    // ── Customers ─────────────────────────────────────────────────────────────
    q(`SELECT * FROM customers WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY legal_name`),
    q(
      `SELECT ve.*, v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} AND ve.customer_id IS NOT NULL ${df("v.voucher_date")} ORDER BY v.voucher_date, ve.id`
    ),
    q(`SELECT * FROM customer_balances WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM customer_orders WHERE company_id = ${cid} ${df("order_date")} ORDER BY order_date DESC, id`),
    q(
      `SELECT col.* FROM customer_order_lines col INNER JOIN customer_orders co ON co.id = col.order_id WHERE co.company_id = ${cid} ORDER BY col.id`
    ),
    q(
      `SELECT cob.* FROM customer_order_bales cob INNER JOIN customer_orders co ON co.id = cob.order_id WHERE co.company_id = ${cid} ORDER BY cob.id`
    ),
    q(
      `SELECT coc.* FROM customer_order_charges coc INNER JOIN customer_orders co ON co.id = coc.order_id WHERE co.company_id = ${cid} ORDER BY coc.id`
    ),
    q(`SELECT * FROM customer_proformas WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT cpl.* FROM customer_proforma_lines cpl INNER JOIN customer_proformas cp ON cp.id = cpl.proforma_id WHERE cp.company_id = ${cid} ORDER BY cpl.id`
    ),
    q(
      `SELECT cni.* FROM credit_note_items cni INNER JOIN vouchers v ON v.id = cni.voucher_id WHERE v.company_id = ${cid} ORDER BY cni.id`
    ),

    // ── Employees ─────────────────────────────────────────────────────────────
    q(`SELECT * FROM employees WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY first_name, last_name`),
    q(`SELECT * FROM erp_payroll_runs WHERE company_id = ${cid} ${df("date")} ORDER BY date, id`),
    q(
      `SELECT p.* FROM erp_payroll_run_items p INNER JOIN erp_payroll_runs r ON r.id = p.run_id WHERE r.company_id = ${cid} ${df("r.date")} ORDER BY r.date, p.id`
    ),
    q(`SELECT * FROM employee_advances WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM salary_advances WHERE company_id = ${cid} ${df("advance_date")} ORDER BY advance_date, id`),
    q(
      `SELECT sad.* FROM salary_advance_deductions sad INNER JOIN salary_advances sa ON sa.id = sad.salary_advance_id WHERE sa.company_id = ${cid} ORDER BY sad.id`
    ),
    q(`SELECT * FROM employee_advance_repayments WHERE company_id = ${cid} ORDER BY id`),
    q(
      `SELECT * FROM employee_attendance WHERE company_id = ${cid} ${df("attendance_date")} ORDER BY attendance_date, id`
    ),
    q(`SELECT * FROM employee_bonuses WHERE company_id = ${cid} ${df("bonus_date")} ORDER BY bonus_date, id`),
    q(`SELECT * FROM employee_groups WHERE company_id = ${cid} ORDER BY name`),
    q(
      `SELECT egm.* FROM employee_group_members egm INNER JOIN employee_groups eg ON eg.id = egm.employee_group_id WHERE eg.company_id = ${cid} ORDER BY egm.id`
    ),
    q(`SELECT * FROM employee_bale_rates WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM employee_bale_pct_rates WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM erp_worker_docs WHERE company_id = ${cid} ORDER BY id`),

    // ── Factory Workers ───────────────────────────────────────────────────────
    q(`SELECT * FROM factory_workers WHERE company_id = ${cid} ORDER BY full_name`),
    q(`SELECT * FROM factory_worker_categories WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_worker_documents WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_worker_advances WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_advance_repayments WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_payrolls WHERE company_id = ${cid} ${df("period_start")} ORDER BY period_start, id`),
    q(
      `SELECT * FROM factory_attendance WHERE company_id = ${cid} ${df("attendance_date")} ORDER BY attendance_date, id`
    ),
    q(`SELECT * FROM worker_bonuses WHERE company_id = ${cid} ORDER BY id`),

    // ── Factory Operations ────────────────────────────────────────────────────
    q(`SELECT * FROM factory_settings WHERE company_id = ${cid}`),
    q(`SELECT * FROM factory_categories WHERE company_id = ${cid} ORDER BY name`),
    q(`SELECT * FROM factory_daybook_entries WHERE company_id = ${cid} ${df("tx_date")} ORDER BY tx_date, id`),
    q(
      `SELECT fde.* FROM factory_daybook_entry_edits fde INNER JOIN factory_daybook_entries fdb ON fdb.id = fde.daybook_entry_id WHERE fdb.company_id = ${cid} ORDER BY fde.id`
    ),
    q(`SELECT * FROM factory_daily_kpi_snapshots WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC`),
    q(`SELECT * FROM factory_daily_usages WHERE company_id = ${cid} ${df("used_date")} ORDER BY used_date DESC`),
    q(`SELECT * FROM factory_alerts WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_duty_audit_log WHERE company_id = ${cid} ORDER BY id DESC LIMIT 50000`),

    // ── Factory Raw / Production ──────────────────────────────────────────────
    q(`SELECT * FROM factory_raw_stock WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_raw_material_adjustments WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`),
    q(
      `SELECT * FROM factory_pressing_batches WHERE company_id = ${cid} ${df("created_at::date")} ORDER BY created_at DESC, id`
    ),
    q(`SELECT * FROM pressing_batches WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_mix_batches WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT fms.* FROM factory_mix_batch_sources fms INNER JOIN factory_mix_batches fmb ON fmb.id = fms.mix_batch_id WHERE fmb.company_id = ${cid} ORDER BY fms.id`
    ),
    q(`SELECT * FROM mix_batches WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT mbs.* FROM mix_batch_sources mbs INNER JOIN mix_batches mb ON mb.id = mbs.mix_batch_id WHERE mb.company_id = ${cid} ORDER BY mbs.id`
    ),
    q(`SELECT * FROM production_bales WHERE company_id = ${cid} ORDER BY id DESC LIMIT 100000`),
    q(`SELECT * FROM production_raw_stock WHERE company_id = ${cid} ORDER BY id`),

    // ── Factory Bales ─────────────────────────────────────────────────────────
    q(`SELECT * FROM factory_bale_products WHERE company_id = ${cid} ORDER BY name`),
    q(`SELECT * FROM factory_bales WHERE company_id = ${cid} ${df("pressed_at::date")} ORDER BY pressed_at DESC, id`),
    q(`SELECT * FROM factory_bale_sequences WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_bale_cost_snapshots WHERE company_id = ${cid} ORDER BY id DESC LIMIT 50000`),
    q(`SELECT * FROM factory_bale_waste_dispatches WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_waste_entries WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`),

    // ── Factory Containers ────────────────────────────────────────────────────
    q(`SELECT * FROM factory_containers WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_container_plans WHERE company_id = ${cid} ORDER BY updated_at DESC, id DESC`),
    q(`SELECT * FROM factory_container_plan_containers WHERE company_id = ${cid} ORDER BY plan_id, position, id`),
    q(`SELECT * FROM factory_container_plan_lines WHERE company_id = ${cid} ORDER BY plan_id, plan_container_id, product_name, article_code`),
    q(`SELECT * FROM factory_container_commissions WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_container_other_charges WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM factory_container_profit_snapshots WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_offload_additional_charges WHERE company_id = ${cid} ORDER BY id`),

    // ── Factory Suppliers ─────────────────────────────────────────────────────
    q(`SELECT * FROM factory_suppliers WHERE company_id = ${cid} ORDER BY name`),
    q(`SELECT * FROM factory_supplier_payments WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`),
    q(`SELECT * FROM factory_supplier_fx_transfers WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_supplier_score_snapshots WHERE company_id = ${cid} ORDER BY id DESC`),

    // ── Factory FX ────────────────────────────────────────────────────────────
    q(`SELECT * FROM factory_fx_rates WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM factory_fx_allocations WHERE company_id = ${cid} ORDER BY id DESC`),

    // ── Factory POS ───────────────────────────────────────────────────────────
    q(`SELECT * FROM factory_pos_sales WHERE company_id = ${cid} ${df("tx_date")} ORDER BY tx_date DESC, id`),
    q(
      `SELECT fps.* FROM factory_pos_sale_items fps INNER JOIN factory_pos_sales fp ON fp.id = fps.sale_id WHERE fp.company_id = ${cid} ORDER BY fps.id`
    ),

    // ── Bales (Sorting) ───────────────────────────────────────────────────────
    q(`SELECT * FROM bales WHERE company_id = ${cid} ${df("date_pressed")} ORDER BY date_pressed DESC, id`),
    q(`SELECT * FROM bale_products WHERE company_id = ${cid} ORDER BY name`),
    q(`SELECT * FROM bale_product_categories WHERE company_id = ${cid} ORDER BY name`),
    q(`SELECT * FROM bale_sequences WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM bale_label_prints WHERE company_id = ${cid} ORDER BY id DESC LIMIT 100000`),
    q(`SELECT * FROM bale_transfers WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT bti.* FROM bale_transfer_items bti INNER JOIN bale_transfers bt ON bt.id = bti.transfer_id WHERE bt.company_id = ${cid} ORDER BY bti.id`
    ),
    q(`SELECT * FROM bale_recode_sessions WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT bri.* FROM bale_recode_items bri INNER JOIN bale_recode_sessions brs ON brs.id = bri.session_id WHERE brs.company_id = ${cid} ORDER BY bri.id`
    ),

    // ── Stock ─────────────────────────────────────────────────────────────────
    q(`SELECT * FROM stock_groups WHERE company_id = ${cid} ORDER BY name`),
    q(`SELECT * FROM stock_items WHERE company_id = ${cid} ORDER BY code`),
    q(`SELECT * FROM stock_item_code_aliases WHERE company_id = ${cid} ORDER BY id`),
    q(
      `SELECT silp.* FROM stock_item_location_prices silp INNER JOIN stock_items si ON si.id = silp.stock_item_id WHERE si.company_id = ${cid} ORDER BY silp.id`
    ),
    q(
      `SELECT i.*, si.code AS item_code, si.name AS item_name, l.name AS location_name FROM inventory i INNER JOIN stock_items si ON si.id = i.stock_item_id INNER JOIN locations l ON l.id = i.location_id WHERE si.company_id = ${cid} ORDER BY l.name, si.code`
    ),
    q(`SELECT * FROM inventory_negative_layers WHERE company_id = ${cid} ORDER BY id`),
    q(`SELECT * FROM stock_group_location_archives WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY id`),
    q(
      `SELECT sglai.* FROM stock_group_location_archive_items sglai INNER JOIN stock_group_location_archives sgla ON sgla.id = sglai.archive_id WHERE sgla.company_id = ${cid} ORDER BY sglai.id`
    ),
    q(
      `SELECT stv.*, v.voucher_number, v.voucher_date, v.description AS transfer_notes, l1.name AS from_location_name, l2.name AS to_location_name FROM stock_transfer_vouchers stv INNER JOIN vouchers v ON v.id = stv.voucher_id LEFT JOIN locations l1 ON l1.id = stv.source_location_id LEFT JOIN locations l2 ON l2.id = stv.destination_location_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, stv.id`
    ),
    q(
      `SELECT sti.* FROM stock_transfer_items sti INNER JOIN stock_transfer_vouchers stv ON stv.id = sti.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY sti.id`
    ),
    q(
      `SELECT r.* FROM stock_transfer_revisions r INNER JOIN stock_transfer_vouchers stv ON stv.id = r.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY r.id`
    ),
    q(
      `SELECT ri.* FROM stock_transfer_revision_items ri INNER JOIN stock_transfer_revisions r ON r.id = ri.revision_id INNER JOIN stock_transfer_vouchers stv ON stv.id = r.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY ri.id`
    ),
    q(
      `SELECT sav.* FROM stock_adjustment_vouchers sav INNER JOIN vouchers v ON v.id = sav.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY sav.id`
    ),
    q(
      `SELECT ai.* FROM stock_adjustment_items ai INNER JOIN stock_adjustment_vouchers av ON av.id = ai.adjustment_id INNER JOIN vouchers v ON v.id = av.voucher_id WHERE v.company_id = ${cid} ORDER BY ai.id`
    ),
    q(`SELECT * FROM proforma_stock_reservations WHERE company_id = ${cid} ORDER BY id`),

    // ── Containers ────────────────────────────────────────────────────────────
    q(`
      SELECT
        c.container_number,
        c.status,
        c.import_date,
        c.eta,
        c.eta_source,
        c.border_date,
        c.offload_date,
        c.item_name,
        c.total_kg,
        c.rate_per_kg,
        c.items_total,
        c.charges_total,
        c.grand_total,
        c.transport_fee,
        c.duty_fee,
        c.agent,
        c.transporter,
        c.number_plate,
        c.shop_name,
        c.tracking_location,
        c.tracking_description,
        c.doc_received,
        s.legal_name                              AS supplier_name,
        s.phone                                   AS supplier_phone,

        COALESCE(ch.total_charges, 0)             AS total_other_charges,
        COALESCE(ch.charge_breakdown, '')         AS charge_breakdown,

        COALESCE(fr.freight_amount_usd, 0)        AS freight_usd,
        COALESCE(fr.freight_amount_local, 0)      AS freight_local,

        COALESCE(off.total_bales, 0)              AS offloaded_bales,
        COALESCE(off.duties, 0)                   AS offload_duties,
        COALESCE(off.office_charges, 0)           AS offload_office_charges,
        COALESCE(off.transfer_charges, 0)         AS offload_transfer_charges,
        COALESCE(off.transport_fees, 0)           AS offload_transport_fees,
        COALESCE(off.total_charges, 0)            AS offload_total_charges,

        COALESCE(sa.total_sale_amount, 0)         AS total_sale_amount,
        COALESCE(sa.total_paid, 0)                AS total_paid,
        COALESCE(sa.total_commission, 0)          AS total_commission,
        COALESCE(sa.sale_count, 0)                AS sale_count,

        COALESCE(oi.offload_qty, 0)               AS offload_qty_items,
        COALESCE(oi.offload_value, 0)             AS offload_value

      FROM containers c
      LEFT JOIN suppliers s ON s.id = c.supplier_id

      LEFT JOIN LATERAL (
        SELECT
          SUM(cc.amount) AS total_charges,
          STRING_AGG(cc.charge_name || ': ' || cc.amount::text, ' | ' ORDER BY cc.id) AS charge_breakdown
        FROM container_charges cc WHERE cc.container_id = c.id
      ) ch ON true

      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN cf.currency = 'USD' THEN cf.freight_amount ELSE 0 END) AS freight_amount_usd,
          SUM(CASE WHEN cf.currency != 'USD' THEN cf.freight_amount ELSE 0 END) AS freight_amount_local
        FROM container_freight cf WHERE cf.container_id = c.id
      ) fr ON true

      LEFT JOIN LATERAL (
        SELECT
          SUM(co.total_bales) AS total_bales,
          SUM(co.duties)        AS duties,
          SUM(co.office_charges) AS office_charges,
          SUM(co.transfer_charges) AS transfer_charges,
          SUM(co.transport_fees) AS transport_fees,
          SUM(co.total_charges) AS total_charges
        FROM container_offloads co WHERE co.container_id = c.id
      ) off ON true

      LEFT JOIN LATERAL (
        SELECT
          SUM(cs.total_amount) AS total_sale_amount,
          SUM(cs.paid_amount)  AS total_paid,
          SUM(cs.commission)   AS total_commission,
          COUNT(cs.id)         AS sale_count
        FROM container_sales cs WHERE cs.container_id = c.id
      ) sa ON true

      LEFT JOIN LATERAL (
        SELECT
          SUM(coi.quantity)    AS offload_qty,
          SUM(coi.total_value) AS offload_value
        FROM container_offload_items coi
        INNER JOIN container_offloads co ON co.id = coi.offload_id
        WHERE co.container_id = c.id
      ) oi ON true

      WHERE c.company_id = ${cid}
      ORDER BY c.import_date DESC NULLS LAST, c.id DESC
    `),
    q(`SELECT * FROM containers WHERE company_id = ${cid} ${df("import_date")} ORDER BY import_date DESC, id`),
    q(
      `SELECT cc.* FROM container_charges cc INNER JOIN containers c ON c.id = cc.container_id WHERE c.company_id = ${cid} ORDER BY cc.id`
    ),
    q(
      `SELECT co.* FROM container_offloads co INNER JOIN containers c ON c.id = co.container_id WHERE c.company_id = ${cid} ORDER BY co.id`
    ),
    q(
      `SELECT coi.* FROM container_offload_items coi INNER JOIN container_offloads co ON co.id = coi.offload_id INNER JOIN containers c ON c.id = co.container_id WHERE c.company_id = ${cid} ORDER BY coi.id`
    ),
    q(`SELECT * FROM container_freight WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM container_freight_payments WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM container_documents WHERE company_id = ${cid} ORDER BY id DESC`),
    q(`SELECT * FROM container_sales WHERE company_id = ${cid} ORDER BY id DESC`),

    // ── Purchase Orders ───────────────────────────────────────────────────────
    q(
      `SELECT po.* FROM purchase_orders po WHERE po.company_id = ${cid} ${df("po.created_at::date")} ORDER BY po.created_at, po.id`
    ),
    q(
      `SELECT pli.* FROM po_line_items pli INNER JOIN purchase_orders po ON po.id = pli.po_id WHERE po.company_id = ${cid} ORDER BY pli.id`
    ),

    // ── POS ───────────────────────────────────────────────────────────────────
    q(`SELECT * FROM pos_shifts WHERE company_id = ${cid} ${df("opened_at::date")} ORDER BY opened_at DESC`),
    q(
      `SELECT si.*, v.voucher_number, v.voucher_date FROM sales_items si INNER JOIN vouchers v ON v.id = si.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, si.id`
    ),

    // ── Waste ─────────────────────────────────────────────────────────────────
    q(`SELECT * FROM waste_dispatches WHERE company_id = ${cid} ORDER BY id DESC`),
    q(
      `SELECT wdi.* FROM waste_dispatch_items wdi INNER JOIN waste_dispatches wd ON wd.id = wdi.dispatch_id WHERE wd.company_id = ${cid} ORDER BY wdi.id`
    ),

    // ── Spreadsheets ──────────────────────────────────────────────────────────
    q(`SELECT id, name, created_at, updated_at FROM spreadsheets WHERE company_id = ${cid} ORDER BY name`),

    // ── Import Logs ───────────────────────────────────────────────────────────
    q(`SELECT * FROM import_logs WHERE company_id = ${cid} ORDER BY id DESC LIMIT 10000`),

    // ── Audit ─────────────────────────────────────────────────────────────────
    q(
      `SELECT * FROM audit_log WHERE company_id = ${cid} ${df("created_at::date")} ORDER BY created_at DESC LIMIT 50000`
    ),

    // ── Factory Enriched Detail Views ─────────────────────────────────────────
    q(
      `SELECT fb.bale_code, fb.reference_number, fb.article_code, fb.product_name, fb.weight_kg, fb.cost_per_kg, fb.total_cost, fb.status, fb.pressed_at, fb.finalized_at, fb.category, fb.grade, fb.quantity, fb.stock_entry_date, fb.notes, fbp.code AS product_code, fbp.selling_price, fbp.production_price, l.name AS erp_location, fmb.batch_code AS mix_batch_code, fmb.batch_number AS mix_batch_number FROM factory_bales fb LEFT JOIN factory_bale_products fbp ON fbp.id = fb.product_id LEFT JOIN locations l ON l.id = fb.erp_location_id LEFT JOIN factory_mix_batches fmb ON fmb.id = fb.mix_batch_id WHERE fb.company_id = ${cid} ${df("fb.pressed_at::date")} ORDER BY fb.pressed_at DESC, fb.id`
    ),
    q(
      `SELECT fa.advance_date, fa.amount, fa.remaining_balance, fa.notes, fa.fully_paid, fa.repayment_type, fw.full_name AS worker_name, fw.employee_code, fw.department, fw.position FROM factory_worker_advances fa INNER JOIN factory_workers fw ON fw.id = fa.worker_id WHERE fa.company_id = ${cid} ORDER BY fa.advance_date, fa.id`
    ),
    q(
      `SELECT fp.period_start, fp.period_end, fp.status, fp.base_salary, fp.bale_earnings, fp.kg_earnings, fp.overtime_pay, fp.bonuses, fp.deductions, fp.advances, fp.net_salary, fp.bales_count, fp.kg_processed, fp.overtime_hours, fp.total_working_days, fp.present_days, fp.absent_days, fp.transport, fp.notes, fw.full_name AS worker_name, fw.employee_code, fw.department, fw.position, fw.salary_type FROM factory_payrolls fp INNER JOIN factory_workers fw ON fw.id = fp.worker_id WHERE fp.company_id = ${cid} ${df("fp.period_start")} ORDER BY fp.period_start, fp.id`
    ),
    q(
      `SELECT fc.container_number, fc.status, fc.arrival_date, fc.total_kg, fc.declared_kg, fc.actual_received_kg, fc.difference_kg, fc.rate_per_kg, fc.currency_code, fc.fx_rate_to_usd, fc.rate_per_kg_usd, fc.freight, fc.other_charges, fc.commission_amount, fc.duty_amount, fc.duty_status, fc.final_payable_amount, fc.final_payable_amount_usd, fc.notes, fs.name AS supplier_name FROM factory_containers fc LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id WHERE fc.company_id = ${cid} ORDER BY fc.arrival_date DESC, fc.id`
    ),
    q(
      `SELECT fsp.date AS payment_date, fsp.amount, fsp.currency_code, fsp.fx_rate_to_usd, fsp.amount_usd, fsp.notes, fs.name AS supplier_name FROM factory_supplier_payments fsp INNER JOIN factory_suppliers fs ON fs.id = fsp.supplier_id WHERE fsp.company_id = ${cid} ${df("fsp.date")} ORDER BY fsp.date DESC, fsp.id`
    ),
    q(
      `SELECT fr.offloaded_at, fr.material_type, fr.quantity_kg, fr.received_kg, fr.used_kg, fr.rate_per_kg, fr.cost_per_kg, fr.cost_per_kg_usd, fr.notes, fc.container_number, fs.name AS supplier_name FROM factory_raw_stock fr LEFT JOIN factory_containers fc ON fc.id = fr.container_id LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id WHERE fr.company_id = ${cid} ORDER BY fr.offloaded_at DESC, fr.id`
    ),
    q(
      `SELECT fmb.batch_number, fmb.batch_code, fmb.batch_date, fmb.total_weight_kg, fmb.cost_per_kg, fmb.total_cost, fmb.status, fmb.notes, fms.source_type, fms.weight_kg, fms.cost_per_kg AS source_cost_per_kg, fms.total_cost AS source_total_cost, fms.notes AS source_notes, fs.name AS supplier_name, fc.container_number FROM factory_mix_batches fmb LEFT JOIN factory_mix_batch_sources fms ON fms.mix_batch_id = fmb.id LEFT JOIN factory_suppliers fs ON fs.id = fms.supplier_id LEFT JOIN factory_containers fc ON fc.id = fms.container_id WHERE fmb.company_id = ${cid} ORDER BY fmb.batch_date DESC, fmb.id, fms.id`
    ),
    q(
      `SELECT fps.sale_number, fps.tx_date AS sale_date, fps.customer_name, fps.notes AS sale_notes, fps.total_amount AS sale_total, fps.currency_code, fps.payment_type, fps.status, fpsi.product_name, fpsi.article_code, fpsi.quantity, fpsi.unit_price, fpsi.total_amount AS item_total FROM factory_pos_sales fps LEFT JOIN factory_pos_sale_items fpsi ON fpsi.sale_id = fps.id WHERE fps.company_id = ${cid} ${df("fps.tx_date")} ORDER BY fps.tx_date DESC, fps.id, fpsi.id`
    ),

    q(
      `SELECT v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration, v.currency, v.exchange_rate, v.location_name, la.code AS account_code, la.name AS account_name, la.account_type, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration AS entry_narration, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, c.legal_name AS customer_name, s.legal_name AS supplier_name FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id LEFT JOIN employees e ON e.id = ve.employee_id LEFT JOIN customers c ON c.id = ve.customer_id LEFT JOIN suppliers s ON s.id = ve.supplier_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, v.id, ve.id`
    ),
    q(
      `SELECT po.po_number, po.status, po.currency, po.created_at AS po_date, s.legal_name AS supplier_name, COALESCE(si.code,'') AS item_code, pol.item_name, pol.quantity, pol.rate, pol.line_total, po.freight, po.other_charges, po.surcharge, po.fumigation, po.document_charges, po.discount, po.items_total FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN po_line_items pol ON pol.po_id = po.id LEFT JOIN stock_items si ON si.id = pol.stock_item_id WHERE po.company_id = ${cid} ORDER BY po.created_at DESC, po.id, pol.id`
    ),
    q(
      `SELECT v.voucher_number, v.voucher_date, v.description AS notes, l1.name AS from_location, l2.name AS to_location, si.code AS item_code, si.name AS item_name, sti.quantity, sti.rate, sti.total_amount FROM stock_transfer_vouchers stv INNER JOIN vouchers v ON v.id = stv.voucher_id LEFT JOIN locations l1 ON l1.id = stv.source_location_id LEFT JOIN locations l2 ON l2.id = stv.destination_location_id LEFT JOIN stock_transfer_items sti ON sti.transfer_id = stv.id LEFT JOIN stock_items si ON si.id = sti.stock_item_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date DESC, stv.id, sti.id`
    ),
    q(
      `SELECT s.code AS supplier_code, s.legal_name AS supplier_name, s.phone, s.email, s.payment_terms, COALESCE(s.opening_balance,0) AS opening_balance, COALESCE(SUM(ve.debit_amount),0) AS total_debits, COALESCE(SUM(ve.credit_amount),0) AS total_credits FROM suppliers s INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id LEFT JOIN voucher_entries ve ON ve.supplier_id = s.id WHERE la.company_id = ${cid} AND s.deleted_at IS NULL GROUP BY s.id, s.code, s.legal_name, s.phone, s.email, s.payment_terms, s.opening_balance ORDER BY s.legal_name`
    ),
    q(
      `SELECT s.legal_name AS supplier_name, s.code AS supplier_code, v.voucher_number, v.voucher_type, v.voucher_date, la.code AS account_code, la.name AS account_name, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id INNER JOIN suppliers s ON s.id = ve.supplier_id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY s.legal_name, v.voucher_date, ve.id`
    ),
    q(
      `SELECT c.legal_name AS customer_name, c.code AS customer_code, cb.transaction_date, cb.transaction_type, cb.reference_type, cb.debit_amount, cb.credit_amount, cb.balance, cb.currency, cb.description, cb.side FROM customer_balances cb INNER JOIN customers c ON c.id = cb.customer_id WHERE cb.company_id = ${cid} ${df("cb.transaction_date")} ORDER BY c.legal_name, cb.transaction_date, cb.id`
    ),
    q(
      `SELECT c.legal_name AS customer_name, c.code AS customer_code, co.invoice_number, co.order_date, co.status, co.container_number, co.shipping_company, col.article_code, col.bale_name AS item_name, col.qty, col.weight_per_bale, col.total_weight, col.price_per_bale AS rate, col.total_price, co.freight_amount, co.other_charges_total, co.grand_total FROM customer_orders co INNER JOIN customers c ON c.id = co.customer_id LEFT JOIN customer_order_lines col ON col.order_id = co.id WHERE co.company_id = ${cid} ${df("co.order_date")} ORDER BY co.order_date DESC, co.id, col.id`
    ),
    q(
      `SELECT v.voucher_number, v.voucher_type, v.voucher_date, v.description AS narration, c.legal_name AS customer_name, si.code AS item_code, si.name AS item_name, l.name AS location_name, cni.quantity, cni.rate, cni.total_value, cni.inventory_cost FROM credit_note_items cni INNER JOIN vouchers v ON v.id = cni.voucher_id LEFT JOIN stock_items si ON si.id = cni.stock_item_id LEFT JOIN locations l ON l.id = cni.location_id LEFT JOIN LATERAL (SELECT ve2.customer_id FROM voucher_entries ve2 WHERE ve2.voucher_id = v.id AND ve2.customer_id IS NOT NULL LIMIT 1) ve ON true LEFT JOIN customers c ON c.id = ve.customer_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date DESC, v.id, cni.id`
    ),
    q(
      `SELECT sa.advance_date, sa.amount, sa.remaining_balance, sa.notes, sa.fully_paid, sa.is_opening_balance, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.code AS employee_code, e.department FROM salary_advances sa INNER JOIN employees e ON e.id = sa.employee_id WHERE sa.company_id = ${cid} ${df("sa.advance_date")} ORDER BY sa.advance_date, sa.id`
    ),
    q(
      `SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.code AS employee_code, e.department, v.voucher_number, v.voucher_type, v.voucher_date, la.code AS account_code, la.name AS account_name, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id INNER JOIN employees e ON e.id = ve.employee_id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY e.first_name, v.voucher_date, ve.id`
    ),
    q(
      `SELECT l.name AS location_name, sg.name AS stock_group, si.code AS item_code, si.name AS item_name, si.uom, i.quantity, i.average_rate AS rate, i.total_value, i.last_updated FROM inventory i INNER JOIN stock_items si ON si.id = i.stock_item_id INNER JOIN locations l ON l.id = i.location_id LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id WHERE i.company_id = ${cid} AND i.quantity != 0 ORDER BY l.name, sg.name, si.code`
    ),
  ]);

  return {
    company: companiesRows[0] || {},
    companySettings,
    locations,
    ledgerAccounts,
    bankAccounts,
    fixedAssets,
    exchangeRates,
    fiscalPeriodClosures,
    referenceSequences,
    agentAccounts,
    vouchers,
    voucherEntries,
    suppliers,
    supplierTransactions,
    supplierProformas,
    supplierProformaLines,
    supplierContainers,
    supplierContainerLoadedItems,
    customers,
    customerTransactions,
    customerBalances,
    customerOrders,
    customerOrderLines,
    customerOrderBales,
    customerOrderCharges,
    customerProformas,
    customerProformaLines,
    creditNoteItems,
    employees,
    employeePayrolls: employeePayrollRuns,
    employeePayrollItems,
    employeeAdvances,
    salaryAdvances,
    salaryAdvanceDeductions,
    employeeAdvanceRepayments,
    employeeAttendance,
    employeeBonuses,
    employeeGroups,
    employeeGroupMembers,
    employeeBaleRates,
    employeeBalePercentRates,
    workerDocs,
    factoryWorkers,
    factoryWorkerCategories,
    factoryWorkerDocuments,
    factoryWorkerAdvances,
    factoryAdvanceRepayments,
    factoryPayrolls,
    factoryAttendance,
    workerBonuses,
    factorySettings,
    factoryCategories,
    factoryDaybook,
    factoryDaybookEdits,
    factoryDailyKpiSnapshots,
    factoryDailyUsages,
    factoryAlerts,
    factoryDutyAuditLog,
    factoryRawStock,
    factoryRawMaterialAdjustments,
    factoryPressingBatches,
    pressingBatches,
    factoryMixBatches,
    factoryMixBatchSources,
    mixBatches,
    mixBatchSources,
    productionBales,
    productionRawStock,
    factoryBaleProducts,
    factoryBales,
    factoryBaleSequences,
    factoryBaleCostSnapshots,
    factoryBaleWasteDispatches,
    factoryWasteEntries,
    factoryContainers,
    factoryContainerPlans,
    factoryContainerPlanContainers,
    factoryContainerPlanLines,
    factoryContainerCommissions,
    factoryContainerOtherCharges,
    factoryContainerProfitSnapshots,
    factoryOffloadAdditionalCharges,
    factorySuppliers,
    factorySupplierPayments,
    factorySupplierFxTransfers,
    factorySupplierScoreSnapshots,
    factoryFxRates,
    factoryFxAllocations,
    factoryPosSales,
    factoryPosSaleItems,
    bales,
    baleProducts,
    baleProductCategories,
    baleSequences,
    baleLabelPrints,
    baleTransfers,
    baleTransferItems,
    baleRecodeSessions,
    baleRecodeItems,
    stockGroups,
    stockItems,
    stockItemCodeAliases,
    stockItemLocationPrices,
    inventory,
    inventoryNegativeLayers,
    stockGroupLocationArchives,
    stockGroupLocationArchiveItems,
    stockTransfers,
    stockTransferItems,
    stockTransferRevisions,
    stockTransferRevisionItems,
    stockAdjustments,
    stockAdjustmentItems,
    proformaStockReservations,
    containersDetail,
    containers,
    containerCharges,
    containerOffloads,
    containerOffloadItems,
    containerFreight,
    containerFreightPayments,
    containerDocuments,
    containerSales,
    purchaseOrders,
    poLineItems,
    posShifts,
    salesItems,
    wasteDispatches,
    wasteDispatchItems,
    spreadsheets,
    importLogs,
    auditLog,
    factoryBaleDetail,
    factoryWorkerAdvancesDetail,
    factoryPayrollDetail,
    factoryContainerDetail,
    factorySupplierPaymentsDetail,
    factoryRawStockDetail,
    factoryMixBatchDetail,
    factoryPosSalesDetail,
    voucherLinesDetail,
    poDetail,
    stockTransferDetail,
    supplierBalances,
    supplierTxnDetail,
    customerBalancesDetail,
    customerOrderDetail,
    creditNoteDetail,
    salaryAdvancesDetail,
    employeeTxnDetail,
    locationStockDetail,
  };
}
