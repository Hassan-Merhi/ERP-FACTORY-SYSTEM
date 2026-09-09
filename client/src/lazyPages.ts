/**
 * Lazy page imports — all client-side code-split pages.
 * Centralised here so App.tsx stays focused on routing logic.
 * Each export is a React.lazy() component; import them where needed.
 */
import { lazyRetry as lazy } from "@/lib/lazyRetry";

// ── Core ERP pages ────────────────────────────────────────────────────────────
export const Dashboard = lazy(() => import("@/pages/Dashboard"));
export const ContainersOTW = lazy(() => import("@/pages/GITContainers"));
export const GITMockup = lazy(() => import("@/pages/GITMockup"));
export const TrackingHub = lazy(() => import("@/pages/TrackingHub"));
export const StockItems = lazy(() => import("@/pages/StockItems"));
export const Containers = lazy(() => import("@/pages/Containers"));
export const ContainersPage = lazy(() => import("@/pages/ContainersPage"));
export const InventoryHub = lazy(() => import("@/pages/InventoryHub"));
export const StockHub = lazy(() => import("@/pages/StockHub"));
export const Accounts = lazy(() => import("@/pages/Accounts"));
export const Agents = lazy(() => import("@/pages/Agents"));
export const Suppliers = lazy(() => import("@/pages/Suppliers"));
export const Vouchers = lazy(() => import("@/pages/Vouchers"));
export const Daybook = lazy(() => import("@/pages/Daybook"));
export const TransactionJournal = lazy(() => import("@/pages/TransactionJournal"));
export const Analytics = lazy(() => import("@/pages/Analytics"));
export const AccountingCreate = lazy(() => import("@/pages/AccountingCreate"));
export const POImport = lazy(() => import("@/pages/POImport"));
export const AiValidationPage = lazy(() => import("@/pages/AiValidationPage"));
export const AICommandCenter = lazy(() => import("@/pages/AICommandCenter"));
export const ContainerDetail = lazy(() => import("@/pages/ContainerDetail"));
export const ContainerDetailPage = lazy(() => import("@/pages/ContainerDetailPage"));
export const LocationInventory = lazy(() => import("@/pages/LocationInventory"));
export const Settings = lazy(() => import("@/pages/Settings"));
export const VoucherEdit = lazy(() => import("@/pages/VoucherEdit"));
export const Payroll = lazy(() => import("@/pages/Payroll"));
export const ImportStockItems = lazy(() => import("@/pages/ImportStockItems"));
export const StockQuery = lazy(() => import("@/pages/StockQuery"));
export const OffloadItemSearch = lazy(() => import("@/pages/OffloadItemSearch"));
export const StockItemDetail = lazy(() => import("@/pages/StockItemDetail"));
export const SalesReport = lazy(() => import("@/pages/SalesReport"));
export const CompanyTransfer = lazy(() => import("@/pages/CompanyTransfer"));
export const SalesToolsHub = lazy(() => import("@/pages/SalesToolsHub"));
export const PartiesHub = lazy(() => import("@/pages/PartiesHub"));
export const EditSupplier = lazy(() => import("@/pages/EditSupplier"));
export const SupplierProformas = lazy(() => import("@/pages/SupplierProformas"));
export const SupplierProfitCheck = lazy(() => import("@/pages/SupplierProfitCheck"));
export const ContainerVerification = lazy(() => import("@/pages/ContainerVerification"));
export const StockOTW = lazy(() => import("@/pages/StockOTW"));
export const Customers = lazy(() => import("@/pages/Customers"));
export const SoldContainers = lazy(() => import("@/pages/SoldContainers"));
export const Bales = lazy(() => import("@/pages/Bales"));
export const ProductionBales = lazy(() => import("@/pages/ProductionBales"));
export const BaleProducts = lazy(() => import("@/pages/BaleProducts"));
export const OrphanedRecords = lazy(() => import("@/pages/OrphanedRecords"));
export const DeletedItems = lazy(() => import("@/pages/DeletedItems"));
export const ChatbotSettings = lazy(() => import("@/pages/ChatbotSettings"));
export const NotificationSettings = lazy(() => import("@/pages/NotificationSettings"));
export const AccountGroups = lazy(() => import("@/pages/AccountGroups"));
export const PurchaseOrderEdit = lazy(() => import("@/pages/PurchaseOrderEdit"));
export const OffloadDetail = lazy(() => import("@/pages/OffloadDetail"));
export const StockItemHistory = lazy(() => import("@/pages/StockItemHistory"));
export const StockItemVouchers = lazy(() => import("@/pages/StockItemVouchers"));
export const LocationMonthlySummary = lazy(() => import("@/pages/LocationMonthlySummary"));
export const LocationVouchers = lazy(() => import("@/pages/LocationVouchers"));
export const OpeningStockSummary = lazy(() => import("@/pages/OpeningStockSummary"));
export const OpeningStockDetail = lazy(() => import("@/pages/OpeningStockDetail"));
export const ClosingStockSummary = lazy(() => import("@/pages/ClosingStockSummary"));
export const ClosingStockDetail = lazy(() => import("@/pages/ClosingStockDetail"));
export const LedgerMonthlySummary = lazy(() => import("@/pages/LedgerMonthlySummary"));
export const LedgerVouchers = lazy(() => import("@/pages/LedgerVouchers"));
export const VoucherDetail = lazy(() => import("@/pages/VoucherDetail"));
export const PressingBales = lazy(() => import("@/pages/PressingBales"));
export const BarcodeLookup = lazy(() => import("@/pages/BarcodeLookup"));
export const BarcodeManager = lazy(() => import("@/pages/BarcodeManager"));
export const TestDataImport = lazy(() => import("@/pages/TestDataImport"));
export const ImportCycleDiagnostics = lazy(() => import("@/pages/ImportCycleDiagnostics"));
export const InventoryRepair = lazy(() => import("@/pages/InventoryRepair"));
export const BalanceRepair = lazy(() => import("@/pages/BalanceRepair"));
export const ConvergenceReconciliation = lazy(() => import("@/pages/ConvergenceReconciliation"));
export const NetProfitDetails = lazy(() => import("@/pages/NetProfitDetails"));
export const NetProfitReport = lazy(() => import("@/pages/NetProfitReport"));
export const CompanyDataReset = lazy(() => import("@/pages/CompanyDataReset"));
export const AccountMigration = lazy(() => import("@/pages/AccountMigration"));
export const AccountTransfer = lazy(() => import("@/pages/AccountTransfer"));
export const StockTransferOrder = lazy(() => import("@/pages/StockTransferOrder"));
export const StockTransfers = lazy(() => import("@/pages/StockTransfers"));
export const OptionalVouchers = lazy(() => import("@/pages/OptionalVouchers"));
export const BaleLedger = lazy(() => import("@/pages/BaleLedger"));
export const SalesReportDetail = lazy(() => import("@/pages/SalesReportDetail"));
export const SalesReportComparison = lazy(() => import("@/pages/SalesReportComparison"));
export const ConflictCenter = lazy(() => import("@/pages/ConflictCenter"));
export const Chat = lazy(() => import("@/pages/Chat"));
export const SpreadsheetEditor = lazy(() => import("@/pages/SpreadsheetEditor"));
export const LiveSheets = lazy(() => import("@/pages/LiveSheets"));
export const MySettings = lazy(() => import("@/pages/MySettings"));
export const IntercompanyLinks = lazy(() => import("@/pages/IntercompanyLinks"));
export const IntercompanyRequests = lazy(() => import("@/pages/IntercompanyRequests"));

