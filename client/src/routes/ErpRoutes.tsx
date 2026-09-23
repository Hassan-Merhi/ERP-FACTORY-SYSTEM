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

  const isAdminOrDev = user?.role === "Admin" || user?.role === "Developer";
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
      <Route path="/">{() => (isAdminOrDev ? <ContainersOTW /> : <Redirect to="/tracking" />)}</Route>
      <Route path="/tracking" component={TrackingHub} />
      {G("/financial-overview", "dashboard", Dashboard)}

      {canAccess("pos") ? (
        <Route path="/pos">{() => <POSPage />}</Route>
      ) : (
        <Route path="/pos">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("pos") ? (
        <Route path="/pos/edit/:id">{(params) => <POS editVoucherId={params.id} />}</Route>
      ) : (
        <Route path="/pos/edit/:id"><Redirect replace to="/tracking" /></Route>
      )}
      {(user?.currentRole ?? user?.role) !== "POS" && canAccess("pos") ? (
        <Route path="/pos-item-replacement" component={POSItemReplacement} />
      ) : (
        <Route path="/pos-item-replacement">
          <Redirect to="/tracking" />
        </Route>
      )}

      {canAccessAny(["stock_items", "location_inventory", "stock_otw", "containers"]) ? (
        <Route path="/inventory" component={InventoryHub} />
      ) : (
        <Route path="/inventory"><Redirect replace to="/tracking" /></Route>
      )}
      {canAccessAny(["stock_items", "stock_query"]) ? (
        <Route path="/stock" component={StockHub} />
      ) : (
        <Route path="/stock"><Redirect replace to="/tracking" /></Route>
      )}
      {canAccess("location_inventory") ? (
        <Route path="/location-inventory">
          <Redirect to="/inventory?tab=by-location" />
        </Route>
      ) : (
        <Route path="/location-inventory">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("stock_items") ? (
        <Route path="/stock-items">
          <Redirect to="/stock?tab=items" />
        </Route>
      ) : (
        <Route path="/stock-items">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("stock_otw") ? (
        <Route path="/stock-otw">
          <Redirect to="/inventory?tab=on-the-way" />
        </Route>
      ) : (
        <Route path="/stock-otw">
          <Redirect to="/tracking" />
        </Route>
      )}

      {R("/mock-containers-otw", isAdminOrDev, ContainersOTW as RouteComponent)}
      {R("/containers-otw", isAdminOrDev, ContainersOTW as RouteComponent)}
      <Route path="/mock-git" component={GITMockup as RouteComponent} />
      <Route path="/git" component={GITMockup as RouteComponent} />

      {G("/containers/:containerId/verification", "containers", ContainerVerification)}
      {G("/containers/:id", "containers", ContainerDetailPage)}
      {G("/containers", "containers", ContainersPage)}
      {canAccess("containers") ? (
        <Route path="/sold-containers">
          <Redirect to="/containers" />
        </Route>
      ) : (
        <Route path="/sold-containers">
          <Redirect to="/tracking" />
        </Route>
      )}
      {G("/offloads/:id", "containers", OffloadDetail)}

      {G("/po-import", "containers", POImport)}
      <Route path="/ai-validation" component={AiValidationPage} />
      <Route path="/ai-command-center" component={AICommandCenter} />
      {G("/pos-import", "pos", POSImport)}
      <Route path="/agents" component={Agents} />
      {G("/analytics", "analytics", Analytics)}

      {G("/accounts", "accounts", Accounts)}
      {canAccess("accounts") ? (
        <Route path="/ledger-monthly/:accountId" component={LedgerMonthlySummary} />
      ) : (
        <Route path="/ledger-monthly/:accountId">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("accounts") ? (
        <Route path="/ledger-vouchers/:accountId/:year/:month" component={LedgerVouchers} />
      ) : (
        <Route path="/ledger-vouchers/:accountId/:year/:month">
          <Redirect to="/tracking" />
        </Route>
      )}

      {canAccess("suppliers") || canAccess("customers") ? (
        <Route path="/parties" component={PartiesHub} />
      ) : (
        <Route path="/parties">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("suppliers") ? (
        <Route path="/suppliers">
          <Redirect to="/parties?tab=suppliers" />
        </Route>
      ) : (
        <Route path="/suppliers">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("customers") ? (
        <Route path="/customers">
          <Redirect to="/parties?tab=customers" />
        </Route>
      ) : (
        <Route path="/customers">
          <Redirect to="/tracking" />
        </Route>
      )}
      {G("/suppliers/:supplierId/proformas", "suppliers", SupplierProformas)}
      {G("/suppliers/:id/edit", "suppliers", EditSupplier)}
      {canAccess("suppliers") && <Route path="/supplier-profit-check" component={SupplierProfitCheck} />}

      {canAccess("vouchers") ? (
        <Route path="/vouchers">{() => <Vouchers />}</Route>
      ) : (
        <Route path="/vouchers">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("vouchers") && <Route path="/vouchers/:id/edit" component={VoucherEdit} />}
      {canAccess("vouchers") && <Route path="/purchase-orders/:id/edit" component={PurchaseOrderEdit} />}
      {canAccess("vouchers") ? (
        <Route path="/voucher-detail/:voucherId" component={VoucherDetail} />
      ) : (
        <Route path="/voucher-detail/:voucherId">
          <Redirect to="/tracking" />
        </Route>
      )}

      {canAccess("daybook") ? (
        <Route path="/daybook">{() => <Daybook user={user} />}</Route>
      ) : (
        <Route path="/daybook">
          <Redirect to="/tracking" />
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
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("stock_query") ? (
        <Route path="/stock-query">
          <Redirect to="/stock?tab=query" />
        </Route>
      ) : (
        <Route path="/stock-query">
          <Redirect to="/tracking" />
        </Route>
      )}
      {canAccess("stock_items") ? (
        <Route path="/offload-item-search">
          <Redirect to="/stock?tab=offload" />
        </Route>
      ) : (
        <Route path="/offload-item-search">
          <Redirect to="/tracking" />
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
      <Route path="/sales-tools" component={SalesToolsHub} />
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

      {R("/company-transfer", user?.role === "Developer", CompanyTransfer)}
      {R("/net-profit-report", user?.role === "Developer", NetProfitReport)}
      {R("/spreadsheet", user?.role === "Developer", SpreadsheetEditor)}
      {R("/live-sheets", user?.role === "Developer", LiveSheets)}

      {canAccess("stock_items") ? (
        <Route path="/combined-inventory">
          <Redirect to="/inventory?tab=combined" />
        </Route>
      ) : (
        <Route path="/combined-inventory">
          <Redirect to="/tracking" />
        </Route>
      )}

      {G("/bale-ledger", "stock_items", BaleLedger)}
      {canAccess("pos_daybook") ? (
        <Route path="/pos-daybook">
          <Redirect to="/sales-tools?tab=daybook" />
        </Route>
      ) : (
        <Route path="/pos-daybook">
          <Redirect to="/tracking" />
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
      <Route path="/chat" component={Chat} />

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

      {(user?.role === "Admin" || user?.role === "Developer") && <Route path="/settings" component={Settings} />}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/intercompany-links" component={IntercompanyLinks} />
      )}
      <Route path="/intercompany-requests" component={IntercompanyRequests} />
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/orphaned-records" component={OrphanedRecords} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/deleted-items" component={DeletedItems} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/chatbot-settings" component={ChatbotSettings} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/notification-settings" component={NotificationSettings} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/account-groups" component={AccountGroups} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/test-data-import" component={TestDataImport} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/import-cycle-diagnostics" component={ImportCycleDiagnostics} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/inventory-repair" component={InventoryRepair} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/balance-repair" component={BalanceRepair} />
      )}
      {/* Matches the endpoint's own guard: requireRole("Admin", "Owner"), which
          Developer passes through. A wider gate here would put a page in the
          menu that answers 403 to everyone who found it. */}
      {(user?.role === "Admin" || user?.role === "Owner" || user?.role === "Developer") && (
        <Route path="/convergence-reconciliation" component={ConvergenceReconciliation} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/net-position-details" component={NetProfitDetails} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/company-data-reset" component={CompanyDataReset} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/account-migration" component={AccountMigration} />
      )}
      {(user?.role === "Admin" || user?.role === "Developer") && (
        <Route path="/account-transfer" component={AccountTransfer} />
      )}
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
