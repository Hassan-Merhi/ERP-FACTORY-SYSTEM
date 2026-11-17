// Extracted from ./workbook.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import type { CompanyExportData } from "../export-data";
import { addSheet } from "./sheet-helpers";
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