// ── POS pages ─────────────────────────────────────────────────────────────────
export const POS = lazy(() => import("@/pages/pos/POS"));
export const POSPage = lazy(() => import("@/pages/pos/POSPage"));
export const POSImport = lazy(() => import("@/pages/pos/POSImport"));
export const POSItemReplacement = lazy(() => import("@/pages/POSItemReplacement"));
export const POSDaybook = lazy(() => import("@/pages/pos/POSDaybook"));
export const POSDashboard = lazy(() => import("@/pages/pos/POSDashboard"));
export const POSCustomers = lazy(() => import("@/pages/pos/POSCustomers"));
export const POSSettings = lazy(() => import("@/pages/pos/POSSettings"));
export const POSPriceList = lazy(() => import("@/pages/pos/POSPriceList"));
export const PosTransferOrders = lazy(() => import("@/pages/pos/PosTransferOrders"));

// ── Factory pages ─────────────────────────────────────────────────────────────
export const FactoryAccounts = lazy(() => import("@/pages/factory/FactoryAccounts"));
export const FactoryVouchers = lazy(() => import("@/pages/factory/FactoryVouchers"));
export const FactoryDaybook = lazy(() => import("@/pages/factory/FactoryDaybook"));
export const FactoryLocationInventory = lazy(() => import("@/pages/factory/FactoryLocationInventory"));
export const FactoryLocationInventoryMockup = lazy(() => import("@/pages/factory/FactoryLocationInventoryMockup"));
export const FactoryProduction = lazy(() => import("@/pages/factory/FactoryProduction"));
export const ProductionRawStock = lazy(() => import("@/pages/factory/ProductionRawStock"));
export const RawStockRecalculate = lazy(() => import("@/pages/factory/production-raw-stock/RawStockRecalculate"));
export const FactoryOpeningBalanceEdit = lazy(() => import("@/pages/factory/FactoryOpeningBalanceEdit"));
export const BaleStockEntry = lazy(() => import("@/pages/factory/BaleStockEntry"));
export const BalesHistory = lazy(() => import("@/pages/factory/BalesHistory"));
export const FactoryBaleProductHistory = lazy(() =>
  import("@/pages/factory/FactoryBaleProductHistory").then((m) => ({
    default: m.FactoryBaleProductHistory,
  }))
);
export const FactoryBaleProductMonthDetail = lazy(() =>
  import("@/pages/factory/FactoryBaleProductHistory").then((m) => ({
    default: m.FactoryBaleProductMonthDetail,
  }))
);
export const FactoryBaleProductAllMonths = lazy(() =>
  import("@/pages/factory/FactoryBaleProductHistory").then((m) => ({
    default: m.FactoryBaleProductAllMonths,
  }))
);
export const FactoryBalesHub = lazy(() => import("@/pages/factory/FactoryBalesHub"));
export const FactoryReprintLabels = lazy(() => import("@/pages/factory/FactoryReprintLabels"));
export const FactoryRawMaterialsHub = lazy(() => import("@/pages/factory/FactoryRawMaterialsHub"));
export const FactoryLoadingsHub = lazy(() => import("@/pages/factory/FactoryLoadingsHub"));
export const ProductionSummary = lazy(() => import("@/pages/factory/ProductionSummary"));
export const FactorySuppliers = lazy(() => import("@/pages/factory/FactorySuppliers"));
export const FactoryPartiesHub = lazy(() => import("@/pages/factory/FactoryPartiesHub"));
export const FactoryContainers = lazy(() => import("@/pages/factory/FactoryContainers"));
export const FactoryContainerCreate = lazy(() => import("@/pages/factory/FactoryContainerCreate"));
export const FactoryContainersHub = lazy(() => import("@/pages/factory/FactoryContainersHub"));
export const FactoryStockItemDetail = lazy(() => import("@/pages/factory/FactoryStockItemDetail"));
export const FactoryStockBaleList = lazy(() => import("@/pages/factory/FactoryStockBaleList"));
export const FactoryNetProfitAnalytics = lazy(() => import("@/pages/factory/FactoryNetProfitAnalytics"));
export const FactoryNetPosition = lazy(() => import("@/pages/factory/FactoryNetPosition"));
export const FactoryNetPositionDetails = lazy(() => import("@/pages/factory/FactoryNetPositionDetails"));
export const FactoryFinancialSnapshot = lazy(() => import("@/pages/factory/FactoryFinancialSnapshot"));
export const DailyProductionReport = lazy(() => import("@/pages/factory/DailyProductionReport"));
export const ProductionComparison = lazy(() => import("@/pages/factory/ProductionComparison"));
export const FactoryImport = lazy(() => import("@/pages/factory/FactoryImport"));
export const FactoryBaleRelabeling = lazy(() => import("@/pages/factory/FactoryBaleRelabeling"));
export const MergeBaleProducts = lazy(() => import("@/pages/factory/MergeBaleProducts"));
export const BaleProductImages = lazy(() => import("@/pages/factory/BaleProductImages"));
export const CustomerLogosSettings = lazy(() => import("@/pages/factory/CustomerLogosSettings"));
export const LabelBannersSettings = lazy(() => import("@/pages/factory/LabelBannersSettings"));
export const WipersReEntry = lazy(() => import("@/pages/factory/WipersReEntry"));
export const FactoryUsers = lazy(() => import("@/pages/factory/FactoryUsers"));
export const FactoryWorkersHub = lazy(() => import("@/pages/factory/FactoryWorkersHub"));
export const FactoryWorkerDetail = lazy(() => import("@/pages/factory/FactoryWorkerDetail"));
export const FactoryEmployeesHub = lazy(() => import("@/pages/factory/FactoryEmployeesHub"));
export const FactoryEmployeeDetail = lazy(() => import("@/pages/factory/FactoryEmployeeDetail"));
export const FactoryPayrollHub = lazy(() => import("@/pages/factory/FactoryPayrollHub"));
export const FactoryInsurance = lazy(() => import("@/pages/factory/FactoryInsurance"));
export const FactorySheetsAndSacks = lazy(() => import("@/pages/factory/FactorySheetsAndSacks"));
export const FactorySupplierReport = lazy(() => import("@/pages/factory/FactorySupplierReport"));
export const FactorySupplierStatement = lazy(() => import("@/pages/factory/FactorySupplierStatement"));
export const FactoryBrokerVisualStatement = lazy(() => import("@/pages/factory/FactoryBrokerVisualStatement"));
export const FactoryCustomers = lazy(() => import("@/pages/factory/FactoryCustomers"));
export const FactoryCustomerStatement = lazy(() => import("@/pages/factory/FactoryCustomerStatement"));
export const FactoryInvoicing = lazy(() => import("@/pages/factory/FactoryInvoicing"));
export const FactoryInvoices = lazy(() => import("@/pages/factory/FactoryInvoices"));
export const FactoryInvoiceCreate = lazy(() => import("@/pages/factory/FactoryInvoiceCreate"));
export const FactoryInvoiceDetail = lazy(() => import("@/pages/factory/FactoryInvoiceDetail"));
export const FactoryProformas = lazy(() => import("@/pages/factory/FactoryProformas"));
export const FactoryDispatchBatches = lazy(() => import("@/pages/factory/FactoryDispatchBatches"));
export const FactoryDispatchBatchDetail = lazy(() => import("@/pages/factory/FactoryDispatchBatchDetail"));
export const FactoryDispatchBatchScan = lazy(() => import("@/pages/factory/FactoryDispatchBatchScan"));
export const FactoryBaleTracking = lazy(() => import("@/pages/factory/FactoryBaleTracking"));
export const FactoryStockAllocation = lazy(() => import("@/pages/factory/FactoryStockAllocationV2"));
export const FactoryStockAllocationV3 = lazy(() => import("@/pages/factory/FactoryStockAllocationV3"));
export const FactoryStockAllocationV5 = lazy(() => import("@/pages/factory/FactoryStockAllocationV5"));
export const ProformaAddLine = lazy(() => import("@/pages/factory/ProformaAddLine"));
export const FactoryPriceList = lazy(() => import("@/pages/factory/FactoryPriceList"));
export const FactoryPendingInvoiceVerify = lazy(() => import("@/pages/factory/FactoryPendingInvoiceVerify"));
export const FactoryPendingLoadings = lazy(() => import("@/pages/factory/FactoryPendingLoadings"));
export const FactoryContainerLoadingScan = lazy(() => import("@/pages/factory/FactoryContainerLoadingScan"));
export const FactoryInvoiceLoadingScan = lazy(() => import("@/pages/factory/FactoryInvoiceLoadingScan"));
export const FactoryTransporters = lazy(() => import("@/pages/factory/FactoryTransporters"));
export const FactoryDashboardIntel = lazy(() => import("@/pages/factory/FactoryDashboard"));
export const FactoryKpis = lazy(() => import("@/pages/factory/FactoryKpis"));
export const FactoryProfitability = lazy(() => import("@/pages/factory/FactoryProfitability"));
export const FactoryAlerts = lazy(() => import("@/pages/factory/FactoryAlerts"));
export const FactorySupplierScoreboard = lazy(() => import("@/pages/factory/FactorySupplierScoreboard"));
export const FactoryMixOptimizer = lazy(() => import("@/pages/factory/FactoryMixOptimizer"));
export const FactoryCashflow = lazy(() => import("@/pages/factory/FactoryCashflow"));
export const FactoryWaste = lazy(() => import("@/pages/factory/FactoryWaste"));
export const FactorySupplierHub = lazy(() => import("@/pages/factory/FactorySupplierHub"));
export const FactoryFinancialHub = lazy(() => import("@/pages/factory/FactoryFinancialHub"));
export const FactoryProductionIntelHub = lazy(() => import("@/pages/factory/FactoryProductionIntelHub"));
export const WasteDispatchPage = lazy(() => import("@/pages/factory/WasteDispatch"));
export const FactoryPOS = lazy(() => import("@/pages/factory/FactoryPOS"));
export const FactoryIntelSettings = lazy(() => import("@/pages/factory/FactorySettings"));
export const FactoryRentalWarehouses = lazy(() => import("@/pages/factory/FactoryRentalWarehouses"));
export const FactoryRentalShops = lazy(() => import("@/pages/factory/FactoryRentalShops"));
export const FactoryRentalPayments = lazy(() => import("@/pages/factory/FactoryRentalPayments"));
export const FactoryContacts = lazy(() => import("@/pages/factory/FactoryContacts"));

