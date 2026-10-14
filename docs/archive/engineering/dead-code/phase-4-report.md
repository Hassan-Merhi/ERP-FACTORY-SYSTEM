# Dead-code cleanup — Phase 4 frontend reachability review

**Status: COMPLETE.**
Branch: `refactor/erp-dead-code-cleanup`.
No CI, type-checking, linting, tests, builds or deployments were run (owner instruction).

## Method

A full static module graph was built for every tracked `.ts/.tsx/.js/.jsx/.mjs/.cjs` file
with the TypeScript parser (parse only, no type checking). It follows static imports and
re-exports, `import()` / `React.lazy`, `require`, `vi.mock`/`importActual` specifiers,
`import.meta.glob` patterns, `import type` and `/// <reference>`, and resolves the `@/`,
`@shared/` and `@assets/` aliases. Every import in the repository resolved, so the graph had
no blind spots from unknown specifiers. There are no variable (`import(name)`) dynamic imports
in `client/`.

Roots: `client/index.html` scripts (`main.tsx`, `lib/containerExportEnhancements.ts`,
`registerServiceWorker.ts`), `client/public`, the server entry points, `desktop/`, root
configs, `build/` and `scripts/`, plus every test. **Modules that the Vite build plugins
inject at build time** (for example `erpDaybookPaginationClient`, `accountStatementContinuousClient`,
`daybookPaginationClient`, `v5AllocationPaginationClient`, `excelHelper`,
`useBoundedTableRows`, `salesReportBandwidthClient`) were added as production roots so they
are not mistaken for dead code.

A file was removed only when it was unreachable from every root, **and** no live file named it
by path or by bare basename (source-text tests and verify scripts read files by path), **and**
its history showed retirement rather than a temporary hide. `lazyPages.ts` was also checked at
the export level, because an unused lazy export keeps a page looking reachable.

## Results

| Metric | Count |
|---|---:|
| Client files deleted | **175** |
| Lines removed by the phase (all files) | **33,861** |
| Unused `lazyPages.ts` exports removed | 8 |
| Test files deleted (tested only deleted modules) | 4 (+2 colocated client tests) |
| Test files edited to drop cases for deleted pages | 11 |
| Verify/audit scripts edited to drop checks on deleted files | 3 |

### Retired pages (routes already redirect elsewhere)

