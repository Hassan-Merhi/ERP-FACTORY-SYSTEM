import type { QueryResultRow } from "pg";

export interface CompanyExportData {
  company: QueryResultRow;
  companySettings: QueryResultRow[];
  locations: QueryResultRow[];
  // Ledger / Finance
  ledgerAccounts: QueryResultRow[];
  bankAccounts: QueryResultRow[];
  fixedAssets: QueryResultRow[];
  exchangeRates: QueryResultRow[];
  fiscalPeriodClosures: QueryResultRow[];
  referenceSequences: QueryResultRow[];
  agentAccounts: QueryResultRow[];
  // Vouchers
  vouchers: QueryResultRow[];
  voucherEntries: QueryResultRow[];
  // Suppliers
  suppliers: QueryResultRow[];
  supplierTransactions: QueryResultRow[];
  supplierProformas: QueryResultRow[];
  supplierProformaLines: QueryResultRow[];
  supplierContainers: QueryResultRow[];
  supplierContainerLoadedItems: QueryResultRow[];
  // Customers
  customers: QueryResultRow[];
  customerTransactions: QueryResultRow[];
  customerBalances: QueryResultRow[];
  customerOrders: QueryResultRow[];
  customerOrderLines: QueryResultRow[];
  customerOrderBales: QueryResultRow[];
  customerOrderCharges: QueryResultRow[];
  customerProformas: QueryResultRow[];
  customerProformaLines: QueryResultRow[];
  creditNoteItems: QueryResultRow[];
  // Employees
  employees: QueryResultRow[];
  employeePayrolls: QueryResultRow[];
  employeePayrollItems: QueryResultRow[];
  employeeAdvances: QueryResultRow[];
  salaryAdvances: QueryResultRow[];
  salaryAdvanceDeductions: QueryResultRow[];
  employeeAdvanceRepayments: QueryResultRow[];
  employeeAttendance: QueryResultRow[];
  employeeBonuses: QueryResultRow[];
  employeeGroups: QueryResultRow[];
  employeeGroupMembers: QueryResultRow[];
  employeeBaleRates: QueryResultRow[];
  employeeBalePercentRates: QueryResultRow[];
  workerDocs: QueryResultRow[];
  // Factory Workers
  factoryWorkers: QueryResultRow[];
  factoryWorkerCategories: QueryResultRow[];
  factoryWorkerDocuments: QueryResultRow[];
  factoryWorkerAdvances: QueryResultRow[];
  factoryAdvanceRepayments: QueryResultRow[];
  factoryPayrolls: QueryResultRow[];
  factoryAttendance: QueryResultRow[];
  workerBonuses: QueryResultRow[];
  // Factory Operations
  factorySettings: QueryResultRow[];
  factoryCategories: QueryResultRow[];
  factoryDaybook: QueryResultRow[];
  factoryDaybookEdits: QueryResultRow[];
  factoryDailyKpiSnapshots: QueryResultRow[];
  factoryDailyUsages: QueryResultRow[];
  factoryAlerts: QueryResultRow[];
  factoryDutyAuditLog: QueryResultRow[];
  // Factory Raw / Production
  factoryRawStock: QueryResultRow[];
  factoryRawMaterialAdjustments: QueryResultRow[];
  factoryPressingBatches: QueryResultRow[];
  pressingBatches: QueryResultRow[];
  factoryMixBatches: QueryResultRow[];
  factoryMixBatchSources: QueryResultRow[];
  mixBatches: QueryResultRow[];
  mixBatchSources: QueryResultRow[];
  productionBales: QueryResultRow[];
  productionRawStock: QueryResultRow[];
  // Factory Bales
  factoryBaleProducts: QueryResultRow[];
  factoryBales: QueryResultRow[];
  factoryBaleSequences: QueryResultRow[];
  factoryBaleCostSnapshots: QueryResultRow[];
  factoryBaleWasteDispatches: QueryResultRow[];
  factoryWasteEntries: QueryResultRow[];
  // Factory Containers
  factoryContainers: QueryResultRow[];
  factoryContainerPlans: QueryResultRow[];
  factoryContainerPlanContainers: QueryResultRow[];
  factoryContainerPlanLines: QueryResultRow[];
  factoryContainerCommissions: QueryResultRow[];
  factoryContainerOtherCharges: QueryResultRow[];
  factoryContainerProfitSnapshots: QueryResultRow[];
  factoryOffloadAdditionalCharges: QueryResultRow[];
  // Factory Suppliers
  factorySuppliers: QueryResultRow[];
  factorySupplierPayments: QueryResultRow[];
  factorySupplierFxTransfers: QueryResultRow[];
  factorySupplierScoreSnapshots: QueryResultRow[];
  // Factory FX
  factoryFxRates: QueryResultRow[];
  factoryFxAllocations: QueryResultRow[];
  // Factory POS
  factoryPosSales: QueryResultRow[];
  factoryPosSaleItems: QueryResultRow[];
  // Bales (Sorting)
  bales: QueryResultRow[];
  baleProducts: QueryResultRow[];
  baleProductCategories: QueryResultRow[];
  baleSequences: QueryResultRow[];
  baleLabelPrints: QueryResultRow[];
  baleTransfers: QueryResultRow[];
  baleTransferItems: QueryResultRow[];
  baleRecodeSessions: QueryResultRow[];
  baleRecodeItems: QueryResultRow[];
  // Stock
  stockGroups: QueryResultRow[];
  stockItems: QueryResultRow[];
  stockItemCodeAliases: QueryResultRow[];
  stockItemLocationPrices: QueryResultRow[];
  inventory: QueryResultRow[];
  inventoryNegativeLayers: QueryResultRow[];
  stockGroupLocationArchives: QueryResultRow[];
  stockGroupLocationArchiveItems: QueryResultRow[];
  stockTransfers: QueryResultRow[];
  stockTransferItems: QueryResultRow[];
  stockTransferRevisions: QueryResultRow[];
  stockTransferRevisionItems: QueryResultRow[];
  stockAdjustments: QueryResultRow[];
  stockAdjustmentItems: QueryResultRow[];
  proformaStockReservations: QueryResultRow[];
  // Containers
  containersDetail: QueryResultRow[];
  containers: QueryResultRow[];
  containerCharges: QueryResultRow[];
  containerOffloads: QueryResultRow[];
  containerOffloadItems: QueryResultRow[];
  containerFreight: QueryResultRow[];
  containerFreightPayments: QueryResultRow[];
  containerDocuments: QueryResultRow[];
  containerSales: QueryResultRow[];
  // Purchase Orders
  purchaseOrders: QueryResultRow[];
  poLineItems: QueryResultRow[];
  // POS
  posShifts: QueryResultRow[];
  salesItems: QueryResultRow[];
  // Waste
  wasteDispatches: QueryResultRow[];
  wasteDispatchItems: QueryResultRow[];
  // Spreadsheets
  spreadsheets: QueryResultRow[];
  // Import Logs
  importLogs: QueryResultRow[];
  // Audit
  auditLog: QueryResultRow[];
  // ── Enriched / Detail Views ────────────────────────────────────────────────
  voucherLinesDetail: QueryResultRow[];
  poDetail: QueryResultRow[];
  stockTransferDetail: QueryResultRow[];
  supplierBalances: QueryResultRow[];
  supplierTxnDetail: QueryResultRow[];
  customerBalancesDetail: QueryResultRow[];
  customerOrderDetail: QueryResultRow[];
  creditNoteDetail: QueryResultRow[];
  salaryAdvancesDetail: QueryResultRow[];
  employeeTxnDetail: QueryResultRow[];
  locationStockDetail: QueryResultRow[];
  // ── Factory Enriched Detail Views ──────────────────────────────────────────
  factoryBaleDetail: QueryResultRow[];
  factoryWorkerAdvancesDetail: QueryResultRow[];
  factoryPayrollDetail: QueryResultRow[];
  factoryContainerDetail: QueryResultRow[];
  factorySupplierPaymentsDetail: QueryResultRow[];
  factoryRawStockDetail: QueryResultRow[];
  factoryMixBatchDetail: QueryResultRow[];
  factoryPosSalesDetail: QueryResultRow[];
}
