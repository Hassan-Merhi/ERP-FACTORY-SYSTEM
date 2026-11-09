# Factory Unification — Phase 1 Source Baseline

**Date:** 2026-11-09  
**Working branch:** `factory/unification-8-phases-2026-11-09`  
**Source:** repository `Hassan-Merhi/ERP-FACTORY-SYSTEM`, created from `main`; originating audit pinned to `69d2b73b60d5e3b3ad2833f15ac275051c407aca`.  
**Scope:** Static source inspection only. No CI, runtime environment, API calls, database operations, or tests executed. This is not evidence of runtime correctness.

## Preservation boundaries
- Factory dispatch verification must not post accounting, create invoices or proformas, or move stock.
- Preserve historical Net Position, raw-material supplier-average pricing, precision, voucher posting/reversals, payroll and bonus accounting, and partial offload semantics.
- Keep Factory, Properties and ERP domain data and authorization isolated. Preserve V2/V3 URLs until parity is assessed.

## Canonical access registry inventory (62 entries)
The list below comes from `shared/factoryAccessRegistry.ts`; it captures **registry keys and canonical URLs**, not guaranteed availability for every role.

| Page key | Canonical route |
|---|---|
| `factory/help-training` | `/factory/help-training` |
| `factory/tickets` | `/factory/tickets` |
| `factory/production-report` | `/factory/production-report` |
| `factory/agents` | `/factory/agents` |
| `factory/accounts` | `/factory/accounts` |
| `factory/cost-centers` | `/factory/cost-centers` |
| `factory/daybook` | `/factory/daybook` |
| `factory/vouchers` | `/factory/vouchers` |
| `factory/stock-entry` | `/factory/stock-entry` |
| `factory/production-bonuses` | `/factory/production-bonuses` |
| `factory/raw-materials` | `/factory/raw-materials` |
| `factory/waste-dispatch` | `/factory/waste-dispatch` |
| `factory/bales-hub` | `/factory/bales-hub` |
| `factory/bale-relabeling` | `/factory/bale-relabeling` |
| `factory/production-comparison` | `/factory/production-comparison` |
| `factory/pos` | `/factory/pos` |
| `factory/invoicing` | `/factory/invoicing` |
| `factory/price-list` | `/factory/price-list` |
| `factory/dispatch-batches` | `/factory/dispatch-batches` |
| `factory/location-inventory` | `/factory/location-inventory` |
| `factory/containers-hub` | `/factory/containers-hub` |
| `factory/stock-allocation-v5` | `/factory/stock-allocation-v5` |
| `factory/sheets-sacks` | `/factory/sheets-sacks` |
| `factory/monthly-production-matrix` | `/factory/monthly-production-matrix` |
| `factory/stock-query` | `/factory/stock-query` |
| `factory/stock-bale-list` | `/factory/stock-bale-list` |
| `factory/bale-tracking` | `/factory/bale-tracking` |
| `factory/import` | `/factory/import` |
| `factory/merge-bale-products` | `/factory/merge-bale-products` |
| `factory/bale-product-images` | `/factory/bale-product-images` |
| `factory/parties` | `/factory/parties` |
| `factory/contacts` | `/factory/contacts` |
| `factory/payroll-hub` | `/factory/payroll-hub` |
| `factory/analytics` | `/factory/analytics` |
| `factory/transporters` | `/factory/transporters` |
| `factory/broker-visual-statement` | `/factory/broker-visual-statement` |
| `factory/rental/shops` | `/factory/rental/shops` |
| `factory/rental/warehouses` | `/factory/rental/warehouses` |
| `factory/rental/payments` | `/factory/rental/payments` |
| `factory/intelligence/dashboard` | `/factory/intelligence/dashboard` |
| `factory/intelligence/kpis` | `/factory/intelligence/kpis` |
| `factory/intelligence/supplier-hub` | `/factory/intelligence/supplier-hub` |
| `factory/intelligence/financial-hub` | `/factory/intelligence/financial-hub` |
| `factory/intelligence/production-hub` | `/factory/intelligence/production-hub` |
| `factory/intelligence/alerts` | `/factory/intelligence/alerts` |
| `factory/intelligence/mhd-view` | `/factory/intelligence/mhd-view` |
| `factory/intelligence/settings` | `/factory/intelligence/settings` |
| `factory/accounting/toolbox` | `/factory/accounting/toolbox` |
| `factory/balance-repair` | `/factory/balance-repair` |
| `factory/net-position-details` | `/factory/net-position-details` |
| `factory/conflicts` | `/factory/conflicts` |
| `factory/settings` | `/factory/settings` |
| `factory/spreadsheet` | `/factory/spreadsheet` |
| `factory/chat` | `/factory/chat` |
| `factory/location-inventory-mockup` | `/factory/location-inventory-mockup` |
| `factory/account-groups` | `/factory/account-groups` |
| `factory/deleted-items` | `/factory/deleted-items` |
| `factory/orphaned-records` | `/factory/orphaned-records` |
| `factory/chatbot-settings` | `/factory/chatbot-settings` |
| `factory/import-cycle-diagnostics` | `/factory/import-cycle-diagnostics` |
| `factory/inventory-repair` | `/factory/inventory-repair` |
| `factory/company-data-reset` | `/factory/company-data-reset` |

