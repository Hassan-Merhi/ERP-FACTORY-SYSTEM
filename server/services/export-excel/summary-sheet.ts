import ExcelJS from "exceljs";
import type { CompanyExportData } from "../export-data";

import { ALT_FILL, HDR_FILL, HDR_FONT } from "./sheet-helpers";

export function addSummarySheet(wb: ExcelJS.Workbook, data: CompanyExportData) {
  const sl = (arr: Record<string, unknown>[] | undefined | null): number => (Array.isArray(arr) ? arr.length : 0);
  const ws = wb.addWorksheet("SUMMARY");
  ws.getColumn(1).width = 38;
  ws.getColumn(2).width = 18;

  const title = ws.addRow([`Full Data Export — ${data.company?.name || ""}`]);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1E3A5F" } };
  ws.addRow(["Generated at", new Date().toISOString()]);
  ws.addRow([]);

  const headerRow = ws.addRow(["Data Category", "Record Count"]);
  headerRow.eachCell((cell) => {
    cell.fill = HDR_FILL;
    cell.font = HDR_FONT;
  });
  headerRow.height = 18;

  const counts: [string, number][] = [
    ["Company Info", 1],
    ["Company Settings", sl(data.companySettings)],
    ["Locations", sl(data.locations)],
    ["Ledger Accounts", sl(data.ledgerAccounts)],
    ["Bank Accounts", sl(data.bankAccounts)],
    ["Fixed Assets", sl(data.fixedAssets)],
    ["Exchange Rates", sl(data.exchangeRates)],
    ["Fiscal Period Closures", sl(data.fiscalPeriodClosures)],
    ["Reference Sequences", sl(data.referenceSequences)],
    ["Agent Accounts", sl(data.agentAccounts)],
    ["Vouchers", sl(data.vouchers)],
    ["Voucher Entries", sl(data.voucherEntries)],
    ["Suppliers", sl(data.suppliers)],
    ["Supplier Transactions", sl(data.supplierTransactions)],
    ["Supplier Proformas", sl(data.supplierProformas)],
    ["Supplier Proforma Lines", sl(data.supplierProformaLines)],
    ["Supplier Containers", sl(data.supplierContainers)],
    ["Supplier Container Items", sl(data.supplierContainerLoadedItems)],
    ["Customers", sl(data.customers)],
    ["Customer Transactions", sl(data.customerTransactions)],
    ["Customer Balances", sl(data.customerBalances)],
    ["Customer Orders", sl(data.customerOrders)],
    ["Customer Order Lines", sl(data.customerOrderLines)],
    ["Customer Order Bales", sl(data.customerOrderBales)],
    ["Customer Order Charges", sl(data.customerOrderCharges)],
    ["Customer Proformas", sl(data.customerProformas)],
    ["Customer Proforma Lines", sl(data.customerProformaLines)],
    ["Credit Note Items", sl(data.creditNoteItems)],
    ["Employees", sl(data.employees)],
    ["Payroll Runs", sl(data.employeePayrolls)],
    ["Payroll Run Items", sl(data.employeePayrollItems)],
    ["Employee Advances", sl(data.employeeAdvances)],
    ["Salary Advances", sl(data.salaryAdvances)],
    ["Salary Advance Deductions", sl(data.salaryAdvanceDeductions)],
    ["Employee Advance Repayments", sl(data.employeeAdvanceRepayments)],
    ["Employee Attendance", sl(data.employeeAttendance)],
    ["Employee Bonuses", sl(data.employeeBonuses)],
    ["Employee Groups", sl(data.employeeGroups)],
    ["Employee Group Members", sl(data.employeeGroupMembers)],
    ["Employee Bale Rates", sl(data.employeeBaleRates)],
    ["Employee Bale Pct Rates", sl(data.employeeBalePercentRates)],
    ["Worker Documents (ERP)", sl(data.workerDocs)],
    ["Factory Workers", sl(data.factoryWorkers)],
    ["Factory Worker Categories", sl(data.factoryWorkerCategories)],
    ["Factory Worker Documents", sl(data.factoryWorkerDocuments)],
    ["Factory Worker Advances", sl(data.factoryWorkerAdvances)],
    ["Factory Advance Repayments", sl(data.factoryAdvanceRepayments)],
    ["Factory Payrolls", sl(data.factoryPayrolls)],
    ["Factory Attendance", sl(data.factoryAttendance)],
    ["Worker Bonuses", sl(data.workerBonuses)],
    ["Factory Settings", sl(data.factorySettings)],
    ["Factory Categories", sl(data.factoryCategories)],
    ["Factory Daybook", sl(data.factoryDaybook)],
    ["Daybook Entry Edits", sl(data.factoryDaybookEdits)],
    ["Factory KPI Snapshots", sl(data.factoryDailyKpiSnapshots)],
    ["Factory Daily Usages", sl(data.factoryDailyUsages)],
    ["Factory Alerts", sl(data.factoryAlerts)],
    ["Factory Duty Audit Log", sl(data.factoryDutyAuditLog)],
    ["Factory Raw Stock", sl(data.factoryRawStock)],
    ["Raw Material Adjustments", sl(data.factoryRawMaterialAdjustments)],
    ["Factory Pressing Batches", sl(data.factoryPressingBatches)],
    ["Pressing Batches", sl(data.pressingBatches)],
    ["Factory Mix Batches", sl(data.factoryMixBatches)],
    ["Factory Mix Batch Sources", sl(data.factoryMixBatchSources)],
    ["Mix Batches", sl(data.mixBatches)],
    ["Mix Batch Sources", sl(data.mixBatchSources)],
    ["Production Bales", sl(data.productionBales)],
    ["Production Raw Stock", sl(data.productionRawStock)],
    ["Factory Bale Products", sl(data.factoryBaleProducts)],
    ["Factory Bales", sl(data.factoryBales)],
    ["Factory Bale Sequences", sl(data.factoryBaleSequences)],
    ["Factory Bale Cost Snapshots", sl(data.factoryBaleCostSnapshots)],
    ["Factory Bale Waste Dispatches", sl(data.factoryBaleWasteDispatches)],
    ["Factory Waste Entries", sl(data.factoryWasteEntries)],
    ["Factory Containers", sl(data.factoryContainers)],
    ["Container Plans", sl(data.factoryContainerPlans)],
    ["Plan Containers", sl(data.factoryContainerPlanContainers)],
    ["Plan Lines", sl(data.factoryContainerPlanLines)],
    ["Factory Container Commissions", sl(data.factoryContainerCommissions)],
    ["Factory Container Other Charges", sl(data.factoryContainerOtherCharges)],
    ["Factory Container P&L Snapshots", sl(data.factoryContainerProfitSnapshots)],
    ["Offload Additional Charges", sl(data.factoryOffloadAdditionalCharges)],
    ["Factory Suppliers", sl(data.factorySuppliers)],
    ["Factory Supplier Payments", sl(data.factorySupplierPayments)],
    ["Factory Supplier FX Transfers", sl(data.factorySupplierFxTransfers)],
    ["Factory Supplier Scores", sl(data.factorySupplierScoreSnapshots)],
    ["Factory FX Rates", sl(data.factoryFxRates)],
    ["Factory FX Allocations", sl(data.factoryFxAllocations)],
    ["Factory POS Sales", sl(data.factoryPosSales)],
    ["Factory POS Sale Items", sl(data.factoryPosSaleItems)],
    ["Bales (Sorting)", sl(data.bales)],
    ["Bale Products", sl(data.baleProducts)],
    ["Bale Product Categories", sl(data.baleProductCategories)],
    ["Bale Sequences", sl(data.baleSequences)],
    ["Bale Label Prints", sl(data.baleLabelPrints)],
    ["Bale Transfers", sl(data.baleTransfers)],
    ["Bale Transfer Items", sl(data.baleTransferItems)],
    ["Bale Recode Sessions", sl(data.baleRecodeSessions)],
    ["Bale Recode Items", sl(data.baleRecodeItems)],
    ["Stock Groups", sl(data.stockGroups)],
    ["Stock Items", sl(data.stockItems)],
    ["Stock Item Aliases", sl(data.stockItemCodeAliases)],
    ["Stock Item Location Prices", sl(data.stockItemLocationPrices)],
    ["Inventory by Location", sl(data.inventory)],
    ["Inventory Negative Layers", sl(data.inventoryNegativeLayers)],
    ["Stock Group Archives", sl(data.stockGroupLocationArchives)],
    ["Stock Group Archive Items", sl(data.stockGroupLocationArchiveItems)],
    ["Stock Transfers", sl(data.stockTransfers)],
    ["Transfer Items", sl(data.stockTransferItems)],
    ["Transfer Revisions", sl(data.stockTransferRevisions)],
    ["Revision Items", sl(data.stockTransferRevisionItems)],
    ["Stock Adjustments", sl(data.stockAdjustments)],
    ["Adjustment Items", sl(data.stockAdjustmentItems)],
    ["Proforma Reservations", sl(data.proformaStockReservations)],
    ["Containers", sl(data.containers)],
    ["Container Charges", sl(data.containerCharges)],
    ["Container Offloads", sl(data.containerOffloads)],
    ["Offload Items", sl(data.containerOffloadItems)],
    ["Container Freight", sl(data.containerFreight)],
    ["Container Freight Payments", sl(data.containerFreightPayments)],
    ["Container Documents", sl(data.containerDocuments)],
    ["Container Sales", sl(data.containerSales)],
    ["Purchase Orders", sl(data.purchaseOrders)],
    ["PO Line Items", sl(data.poLineItems)],
    ["POS Shifts", sl(data.posShifts)],
    ["Sales Items", sl(data.salesItems)],
    ["Waste Dispatches", sl(data.wasteDispatches)],
    ["Waste Dispatch Items", sl(data.wasteDispatchItems)],
    ["Spreadsheets", sl(data.spreadsheets)],
    ["Import Logs", sl(data.importLogs)],
    ["Audit Log", sl(data.auditLog)],
    ["— FACTORY ENRICHED VIEWS —", 0],
    ["Factory Bale Production Detail", sl(data.factoryBaleDetail)],
    ["Factory Worker Advances Detail", sl(data.factoryWorkerAdvancesDetail)],
    ["Factory Payroll Detail", sl(data.factoryPayrollDetail)],
    ["Factory Container Detail", sl(data.factoryContainerDetail)],
    ["Factory Supplier Payments Detail", sl(data.factorySupplierPaymentsDetail)],
    ["Factory Raw Stock Detail", sl(data.factoryRawStockDetail)],
    ["Factory Mix Batch Detail", sl(data.factoryMixBatchDetail)],
    ["Factory POS Sales Detail", sl(data.factoryPosSalesDetail)],
    ["— ERP ENRICHED VIEWS —", 0],
    ["Voucher Lines Detail", sl(data.voucherLinesDetail)],
    ["PO Detail (flat)", sl(data.poDetail)],
    ["Stock Transfer Detail", sl(data.stockTransferDetail)],
    ["Supplier Balances", sl(data.supplierBalances)],
    ["Supplier Txn Detail", sl(data.supplierTxnDetail)],
    ["Customer Balances Detail", sl(data.customerBalancesDetail)],
    ["Customer Order Detail", sl(data.customerOrderDetail)],
    ["Credit-Debit Note Detail", sl(data.creditNoteDetail)],
    ["Salary Advances Detail", sl(data.salaryAdvancesDetail)],
    ["Employee Txn Detail", sl(data.employeeTxnDetail)],
    ["Location Stock Detail", sl(data.locationStockDetail)],
  ];

  const total = counts.reduce((s, [, n]) => s + n, 0);

  counts.forEach(([label, count], i) => {
    const r = ws.addRow([label, count]);
    r.getCell(2).numFmt = "#,##0";
    if (i % 2 === 1)
      r.eachCell((c) => {
        c.fill = ALT_FILL;
      });
  });

  ws.addRow([]);
  const totalRow = ws.addRow(["TOTAL RECORDS", total]);
  totalRow.getCell(1).font = { bold: true, size: 11 };
  totalRow.getCell(2).font = { bold: true, size: 11 };
  totalRow.getCell(2).numFmt = "#,##0";
}

/**
 * Write the company workbook directly to `outputStream` without buffering the
 * entire file in RAM.  The caller is responsible for ending the stream after
 * this resolves (or letting ExcelJS handle it via wb.xlsx.write which ends the
 * stream internally).
 */