// ── Properties pages ──────────────────────────────────────────────────────────
export const PropertiesDashboard = lazy(() => import("@/pages/properties/PropertiesDashboard"));
export const PropertiesAccounts = lazy(() => import("@/pages/properties/PropertiesAccounts"));
export const PropertiesVouchers = lazy(() => import("@/pages/properties/PropertiesVouchers"));
export const PropertiesVoucherEdit = lazy(() => import("@/pages/properties/PropertiesVoucherEdit"));
export const PropertiesVoucherDetail = lazy(() => import("@/pages/properties/PropertiesVoucherDetail"));
export const PropertiesCreate = lazy(() => import("@/pages/properties/PropertiesCreate"));
export const PropertiesAnalytics = lazy(() => import("@/pages/properties/PropertiesAnalytics"));
export const PropertiesDaybook = lazy(() => import("@/pages/properties/PropertiesDaybook"));
export const PropertiesLedgerMonthly = lazy(() => import("@/pages/properties/PropertiesLedgerMonthly"));
export const PropertiesLedgerVouchers = lazy(() => import("@/pages/properties/PropertiesLedgerVouchers"));
export const PropertiesSettings = lazy(() => import("@/pages/properties/PropertiesSettings"));
export const PropertiesRentalWarehouses = lazy(() => import("@/pages/properties/PropertiesRentalWarehouses"));
export const PropertiesRentalShops = lazy(() => import("@/pages/properties/PropertiesRentalShops"));
export const PropertiesRentalPayments = lazy(() => import("@/pages/properties/PropertiesRentalPayments"));

// ── ERP rental pages ──────────────────────────────────────────────────────────
export const ErpRentalWarehouses = lazy(() => import("@/pages/erp/ErpRentalWarehouses"));
export const ErpRentalShops = lazy(() => import("@/pages/erp/ErpRentalShops"));
export const ErpRentalPayments = lazy(() => import("@/pages/erp/ErpRentalPayments"));

// ── Supplier Partner pages ────────────────────────────────────────────────────
export const SpSetup = lazy(() => import("@/pages/sp/SpSetup"));
export const SpReports = lazy(() => import("@/pages/sp/SpReports"));
export const SpOpeningStock = lazy(() => import("@/pages/sp/SpOpeningStock"));
export const SpAliases = lazy(() => import("@/pages/sp/SpAliases"));