## Actual Factory router declarations (151 route declarations)
The list below comes from `client/src/components/FactoryRoutes.tsx`. The static router includes aliases, parameterized URLs, conditional role guards and inline renderers beyond canonical registry entries.

| Path | Declared component / renderer |
|---|---|
| `/factory/tickets/new` | inline/guarded renderer |
| `/factory/tickets` | inline/guarded renderer |
| `/factory/help-training` | inline/guarded renderer |
| `/factory/daybook` | inline/guarded renderer |
| `/factory/transporters` | FactoryTransporters |
| `/factory/finance` | inline/guarded renderer |
| `/factory/suppliers` | inline/guarded renderer |
| `/factory/containers/new` | FactoryContainerCreate |
| `/factory/containers` | inline/guarded renderer |
| `/factory/bale-products` | BaleProducts |
| `/factory/raw-stock/opening-balance/:id/edit` | FactoryOpeningBalanceEdit |
| `/factory/raw-stock/recalculate` | RawStockRecalculate |
| `/factory/raw-stock` | ProductionRawStock |
| `/factory/raw-materials` | FactoryRawMaterialsHub |
| `/factory/pressing` | inline/guarded renderer |
| `/factory/finalize` | inline/guarded renderer |
| `/factory/production-bonuses` | FactoryProductionBonuses |
| `/factory/stock-entry` | BaleStockEntry |
| `/factory/bales-history` | BalesHistory |
| `/factory/bales-hub` | FactoryBalesHub |
| `/factory/reprint-labels` | FactoryReprintLabels |
| `/factory/location-inventory` | FactoryLocationInventory |
| `/factory/location-inventory-mockup` | FactoryLocationInventoryMockup |
| `/factory/bale-product-history/:productId/:locationId/:year/all` | FactoryBaleProductAllMonths |
| `/factory/bale-product-history/:productId/:locationId/:year/:month` | FactoryBaleProductMonthDetail |
| `/factory/bale-product-history/:productId/:locationId` | FactoryBaleProductHistory |
| `/factory/containers-hub` | FactoryContainersHub |
| `/factory/stock-otw` | inline/guarded renderer |
| `/factory/stock-bale-list` | FactoryStockBaleList |
| `/factory/stock-query/:id` | FactoryStockItemDetail |
| `/factory/stock-query` | FactoryStockQueryWorkspace |
| `/factory/monthly-production-matrix/:productId/bales/:workerId` | FactoryMonthlyProductionBales |
| `/factory/monthly-production-matrix/:productId/workers` | FactoryMonthlyProductionWorkers |
| `/factory/monthly-production-matrix` | FactoryMonthlyProductionMatrix |
| `/factory/contacts` | FactoryContacts |
| `/factory/accounts` | FactoryAccounts |
| `/factory/accounting/toolbox` | AccountingToolbox |
| `/factory/balance-repair` | BalanceRepair |
| `/factory/accounting/open-items` | AccountingOpenItems |
| `/factory/accounting/cash-bank` | CashBankReconciliation |
| `/factory/accounting/monetary-fx` | MonetaryFxAccounting |
| `/factory/accounting/production` | FactoryProductionAccounting |
| `/factory/accounting/rentals` | UnifiedRentalAccounting |
| `/factory/accounting/consolidation` | GroupConsolidationAccounting |
| `/factory/accounting/history` | HistoricalAccounting |
| `/factory/accounting/statements` | ProfessionalFinancialStatements |
| `/factory/accounting/fiscal-review` | FiscalCloseReview |
| `/factory/accounting/dashboard` | UnifiedAccountingDashboard |
| `/factory/accounting/rollout` | UnifiedAccountingRollout |
| `/factory/cost-centers` | inline/guarded renderer |
| `/factory/account-groups` | AccountGroups |
| `/factory/agents` | Agents |
| `/factory/vouchers` | inline/guarded renderer |
| `/factory/vouchers/:id/edit` | VoucherEdit |
| `/factory/voucher-detail/:voucherId` | VoucherDetail |
| `/factory/create` | AccountingCreate |
| `/factory/payroll` | Payroll |
| `/factory/analytics` | Analytics |
| `/factory/production-summary` | inline/guarded renderer |
| `/factory/sales/new` | FactoryInvoiceCreate |
| `/factory/sales/loading/pending` | inline/guarded renderer |
| `/factory/sales/loading/dispatch/:orderId/:dispatchId/report` | FactoryLoadingDispatchReport |
| `/factory/sales/loading/dispatch/:orderId/report` | FactoryLoadingDispatchReport |
| `/factory/sales/loading/dispatch/:orderId/:dispatchId/compare` | FactoryLoadingDispatchCompare |
| `/factory/sales/loading/dispatch/:orderId/compare` | FactoryLoadingDispatchCompare |
| `/factory/sales/loading/dispatch/:orderId/:dispatchId` | FactoryLoadingDispatch |
| `/factory/sales/loading/dispatch/:orderId` | FactoryLoadingDispatch |
| `/factory/sales/loading/new` | FactoryContainerLoadingScan |
| `/factory/sales/loadings` | FactoryLoadingsHub |
| `/factory/sales/pending-invoices/:id/verify` | FactoryPendingInvoiceVerify |
| `/factory/invoices/:id/loading-scan` | FactoryInvoiceLoadingScan |
| `/factory/sales/invoices/:id` | FactoryInvoiceDetailBilingual |
| `/factory/price-list` | FactoryPriceList |
| `/factory/sales/proformas/:proformaId/add-line` | ProformaAddLine |
| `/factory/bale-tracking` | FactoryBaleTracking |
| `/factory/dispatch-batches/:batchId/rides/:rideId/scan` | FactoryDispatchBatchScan |
| `/factory/dispatch-batches/:id` | FactoryDispatchBatchDetail |
| `/factory/dispatch-batches` | FactoryDispatchBatches |
| `/factory/invoicing/proformas/:id/edit` | FactoryStockAllocationV5EditProforma |
| `/factory/invoicing` | FactoryInvoicing |
| `/factory/stock-allocation` | FactoryStockAllocation |
| `/factory/stock-allocation-v3` | FactoryStockAllocationV3 |
| `/factory/stock-allocation-v5/proformas/new` | FactoryStockAllocationV5CreateProforma |
| `/factory/stock-allocation-v5/proformas/:id/edit` | FactoryStockAllocationV5EditProforma |
| `/factory/stock-allocation-v5` | FactoryStockAllocationV5 |
| `/factory/parties` | FactoryPartiesHub |
| `/factory/customers/:id` | FactoryCustomerStatement |
| `/factory/customers` | inline/guarded renderer |
| `/factory/payroll-hub` | FactoryPayrollHub |
| `/factory/insurance` | inline/guarded renderer |
| `/factory/sheets-sacks` | FactorySheetsAndSacks |
| `/factory/employees/:id` | FactoryEmployeeDetail |
| `/factory/employees` | inline/guarded renderer |
| `/factory/workers/:id` | FactoryWorkerDetail |
| `/factory/workers` | inline/guarded renderer |
| `/factory/worker-payroll` | inline/guarded renderer |
| `/factory/supplier-report` | inline/guarded renderer |
| `/factory/supplier-statement` | inline/guarded renderer |
| `/factory/broker-visual-statement` | FactoryBrokerVisualStatement |
| `/factory/barcode-lookup` | BarcodeLookup |
| `/factory/import` | FactoryImport |
| `/factory/bale-relabeling` | FactoryBaleRelabeling |
| `/factory/merge-bale-products` | MergeBaleProducts |
| `/factory/catalog-translations` | FactoryCatalogTranslations |
| `/factory/bale-product-images` | BaleProductImages |
| `/factory/customer-logos` | CustomerLogosSettings |
| `/factory/label-banners` | LabelBannersSettings |
| `/factory/bale-relabeling/wipers-re-entry` | WipersReEntry |
| `/factory/users` | inline/guarded renderer |
| `/factory/ledger-monthly/:accountId` | LedgerMonthlySummary |
| `/factory/ledger-vouchers/:accountId/:year/:month` | LedgerVouchers |
| `/factory/intelligence/dashboard` | FactoryDashboardIntel |
| `/factory/intelligence/kpis` | FactoryKpis |
| `/factory/intelligence/profitability` | inline/guarded renderer |
| `/factory/intelligence/alerts` | FactoryAlerts |
| `/factory/intelligence/supplier-hub` | FactorySupplierHub |
| `/factory/intelligence/financial-hub` | FactoryFinancialHub |
| `/factory/intelligence/production-hub` | FactoryProductionIntelHub |
| `/factory/intelligence/supplier-scores` | inline/guarded renderer |
| `/factory/intelligence/mix-optimizer` | inline/guarded renderer |
| `/factory/intelligence/cashflow` | inline/guarded renderer |
| `/factory/intelligence/waste` | inline/guarded renderer |
| `/factory/waste-dispatch` | WasteDispatchPage |
| `/factory/pos` | FactoryPOS |
| `/factory/bale-ledger` | inline/guarded renderer |
| `/factory/intelligence/mhd-view` | FactoryMhdViewManagerPage |
| `/factory/intelligence/settings` | FactoryIntelSettings |
| `/factory/spreadsheet` | SpreadsheetEditor |
| `/factory/chat` | Chat |
| `/factory/conflicts` | ConflictCenter |
| `/factory/settings` | Settings |
| `/my-settings` | MySettings |
| `/intercompany-requests` | IntercompanyRequests |
| `/intercompany-links` | IntercompanyLinks |
| `/factory/deleted-items` | DeletedItems |
| `/factory/orphaned-records` | OrphanedRecords |
| `/factory/chatbot-settings` | ChatbotSettings |
| `/factory/import-cycle-diagnostics` | ImportCycleDiagnostics |
| `/factory/inventory-repair` | InventoryRepair |
| `/factory/company-data-reset` | CompanyDataReset |
| `/factory/net-position-details` | FactoryNetPositionDetails |
| `/factory/net-profit-analytics` | inline/guarded renderer |
| `/factory/net-position` | inline/guarded renderer |
| `/factory/financial-snapshot` | FactoryFinancialSnapshot |
| `/factory/production-comparison` | ProductionComparison |
| `/factory/others` | FactoryOthers |
| `/factory/production-report` | inline/guarded renderer |
| `/factory/rental/warehouses` | FactoryRentalWarehouses |
| `/factory/rental/shops` | FactoryRentalShops |
| `/factory/rental/payments` | FactoryRentalPayments |
| `/balance-repair` | BalanceRepair |

