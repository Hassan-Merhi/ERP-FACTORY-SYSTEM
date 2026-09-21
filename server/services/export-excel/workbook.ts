import { toArrayBuffer } from "../../lib/bufferCompatibility";
import ExcelJS from "exceljs";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { pool } from "../../db";
import type { CompanyExportData } from "../export-data";

import { ALT_FILL, HDR_FILL, HDR_FONT, addSheet } from "./sheet-helpers";
import { addSummarySheet } from "./summary-sheet";

export async function buildCompanyWorkbook(
  data: CompanyExportData,
  outputStream: NodeJS.WritableStream
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ERP System";
  wb.created = new Date();

  addSummarySheet(wb, data);

  // ── Company ───────────────────────────────────────────────────────────────
  addSheet(wb, "Company Info", [data.company]);
  addSheet(wb, "Company Settings", data.companySettings);
  addSheet(wb, "Locations", data.locations);

  // ── Finance ───────────────────────────────────────────────────────────────
  addSheet(wb, "Ledger Accounts", data.ledgerAccounts);
  addSheet(wb, "Bank Accounts", data.bankAccounts);
  addSheet(wb, "Fixed Assets", data.fixedAssets);
  addSheet(wb, "Exchange Rates", data.exchangeRates);
  addSheet(wb, "Fiscal Period Closures", data.fiscalPeriodClosures);
  addSheet(wb, "Reference Sequences", data.referenceSequences);
  addSheet(wb, "Agent Accounts", data.agentAccounts);

  // ── Vouchers ──────────────────────────────────────────────────────────────
  addSheet(wb, "Vouchers", data.vouchers);
  addSheet(wb, "Voucher Entries", data.voucherEntries);

  // ── Suppliers ─────────────────────────────────────────────────────────────
  addSheet(wb, "Suppliers", data.suppliers);
  addSheet(wb, "Supplier Transactions", data.supplierTransactions);
  addSheet(wb, "Supplier Proformas", data.supplierProformas);
  addSheet(wb, "Supplier Proforma Lines", data.supplierProformaLines);
  addSheet(wb, "Supplier Containers", data.supplierContainers);
  addSheet(wb, "Supplier Container Items", data.supplierContainerLoadedItems);

  // ── Customers ─────────────────────────────────────────────────────────────
  addSheet(wb, "Customers", data.customers);
  addSheet(wb, "Customer Transactions", data.customerTransactions);
  addSheet(wb, "Customer Balances", data.customerBalances);
  addSheet(wb, "Customer Orders", data.customerOrders);
  addSheet(wb, "Customer Order Lines", data.customerOrderLines);
  addSheet(wb, "Customer Order Bales", data.customerOrderBales);
  addSheet(wb, "Customer Order Charges", data.customerOrderCharges);
  addSheet(wb, "Customer Proformas", data.customerProformas);
  addSheet(wb, "Customer Proforma Lines", data.customerProformaLines);
  addSheet(wb, "Credit Note Items", data.creditNoteItems);

  // ── Employees ─────────────────────────────────────────────────────────────
  addSheet(wb, "Employees", data.employees);
  addSheet(wb, "Payroll Runs", data.employeePayrolls);
  addSheet(wb, "Payroll Run Items", data.employeePayrollItems);
  addSheet(wb, "Employee Advances", data.employeeAdvances);
  addSheet(wb, "Salary Advances", data.salaryAdvances);
  addSheet(wb, "Salary Advance Deductions", data.salaryAdvanceDeductions);
  addSheet(wb, "Employee Advance Repayments", data.employeeAdvanceRepayments);
  addSheet(wb, "Employee Attendance", data.employeeAttendance);
  addSheet(wb, "Employee Bonuses", data.employeeBonuses);
  addSheet(wb, "Employee Groups", data.employeeGroups);
  addSheet(wb, "Employee Group Members", data.employeeGroupMembers);
  addSheet(wb, "Employee Bale Rates", data.employeeBaleRates);
  addSheet(wb, "Employee Bale Pct Rates", data.employeeBalePercentRates);
  addSheet(wb, "Worker Documents", data.workerDocs);

  // ── Factory Workers ───────────────────────────────────────────────────────
  addSheet(wb, "Factory Workers", data.factoryWorkers);
  addSheet(wb, "Factory Worker Categories", data.factoryWorkerCategories);
  addSheet(wb, "Factory Worker Documents", data.factoryWorkerDocuments);
  addSheet(wb, "Factory Worker Advances", data.factoryWorkerAdvances);
  addSheet(wb, "Factory Advance Repayments", data.factoryAdvanceRepayments);
  addSheet(wb, "Factory Payrolls", data.factoryPayrolls);
  addSheet(wb, "Factory Attendance", data.factoryAttendance);
  addSheet(wb, "Worker Bonuses", data.workerBonuses);

  // ── Factory Operations ────────────────────────────────────────────────────
  addSheet(wb, "Factory Settings", data.factorySettings);
  addSheet(wb, "Factory Categories", data.factoryCategories);
  addSheet(wb, "Factory Daybook", data.factoryDaybook);
  addSheet(wb, "Daybook Entry Edits", data.factoryDaybookEdits);
  addSheet(wb, "Factory KPI Snapshots", data.factoryDailyKpiSnapshots);
  addSheet(wb, "Factory Daily Usages", data.factoryDailyUsages);
  addSheet(wb, "Factory Alerts", data.factoryAlerts);
  addSheet(wb, "Factory Duty Audit Log", data.factoryDutyAuditLog);

  // ── Factory Raw / Production ──────────────────────────────────────────────
  addSheet(wb, "Factory Raw Stock", data.factoryRawStock);
  addSheet(wb, "Raw Material Adjustments", data.factoryRawMaterialAdjustments);
  addSheet(wb, "Factory Pressing Batches", data.factoryPressingBatches);
  addSheet(wb, "Pressing Batches", data.pressingBatches);
  addSheet(wb, "Factory Mix Batches", data.factoryMixBatches);
  addSheet(wb, "Factory Mix Batch Sources", data.factoryMixBatchSources);
  addSheet(wb, "Mix Batches", data.mixBatches);
  addSheet(wb, "Mix Batch Sources", data.mixBatchSources);
  addSheet(wb, "Production Bales", data.productionBales);
  addSheet(wb, "Production Raw Stock", data.productionRawStock);

  // ── Factory Bales ─────────────────────────────────────────────────────────
  addSheet(wb, "Factory Bale Products", data.factoryBaleProducts);
  addSheet(wb, "Factory Bales", data.factoryBales);
  addSheet(wb, "Factory Bale Sequences", data.factoryBaleSequences);
  addSheet(wb, "Factory Bale Cost Snapshots", data.factoryBaleCostSnapshots);
  addSheet(wb, "Factory Bale Waste Dispatches", data.factoryBaleWasteDispatches);
  addSheet(wb, "Factory Waste Entries", data.factoryWasteEntries);

  // ── Factory Containers ────────────────────────────────────────────────────
  addSheet(wb, "Factory Containers", data.factoryContainers);
  addSheet(wb, "Container Plans", data.factoryContainerPlans);
  addSheet(wb, "Plan Containers", data.factoryContainerPlanContainers);
  addSheet(wb, "Plan Lines", data.factoryContainerPlanLines);
  addSheet(wb, "Factory Ctnr Commissions", data.factoryContainerCommissions);
  addSheet(wb, "Factory Ctnr Other Charges", data.factoryContainerOtherCharges);
  addSheet(wb, "Factory Ctnr PL Snapshots", data.factoryContainerProfitSnapshots);
  addSheet(wb, "Offload Additional Charges", data.factoryOffloadAdditionalCharges);

  // ── Factory Suppliers ─────────────────────────────────────────────────────
  addSheet(wb, "Factory Suppliers", data.factorySuppliers);
  addSheet(wb, "Factory Supplier Payments", data.factorySupplierPayments);
  addSheet(wb, "Factory Supplier FX Xfers", data.factorySupplierFxTransfers);
  addSheet(wb, "Factory Supplier Scores", data.factorySupplierScoreSnapshots);

  // ── Factory FX & POS ──────────────────────────────────────────────────────
  addSheet(wb, "Factory FX Rates", data.factoryFxRates);
  addSheet(wb, "Factory FX Allocations", data.factoryFxAllocations);
  addSheet(wb, "Factory POS Sales", data.factoryPosSales);
  addSheet(wb, "Factory POS Sale Items", data.factoryPosSaleItems);

  // ── Bales (Sorting) ───────────────────────────────────────────────────────
  addSheet(wb, "Bales (Sorting)", data.bales);
  addSheet(wb, "Bale Products", data.baleProducts);
  addSheet(wb, "Bale Product Categories", data.baleProductCategories);
  addSheet(wb, "Bale Sequences", data.baleSequences);
  addSheet(wb, "Bale Label Prints", data.baleLabelPrints);
  addSheet(wb, "Bale Transfers", data.baleTransfers);
  addSheet(wb, "Bale Transfer Items", data.baleTransferItems);
  addSheet(wb, "Bale Recode Sessions", data.baleRecodeSessions);
  addSheet(wb, "Bale Recode Items", data.baleRecodeItems);

  // ── Stock ─────────────────────────────────────────────────────────────────
  addSheet(wb, "Stock Groups", data.stockGroups);
  addSheet(wb, "Stock Items", data.stockItems);
  addSheet(wb, "Stock Item Aliases", data.stockItemCodeAliases);
  addSheet(wb, "Stock Item Location Prices", data.stockItemLocationPrices);
  addSheet(wb, "Inventory by Location", data.inventory);
  addSheet(wb, "Inventory Negative Layers", data.inventoryNegativeLayers);
  addSheet(wb, "Stock Group Archives", data.stockGroupLocationArchives);
  addSheet(wb, "Stock Group Archive Items", data.stockGroupLocationArchiveItems);
  addSheet(wb, "Stock Transfers", data.stockTransfers);
  addSheet(wb, "Transfer Items", data.stockTransferItems);
  addSheet(wb, "Transfer Revisions", data.stockTransferRevisions);
  addSheet(wb, "Revision Items", data.stockTransferRevisionItems);
  addSheet(wb, "Stock Adjustments", data.stockAdjustments);
  addSheet(wb, "Adjustment Items", data.stockAdjustmentItems);
  addSheet(wb, "Proforma Reservations", data.proformaStockReservations);

  // ── Containers ────────────────────────────────────────────────────────────
  addSheet(wb, "Containers Detail", data.containersDetail);
  addSheet(wb, "Containers", data.containers);
  addSheet(wb, "Container Charges", data.containerCharges);
  addSheet(wb, "Container Offloads", data.containerOffloads);
  addSheet(wb, "Offload Items", data.containerOffloadItems);
  addSheet(wb, "Container Freight", data.containerFreight);
  addSheet(wb, "Container Freight Payments", data.containerFreightPayments);
  addSheet(wb, "Container Documents", data.containerDocuments);
  addSheet(wb, "Container Sales", data.containerSales);

  // ── Purchase Orders ───────────────────────────────────────────────────────
  addSheet(wb, "Purchase Orders", data.purchaseOrders);
  addSheet(wb, "PO Line Items", data.poLineItems);

  // ── POS ───────────────────────────────────────────────────────────────────
  addSheet(wb, "POS Shifts", data.posShifts);
  addSheet(wb, "Sales Items", data.salesItems);

  // ── Waste ─────────────────────────────────────────────────────────────────
  addSheet(wb, "Waste Dispatches", data.wasteDispatches);
  addSheet(wb, "Waste Dispatch Items", data.wasteDispatchItems);

  // ── Misc ──────────────────────────────────────────────────────────────────
  addSheet(wb, "Spreadsheets", data.spreadsheets);
  addSheet(wb, "Import Logs", data.importLogs);

  // ── Audit ─────────────────────────────────────────────────────────────────
  addSheet(wb, "Audit Log", data.auditLog);

  // ── Factory Enriched Detail Views ─────────────────────────────────────────
  addSheet(wb, "Factory Bale Production", data.factoryBaleDetail);
  addSheet(wb, "Factory Wkr Advances Detail", data.factoryWorkerAdvancesDetail);
  addSheet(wb, "Factory Payroll Detail", data.factoryPayrollDetail);
  addSheet(wb, "Factory Container Detail", data.factoryContainerDetail);
  addSheet(wb, "Factory Supplier Pay Detail", data.factorySupplierPaymentsDetail);
  addSheet(wb, "Factory Raw Stock Detail", data.factoryRawStockDetail);
  addSheet(wb, "Factory Mix Batch Detail", data.factoryMixBatchDetail);
  addSheet(wb, "Factory POS Sales Detail", data.factoryPosSalesDetail);

  // ── ERP Enriched Detail Views ─────────────────────────────────────────────
  addSheet(wb, "Voucher Lines Detail", data.voucherLinesDetail);
  addSheet(wb, "PO Detail", data.poDetail);
  addSheet(wb, "Stock Transfer Detail", data.stockTransferDetail);
  addSheet(wb, "Supplier Balances", data.supplierBalances);
  addSheet(wb, "Supplier Txn Detail", data.supplierTxnDetail);
  addSheet(wb, "Customer Balances Detail", data.customerBalancesDetail);
  addSheet(wb, "Customer Order Detail", data.customerOrderDetail);
  addSheet(wb, "Credit-Debit Note Detail", data.creditNoteDetail);
  addSheet(wb, "Salary Advances Detail", data.salaryAdvancesDetail);
  addSheet(wb, "Employee Txn Detail", data.employeeTxnDetail);
  addSheet(wb, "Location Stock Detail", data.locationStockDetail);

  const buf1 = Buffer.from(await wb.xlsx.writeBuffer());
  outputStream.write(buf1);
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY-SAFE STREAMING WORKBOOK
// Fetches one sheet at a time, discards raw data before querying the next.
// Peak RAM = ExcelJS workbook + one dataset, instead of all datasets at once.
// ─────────────────────────────────────────────────────────────────────────────

async function qStream(sql: string) {
  try {
    const r = await pool.query(sql);
    return r.rows;
  } catch (err: unknown) {
    logger.warn(`[ExportStream] Query warning: ${getErrorMessage(err)}`);
    return [];
  }
}

export async function streamCompanyWorkbookDirect(
  companyId: number,
  fromDate: string | undefined,
  toDate: string | undefined
): Promise<Buffer> {
  const cid = Number(companyId);
  const df = (col: string): string => {
    const parts: string[] = [];
    if (fromDate) parts.push(`AND ${col} >= '${fromDate}'`);
    if (toDate) parts.push(`AND ${col} <= '${toDate}'`);
    return parts.join(" ");
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "ERP System";
  wb.created = new Date();

  const summaryRows: [string, number][] = [];

  // Create SUMMARY worksheet first so it is always the first tab in the workbook.
  // ExcelJS has no ws.moveTo() API — sheet order is determined by creation order.
  const summaryWs = wb.addWorksheet("SUMMARY");
  summaryWs.getColumn(1).width = 38;
  summaryWs.getColumn(2).width = 18;
  // Content is written after all data sheets are fetched (summaryRows must be complete).

  async function fetch1(sheetName: string, sql: string): Promise<void> {
    const rows = await qStream(sql);
    try {
      addSheet(wb, sheetName, rows);
    } catch (sheetErr: unknown) {
      logger.warn(`[FullExport] Sheet failed: ${sheetName} - ${getErrorMessage(sheetErr)}`);
    }
    summaryRows.push([sheetName, rows.length]);
    // rows goes out of scope here — GC can reclaim it before next fetch
  }

  // ── Company ────────────────────────────────────────────────────────────────
  await fetch1("Company Info", `SELECT * FROM companies WHERE id = ${cid}`);
  await fetch1("Company Settings", `SELECT * FROM company_settings WHERE company_id = ${cid}`);
  await fetch1("Locations", `SELECT * FROM locations WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY name`);

  // ── Finance ────────────────────────────────────────────────────────────────
  await fetch1(
    "Ledger Accounts",
    `SELECT * FROM ledger_accounts WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY code`
  );
  await fetch1(
    "Bank Accounts",
    `SELECT * FROM bank_accounts WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY name`
  );
  await fetch1("Fixed Assets", `SELECT * FROM fixed_assets WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Exchange Rates",
    `SELECT * FROM exchange_rates WHERE company_id = ${cid} ${df("effective_date")} ORDER BY effective_date DESC, id`
  );
  await fetch1("Fiscal Period Closures", `SELECT * FROM fiscal_period_closures WHERE company_id = ${cid} ORDER BY id`);
  await fetch1("Reference Sequences", `SELECT * FROM reference_sequences WHERE company_id = ${cid} ORDER BY id`);
  await fetch1("Agent Accounts", `SELECT * FROM agent_accounts WHERE company_id = ${cid} ORDER BY id`);

  // ── Vouchers ───────────────────────────────────────────────────────────────
  await fetch1(
    "Vouchers",
    `SELECT * FROM vouchers WHERE company_id = ${cid} ${df("voucher_date")} ORDER BY voucher_date, id`
  );
  await fetch1(
    "Voucher Entries",
    `SELECT ve.* FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY ve.id`
  );

  // ── Suppliers ──────────────────────────────────────────────────────────────
  await fetch1(
    "Suppliers",
    `SELECT s.* FROM suppliers s INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} AND s.deleted_at IS NULL ORDER BY s.legal_name`
  );
  await fetch1(
    "Supplier Transactions",
    `SELECT ve.*, v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} AND ve.supplier_id IS NOT NULL ${df("v.voucher_date")} ORDER BY v.voucher_date, ve.id`
  );
  await fetch1("Supplier Proformas", `SELECT * FROM supplier_proformas WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Supplier Proforma Lines",
    `SELECT spl.* FROM supplier_proforma_lines spl INNER JOIN supplier_proformas sp ON sp.id = spl.proforma_id WHERE sp.company_id = ${cid} ORDER BY spl.id`
  );
  await fetch1(
    "Supplier Containers",
    `SELECT sc.* FROM supplier_containers sc INNER JOIN suppliers s ON s.id = sc.supplier_id INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} ORDER BY sc.id DESC`
  );
  await fetch1(
    "Supplier Container Items",
    `SELECT scl.* FROM supplier_container_loaded_items scl INNER JOIN supplier_containers sc ON sc.id = scl.container_id INNER JOIN suppliers s ON s.id = sc.supplier_id INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id WHERE la.company_id = ${cid} ORDER BY scl.id`
  );

  // ── Customers ──────────────────────────────────────────────────────────────
  await fetch1(
    "Customers",
    `SELECT * FROM customers WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY legal_name`
  );
  await fetch1(
    "Customer Transactions",
    `SELECT ve.*, v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = ${cid} AND ve.customer_id IS NOT NULL ${df("v.voucher_date")} ORDER BY v.voucher_date, ve.id`
  );
  await fetch1("Customer Balances", `SELECT * FROM customer_balances WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Customer Orders",
    `SELECT * FROM customer_orders WHERE company_id = ${cid} ${df("order_date")} ORDER BY order_date DESC, id`
  );
  await fetch1(
    "Customer Order Lines",
    `SELECT col.* FROM customer_order_lines col INNER JOIN customer_orders co ON co.id = col.order_id WHERE co.company_id = ${cid} ORDER BY col.id`
  );
  await fetch1(
    "Customer Order Bales",
    `SELECT cob.* FROM customer_order_bales cob INNER JOIN customer_orders co ON co.id = cob.order_id WHERE co.company_id = ${cid} ORDER BY cob.id`
  );
  await fetch1(
    "Customer Order Charges",
    `SELECT coc.* FROM customer_order_charges coc INNER JOIN customer_orders co ON co.id = coc.order_id WHERE co.company_id = ${cid} ORDER BY coc.id`
  );
  await fetch1("Customer Proformas", `SELECT * FROM customer_proformas WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Customer Proforma Lines",
    `SELECT cpl.* FROM customer_proforma_lines cpl INNER JOIN customer_proformas cp ON cp.id = cpl.proforma_id WHERE cp.company_id = ${cid} ORDER BY cpl.id`
  );
  await fetch1(
    "Credit Note Items",
    `SELECT cni.* FROM credit_note_items cni INNER JOIN vouchers v ON v.id = cni.voucher_id WHERE v.company_id = ${cid} ORDER BY cni.id`
  );

  // ── Employees ──────────────────────────────────────────────────────────────
  await fetch1(
    "Employees",
    `SELECT * FROM employees WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY first_name, last_name`
  );
  await fetch1(
    "Payroll Runs",
    `SELECT * FROM erp_payroll_runs WHERE company_id = ${cid} ${df("date")} ORDER BY date, id`
  );
  await fetch1(
    "Payroll Run Items",
    `SELECT p.* FROM erp_payroll_run_items p INNER JOIN erp_payroll_runs r ON r.id = p.run_id WHERE r.company_id = ${cid} ${df("r.date")} ORDER BY r.date, p.id`
  );
  await fetch1("Employee Advances", `SELECT * FROM employee_advances WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Salary Advances",
    `SELECT * FROM salary_advances WHERE company_id = ${cid} ${df("advance_date")} ORDER BY advance_date, id`
  );
  await fetch1(
    "Salary Advance Deductions",
    `SELECT sad.* FROM salary_advance_deductions sad INNER JOIN salary_advances sa ON sa.id = sad.salary_advance_id WHERE sa.company_id = ${cid} ORDER BY sad.id`
  );
  await fetch1(
    "Employee Advance Repayments",
    `SELECT * FROM employee_advance_repayments WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Employee Attendance",
    `SELECT * FROM employee_attendance WHERE company_id = ${cid} ${df("attendance_date")} ORDER BY attendance_date, id`
  );
  await fetch1(
    "Employee Bonuses",
    `SELECT * FROM employee_bonuses WHERE company_id = ${cid} ${df("bonus_date")} ORDER BY bonus_date, id`
  );
  await fetch1("Employee Groups", `SELECT * FROM employee_groups WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Employee Group Members",
    `SELECT egm.* FROM employee_group_members egm INNER JOIN employee_groups eg ON eg.id = egm.employee_group_id WHERE eg.company_id = ${cid} ORDER BY egm.id`
  );
  await fetch1("Employee Bale Rates", `SELECT * FROM employee_bale_rates WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Employee Bale Pct Rates",
    `SELECT * FROM employee_bale_pct_rates WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1("Worker Documents", `SELECT * FROM erp_worker_docs WHERE company_id = ${cid} ORDER BY id`);

  // ── Factory Workers ────────────────────────────────────────────────────────
  await fetch1("Factory Workers", `SELECT * FROM factory_workers WHERE company_id = ${cid} ORDER BY full_name`);
  await fetch1(
    "Factory Worker Categories",
    `SELECT * FROM factory_worker_categories WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Worker Documents",
    `SELECT * FROM factory_worker_documents WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Worker Advances",
    `SELECT * FROM factory_worker_advances WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Advance Repayments",
    `SELECT * FROM factory_advance_repayments WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Payrolls",
    `SELECT * FROM factory_payrolls WHERE company_id = ${cid} ${df("period_start")} ORDER BY period_start, id`
  );
  await fetch1(
    "Factory Attendance",
    `SELECT * FROM factory_attendance WHERE company_id = ${cid} ${df("attendance_date")} ORDER BY attendance_date, id`
  );
  await fetch1("Worker Bonuses", `SELECT * FROM worker_bonuses WHERE company_id = ${cid} ORDER BY id`);

  // ── Factory Operations ─────────────────────────────────────────────────────
  await fetch1("Factory Settings", `SELECT * FROM factory_settings WHERE company_id = ${cid}`);
  await fetch1("Factory Categories", `SELECT * FROM factory_categories WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Factory Daybook",
    `SELECT * FROM factory_daybook_entries WHERE company_id = ${cid} ${df("tx_date")} ORDER BY tx_date, id`
  );
  await fetch1(
    "Daybook Entry Edits",
    `SELECT fde.* FROM factory_daybook_entry_edits fde INNER JOIN factory_daybook_entries fdb ON fdb.id = fde.daybook_entry_id WHERE fdb.company_id = ${cid} ORDER BY fde.id`
  );
  await fetch1(
    "Factory KPI Snapshots",
    `SELECT * FROM factory_daily_kpi_snapshots WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC`
  );
  await fetch1(
    "Factory Daily Usages",
    `SELECT * FROM factory_daily_usages WHERE company_id = ${cid} ${df("used_date")} ORDER BY used_date DESC`
  );
  await fetch1("Factory Alerts", `SELECT * FROM factory_alerts WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Factory Duty Audit Log",
    `SELECT * FROM factory_duty_audit_log WHERE company_id = ${cid} ORDER BY id DESC LIMIT 50000`
  );

  // ── Factory Raw / Production ───────────────────────────────────────────────
  await fetch1("Factory Raw Stock", `SELECT * FROM factory_raw_stock WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Raw Material Adjustments",
    `SELECT * FROM factory_raw_material_adjustments WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`
  );
  await fetch1(
    "Factory Pressing Batches",
    `SELECT * FROM factory_pressing_batches WHERE company_id = ${cid} ${df("created_at::date")} ORDER BY created_at DESC, id`
  );
  await fetch1("Pressing Batches", `SELECT * FROM pressing_batches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1("Factory Mix Batches", `SELECT * FROM factory_mix_batches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Factory Mix Batch Sources",
    `SELECT fms.* FROM factory_mix_batch_sources fms INNER JOIN factory_mix_batches fmb ON fmb.id = fms.mix_batch_id WHERE fmb.company_id = ${cid} ORDER BY fms.id`
  );
  await fetch1("Mix Batches", `SELECT * FROM mix_batches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Mix Batch Sources",
    `SELECT mbs.* FROM mix_batch_sources mbs INNER JOIN mix_batches mb ON mb.id = mbs.mix_batch_id WHERE mb.company_id = ${cid} ORDER BY mbs.id`
  );
  await fetch1(
    "Production Bales",
    `SELECT * FROM production_bales WHERE company_id = ${cid} ORDER BY id DESC LIMIT 100000`
  );
  await fetch1("Production Raw Stock", `SELECT * FROM production_raw_stock WHERE company_id = ${cid} ORDER BY id`);

  // ── Factory Bales ──────────────────────────────────────────────────────────
  await fetch1("Factory Bale Products", `SELECT * FROM factory_bale_products WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Factory Bales",
    `SELECT * FROM factory_bales WHERE company_id = ${cid} ${df("pressed_at::date")} ORDER BY pressed_at DESC, id`
  );
  await fetch1("Factory Bale Sequences", `SELECT * FROM factory_bale_sequences WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Factory Bale Cost Snapshots",
    `SELECT * FROM factory_bale_cost_snapshots WHERE company_id = ${cid} ORDER BY id DESC LIMIT 50000`
  );
  await fetch1(
    "Factory Bale Waste Dispatches",
    `SELECT * FROM factory_bale_waste_dispatches WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Factory Waste Entries",
    `SELECT * FROM factory_waste_entries WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`
  );

  // ── Factory Containers ─────────────────────────────────────────────────────
  await fetch1("Factory Containers", `SELECT * FROM factory_containers WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Container Plans",
    `SELECT * FROM factory_container_plans WHERE company_id = ${cid} ORDER BY updated_at DESC, id DESC`
  );
  await fetch1(
    "Plan Containers",
    `SELECT * FROM factory_container_plan_containers WHERE company_id = ${cid} ORDER BY plan_id, position, id`
  );
  await fetch1(
    "Plan Lines",
    `SELECT * FROM factory_container_plan_lines WHERE company_id = ${cid} ORDER BY plan_id, plan_container_id, product_name, article_code`
  );
  await fetch1(
    "Factory Ctnr Commissions",
    `SELECT * FROM factory_container_commissions WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Ctnr Other Charges",
    `SELECT * FROM factory_container_other_charges WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Factory Ctnr PL Snapshots",
    `SELECT * FROM factory_container_profit_snapshots WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Offload Additional Charges",
    `SELECT * FROM factory_offload_additional_charges WHERE company_id = ${cid} ORDER BY id`
  );

  // ── Factory Suppliers ──────────────────────────────────────────────────────
  await fetch1("Factory Suppliers", `SELECT * FROM factory_suppliers WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Factory Supplier Payments",
    `SELECT * FROM factory_supplier_payments WHERE company_id = ${cid} ${df("date")} ORDER BY date DESC, id`
  );
  await fetch1(
    "Factory Supplier FX Xfers",
    `SELECT * FROM factory_supplier_fx_transfers WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Factory Supplier Scores",
    `SELECT * FROM factory_supplier_score_snapshots WHERE company_id = ${cid} ORDER BY id DESC`
  );

  // ── Factory FX & POS ──────────────────────────────────────────────────────
  await fetch1("Factory FX Rates", `SELECT * FROM factory_fx_rates WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Factory FX Allocations",
    `SELECT * FROM factory_fx_allocations WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1(
    "Factory POS Sales",
    `SELECT * FROM factory_pos_sales WHERE company_id = ${cid} ${df("tx_date")} ORDER BY tx_date DESC, id`
  );
  await fetch1(
    "Factory POS Sale Items",
    `SELECT fps.* FROM factory_pos_sale_items fps INNER JOIN factory_pos_sales fp ON fp.id = fps.sale_id WHERE fp.company_id = ${cid} ORDER BY fps.id`
  );

  // ── Bales (Sorting) ────────────────────────────────────────────────────────
  await fetch1(
    "Bales (Sorting)",
    `SELECT * FROM bales WHERE company_id = ${cid} ${df("date_pressed")} ORDER BY date_pressed DESC, id`
  );
  await fetch1("Bale Products", `SELECT * FROM bale_products WHERE company_id = ${cid} ORDER BY name`);
  await fetch1(
    "Bale Product Categories",
    `SELECT * FROM bale_product_categories WHERE company_id = ${cid} ORDER BY name`
  );
  await fetch1("Bale Sequences", `SELECT * FROM bale_sequences WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Bale Label Prints",
    `SELECT * FROM bale_label_prints WHERE company_id = ${cid} ORDER BY id DESC LIMIT 100000`
  );
  await fetch1("Bale Transfers", `SELECT * FROM bale_transfers WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Bale Transfer Items",
    `SELECT bti.* FROM bale_transfer_items bti INNER JOIN bale_transfers bt ON bt.id = bti.transfer_id WHERE bt.company_id = ${cid} ORDER BY bti.id`
  );
  await fetch1("Bale Recode Sessions", `SELECT * FROM bale_recode_sessions WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Bale Recode Items",
    `SELECT bri.* FROM bale_recode_items bri INNER JOIN bale_recode_sessions brs ON brs.id = bri.session_id WHERE brs.company_id = ${cid} ORDER BY bri.id`
  );

  // ── Stock ──────────────────────────────────────────────────────────────────
  await fetch1("Stock Groups", `SELECT * FROM stock_groups WHERE company_id = ${cid} ORDER BY name`);
  await fetch1("Stock Items", `SELECT * FROM stock_items WHERE company_id = ${cid} ORDER BY code`);
  await fetch1("Stock Item Aliases", `SELECT * FROM stock_item_code_aliases WHERE company_id = ${cid} ORDER BY id`);
  await fetch1(
    "Stock Item Location Prices",
    `SELECT silp.* FROM stock_item_location_prices silp INNER JOIN stock_items si ON si.id = silp.stock_item_id WHERE si.company_id = ${cid} ORDER BY silp.id`
  );
  await fetch1(
    "Inventory by Location",
    `SELECT i.*, si.code AS item_code, si.name AS item_name, l.name AS location_name FROM inventory i INNER JOIN stock_items si ON si.id = i.stock_item_id INNER JOIN locations l ON l.id = i.location_id WHERE si.company_id = ${cid} ORDER BY l.name, si.code`
  );
  await fetch1(
    "Inventory Negative Layers",
    `SELECT * FROM inventory_negative_layers WHERE company_id = ${cid} ORDER BY id`
  );
  await fetch1(
    "Stock Group Archives",
    `SELECT * FROM stock_group_location_archives WHERE company_id = ${cid} AND deleted_at IS NULL ORDER BY id`
  );
  await fetch1(
    "Stock Group Archive Items",
    `SELECT sglai.* FROM stock_group_location_archive_items sglai INNER JOIN stock_group_location_archives sgla ON sgla.id = sglai.archive_id WHERE sgla.company_id = ${cid} ORDER BY sglai.id`
  );
  await fetch1(
    "Stock Transfers",
    `SELECT stv.*, v.voucher_number, v.voucher_date, v.description AS transfer_notes, l1.name AS from_location_name, l2.name AS to_location_name FROM stock_transfer_vouchers stv INNER JOIN vouchers v ON v.id = stv.voucher_id LEFT JOIN locations l1 ON l1.id = stv.source_location_id LEFT JOIN locations l2 ON l2.id = stv.destination_location_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, stv.id`
  );
  await fetch1(
    "Transfer Items",
    `SELECT sti.* FROM stock_transfer_items sti INNER JOIN stock_transfer_vouchers stv ON stv.id = sti.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY sti.id`
  );
  await fetch1(
    "Transfer Revisions",
    `SELECT r.* FROM stock_transfer_revisions r INNER JOIN stock_transfer_vouchers stv ON stv.id = r.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY r.id`
  );
  await fetch1(
    "Revision Items",
    `SELECT ri.* FROM stock_transfer_revision_items ri INNER JOIN stock_transfer_revisions r ON r.id = ri.revision_id INNER JOIN stock_transfer_vouchers stv ON stv.id = r.transfer_id INNER JOIN vouchers v ON v.id = stv.voucher_id WHERE v.company_id = ${cid} ORDER BY ri.id`
  );
  await fetch1(
    "Stock Adjustments",
    `SELECT sav.* FROM stock_adjustment_vouchers sav INNER JOIN vouchers v ON v.id = sav.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY sav.id`
  );
  await fetch1(
    "Adjustment Items",
    `SELECT ai.* FROM stock_adjustment_items ai INNER JOIN stock_adjustment_vouchers av ON av.id = ai.adjustment_id INNER JOIN vouchers v ON v.id = av.voucher_id WHERE v.company_id = ${cid} ORDER BY ai.id`
  );
  await fetch1(
    "Proforma Reservations",
    `SELECT * FROM proforma_stock_reservations WHERE company_id = ${cid} ORDER BY id`
  );

  // ── Containers ─────────────────────────────────────────────────────────────
  await fetch1(
    "Containers Detail",
    `
    SELECT c.container_number, c.status, c.import_date, c.eta, c.eta_source,
      c.border_date, c.offload_date, c.item_name, c.total_kg, c.rate_per_kg,
      c.items_total, c.charges_total, c.grand_total, c.transport_fee, c.duty_fee,
      c.agent, c.transporter, c.number_plate, c.shop_name, c.tracking_location,
      c.tracking_description, c.doc_received, s.legal_name AS supplier_name, s.phone AS supplier_phone,
      COALESCE(ch.total_charges, 0) AS total_other_charges, COALESCE(ch.charge_breakdown,'') AS charge_breakdown,
      COALESCE(fr.freight_amount_usd, 0) AS freight_usd, COALESCE(fr.freight_amount_local, 0) AS freight_local,
      COALESCE(off.total_bales, 0) AS offloaded_bales, COALESCE(off.duties, 0) AS offload_duties,
      COALESCE(off.office_charges, 0) AS offload_office_charges, COALESCE(off.transfer_charges, 0) AS offload_transfer_charges,
      COALESCE(off.transport_fees, 0) AS offload_transport_fees, COALESCE(off.total_charges, 0) AS offload_total_charges,
      COALESCE(sa.total_sale_amount, 0) AS total_sale_amount, COALESCE(sa.total_paid, 0) AS total_paid,
      COALESCE(sa.total_commission, 0) AS total_commission, COALESCE(sa.sale_count, 0) AS sale_count,
      COALESCE(oi.offload_qty, 0) AS offload_qty_items, COALESCE(oi.offload_value, 0) AS offload_value
    FROM containers c
    LEFT JOIN suppliers s ON s.id = c.supplier_id
    LEFT JOIN LATERAL (SELECT SUM(cc.amount) AS total_charges, STRING_AGG(cc.charge_name||': '||cc.amount::text,' | ' ORDER BY cc.id) AS charge_breakdown FROM container_charges cc WHERE cc.container_id=c.id) ch ON true
    LEFT JOIN LATERAL (SELECT SUM(CASE WHEN cf.currency='USD' THEN cf.freight_amount ELSE 0 END) AS freight_amount_usd, SUM(CASE WHEN cf.currency!='USD' THEN cf.freight_amount ELSE 0 END) AS freight_amount_local FROM container_freight cf WHERE cf.container_id=c.id) fr ON true
    LEFT JOIN LATERAL (SELECT SUM(co.total_bales) AS total_bales, SUM(co.duties) AS duties, SUM(co.office_charges) AS office_charges, SUM(co.transfer_charges) AS transfer_charges, SUM(co.transport_fees) AS transport_fees, SUM(co.total_charges) AS total_charges FROM container_offloads co WHERE co.container_id=c.id) off ON true
    LEFT JOIN LATERAL (SELECT SUM(cs.total_amount) AS total_sale_amount, SUM(cs.paid_amount) AS total_paid, SUM(cs.commission) AS total_commission, COUNT(cs.id) AS sale_count FROM container_sales cs WHERE cs.container_id=c.id) sa ON true
    LEFT JOIN LATERAL (SELECT SUM(coi.quantity) AS offload_qty, SUM(coi.total_value) AS offload_value FROM container_offload_items coi INNER JOIN container_offloads co ON co.id=coi.offload_id WHERE co.container_id=c.id) oi ON true
    WHERE c.company_id = ${cid} ORDER BY c.import_date DESC NULLS LAST, c.id DESC`
  );
  await fetch1(
    "Containers",
    `SELECT * FROM containers WHERE company_id = ${cid} ${df("import_date")} ORDER BY import_date DESC, id`
  );
  await fetch1(
    "Container Charges",
    `SELECT cc.* FROM container_charges cc INNER JOIN containers c ON c.id = cc.container_id WHERE c.company_id = ${cid} ORDER BY cc.id`
  );
  await fetch1(
    "Container Offloads",
    `SELECT co.* FROM container_offloads co INNER JOIN containers c ON c.id = co.container_id WHERE c.company_id = ${cid} ORDER BY co.id`
  );
  await fetch1(
    "Offload Items",
    `SELECT coi.* FROM container_offload_items coi INNER JOIN container_offloads co ON co.id = coi.offload_id INNER JOIN containers c ON c.id = co.container_id WHERE c.company_id = ${cid} ORDER BY coi.id`
  );
  await fetch1("Container Freight", `SELECT * FROM container_freight WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Container Freight Payments",
    `SELECT * FROM container_freight_payments WHERE company_id = ${cid} ORDER BY id DESC`
  );
  await fetch1("Container Documents", `SELECT * FROM container_documents WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1("Container Sales", `SELECT * FROM container_sales WHERE company_id = ${cid} ORDER BY id DESC`);

  // ── Purchase Orders ────────────────────────────────────────────────────────
  await fetch1(
    "Purchase Orders",
    `SELECT po.* FROM purchase_orders po WHERE po.company_id = ${cid} ${df("po.created_at::date")} ORDER BY po.created_at, po.id`
  );
  await fetch1(
    "PO Line Items",
    `SELECT pli.* FROM po_line_items pli INNER JOIN purchase_orders po ON po.id = pli.po_id WHERE po.company_id = ${cid} ORDER BY pli.id`
  );

  // ── POS ────────────────────────────────────────────────────────────────────
  await fetch1(
    "POS Shifts",
    `SELECT * FROM pos_shifts WHERE company_id = ${cid} ${df("opened_at::date")} ORDER BY opened_at DESC`
  );
  await fetch1(
    "Sales Items",
    `SELECT si.*, v.voucher_number, v.voucher_date FROM sales_items si INNER JOIN vouchers v ON v.id = si.voucher_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, si.id`
  );

  // ── Waste ──────────────────────────────────────────────────────────────────
  await fetch1("Waste Dispatches", `SELECT * FROM waste_dispatches WHERE company_id = ${cid} ORDER BY id DESC`);
  await fetch1(
    "Waste Dispatch Items",
    `SELECT wdi.* FROM waste_dispatch_items wdi INNER JOIN waste_dispatches wd ON wd.id = wdi.dispatch_id WHERE wd.company_id = ${cid} ORDER BY wdi.id`
  );

  // ── Misc ───────────────────────────────────────────────────────────────────
  await fetch1(
    "Spreadsheets",
    `SELECT id, name, created_at, updated_at FROM spreadsheets WHERE company_id = ${cid} ORDER BY name`
  );
  await fetch1("Import Logs", `SELECT * FROM import_logs WHERE company_id = ${cid} ORDER BY id DESC LIMIT 10000`);
  await fetch1(
    "Audit Log",
    `SELECT * FROM audit_log WHERE company_id = ${cid} ${df("created_at::date")} ORDER BY created_at DESC LIMIT 50000`
  );

  // ── Factory Enriched Detail Views ──────────────────────────────────────────
  await fetch1(
    "Factory Bale Production",
    `SELECT fb.bale_code, fb.reference_number, fb.article_code, fb.product_name, fb.weight_kg, fb.cost_per_kg, fb.total_cost, fb.status, fb.pressed_at, fb.finalized_at, fb.category, fb.grade, fb.quantity, fb.stock_entry_date, fb.notes, fbp.code AS product_code, fbp.selling_price, fbp.production_price, l.name AS erp_location, fmb.batch_code AS mix_batch_code, fmb.batch_number AS mix_batch_number FROM factory_bales fb LEFT JOIN factory_bale_products fbp ON fbp.id = fb.product_id LEFT JOIN locations l ON l.id = fb.erp_location_id LEFT JOIN factory_mix_batches fmb ON fmb.id = fb.mix_batch_id WHERE fb.company_id = ${cid} ${df("fb.pressed_at::date")} ORDER BY fb.pressed_at DESC, fb.id`
  );
  await fetch1(
    "Factory Wkr Advances Detail",
    `SELECT fa.advance_date, fa.amount, fa.remaining_balance, fa.notes, fa.fully_paid, fa.repayment_type, fw.full_name AS worker_name, fw.employee_code, fw.department, fw.position FROM factory_worker_advances fa INNER JOIN factory_workers fw ON fw.id = fa.worker_id WHERE fa.company_id = ${cid} ORDER BY fa.advance_date, fa.id`
  );
  await fetch1(
    "Factory Payroll Detail",
    `SELECT fp.period_start, fp.period_end, fp.status, fp.base_salary, fp.bale_earnings, fp.kg_earnings, fp.overtime_pay, fp.bonuses, fp.deductions, fp.advances, fp.net_salary, fp.bales_count, fp.kg_processed, fp.overtime_hours, fp.total_working_days, fp.present_days, fp.absent_days, fp.transport, fp.notes, fw.full_name AS worker_name, fw.employee_code, fw.department, fw.position, fw.salary_type FROM factory_payrolls fp INNER JOIN factory_workers fw ON fw.id = fp.worker_id WHERE fp.company_id = ${cid} ${df("fp.period_start")} ORDER BY fp.period_start, fp.id`
  );
  await fetch1(
    "Factory Container Detail",
    `SELECT fc.container_number, fc.status, fc.arrival_date, fc.total_kg, fc.declared_kg, fc.actual_received_kg, fc.difference_kg, fc.rate_per_kg, fc.currency_code, fc.fx_rate_to_usd, fc.rate_per_kg_usd, fc.freight, fc.other_charges, fc.commission_amount, fc.duty_amount, fc.duty_status, fc.final_payable_amount, fc.final_payable_amount_usd, fc.notes, fs.name AS supplier_name FROM factory_containers fc LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id WHERE fc.company_id = ${cid} ORDER BY fc.arrival_date DESC, fc.id`
  );
  await fetch1(
    "Factory Supplier Pay Detail",
    `SELECT fsp.date AS payment_date, fsp.amount, fsp.currency_code, fsp.fx_rate_to_usd, fsp.amount_usd, fsp.notes, fs.name AS supplier_name FROM factory_supplier_payments fsp INNER JOIN factory_suppliers fs ON fs.id = fsp.supplier_id WHERE fsp.company_id = ${cid} ${df("fsp.date")} ORDER BY fsp.date DESC, fsp.id`
  );
  await fetch1(
    "Factory Raw Stock Detail",
    `SELECT fr.offloaded_at, fr.material_type, fr.quantity_kg, fr.received_kg, fr.used_kg, fr.rate_per_kg, fr.cost_per_kg, fr.cost_per_kg_usd, fr.notes, fc.container_number, fs.name AS supplier_name FROM factory_raw_stock fr LEFT JOIN factory_containers fc ON fc.id = fr.container_id LEFT JOIN factory_suppliers fs ON fs.id = fc.supplier_id WHERE fr.company_id = ${cid} ORDER BY fr.offloaded_at DESC, fr.id`
  );
  await fetch1(
    "Factory Mix Batch Detail",
    `SELECT fmb.batch_number, fmb.batch_code, fmb.batch_date, fmb.total_weight_kg, fmb.cost_per_kg, fmb.total_cost, fmb.status, fmb.notes, fms.source_type, fms.weight_kg, fms.cost_per_kg AS source_cost_per_kg, fms.total_cost AS source_total_cost, fms.notes AS source_notes, fs.name AS supplier_name, fc.container_number FROM factory_mix_batches fmb LEFT JOIN factory_mix_batch_sources fms ON fms.mix_batch_id = fmb.id LEFT JOIN factory_suppliers fs ON fs.id = fms.supplier_id LEFT JOIN factory_containers fc ON fc.id = fms.container_id WHERE fmb.company_id = ${cid} ORDER BY fmb.batch_date DESC, fmb.id, fms.id`
  );
  await fetch1(
    "Factory POS Sales Detail",
    `SELECT fps.sale_number, fps.tx_date AS sale_date, fps.customer_name, fps.notes AS sale_notes, fps.total_amount AS sale_total, fps.currency_code, fps.payment_type, fps.status, fpsi.product_name, fpsi.article_code, fpsi.quantity, fpsi.unit_price, fpsi.total_amount AS item_total FROM factory_pos_sales fps LEFT JOIN factory_pos_sale_items fpsi ON fpsi.sale_id = fps.id WHERE fps.company_id = ${cid} ${df("fps.tx_date")} ORDER BY fps.tx_date DESC, fps.id, fpsi.id`
  );

  // ── ERP Enriched Detail Views ──────────────────────────────────────────────
  await fetch1(
    "Voucher Lines Detail",
    `SELECT v.voucher_number, v.voucher_type, v.voucher_date, v.description AS voucher_narration, v.currency, v.exchange_rate, v.location_name, la.code AS account_code, la.name AS account_name, la.account_type, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration AS entry_narration, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, c.legal_name AS customer_name, s.legal_name AS supplier_name FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id LEFT JOIN employees e ON e.id = ve.employee_id LEFT JOIN customers c ON c.id = ve.customer_id LEFT JOIN suppliers s ON s.id = ve.supplier_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date, v.id, ve.id`
  );
  await fetch1(
    "PO Detail",
    `SELECT po.po_number, po.status, po.currency, po.created_at AS po_date, s.legal_name AS supplier_name, COALESCE(si.code,'') AS item_code, pol.item_name, pol.quantity, pol.rate, pol.line_total, po.freight, po.other_charges, po.surcharge, po.fumigation, po.document_charges, po.discount, po.items_total FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN po_line_items pol ON pol.po_id = po.id LEFT JOIN stock_items si ON si.id = pol.stock_item_id WHERE po.company_id = ${cid} ORDER BY po.created_at DESC, po.id, pol.id`
  );
  await fetch1(
    "Stock Transfer Detail",
    `SELECT v.voucher_number, v.voucher_date, v.description AS notes, l1.name AS from_location, l2.name AS to_location, si.code AS item_code, si.name AS item_name, sti.quantity, sti.rate, sti.total_amount FROM stock_transfer_vouchers stv INNER JOIN vouchers v ON v.id = stv.voucher_id LEFT JOIN locations l1 ON l1.id = stv.source_location_id LEFT JOIN locations l2 ON l2.id = stv.destination_location_id LEFT JOIN stock_transfer_items sti ON sti.transfer_id = stv.id LEFT JOIN stock_items si ON si.id = sti.stock_item_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date DESC, stv.id, sti.id`
  );
  await fetch1(
    "Supplier Balances",
    `SELECT s.code AS supplier_code, s.legal_name AS supplier_name, s.phone, s.email, s.payment_terms, COALESCE(s.opening_balance,0) AS opening_balance, COALESCE(SUM(ve.debit_amount),0) AS total_debits, COALESCE(SUM(ve.credit_amount),0) AS total_credits FROM suppliers s INNER JOIN ledger_accounts la ON la.id = s.ledger_account_id LEFT JOIN voucher_entries ve ON ve.supplier_id = s.id WHERE la.company_id = ${cid} AND s.deleted_at IS NULL GROUP BY s.id, s.code, s.legal_name, s.phone, s.email, s.payment_terms, s.opening_balance ORDER BY s.legal_name`
  );
  await fetch1(
    "Supplier Txn Detail",
    `SELECT s.legal_name AS supplier_name, s.code AS supplier_code, v.voucher_number, v.voucher_type, v.voucher_date, la.code AS account_code, la.name AS account_name, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.transaction_currency, ve.transaction_debit_amount, ve.transaction_credit_amount, ve.base_debit_amount, ve.base_credit_amount, ve.historical_exchange_rate, ve.rate_convention, ve.narration, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id INNER JOIN suppliers s ON s.id = ve.supplier_id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY s.legal_name, v.voucher_date, ve.id`
  );
  await fetch1(
    "Customer Balances Detail",
    `SELECT c.legal_name AS customer_name, c.code AS customer_code, cb.transaction_date, cb.transaction_type, cb.reference_type, cb.debit_amount, cb.credit_amount, cb.balance, cb.currency, cb.description, cb.side FROM customer_balances cb INNER JOIN customers c ON c.id = cb.customer_id WHERE cb.company_id = ${cid} ${df("cb.transaction_date")} ORDER BY c.legal_name, cb.transaction_date, cb.id`
  );
  await fetch1(
    "Customer Order Detail",
    `SELECT c.legal_name AS customer_name, c.code AS customer_code, co.invoice_number, co.order_date, co.status, co.container_number, co.shipping_company, col.article_code, col.bale_name AS item_name, col.qty, col.weight_per_bale, col.total_weight, col.price_per_bale AS rate, col.total_price, co.freight_amount, co.other_charges_total, co.grand_total FROM customer_orders co INNER JOIN customers c ON c.id = co.customer_id LEFT JOIN customer_order_lines col ON col.order_id = co.id WHERE co.company_id = ${cid} ${df("co.order_date")} ORDER BY co.order_date DESC, co.id, col.id`
  );
  await fetch1(
    "Credit-Debit Note Detail",
    `SELECT v.voucher_number, v.voucher_type, v.voucher_date, v.description AS narration, c.legal_name AS customer_name, si.code AS item_code, si.name AS item_name, l.name AS location_name, cni.quantity, cni.rate, cni.total_value, cni.inventory_cost FROM credit_note_items cni INNER JOIN vouchers v ON v.id = cni.voucher_id LEFT JOIN stock_items si ON si.id = cni.stock_item_id LEFT JOIN locations l ON l.id = cni.location_id LEFT JOIN LATERAL (SELECT ve2.customer_id FROM voucher_entries ve2 WHERE ve2.voucher_id = v.id AND ve2.customer_id IS NOT NULL LIMIT 1) ve ON true LEFT JOIN customers c ON c.id = ve.customer_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY v.voucher_date DESC, v.id, cni.id`
  );
  await fetch1(
    "Salary Advances Detail",
    `SELECT sa.advance_date, sa.amount, sa.remaining_balance, sa.notes, sa.fully_paid, sa.is_opening_balance, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.code AS employee_code, e.department FROM salary_advances sa INNER JOIN employees e ON e.id = sa.employee_id WHERE sa.company_id = ${cid} ${df("sa.advance_date")} ORDER BY sa.advance_date, sa.id`
  );
  await fetch1(
    "Employee Txn Detail",
    `SELECT TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.code AS employee_code, e.department, v.voucher_number, v.voucher_type, v.voucher_date, la.code AS account_code, la.name AS account_name, CASE WHEN COALESCE(ve.debit_amount,0) > 0 THEN 'DR' ELSE 'CR' END AS dr_cr, COALESCE(ve.debit_amount,0) AS debit_amount, COALESCE(ve.credit_amount,0) AS credit_amount, ve.narration, v.description AS voucher_narration FROM voucher_entries ve INNER JOIN vouchers v ON v.id = ve.voucher_id INNER JOIN employees e ON e.id = ve.employee_id LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE v.company_id = ${cid} ${df("v.voucher_date")} ORDER BY e.first_name, v.voucher_date, ve.id`
  );
  await fetch1(
    "Location Stock Detail",
    `SELECT l.name AS location_name, sg.name AS stock_group, si.code AS item_code, si.name AS item_name, si.uom, i.quantity, i.average_rate AS rate, i.total_value, i.last_updated FROM inventory i INNER JOIN stock_items si ON si.id = i.stock_item_id INNER JOIN locations l ON l.id = i.location_id LEFT JOIN stock_groups sg ON sg.id = si.stock_group_id WHERE i.company_id = ${cid} AND i.quantity != 0 ORDER BY l.name, sg.name, si.code`
  );

  // ── Populate SUMMARY sheet (created first; filled here after all counts are known) ──
  {
    const [co] = await qStream(`SELECT name FROM companies WHERE id = ${cid}`);
    const title = summaryWs.addRow([`Full Data Export — ${co?.name || ""}`]);
    title.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1E3A5F" } };
    summaryWs.addRow(["Generated at", new Date().toISOString()]);
    summaryWs.addRow([]);
    const headerRow = summaryWs.addRow(["Data Category", "Record Count"]);
    headerRow.eachCell((cell) => {
      cell.fill = HDR_FILL;
      cell.font = HDR_FONT;
    });
    headerRow.height = 18;
    const total = summaryRows.reduce((s, [, n]) => s + n, 0);
    summaryRows.forEach(([label, count], i) => {
      const r = summaryWs.addRow([label, count]);
      r.getCell(2).numFmt = "#,##0";
      if (i % 2 === 1)
        r.eachCell((c) => {
          c.fill = ALT_FILL;
        });
    });
    summaryWs.addRow([]);
    const totalRow = summaryWs.addRow(["TOTAL RECORDS", total]);
    totalRow.getCell(1).font = { bold: true, size: 11 };
    totalRow.getCell(2).font = { bold: true, size: 11 };
    totalRow.getCell(2).numFmt = "#,##0";
  }

  const workbookBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(new Uint8Array(toArrayBuffer(new Uint8Array(workbookBuffer))));
}
