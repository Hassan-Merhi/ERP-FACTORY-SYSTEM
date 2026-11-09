import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Switch, Route, Redirect } from "wouter";
import NotFound from "@/pages/not-found";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
const ErpHelpTraining = lazy(() =>
  import("@/pages/HelpTrainingWorkspaces").then((m) => ({ default: m.ErpHelpTraining }))
);
const TicketManagement = lazy(() => import("@/pages/TicketManagement"));
import { canAccessAnyErpFeature, canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { useCompany } from "@/contexts/CompanyContext";
import { effectiveErpRole, isErpRouteRoleAllowed } from "@shared/erpNavigationPolicy";
import type { FeatureKey } from "@shared/schema";
import SpOverview from "@/pages/sp/SpOverview";
import {
  AICommandCenter,
  AccountGroups,
  AccountMigration,
  AccountTransfer,
  AccountingCreate,
  AccountingToolbox,
  AccountingOpenItems,
  CashBankReconciliation,
  MonetaryFxAccounting,
  ErpInventoryAccounting,
  FactoryProductionAccounting,
  UnifiedRentalAccounting,
  GroupConsolidationAccounting,
  HistoricalAccounting,
  ProfessionalFinancialStatements,
  FiscalCloseReview,
  UnifiedAccountingDashboard,
  UnifiedAccountingRollout,
  Accounts,
  CostCenters,
  HistoricalOpenings,
  Agents,
  AiValidationPage,
  Analytics,
  BalanceRepair,
  BaleLedger,
  BarcodeManager,
  Chat,
  ChatbotSettings,
  ClosingStockDetail,
  ClosingStockSummary,
  CompanyDataReset,
  CompanyTransfer,
  ConflictCenter,
  ContainerDetailPage,
  ContainerVerification,
  ContainersOTW,
  ContainersPage,
  ConvergenceReconciliation,
  Dashboard,
  Daybook,
  DeletedItems,
  EditSupplier,
  ErpRentalPayments,
  ErpRentalShops,
  ErpRentalWarehouses,
  GITMockup,
  ImportCycleDiagnostics,
  ImportStockItems,
  ItemMarketAnalysis,
  IntercompanyLinks,
  IntercompanyRequests,
  InventoryHub,
  InventoryRepair,
  LedgerMonthlySummary,
  LedgerVouchers,
  LiveSheets,
  LocationMonthlySummary,
  LocationVouchers,
  MySettings,
  NetProfitDetails,
  NetProfitReport,
  NotificationSettings,
  OffloadDetail,
  OpeningStockDetail,
  OpeningStockSummary,
  OptionalVouchers,
  OrphanedRecords,
  POImport,
  POS,
  POSImport,
  POSItemReplacement,
  POSPage,
  PartiesHub,
  Payroll,
  PurchaseOrderEdit,
  SalesReport,
  SalesReportComparison,
  SalesReportDetail,
  SalesToolsHub,
  Settings,
  SpAliases,
  SpOpeningStock,
  SpReports,
  SpSetup,
  SpreadsheetEditor,
  StockHub,
  StockInSalesReport,
  StockItemDetail,
  StockItemHistory,
  StockItemVouchers,
  StockTransferOrder,
  SupplierProfitCheck,
  SupplierProfitReconciliation,
  SupplierProformas,
  TrackingHub,
  TransactionJournal,
  VoucherDetail,
  VoucherEdit,
  Vouchers,
} from "@/lazyPages";

interface ErpRouteUser {
  role?: string | null;
  currentRole?: string | null;
}

interface ErpRoutesProps {
  user: ErpRouteUser;
}

type RouteComponent = ComponentType;

export function ErpRoutes({ user }: ErpRoutesProps) {
  const { selectedCompany } = useCompany();
  const { data: erpAccess } = useQuery<ErpFeatureAccess>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, Boolean(user)),
  });

  const effectiveRole = effectiveErpRole(user);
  const roleAllowed = (path: string) => isErpRouteRoleAllowed(path, effectiveRole);
  const canAccess = (key: FeatureKey) => canAccessErpFeature(erpAccess, key);
  const canAccessAny = (keys: readonly FeatureKey[]) => canAccessAnyErpFeature(erpAccess, keys);
  const G = (path: string, key: FeatureKey, Comp: RouteComponent) =>
    canAccess(key) ? (
      <Route path={path} component={Comp} />
    ) : (
      <Route path={path}>
        <Redirect replace to="/tracking" />
      </Route>
    );
  const R = (path: string, allowed: boolean, Comp: RouteComponent) =>
    allowed && roleAllowed(path) ? (
      <Route path={path} component={Comp} />
    ) : (
      <Route path={path}>
        <Redirect replace to="/tracking" />
      </Route>
    );

  return (
    <Switch>
      <Route path="/tickets/new">{() => <TicketManagement sourceMode="erp" />}</Route>
      <Route path="/tickets">{() => <TicketManagement sourceMode="erp" />}</Route>
      <Route path="/">{() => (roleAllowed("/") ? <ContainersOTW /> : <Redirect replace to="/tracking" />)}</Route>
      <Route path="/tracking" component={TrackingHub} />
      <Route path="/help-training">{() => <ErpHelpTraining user={user} />}</Route>
      {R("/financial-overview", canAccess("dashboard"), Dashboard)}

      {canAccess("pos") ? (
        <Route path="/pos">{() => <POSPage />}</Route>
      ) : (
        <Route path="/pos">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("pos") ? (
        <Route path="/pos/edit/:id">{(params) => <POS editVoucherId={params.id} />}</Route>
      ) : (
        <Route path="/pos/edit/:id">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {roleAllowed("/pos-item-replacement") && canAccess("pos") ? (
        <Route path="/pos-item-replacement" component={POSItemReplacement} />
      ) : (
        <Route path="/pos-item-replacement">
          <Redirect replace to="/tracking" />
        </Route>
      )}

      {canAccessAny(["location_inventory", "stock_otw", "containers"]) ? (
        <Route path="/inventory">{() => <InventoryHub access={erpAccess} />}</Route>
      ) : (
        <Route path="/inventory">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccessAny(["stock_items", "stock_query"]) ? (
        <Route path="/stock">{() => <StockHub access={erpAccess} />}</Route>
      ) : (
        <Route path="/stock">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("location_inventory") ? (
        <Route path="/location-inventory">
          <Redirect to="/inventory?tab=by-location" />
        </Route>
      ) : (
        <Route path="/location-inventory">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("stock_items") ? (
        <Route path="/stock-items">
          <Redirect to="/stock?tab=items" />
        </Route>
      ) : (
        <Route path="/stock-items">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("stock_otw") ? (
        <Route path="/stock-otw">
          <Redirect to="/inventory?tab=on-the-way" />
        </Route>
      ) : (
        <Route path="/stock-otw">
          <Redirect replace to="/tracking" />
        </Route>
      )}

      {R("/mock-containers-otw", true, ContainersOTW as RouteComponent)}
      {R("/containers-otw", true, ContainersOTW as RouteComponent)}
      {R("/mock-git", true, GITMockup as RouteComponent)}
      {R("/git", true, GITMockup as RouteComponent)}

      {G("/containers/:containerId/verification", "containers", ContainerVerification)}
      {G("/containers/:id", "containers", ContainerDetailPage)}
      {G("/containers", "containers", ContainersPage)}
      {canAccess("containers") ? (
        <Route path="/sold-containers">
          <Redirect to="/containers" />
        </Route>
      ) : (
        <Route path="/sold-containers">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {G("/offloads/:id", "containers", OffloadDetail)}

      {G("/po-import", "containers", POImport)}
      {R("/ai-validation", true, AiValidationPage)}
      {R("/ai-command-center", true, AICommandCenter)}
      {G("/pos-import", "pos", POSImport)}
      <Route path="/agents" component={Agents} />
      {G("/analytics", "analytics", Analytics)}

      {R("/accounts/historical-openings", canAccess("accounts"), HistoricalOpenings)}
      {G("/accounts", "accounts", Accounts)}
      {R("/accounting/toolbox", true, AccountingToolbox)}
      {R("/accounting/open-items", true, AccountingOpenItems)}
      {R("/accounting/cash-bank", true, CashBankReconciliation)}
      {R("/accounting/monetary-fx", true, MonetaryFxAccounting)}
      {R("/accounting/erp-inventory", true, ErpInventoryAccounting)}
      {R("/accounting/factory-production", true, FactoryProductionAccounting)}
      {R("/accounting/rentals", true, UnifiedRentalAccounting)}
      {R("/accounting/consolidation", true, GroupConsolidationAccounting)}
      {R("/accounting/history", true, HistoricalAccounting)}
      {R("/accounting/statements", true, ProfessionalFinancialStatements)}
      {R("/accounting/fiscal-review", true, FiscalCloseReview)}
      {R("/accounting/dashboard", true, UnifiedAccountingDashboard)}
      {R("/accounting/rollout", true, UnifiedAccountingRollout)}
      {R("/cost-centers", canAccess("accounts"), CostCenters)}
      {canAccess("accounts") ? (
        <Route path="/ledger-monthly/:accountId" component={LedgerMonthlySummary} />
      ) : (
        <Route path="/ledger-monthly/:accountId">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("accounts") ? (
        <Route path="/ledger-vouchers/:accountId/:year/:month" component={LedgerVouchers} />
      ) : (
        <Route path="/ledger-vouchers/:accountId/:year/:month">
          <Redirect replace to="/tracking" />
        </Route>
      )}

      {canAccess("suppliers") || canAccess("customers") ? (
        <Route path="/parties">{() => <PartiesHub access={erpAccess} />}</Route>
      ) : (
        <Route path="/parties">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("suppliers") ? (
        <Route path="/suppliers">
          <Redirect to="/parties?tab=suppliers" />
        </Route>
      ) : (
        <Route path="/suppliers">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("customers") ? (
        <Route path="/customers">
          <Redirect to="/parties?tab=customers" />
        </Route>
      ) : (
        <Route path="/customers">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {G("/suppliers/:supplierId/proformas", "suppliers", SupplierProformas)}
      {G("/suppliers/:id/edit", "suppliers", EditSupplier)}
      {G("/supplier-profit-check", "suppliers", SupplierProfitCheck)}

      {canAccess("vouchers") ? (
        <Route path="/vouchers">{() => <Vouchers />}</Route>
      ) : (
        <Route path="/vouchers">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {G("/vouchers/:id/edit", "vouchers", VoucherEdit)}
      {G("/purchase-orders/:id/edit", "vouchers", PurchaseOrderEdit)}
      {canAccess("vouchers") ? (
        <Route path="/voucher-detail/:voucherId" component={VoucherDetail} />
      ) : (
        <Route path="/voucher-detail/:voucherId">
          <Redirect replace to="/tracking" />
        </Route>
      )}

      {canAccess("daybook") ? (
        <Route path="/daybook">{() => <Daybook user={user} />}</Route>
      ) : (
        <Route path="/daybook">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {R("/transaction-journal", canAccess("daybook"), TransactionJournal)}
      {G("/payroll", "payroll", Payroll)}
      {G("/create", "create", AccountingCreate)}

      {G("/import-stock-items", "stock_items", ImportStockItems)}
      {canAccess("stock_query") ? (
        <Route path="/stock-query/:id" component={StockItemDetail} />
      ) : (
        <Route path="/stock-query/:id">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("stock_query") ? (
        <Route path="/stock-query">
          <Redirect to="/stock?tab=query" />
        </Route>
      ) : (
        <Route path="/stock-query">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("stock_items") ? (
        <Route path="/offload-item-search">
          <Redirect to="/stock?tab=offload" />
        </Route>
      ) : (
        <Route path="/offload-item-search">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      {canAccess("location_summary") && canAccess("stock_query") ? (
        <Route path="/location-summary">
          <Redirect replace to="/stock-query?tab=summary" />
        </Route>
      ) : (
        <Route path="/location-summary">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      <Route path="/stock-transfer-order" component={StockTransferOrder} />
      <Route path="/sales-tools">{() => <SalesToolsHub access={erpAccess} />}</Route>
      <Route path="/stock-transfers">
        <Redirect to="/sales-tools?tab=transfers" />
      </Route>
      {G("/optional-vouchers", "optional_vouchers", OptionalVouchers)}

      {G("/stock-items/:id/history", "stock_items", StockItemHistory)}
      {G("/stock-items/:id/history/:year/:month", "stock_items", StockItemVouchers)}
      {G("/stock-items/:stockItemId/monthly-summary", "stock_items", LocationMonthlySummary)}
      {G("/locations/:locationId/stock-items/:stockItemId/history", "location_inventory", LocationMonthlySummary)}
      {G(
        "/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month",
        "location_inventory",
        LocationVouchers
      )}

      {G("/sales-report", "sales_report", SalesReport)}
      {G("/supplier-profit-reconciliation", "sales_report", SupplierProfitReconciliation)}
      {G("/stock-in-sales-report", "sales_report", StockInSalesReport)}
      {G("/item-market-analysis", "sales_report", ItemMarketAnalysis)}
      {G("/sales-report/detail", "sales_report", SalesReportDetail)}
      {G("/sales-report/comparison", "sales_report", SalesReportComparison)}

      {R("/company-transfer", true, CompanyTransfer)}
      {R("/net-profit-report", true, NetProfitReport)}
      {R("/spreadsheet", true, SpreadsheetEditor)}
      {R("/live-sheets", true, LiveSheets)}

      {canAccess("stock_items") ? (
        <Route path="/combined-inventory">
          <Redirect replace to="/stock?tab=items" />
        </Route>
      ) : (
        <Route path="/combined-inventory">
          <Redirect replace to="/tracking" />
        </Route>
      )}

      {G("/bale-ledger", "stock_items", BaleLedger)}
      {canAccess("pos_daybook") ? (
        <Route path="/pos-daybook">
          <Redirect to="/sales-tools?tab=daybook" />
        </Route>
      ) : (
        <Route path="/pos-daybook">
          <Redirect replace to="/tracking" />
        </Route>
      )}
      <Route path="/pos-price-list">
        <Redirect to="/sales-tools?tab=pricelist" />
      </Route>
      <Route path="/price-list">
        <Redirect to="/sales-tools?tab=pricelist" />
      </Route>
      {G("/opening-stock", "stock_items", OpeningStockSummary)}
      {G("/opening-stock/:groupId", "stock_items", OpeningStockDetail)}
      {G("/closing-stock-summary", "stock_items", ClosingStockSummary)}
      {G("/closing-stock/:groupId", "stock_items", ClosingStockDetail)}
      {G("/barcode-manager", "stock_items", BarcodeManager)}
      {R("/chat", true, Chat)}

      <Route path="/factory-production">
        <Redirect to="/factory/raw-stock" />
      </Route>
      <Route path="/bales">
        <Redirect to="/factory/raw-stock" />
      </Route>
      <Route path="/production-bales">
        <Redirect to="/factory/stock-entry" />
      </Route>
      <Route path="/bale-products">
        <Redirect to="/factory/bale-products" />
      </Route>

      <Route path="/erp/rental/warehouses" component={ErpRentalWarehouses} />
      <Route path="/erp/rental/shops" component={ErpRentalShops} />
      <Route path="/erp/rental/payments" component={ErpRentalPayments} />
      <Route path="/conflicts" component={ConflictCenter} />

      {R("/settings", true, Settings)}
      {R("/intercompany-links", true, IntercompanyLinks)}
      <Route path="/intercompany-requests" component={IntercompanyRequests} />
      {R("/orphaned-records", true, OrphanedRecords)}
      {R("/deleted-items", true, DeletedItems)}
      {R("/chatbot-settings", true, ChatbotSettings)}
      {R("/notification-settings", true, NotificationSettings)}
      {R("/account-groups", true, AccountGroups)}
      {R("/import-cycle-diagnostics", true, ImportCycleDiagnostics)}
      {R("/inventory-repair", true, InventoryRepair)}
      {R("/balance-repair", true, BalanceRepair)}
      {R("/convergence-reconciliation", true, ConvergenceReconciliation)}
      {R("/net-position-details", true, NetProfitDetails)}
      {R("/company-data-reset", true, CompanyDataReset)}
      {R("/account-migration", true, AccountMigration)}
      {R("/account-transfer", true, AccountTransfer)}
      {R("/my-settings", true, MySettings)}

      <Route path="/sp" component={SpOverview} />
      <Route path="/sp/opening-stock" component={SpOpeningStock} />
      <Route path="/sp/reports" component={SpReports} />
      <Route path="/sp/aliases" component={SpAliases} />
      <Route path="/sp/migration">
        <Redirect to="/sp/setup" />
      </Route>
      <Route path="/sp/gc-migration">
        <Redirect to="/sp/setup" />
      </Route>
      <Route path="/sp/setup" component={SpSetup} />

      <Route component={NotFound} />
    </Switch>
  );
}