## Selected existing defaults, access and cache patterns
### `client/src/pages/factory/FactoryContainers.tsx`
- 95: const { data: containers, isLoading } = useQuery<ContainerWithSupplier[]>({ queryKey: ["/api/factory/containers"] });
- 96: const { data: suppliers } = useQuery<FactorySupplier[]>({ queryKey: ["/api/factory/suppliers"] });
- 98: queryKey: ["/api/factory/containers/account-options"],
- 169: queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
- 170: queryClient.invalidateQueries({ queryKey: ["/api/factory/suppliers"] });

### `client/src/pages/factory/FactoryOtwTrackingTab.tsx`
- 55: const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
- 68: queryKey: ["/api/factory/containers", "otw"],
- 171: tqClient.setQueriesData<ContainerWithSupplier[]>({ queryKey: ["/api/factory/containers"] }, (old) =>
- 179: tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
- 192: tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
- 214: tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
- 366: {currentUser?.role === "Developer" && (

### `client/src/pages/factory/FactoryLocationInventoryModel.tsx`
- 110: queryKey: ["/api/locations"],
- 118: hiddenCostFields: string[];
- 120: queryKey: ["/api/factory/my-access"],
- 124: queryKey: ["/api/factory/settings"],
- 130: const perUserHidden = myAccess?.hiddenCostFields ?? [];
- 143: queryKey: selectedLocation ? [`/api/factory/location-inventory/${selectedLocation.id}`] : [],
- 155: queryKey: selectedLocation ? [`/api/factory/location-inventory/${selectedLocation.id}/available`] : [],
- 178: queryKey: ["/api/factory/bale-products"],
- 188: queryKey: ["/api/factory/categories"],
- 220: queryKey: ["/api/factory/customers"],
- 230: queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
- 231: queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
- 256: queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-proformas") });
- 257: queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"] });
- 275: queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-proformas") });
- 276: queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"] });
- 308: queryClient.invalidateQueries({ queryKey: [`/api/factory/location-inventory/${selectedLocation?.id}`] });
- 309: queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
- 310: queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
- 311: queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list/priority-scan-configs"] });
- 312: queryClient.invalidateQueries({ queryKey: ["/api/factory/customer-orders/loading-list"] });
- 333: queryClient.invalidateQueries({ queryKey: ["/api/factory/locations"] });
- 334: queryClient.invalidateQueries({ queryKey: ["/api/locations"] });

### `client/src/pages/factory/factorysettings/useFactorySettingsModel.ts`
- 35: const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
- 36: const isDeveloper = currentUser?.role === "Developer";
- 49: const [codePrefix, setCodePrefix] = useState("HMD13");
- 110: queryClient.invalidateQueries({ queryKey: ["/api/reports/net-profit-statement"] });
- 111: queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
- 112: queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
- 113: queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
- 153: queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
- 180: queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
- 250: queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
- 262: const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
- 263: const { data, isLoading } = useQuery<FactorySettingsData>({ queryKey: ["/api/factory/settings"] });
- 280: queryKey: ["/api/whatsapp/chats/pos"],
- 292: queryKey: ["/api/whatsapp/chats"],
- 304: queryKey: ["/api/factory/settings?scope=attendance"],
- 314: queryKey: ["/api/whatsapp/chats"],
- 326: queryKey: ["/api/factory/weekly-report-wa-settings"],
- 347: queryClient.invalidateQueries({ queryKey: ["/api/factory/weekly-report-wa-settings"] });
- 373: queryClient.invalidateQueries({ queryKey: ["/api/factory/settings?scope=attendance"] });
- 402: queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
- 422: queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });

### `client/src/pages/factory/FactoryLoadingDispatchLifecycle.tsx`
- 121: queryKey: companyQueryKey(previewUrl, companyId),
- 127: queryKey: companyQueryKey(lifecycleUrl, companyId),
- 134: queryKey: companyQueryKey(frozenUrl, companyId),
- 145: void queryClient.invalidateQueries({ queryKey: companyQueryKey(url, companyId) });
- 239: void queryClient.invalidateQueries({ queryKey: companyQueryKey(previewUrl, companyId) });

### `client/src/pages/factory/FactoryProductionTargets.tsx`
- 64: const { data: session } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 60000 });
- 91: queryKey: ["/api/factory/staff-tracking", "production", periodType, period.start, period.end],
- 185: void queryClient.invalidateQueries({
- 186: queryKey: ["/api/factory/staff-tracking"],

### `client/src/contexts/CompanyContext.tsx`
- 5: cancelCompanySessionQueries,
- 7: removeCompanySessionQueries,
- 31: if (role === "POS") return;
- 34: queryKey: companyDataKey(url, companyId),
- 176: await cancelCompanySessionQueries(queryClient);
- 179: removeCompanySessionQueries(queryClient, {
- 188: void queryClient.invalidateQueries({
- 195: removeCompanySessionQueries(queryClient, {
- 205: void queryClient.invalidateQueries({
- 206: queryKey: ["/api/auth/me"],
- 318: await cancelCompanySessionQueries(queryClient);
- 319: removeCompanySessionQueries(queryClient, { resetAuthenticatedUser: true });

### `client/src/components/FactorySidebar.tsx`
- 241: const isDeveloper = user?.role === "Developer";
- 242: const isAdmin = user?.role === "Admin" \|\| isDeveloper;
- 245: queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
- 257: hiddenCostFields: string[];
- 259: queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
- 287: const hidden = myAccess.hiddenCostFields ?? [];
- 348: if (item.hideKey && myAccess?.hiddenCostFields?.includes(item.hideKey)) return false;
- 369: hiddenTabFields: myAccess?.hiddenCostFields ?? [],
- 392: queryKey: companyQueryKey("/api/chat/unread-count", selectedCompany?.id),

## Verified observations from source
1. Shared `FACTORY_ACCESS_REGISTRY` already defines Factory page keys, routes, display labels, access levels and aliases. Sidebar consumes derived registry data; do not rebuild it.
2. `FactoryRoutes.tsx` uses role-gated routes, including Developer accounting tools; role string conditions require capability comparison in Phase 2.
3. `CompanyContext.tsx` calls `cancelCompanySessionQueries` and `removeCompanySessionQueries` on company transitions. Therefore unscoped query keys do **not** alone demonstrate a cross-company data leak; investigate behavior before altering keys.
4. `FactoryContainers.tsx` uses unscoped cache keys for container, supplier and account-option reads; `FactoryOtwTrackingTab.tsx` uses `["/api/factory/containers", "otw"]`, and mutations invalidate the base prefix.
5. `FactoryLocationInventoryModel.tsx` reads access flags and derives cost visibility from tokens; permission source and field-level policy must be audited, not merely hidden in UI.
6. Factory Settings initializes a rename prefix to `HMD13`, with UI-local `find="-"` and `replace=" "` defaults. A future configuration migration must preserve legacy values and avoid mass renaming.
7. `FactoryLoadingDispatchLifecycle.tsx` already uses `companyQueryKey` for significant dispatch data, while other Factory pages still have URL-only keys.

## Proposed characterization / parity cases (NOT EXECUTED)
| Area | Before/after contract to capture | Priority |
|---|---|---|
| Access | View Only, Create Only, Admin, Owner, Developer permissions and server 403 responses | P0 |
| Company switching | A→B→A cache, pending requests, visible records, permissions and costs | P0 |
| Containers / OTW | `/api/factory/containers` versus `?activeOnly=true`, update + invalidate behavior | P0 |
| Settings | Company-specific rename prefix and settings fallback behavior | P0 |
| Dispatch | Verification-only HTTP effects; zero stock, invoice, proforma or voucher mutation | P0 |
| Stock Allocation V5 | Create/edit status labels, agreed prices, legacy V2/V3 routes | P1 |
| Attendance | Prior-day Admin approval and Beirut local dates | P1 |
| Pressing | Monday–Saturday, historical effective dates, 0 targets, DST | P1 |
| Scanners | Camera cleanup, keyboard scan, duplicates, offline queue and retries | P1 |
| Finances | Historical as-of totals, supplier-average costing and six-decimal costs | P1 |
| Exports | Daybook/report rows, column formatting, locale and voucher drilldown | P1 |

## Phase 1 completion boundary
Static route mapping and targeted source baseline are recorded. **Outstanding before marking fully complete:** exhaustive Factory query/default/capability inventory beyond these representative files; captured before/after API response fixtures and UI screenshots from an executable environment; runtime characterization of affected workflows. CI remains disabled as requested, but avoiding CI does not replace manual parity evidence. No runtime verification claimed.
