/**
 * FactoryRoutes — inner route table for factory/factory_v2 companies.
 * Rendered inside the <Suspense> / <ErrorBoundary> wrapper in AuthenticatedApp.
 * All page components are lazy-loaded from lazyPages.ts.
 *
 * Props received from AuthenticatedApp:
 *   user              — auth user object (for role-gated routes)
 *   myAccess          — factory access data (pageKeys, hiddenCostFields)
 *   factoryDefaultPage — computed landing page for this user
 */
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Switch, Route, Redirect } from "wouter";
import type { ShellUser } from "@/app/shellUser";
import {
  AccountingCreate,
  Agents,
  Analytics,
  BalanceRepair,
  BaleProductImages,
  BaleProducts,
  BaleStockEntry,
  BalesHistory,
  BarcodeLookup,
  Chat,
  ChatbotSettings,
  CompanyDataReset,
  ConflictCenter,
  CustomerLogosSettings,
  DailyProductionReport,
  DeletedItems,
  FactoryAccounts,
  FactoryAlerts,
  FactoryBaleProductAllMonths,
  FactoryBaleProductHistory,
  FactoryContacts,
  FactoryBaleProductMonthDetail,
  FactoryBaleRelabeling,
  FactoryBaleTracking,
  FactoryBalesHub,
  FactoryBrokerVisualStatement,
  FactoryContainerCreate,
  FactoryContainerLoadingScan,
  FactoryContainersHub,
  FactoryCustomerStatement,
  FactoryDashboardIntel,
  FactoryDaybook,
  FactoryDispatchBatchDetail,
  FactoryDispatchBatchScan,
  FactoryDispatchBatches,
  FactoryEmployeeDetail,
  FactoryFinancialHub,
  FactoryFinancialSnapshot,
  FactoryImport,
  FactoryInsurance,
  FactoryIntelSettings,
  FactoryInvoiceCreate,
  FactoryInvoiceLoadingScan,
  FactoryInvoicing,
  FactoryKpis,
  FactoryLoadingsHub,
  FactoryLocationInventory,
  FactoryLocationInventoryMockup,
  FactoryNetPositionDetails,
  FactoryOpeningBalanceEdit,
  FactoryPOS,
  FactoryPartiesHub,
  ProductionComparison,
  FactoryPayrollHub,
  FactoryPendingInvoiceVerify,
  FactoryPendingLoadings,
  FactoryPriceList,
  FactoryProductionIntelHub,
  FactoryRawMaterialsHub,
  FactoryRentalPayments,
  FactoryRentalShops,
  FactoryRentalWarehouses,
  FactoryReprintLabels,
  FactorySheetsAndSacks,
  FactoryStockAllocation,
  FactoryStockAllocationV3,
  FactoryStockAllocationV5,
  FactoryStockBaleList,
  FactoryStockItemDetail,
  FactorySupplierHub,
  FactoryTransporters,
  FactoryVouchers,
  FactoryWorkerDetail,
  ImportCycleDiagnostics,
  IntercompanyLinks,
  IntercompanyRequests,
  InventoryRepair,
  LabelBannersSettings,
  LedgerMonthlySummary,
  LedgerVouchers,
  MergeBaleProducts,
  MySettings,
  OrphanedRecords,
  Payroll,
  ProductionRawStock,
  ProformaAddLine,
  RawStockRecalculate,
  Settings,
  SpreadsheetEditor,
  StockQuery,
  VoucherDetail,
  VoucherEdit,
  WipersReEntry,
} from "@/lazyPages";

const FactoryInvoiceDetailBilingual = lazy(() => import("@/pages/factory/FactoryInvoiceDetailBilingual"));
const WasteDispatchPage = lazy(() => import("@/pages/factory/WasteDispatchOptimized"));

interface FactoryRoutesProps {
  user: ShellUser;
  myAccess:
    | {
        fullAccess?: boolean;
        pageKeys?: string[];
        hiddenCostFields?: string[];
      }
    | undefined;
  factoryDefaultPage: string;
}