| Page | Live replacement / redirect |
|---|---|
| `pages/Bales.tsx` (+ `pages/bales/*`) | `/bales` → `/factory/raw-stock` |
| `pages/ProductionBales.tsx` | `/production-bales` → `/factory/stock-entry` |
| `pages/PressingBales.tsx` | `/factory/pressing` → `/factory/stock-entry` |
| `pages/factory/FactoryUsers.tsx` | `/factory/users` → `/factory/settings` |
| `pages/factory/FactoryNetProfitAnalytics.tsx` | → financial hub `section=net-profit` |
| `pages/factory/FactoryProfitability.tsx` | → financial hub `section=profitability` |
| `pages/factory/FactoryCashflow.tsx` | → financial hub `section=cashflow` (also removed from `offlinePrep`) |
| `pages/BaleTransfers.tsx` | its only consumer (`FactoryProduction.tsx`) was removed in Phase 2 |
| `pages/factory/FactoryPayroll.tsx` + `factorypayroll/*` | superseded by the payroll hubs |
| `pages/factory/FactoryStockOTW.tsx` | merged into the containers page (2026-05-15) |
| `pages/settings/ApprovalsPage.tsx`, `BusinessAlertsPage.tsx` | removed from Settings by "Remove unused approvals and business alerts features from settings" (2026-06-25) |
| `components/GradesCategoriesManager.tsx` | "remove Grades & Categories tab from Stock Hub" (2026-07-29) |
| `pages/payroll/GroupsTab.tsx` | "Move payroll Groups into Employees and Workers" (#1517) |
| `pages/factory/ProductionPlannerDialog.tsx`, `bale-stock-entry/ProductionPositionsTab.tsx`, `bale-stock-entry/WorkerCategoriesTab.tsx` | removed from Stock Entry (#1652 and the Aug 2026 refactor) |
| `pages/git-mockup/TabSummary.tsx`, `TabWhatsApp.tsx`, `TabPortReport.tsx` | GIT report keeps only Detail and Truck/Location tabs |
| `pages/settings/SettingsHubPage.tsx`, `NetPositionExportSection.tsx` | leftovers from the June 2026 page split |

`ContainerDetail` lost only its unused lazy export; the module stays (used by `ContainerDetailPage`).

### Orphan clusters (no importer at all)

Leftovers of the 2026-06-22 page splits (old `analytics/*` panels, `vouchers/Voucher*`
form/sidebar set, `settings/*` tables and dialogs), the 2026-09-01 "restore synchronization
tree" re-adds, the permanently disabled automated container tracking UI (`66c6aa5f3`, "permanently
disable container tracking scheduler"), the Golden Coast LSHI migration wizard
(`pages/sp/GcLshiMigration.tsx` + `gclshimigration/*`, superseded by SP setup consolidation),
`components/erpworkerdetail/*`, unused `client/src/api/*Api.ts` clients, unused hooks and
libraries (`use-table-prefs`, `useVoucherEntries`, `use-currency`, `capacitor`,
`captureElementToPdf`, `requestCache`, `heavyListPaginationClient`,
`accountStatementPaginationClient`) and 14 never-used shadcn primitives (`accordion`,
`action-feedback`, `aspect-ratio`, `breadcrumb`, `carousel`, `context-menu`, `drawer`,
`input-otp`, `menubar`, `navigation-menu`, `resizable`, `slider`, `toggle`, `toggle-group`).
The complete list is in the appendix.

### Reference updates

- `client/src/lazyPages.ts`: 8 unused lazy exports removed. `client/src/lib/offlinePrep.ts`:
  the `FactoryCashflow` preload removed.
- Page-mount suites (`wave4-page-mounts`, `wave4-populated-page-mounts`,
  `wave4-page-interactions`, `wave4-remaining-pages`, `renders-uncovered-pages`, `renders`,
  `phase4-split-pages`) lost only the cases for deleted pages. `priority-specialist-print` and
  `wave-h-production-bales-behavior` tested only retired pages and were removed.
- Source-text checks on deleted files were dropped from `tests/wave2-frontend-speed.test.ts`,
  `tests/ui/performance-wave1-request-churn.test.ts`, `tests/factory-worker-category-membership.test.ts`,
  `tests/ui/git-report-full-listing.test.ts`, `tests/ui/payroll-page-behavior.test.tsx` (an obsolete
  `vi.mock`), `scripts/audit-realtime-wave3.mjs`, `scripts/verify-wave3-api-payload-bandwidth.mjs`
  and `scripts/audit-i18n-phase14.mjs`. `config/factory-bilingual-dependencies.json` no longer
  lists deleted pages.

## Preserved (reachable only from tests or pinned by checks) — owner decision

| File(s) | Why kept |
|---|---|
| `factorystockallocationv5/components/ContainerPlannerPhase1.tsx`, `ContainerPlanner*.tsx`, `containerPlannerEngine.ts` | Hidden, not retired: "Hide container planner from stock allocation (#1765)". |
| `bale-stock-entry/RemoveFromStockTab.tsx`, `RemoveFromStockDialogs.tsx`, `RemoveFromStockTable.tsx` | Hidden, not retired: "Hide remove stock and import bales tabs from stock entry page". |
| `pages/accounts/HistoricalOpeningResolver.tsx` | **Feature gap**: `tests/multi-currency-integration.test.ts` certifies the "Resolve Historical Opening & Asset Values" UI, but no route mounts it. |
| `components/FactoryCatalogTranslationEditor.tsx` | **Feature gap**: `tests/factory-bilingual-completion.test.ts` certifies it; nothing mounts it. |
| `pages/vouchers/StockTransferRevisionHistory.tsx` | **Feature gap**: `scripts/verify-group-a-phase-3.mjs` certifies the admin revision history; nothing mounts it. |
| `components/financial/financial-screen.tsx`, `components/operations/operations-screen.tsx` | Pinned by `scripts/verify-program7d-accessibility-responsive.mjs`; unused by the app. |
| `pages/stockentryhistory/reports.ts`, `reportsLegacy.ts` | Pinned by `scripts/verify-phase11-frontend-pagination.mjs`; unused by the app. |
| `pages/sp/golden-coast/HadiCashRoutingPanel.tsx`, `pages/pos/hooks/goldenCoastPhase6Pos.ts` | Golden Coast financial UI/contract code with behavior tests; removed from the hub when HADI payout became canonical. Retire only with the GC owner. |
| `pages/settings/PageVisibilityTree.tsx` | Dedicated permission-tree test; never mounted. |
| `components/ui/chart.tsx`, `pagination.tsx`, `workflow-dialog.tsx` | UI kit primitives covered by the mobile-responsive suites; unused by pages. |
| `lib/containerPaginationClient.ts`, `lib/supplierPurchaseOrderPaginationClient.ts` | **Possible regression**: `tests/ui/fetch-guards-behavior.test.ts` tests these fetch interceptors, but nothing installs them in the app. *Corrected later: `build/vitePhase1PaginationPlugin.ts` installs them at build time. The same plugin imports `accountStatementPaginationClient`, whose deletion below was reverted in `a1f08d895`.* |

These were not deleted because doing so would remove a hidden feature, delete a behavior-tested
financial component, or silently drop a check that suggests the code was meant to be live.

## Appendix — deleted client files
- `client/src/api/containersApi.ts`
- `client/src/api/reportsApi.ts`
- `client/src/api/stockApi.ts`
- `client/src/api/vouchersApi.ts`
- `client/src/components/ActivityTimeline.tsx`
- `client/src/components/DashboardCard.tsx`
- `client/src/components/DataTableToolbar.tsx`
- `client/src/components/ERPWorkerDetail.tsx`
- `client/src/components/FinancialSummaryCard.tsx`
- `client/src/components/GradesCategoriesManager.tsx`
- `client/src/components/PropertyCard.tsx`
- `client/src/components/QuickActionCard.tsx`
- `client/src/components/dashboard/dashboard-shell.tsx`
- `client/src/components/erpworkerdetail/statement.test.ts`
- `client/src/components/erpworkerdetail/statement.ts`
- `client/src/components/erpworkerdetail/types.ts`
- `client/src/components/erpworkerdetail/useERPWorkerDetailModel.tsx`
- `client/src/components/erpworkerdetail/utils.ts`
- `client/src/components/pos/pos-screen.tsx`
- `client/src/components/shared.ts`
- `client/src/components/stock-transfer/SmartTransferFeedbackSummaryCard.tsx`
- `client/src/components/ui/accordion.tsx`
- `client/src/components/ui/action-feedback.tsx`
- `client/src/components/ui/aspect-ratio.tsx`
- `client/src/components/ui/breadcrumb.tsx`
- `client/src/components/ui/carousel.tsx`
- `client/src/components/ui/context-menu.tsx`
- `client/src/components/ui/drawer.tsx`
- `client/src/components/ui/input-otp.tsx`
- `client/src/components/ui/menubar.tsx`
- `client/src/components/ui/navigation-menu.tsx`
- `client/src/components/ui/resizable.tsx`
- `client/src/components/ui/slider.tsx`
- `client/src/components/ui/toggle-group.tsx`
- `client/src/components/ui/toggle.tsx`
- `client/src/components/vouchers/AccountCombobox.tsx`
- `client/src/hooks/use-currency.ts`
- `client/src/hooks/use-location-summary-bandwidth.ts`
- `client/src/hooks/use-table-prefs.ts`
- `client/src/hooks/useVoucherEntries.ts`
- `client/src/i18n/supplierProfitCheckTranslations.ts`
- `client/src/lib/accountStatementPaginationClient.ts`
- `client/src/lib/capacitor.ts`
- `client/src/lib/captureElementToPdf.ts`
- `client/src/lib/heavyListPaginationClient.ts`
- `client/src/lib/requestCache.test.ts`
- `client/src/lib/requestCache.ts`
- `client/src/pages/BaleTransfers.tsx`
- `client/src/pages/Bales.tsx`
- `client/src/pages/PressingBales.tsx`
- `client/src/pages/ProductionBales.tsx`
- `client/src/pages/accounts/CashBankRevaluationPanel.tsx`
- `client/src/pages/analytics/AccountsPanel.tsx`
- `client/src/pages/analytics/AnalyticsSidebar.tsx`
- `client/src/pages/analytics/ContainerReportPanel.tsx`
- `client/src/pages/analytics/HierarchicalAccounts.tsx`
- `client/src/pages/analytics/NetProfitAccountsList.tsx`
- `client/src/pages/analytics/NetProfitPanel.tsx`
- `client/src/pages/analytics/SalesReportPanel.tsx`
- `client/src/pages/analytics/StockReportPanel.tsx`
- `client/src/pages/analytics/analyticsHelpers.ts`
- `client/src/pages/analytics/analyticsQueryClient.ts`
- `client/src/pages/analytics/analyticsTypes.ts`
- `client/src/pages/analytics/useAnalyticsFactoryQueries.ts`
- `client/src/pages/analytics/useAnalyticsQueries.ts`
- `client/src/pages/analytics/useAnalyticsReferenceQueries.ts`
- `client/src/pages/analytics/useAnalyticsReportQueries.ts`
- `client/src/pages/analyticslegacy/utils.ts`
- `client/src/pages/bales/BaleFormDialog.tsx`
- `client/src/pages/bales/BaleScanner.tsx`
- `client/src/pages/bales/BalesTable.tsx`
- `client/src/pages/bales/useBales.ts`
- `client/src/pages/containers/OtwContainersTable.tsx`
- `client/src/pages/containers/SoldContainersTable.tsx`
- `client/src/pages/containers/otw/OtwContainerActions.tsx`
- `client/src/pages/containers/otw/OtwContainerFilters.tsx`
- `client/src/pages/containers/otw/OtwContainerRow.tsx`
- `client/src/pages/containers/otw/OtwContainerTableHeader.tsx`
- `client/src/pages/containers/otw/OtwEditableCell.tsx`
- `client/src/pages/containers/otw/OtwEmptyState.tsx`
- `client/src/pages/containers/otw/OtwFreightCell.tsx`
- `client/src/pages/containers/useContainerTracking.ts`
- `client/src/pages/containers/useJsonCargoEta.ts`
- `client/src/pages/factory/FactoryBaleImportHistory.tsx`
- `client/src/pages/factory/FactoryCashflow.tsx`
- `client/src/pages/factory/FactoryFinanceHub.tsx`
- `client/src/pages/factory/FactoryNetProfitAnalytics.tsx`
- `client/src/pages/factory/FactoryPayroll.tsx`
- `client/src/pages/factory/FactoryProfitability.tsx`
- `client/src/pages/factory/FactoryStaffTracking.tsx`
- `client/src/pages/factory/FactoryStockOTW.tsx`
- `client/src/pages/factory/FactoryUsers.tsx`
- `client/src/pages/factory/ProductionPlannerDialog.tsx`
- `client/src/pages/factory/bale-stock-entry/ProductionPositionsTab.tsx`
- `client/src/pages/factory/bale-stock-entry/WorkerCategoriesTab.tsx`
- `client/src/pages/factory/dailyproductionreport/components/LedgerSection.tsx`
- `client/src/pages/factory/factory-containers/OtwTrackingPanel.tsx`
- `client/src/pages/factory/factory-containers/TrackingSheets.tsx`
- `client/src/pages/factory/factory-containers/VesselTrackingSheet.tsx`
- `client/src/pages/factory/factory-containers/VesselTrailMap.tsx`
- `client/src/pages/factory/factoryStaffTrackingParts.tsx`
- `client/src/pages/factory/factoryotwtrackingtab/components/ContainerStatusBadge.tsx`
- `client/src/pages/factory/factoryotwtrackingtab/components/EventTimelineSheet.tsx`
- `client/src/pages/factory/factoryotwtrackingtab/components/ProgressStepIcon.tsx`
- `client/src/pages/factory/factoryotwtrackingtab/components/TrackNowProgressLog.tsx`
- `client/src/pages/factory/factoryotwtrackingtab/components/TrackingSettingsSheet.tsx`
- `client/src/pages/factory/factorypayroll/FactoryPayrollView.tsx`
- `client/src/pages/factory/factorypayroll/PayrollSummaryCards.tsx`
- `client/src/pages/factory/factorypayroll/types.ts`
- `client/src/pages/factory/factorypayroll/useFactoryPayrollModel.tsx`
- `client/src/pages/factory/factorypayroll/utils.tsx`
- `client/src/pages/factory/production-raw-stock/OpeningBalanceDialog.tsx`
- `client/src/pages/factory/productioncomparison/components/PctCell.tsx`
- `client/src/pages/factory/useFactoryJsonCargoEta.ts`
- `client/src/pages/git-containers/BulkProgressBanner.tsx`
- `client/src/pages/git-containers/ContainerDrawerTracking.tsx`
- `client/src/pages/git-containers/useContainerFilters.ts`
- `client/src/pages/git-mockup/TabPortReport.tsx`
- `client/src/pages/git-mockup/TabSummary.tsx`
- `client/src/pages/git-mockup/TabWhatsApp.tsx`
- `client/src/pages/payroll/AdvanceDialogs.tsx`
- `client/src/pages/payroll/GroupsTab.tsx`
- `client/src/pages/payroll/WorkerProfilesTab.tsx`
- `client/src/pages/pos/pos-components/CheckoutSidebar.tsx`
- `client/src/pages/salesreportlegacy/utils.ts`
- `client/src/pages/settings/AccountingRepairDialogs.tsx`
- `client/src/pages/settings/ApprovalsPage.tsx`
- `client/src/pages/settings/BusinessAlertsPage.tsx`
- `client/src/pages/settings/ChangePasswordDialog.tsx`
- `client/src/pages/settings/CompaniesTable.tsx`
- `client/src/pages/settings/CompanyDialog.tsx`
- `client/src/pages/settings/DailyAutoSendSection.tsx`
- `client/src/pages/settings/DailyExportSection.tsx`
- `client/src/pages/settings/DataCoverage.tsx`
- `client/src/pages/settings/DiagnosticsSection.tsx`
- `client/src/pages/settings/ExportCommon.tsx`
- `client/src/pages/settings/ExportHistory.tsx`
- `client/src/pages/settings/ExportImportSection.tsx`
- `client/src/pages/settings/ExportStatusBadge.tsx`
- `client/src/pages/settings/ModuleAccessSection.tsx`
- `client/src/pages/settings/NetPositionAdjustmentCard.tsx`
- `client/src/pages/settings/NetPositionExportSection.tsx`
- `client/src/pages/settings/NetPositionTab.tsx`
- `client/src/pages/settings/OfflineSyncPanel.tsx`
- `client/src/pages/settings/PasswordResetDialog.tsx`
- `client/src/pages/settings/ReadinessItem.tsx`
- `client/src/pages/settings/SettingsHubPage.tsx`
- `client/src/pages/settings/UserDialog.tsx`
- `client/src/pages/settings/UsersTable.tsx`
- `client/src/pages/settings/users/UserRoleDialog.tsx`
- `client/src/pages/sp/GcLshiMigration.tsx`
- `client/src/pages/sp/gclshimigration/GcLshiMigrationAccounts.tsx`
- `client/src/pages/sp/gclshimigration/GcLshiMigrationDialogs.tsx`
- `client/src/pages/sp/gclshimigration/GcLshiMigrationExecution.tsx`
- `client/src/pages/sp/gclshimigration/GcLshiMigrationSetup.tsx`
- `client/src/pages/sp/gclshimigration/GcLshiMigrationView.tsx`
- `client/src/pages/sp/gclshimigration/components/ProfitOpeningRunner.tsx`
- `client/src/pages/sp/gclshimigration/components/ReconciliationRunner.tsx`
- `client/src/pages/sp/gclshimigration/components/Stage2StepRunner.tsx`
- `client/src/pages/sp/gclshimigration/components/StatusBadge.tsx`
- `client/src/pages/sp/gclshimigration/types.ts`
- `client/src/pages/sp/gclshimigration/useGcLshiMigrationModel.tsx`
- `client/src/pages/sp/gclshimigration/utils.ts`
- `client/src/pages/sp/golden-coast/ExistingPositionCarryForwardPanel.tsx`
- `client/src/pages/voucher-edit/AdjustmentEditFormRows.tsx`
- `client/src/pages/voucher-edit/PurchaseAdjustmentEditForm.tsx`
- `client/src/pages/voucher-edit/PurchaseEditFormTable.tsx`
- `client/src/pages/vouchers/ApproveRevisionDialog.tsx`
- `client/src/pages/vouchers/SaveRevisionDialog.tsx`
- `client/src/pages/vouchers/StockTransferImportDialog.tsx`
- `client/src/pages/vouchers/VoucherForm.tsx`
- `client/src/pages/vouchers/VoucherFormHeader.tsx`
- `client/src/pages/vouchers/VoucherListPanel.tsx`
- `client/src/pages/vouchers/VoucherSidebar.tsx`
- `client/src/pages/vouchers/VoucherSidebarPanel.tsx`
