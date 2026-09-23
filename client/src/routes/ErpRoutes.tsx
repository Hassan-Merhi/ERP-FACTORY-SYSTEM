import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Switch, Route, Redirect } from "wouter";
import NotFound from "@/pages/not-found";
import { canAccessAnyErpFeature, canAccessErpFeature, type ErpFeatureAccess } from "@/app/erpAccess";
import type { FeatureKey } from "@shared/schema";
import SpOverview from "@/pages/sp/SpOverview";
import {
  AICommandCenter,
  AccountGroups,
  AccountMigration,
  AccountTransfer,
  AccountingCreate,
  Accounts,
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
  SupplierProformas,
  TestDataImport,
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
  const { data: erpAccess } = useQuery<ErpFeatureAccess>({
    queryKey: ["/api/my-erp-pages"],
    enabled: !!user,
    staleTime: 30000,
  });

  const effectiveRole = user?.currentRole ?? user?.role ?? "";
  const isDeveloper = effectiveRole === "Developer";
  const isAdminOrDev = effectiveRole === "Admin" || isDeveloper;
  const isAdminOwnerOrDev = effectiveRole === "Admin" || effectiveRole === "Owner" || isDeveloper;
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
    allowed ? (
      <Route path={path} component={Comp} />
    ) : (
      <Route path={path}>
        <Redirect replace to="/tracking" />
      </Route>
    );

  return (
    <Switch>
      <Route path="/">{() => (isAdminOrDev ? <ContainersOTW /> : <Redirect replace to="/tracking" />)}</Route>
      <Route path="/tracking" component={TrackingHub} />
      {G("/financial-overview", "dashboard", Dashboard)}

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
        <Route path="/pos/edit/:id"><Redirect replace to="/tracking" /></Route>
      )}
      {effectiveRole !== "POS" && canAccess("pos") ? (
        <Route path="/pos-item-replacement" component={POSItemReplacement} />
      ) : (
        <Route path="/pos-item-replacement">
          <Redirect replace to="/tracking" />
        </Route>
      )}

      {canAccessAny(["location_inventory", "stock_otw", "containers"]) ? (
        <Route path="/inventory">{() => <InventoryHub access={erpAccess} />}</Route>
      ) : (
        <Route path="/inventory"><Redirect replace to="/tracking" /></Route>
      )}
      {canAccessAny(["stock_items", "stock_query"]) ? (
        <Route path="/stock">{() => <StockHub access={erpAccess} />}</Route>
      ) : (
        <Route path="/stock"><Redirect replace to="/tracking" /></Route>
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

      {R("/mock-containers-otw", isAdminOrDev, ContainersOTW as RouteComponent)}
      {R("/containers-otw", isAdminOrDev, ContainersOTW as RouteComponent)}
      {R("/mock-git", isAdminOrDev, GITMockup as RouteComponent)}
      {R("/git", isAdminOrDev, GITMockup as RouteComponent)}

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
      {R("/ai-validation", isDeveloper, AiValidationPage)}
      {R("/ai-command-center", isDeveloper, AICommandCenter)}
      {G("/pos-import", "pos", POSImport)}
      <Route path="/agents" component={Agents} />
      {G("/analytics", "analytics", Analytics)}

      {G("/accounts", "accounts", Accounts)}
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
      {G("/transaction-journal", "daybook", TransactionJournal)}
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
      {G("/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month", "location_inventory", LocationVouchers)}

      {G("/sales-report", "sales_report", SalesReport)}
      {G("/stock-in-sales-report", "sales_report", StockInSalesReport)}
      {G("/sales-report/detail", "sales_report", SalesReportDetail)}
      {G("/sales-report/comparison", "sales_report", SalesReportComparison)}

      {R("/company-transfer", isDeveloper, CompanyTransfer)}
      {R("/net-profit-report", isDeveloper, NetProfitReport)}
      {R("/spreadsheet", isDeveloper, SpreadsheetEditor)}
      {R("/live-sheets", isDeveloper, LiveSheets)}

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
      {R("/chat", isDeveloper, Chat)}

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

      {R("/settings", isAdminOrDev, Settings)}
      {R("/intercompany-links", isAdminOrDev, IntercompanyLinks)}
      <Route path="/intercompany-requests" component={IntercompanyRequests} />
      {R("/orphaned-records", isAdminOrDev, OrphanedRecords)}
      {R("/deleted-items", isAdminOrDev, DeletedItems)}
      {R("/chatbot-settings", isAdminOrDev, ChatbotSettings)}
      {R("/notification-settings", isAdminOrDev, NotificationSettings)}
      {R("/account-groups", isAdminOrDev, AccountGroups)}
      {R("/test-data-import", isAdminOrDev, TestDataImport)}
      {R("/import-cycle-diagnostics", isAdminOrDev, ImportCycleDiagnostics)}
      {R("/inventory-repair", isAdminOrDev, InventoryRepair)}
      {R("/balance-repair", isAdminOrDev, BalanceRepair)}
      {R("/convergence-reconciliation", isAdminOwnerOrDev, ConvergenceReconciliation)}
      {R("/net-position-details", isAdminOrDev, NetProfitDetails)}
      {R("/company-data-reset", isAdminOrDev, CompanyDataReset)}
      {R("/account-migration", isAdminOrDev, AccountMigration)}
      {R("/account-transfer", isAdminOrDev, AccountTransfer)}
      <Route path="/my-settings" component={MySettings} />

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