export function FactoryRoutes({ user, myAccess, factoryDefaultPage }: FactoryRoutesProps) {
  const isAdminOrDev = user?.role === "Admin" || user?.role === "Developer";

  return (
    <Switch>
      <Route path="/factory/daybook" component={FactoryDaybook} />
      <Route path="/factory/transporters" component={FactoryTransporters} />
      <Route path="/factory/finance">
        <Redirect replace to="/factory/payroll-hub?section=workers" />
      </Route>
      <Route path="/factory/suppliers">
        <Redirect replace to="/factory/parties?section=suppliers" />
      </Route>
      <Route path="/factory/containers/new" component={FactoryContainerCreate} />
      <Route path="/factory/containers">
        <Redirect replace to="/factory/containers-hub?section=containers" />
      </Route>
      <Route path="/factory/bale-products" component={BaleProducts} />
      <Route path="/factory/raw-stock/opening-balance/:id/edit" component={FactoryOpeningBalanceEdit} />
      <Route path="/factory/raw-stock/recalculate" component={RawStockRecalculate} />
      <Route path="/factory/raw-stock" component={ProductionRawStock} />
      <Route path="/factory/raw-materials" component={FactoryRawMaterialsHub} />
      <Route path="/factory/pressing">
        <Redirect replace to="/factory/stock-entry" />
      </Route>
      <Route path="/factory/finalize">
        <Redirect replace to="/factory/stock-entry" />
      </Route>
      <Route path="/factory/stock-entry" component={BaleStockEntry} />
      <Route path="/factory/bales-history" component={BalesHistory} />
      <Route path="/factory/bales-hub" component={FactoryBalesHub} />
      <Route path="/factory/reprint-labels" component={FactoryReprintLabels} />
      <Route path="/factory/location-inventory" component={FactoryLocationInventory} />
      <Route path="/factory/location-inventory-mockup" component={FactoryLocationInventoryMockup} />
      <Route
        path="/factory/bale-product-history/:productId/:locationId/:year/all"
        component={FactoryBaleProductAllMonths}
      />
      <Route
        path="/factory/bale-product-history/:productId/:locationId/:year/:month"
        component={FactoryBaleProductMonthDetail}
      />
      <Route path="/factory/bale-product-history/:productId/:locationId" component={FactoryBaleProductHistory} />
      <Route path="/factory/containers-hub" component={FactoryContainersHub} />
      <Route path="/factory/stock-otw">
        <Redirect replace to="/factory/containers-hub" />
      </Route>
      <Route path="/factory/stock-bale-list" component={FactoryStockBaleList} />
      <Route path="/factory/stock-query/:id" component={FactoryStockItemDetail} />
      <Route path="/factory/stock-query" component={StockQuery} />
      <Route path="/factory/contacts" component={FactoryContacts} />
      <Route path="/factory/accounts" component={FactoryAccounts} />
      <Route path="/factory/agents" component={Agents} />
      <Route path="/factory/vouchers">{() => <FactoryVouchers />}</Route>
      <Route path="/factory/vouchers/:id/edit" component={VoucherEdit} />
      <Route path="/factory/voucher-detail/:voucherId" component={VoucherDetail} />
      <Route path="/factory/create" component={AccountingCreate} />
      <Route path="/factory/payroll" component={Payroll} />
      <Route path="/factory/analytics" component={Analytics} />
      <Route path="/factory/production-summary">
        <Redirect replace to="/factory/intelligence/production-hub?section=production-summary" />
      </Route>
      <Route path="/factory/sales/new" component={FactoryInvoiceCreate} />
      <Route path="/factory/sales/loading/pending" component={FactoryPendingLoadings} />
      <Route path="/factory/sales/loading/new" component={FactoryContainerLoadingScan} />
      <Route path="/factory/sales/loadings" component={FactoryLoadingsHub} />
      <Route path="/factory/sales/pending-invoices/:id/verify" component={FactoryPendingInvoiceVerify} />
      <Route path="/factory/invoices/:id/loading-scan" component={FactoryInvoiceLoadingScan} />
      <Route path="/factory/sales/invoices/:id" component={FactoryInvoiceDetailBilingual} />
      <Route path="/factory/price-list" component={FactoryPriceList} />
      <Route path="/factory/sales/proformas/:proformaId/add-line" component={ProformaAddLine} />
      <Route path="/factory/bale-tracking" component={FactoryBaleTracking} />
      <Route path="/factory/dispatch-batches/:batchId/rides/:rideId/scan" component={FactoryDispatchBatchScan} />
      <Route path="/factory/dispatch-batches/:id" component={FactoryDispatchBatchDetail} />
      <Route path="/factory/dispatch-batches" component={FactoryDispatchBatches} />
      <Route path="/factory/invoicing" component={FactoryInvoicing} />
      <Route path="/factory/stock-allocation" component={FactoryStockAllocation} />
      <Route path="/factory/stock-allocation-v3" component={FactoryStockAllocationV3} />
      <Route path="/factory/stock-allocation-v5" component={FactoryStockAllocationV5} />
      <Route path="/factory/parties" component={FactoryPartiesHub} />
      <Route path="/factory/customers/:id" component={FactoryCustomerStatement} />
      <Route path="/factory/customers">
        <Redirect replace to="/factory/parties?section=customers" />
      </Route>
      <Route path="/factory/payroll-hub" component={FactoryPayrollHub} />
      <Route path="/factory/insurance" component={FactoryInsurance} />
      <Route path="/factory/sheets-sacks" component={FactorySheetsAndSacks} />
      <Route path="/factory/employees/:id" component={FactoryEmployeeDetail} />
      <Route path="/factory/employees">
        <Redirect replace to="/factory/payroll-hub?section=employees" />
      </Route>
      <Route path="/factory/workers/:id" component={FactoryWorkerDetail} />
      <Route path="/factory/workers">
        <Redirect replace to="/factory/payroll-hub?section=workers" />
      </Route>
      <Route path="/factory/worker-payroll">
        <Redirect replace to="/factory/payroll-hub?section=workers&tab=payroll" />
      </Route>
      <Route path="/factory/supplier-report">
        <Redirect replace to="/factory/intelligence/supplier-hub?section=report" />
      </Route>
      <Route path="/factory/supplier-statement">
        <Redirect replace to="/factory/intelligence/supplier-hub?section=statement" />
      </Route>
      <Route path="/factory/broker-visual-statement" component={FactoryBrokerVisualStatement} />
      <Route path="/factory/barcode-lookup" component={BarcodeLookup} />
      <Route path="/factory/import" component={FactoryImport} />
      <Route path="/factory/bale-relabeling" component={FactoryBaleRelabeling} />
      <Route path="/factory/merge-bale-products" component={MergeBaleProducts} />
      <Route path="/factory/bale-product-images" component={BaleProductImages} />
      <Route path="/factory/customer-logos" component={CustomerLogosSettings} />
      <Route path="/factory/label-banners" component={LabelBannersSettings} />
      <Route path="/factory/bale-relabeling/wipers-re-entry" component={WipersReEntry} />
      <Route path="/factory/users">
        <Redirect replace to="/factory/settings" />
      </Route>
      <Route path="/factory/ledger-monthly/:accountId" component={LedgerMonthlySummary} />
      <Route path="/factory/ledger-vouchers/:accountId/:year/:month" component={LedgerVouchers} />
      <Route path="/factory/intelligence/dashboard" component={FactoryDashboardIntel} />
      <Route path="/factory/intelligence/kpis" component={FactoryKpis} />
      <Route path="/factory/intelligence/profitability">
        <Redirect replace to="/factory/intelligence/financial-hub?section=profitability" />
      </Route>
      <Route path="/factory/intelligence/alerts" component={FactoryAlerts} />
      <Route path="/factory/intelligence/supplier-hub" component={FactorySupplierHub} />
      <Route path="/factory/intelligence/financial-hub" component={FactoryFinancialHub} />
      <Route path="/factory/intelligence/production-hub" component={FactoryProductionIntelHub} />
      <Route path="/factory/intelligence/supplier-scores">
        <Redirect replace to="/factory/intelligence/supplier-hub?section=scores" />
      </Route>
      <Route path="/factory/intelligence/mix-optimizer">
        <Redirect replace to="/factory/intelligence/production-hub?section=mix-optimizer" />
      </Route>
      <Route path="/factory/intelligence/cashflow">
        <Redirect replace to="/factory/intelligence/financial-hub?section=cashflow" />
      </Route>
      <Route path="/factory/intelligence/waste">
        <Redirect replace to="/factory/intelligence/production-hub?section=waste" />
      </Route>
      <Route path="/factory/waste-dispatch" component={WasteDispatchPage} />
      <Route path="/factory/pos" component={FactoryPOS} />
      <Route path="/factory/bale-ledger">{() => <Redirect replace to="/factory/production-report?tab=ledger" />}</Route>
      <Route path="/factory/intelligence/settings" component={FactoryIntelSettings} />
      {(user?.role === "Admin" || user?.role === "Developer" || myAccess?.fullAccess) && (
        <Route path="/factory/spreadsheet" component={SpreadsheetEditor} />
      )}
      <Route path="/factory/chat" component={Chat} />
      <Route path="/factory/conflicts" component={ConflictCenter} />
      {isAdminOrDev && <Route path="/factory/settings" component={Settings} />}
      <Route path="/my-settings" component={MySettings} />
      <Route path="/intercompany-requests" component={IntercompanyRequests} />
      <Route path="/intercompany-links" component={IntercompanyLinks} />
      {isAdminOrDev && <Route path="/factory/deleted-items" component={DeletedItems} />}
      {isAdminOrDev && <Route path="/factory/orphaned-records" component={OrphanedRecords} />}
      {isAdminOrDev && <Route path="/factory/chatbot-settings" component={ChatbotSettings} />}
      {isAdminOrDev && <Route path="/factory/import-cycle-diagnostics" component={ImportCycleDiagnostics} />}
      {isAdminOrDev && <Route path="/factory/inventory-repair" component={InventoryRepair} />}
      {isAdminOrDev && <Route path="/factory/company-data-reset" component={CompanyDataReset} />}
      <Route path="/factory/net-position-details" component={FactoryNetPositionDetails} />
      <Route path="/factory/net-profit-analytics">
        <Redirect replace to="/factory/intelligence/financial-hub?section=net-profit" />
      </Route>
      <Route path="/factory/net-position">
        <Redirect replace to="/factory/intelligence/financial-hub?section=net-position" />
      </Route>
      <Route path="/factory/financial-snapshot" component={FactoryFinancialSnapshot} />
      <Route path="/factory/production-comparison" component={ProductionComparison} />
      <Route path="/factory/production-report">
        {() =>
          myAccess?.hiddenCostFields?.includes("hide_tab_production_analytics") ? (
            <Redirect to={factoryDefaultPage} />
          ) : (
            <DailyProductionReport />
          )
        }
      </Route>
      <Route path="/factory/rental/warehouses" component={FactoryRentalWarehouses} />
      <Route path="/factory/rental/shops" component={FactoryRentalShops} />
      <Route path="/factory/rental/payments" component={FactoryRentalPayments} />
      {isAdminOrDev && <Route path="/balance-repair" component={BalanceRepair} />}
      <Route>{myAccess !== undefined ? <Redirect replace to={factoryDefaultPage} /> : null}</Route>
    </Switch>
  );
}
