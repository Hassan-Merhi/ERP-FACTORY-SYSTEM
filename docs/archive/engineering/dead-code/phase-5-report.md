# Phase 5 — Unused functions, imports, types and exports

**Status: COMPLETE.** Branch `refactor/erp-dead-code-cleanup`.
No CI, tests, builds or deployments were run. The TypeScript compiler API was used only as a
static analyzer (parse/bind/check in memory, `noEmit`), never as a build.

## Method

1. **Unused locals and imports.** A TypeScript `Program` over `client/src`, `server` and
   `shared` (tests excluded) was checked with `noUnusedLocals` for diagnostics 6133/6192/6196/
   6198/6205. A conservative AST fixer removed unused import specifiers, type aliases,
   interfaces, functions, classes and `const`s whose initializer has no side effects
   (no `await`, no I/O, no unknown React hooks; `useRef`/`useMemo`/`useCallback`/`useMutation`
   and plain value expressions only). Variables that are written elsewhere, destructuring
   elements and initializers doing I/O were left for manual review. It was repeated until no
   more diagnostics could be resolved.
2. **Unused exports.** Every top-level named export in `client/src`, `server` and `shared`
   (excluding `shared/schema/**`, which drizzle-kit reads as a whole, and `.d.ts`) was checked
   for its identifier anywhere else in tracked code, tests, scripts, configs and HTML. An export
   whose name occurs in no other file *and* is not used inside its own file was removed. There
   is no namespace iteration (`Object.keys(ns)`) or computed module access in the code base, so
   name absence is conclusive. Exports used only inside their own file were left exported (see
   follow-up).
3. Steps 1–2 were alternated to a fixpoint, because each removal can orphan helpers.
4. **Safety checks.** (a) Every source-text assertion in tests/verify scripts that reads a
   modified file was re-evaluated against the before/after text; files whose pinned text was
   removed were restored. (b) The full-program diagnostics were compared with the pre-phase
   baseline: **no new errors** were introduced (the only new diagnostics, two now-empty modules
   re-exported by `container-tracking/index.ts` and one unused setter, were fixed). (c) Files
   that were Prettier-clean before were re-formatted with Prettier 3.8 after editing.

## Results

| Metric | Count |
|---|---:|
| Files changed | 230 |
| Lines removed (net) | 7,214 |
| Unused exported declarations removed | 244 |
| Unused local declarations / import specifiers removed (tool log) | 423 |
| Modules deleted because nothing was left in them | 9 |

Modules emptied and deleted: `server/services/container-tracking/track-due.ts`,
`track-now.ts` (automated tracking, permanently disabled in `66c6aa5f3`),
`server/services/ais/aisLiveTrackingService.ts`, `aisStreamClient.ts` (AIS live tracking,
disabled in the same change), `server/routes/sp/spMigrationCutoverUsers.ts` and the cut-over
handlers in `spMigrationCutoverRoutes.ts` (their routes were removed in Phase 3),
`server/helpers/calculateRawMaterialStockValue.ts`, `server/helpers/guardedExportResponse.ts`,
`server/lib/backendArchitecture.ts`, `client/src/pages/settings/datatoolstab/utils.ts`.

Notable groups of removed code:

- Dozens of `_`-prefixed locals that had been renamed to silence the linter instead of being
  deleted (unused handlers, mutations, refs, form schemas and their `z.infer` types).
- Unused storage functions (`server/storage/**`, reached only through `storage.<name>`):
  e.g. `createVoucherEntry`/`updateVoucherEntry`/`deleteVoucherEntry`, `getAllVouchers`,
  `createExchangeRate`, bale-transfer CRUD, salary-advance helpers. No caller of any form
  existed.
- Dead reads whose results were never used (e.g. an unused ledger-account list in payroll
  bulk adjustments, unused freight/mix-source queries in factory profitability, an unused
  supplier lookup inside the PO-fix loop). These only removed wasted queries.
- Write-only variables (`_deletedRepayVouchers`, `_insertedAdj`, `_qzInstance`): the writes
  they captured are kept; only the never-read capture was removed.

**No financial calculation was changed.** Every removed declaration was unreferenced; the only
behavioral effect is fewer wasted database/network reads.

## Retained deliberately

| Item | Reason |
|---|---|
| `server/services/factory/historical-replay/exactApply.ts` (`applyExactHistoricalCostReplay`), `historical-replay/types.ts` (`ReplayBlockReason` etc.) | Unused, but ~30 source-text assertions in the historical-replay safety tests pin their text. Owner decision (see Phase 6). |
| `server/lib/operationalAlertRuntime.ts` (`handleOperationalIncidents`) | Pinned by two observability verify scripts. |
| `client/src/lib/salesReportBandwidthClient.ts` (`invalidateSalesReportQueries`) | Pinned by `scripts/verify-bandwidth-phase-3-sales-report.mjs`; the bandwidth plugin is opt-in at build time. |
| `client/src/pages/settings/AuditLogUtils.tsx` (`ALL_SUPPORTED_ACTIONS`) | Pinned by `tests/audit-detail-completeness.test.ts`. |
| `backendMessagesPhase7TypedCallbackAuditCompatibility` | Intentional text artifact read by the i18n audits. |
| Stock Entry production-session query | `tests/ui/factory-permission-query-gating.test.tsx` asserts the request; kept as a bare `useQuery`. |
| Files preserved in Phase 4 (`financial-screen.tsx`, `operations-screen.tsx`, `ContainerPlannerPhase1.tsx`) | Owner decision items. |
| `shared/schema/**` exports | drizzle-kit consumes the schema as a whole. |

## Follow-up (not done, by design)

- **1,590 exports are used only inside their own file** (mostly component prop interfaces and
  local helper types). Un-exporting them is cosmetic churn across hundreds of files and would
  conflict with concurrent work; Phase 12 adds the tooling note for catching new ones.
- (Resolved in the Phase 13 follow-up, which also removed ~400 `_`-prefixed dead bindings and
  tightened ESLint.) About 30 remaining TypeScript "unused" diagnostics are destructured state setters, values
  written in loops, or initializers performing I/O; each needs a human look.

## Appendix — removed exported declarations
- `client/src/app/factoryAccessGuard.ts SUBPAGE_PARENT`
- `client/src/components/CurrencySelector.tsx CurrencyLabel`
- `client/src/components/ExchangeRateInput.tsx formatRateDisplay`
- `client/src/components/FactorySidebar.tsx FACTORY_NAV_PAGES`
- `client/src/components/remote-support-auth-lifecycle.ts resetRemoteSupportAuthLifecycle`
- `client/src/components/ui/page-shell.tsx FinancialReportHeader`
- `client/src/components/vouchers/PaymentVoucherTab.tsx PaymentVoucherTabProps (specifier)`
- `client/src/components/vouchers/ReceiptVoucherTab.tsx ReceiptVoucherTabProps (specifier)`
- `client/src/hooks/use-admin-override.tsx clearAdminOverrideCache`
- `client/src/hooks/use-paginated-filter-state.ts FilterFieldSetter`
- `client/src/i18n/accountingDocumentTranslations.ts accountingDocumentTranslationEntries`
- `client/src/i18n/factoryProductComparisonTranslations.ts formatFactoryProductComparisonOptionLabel`
- `client/src/lib/db.ts clearAllOfflineData`
- `client/src/lib/db.ts clearSyncLogs`
- `client/src/lib/db.ts getRecentSyncLogs`
- `client/src/lib/erpDaybookPaginationClient.ts ErpDaybookPage`
- `client/src/lib/erpDaybookPaginationClient.ts fetchErpDaybookPage`
- `client/src/lib/factoryApi.ts factoryQueryClient`
- `client/src/lib/factoryApi.ts resolveApiPath`
- `client/src/lib/historicalReplayPreparedRequest.ts PreparedHistoricalReplayResponse`
- `client/src/lib/labelHtml.ts prefetchBarcodeDataUrls`
- `client/src/lib/labelHtml.ts prefetchLogoDataUrl`
- `client/src/lib/labelHtml.ts prefetchLogoEager`
- `client/src/lib/queryClient.ts invalidateStockItemLight`
- `client/src/lib/queryClient.ts invalidateStockItemPageQueries`
- `client/src/lib/queryClient.ts invalidateStockItems`
- `client/src/lib/queryPolicies.ts liveTransactionalQueryPolicy`
- `client/src/lib/refPool.ts consumeRef`
- `client/src/lib/refPool.ts pruneUsedRefs`
- `client/src/pages/accounts/accountTypes.ts exportLabels`
- `client/src/pages/containers/types.ts SpContainerCancelResponse`
- `client/src/pages/containers/types.ts TrackingEdit`
- `client/src/pages/containers/types.ts TrackingFieldEdits`
- `client/src/pages/daybook/state.ts focusDaybookEditById`
- `client/src/pages/factory/dailyproductionreport/types.ts LedgerSectionProps`
- `client/src/pages/factory/dailyproductionreport/utils.tsx DETAILED_COLORS`
- `client/src/pages/factory/dailyproductionreport/utils.tsx DETAILED_ORDER`
- `client/src/pages/factory/factory-containers/ContainerDialogs.tsx FullImportDialog`
- `client/src/pages/factory/factory-containers/ContainerDialogs.tsx exportContainers`
- `client/src/pages/factory/factory-containers/ContainerDialogs.tsx parseContainerImportFile`
- `client/src/pages/factory/factoryProductionTargetsModel.ts ImportedProductionTarget`
- `client/src/pages/factory/factoryProductionTargetsModel.ts normalizeExcelHeader`
- `client/src/pages/factory/factoryProductionTargetsModel.ts normalizeWorkerCode`
- `client/src/pages/factory/factorycontainerloadingscan/types.ts CreateLoadingOrderInput`
- `client/src/pages/factory/production-raw-stock/ProductionRawStockHelpers.tsx AdjustmentsHistoryCard`
- `client/src/pages/factory/productioncomparison/utils.ts fmtPct`
- `client/src/pages/git-containers/gitContainerTypes.ts ALL_STATUSES`
- `client/src/pages/git-containers/gitContainerTypes.ts BulkProgress`
- `client/src/pages/git-containers/gitContainerTypes.ts FREIGHT_META`
- `client/src/pages/git-containers/gitContainerTypes.ts STATUS_META`
- `client/src/pages/git-containers/gitContainerTypes.ts UIPriority`
- `client/src/pages/git-containers/gitContainerTypes.ts fmtSkipReason`
- `client/src/pages/git-containers/gitContainerTypes.ts getContainerPriority`
- `client/src/pages/git-mockup/types.ts PORT_BUCKETS`
- `client/src/pages/git-mockup/types.ts PortBucket`
- `client/src/pages/payroll/payrollSchemas.ts BonusFormData`
- `client/src/pages/payroll/payrollSchemas.ts WorkerPayment`
- `client/src/pages/payroll/payrollSchemas.ts bonusSchema`
- `client/src/pages/settings/SystemMaintenanceDialogs.tsx FixPOCreditsDialog`
- `client/src/pages/settings/datatoolstab/types.ts CompanyFormData`
- `client/src/pages/settings/datatoolstab/types.ts RoleAssignmentData`
- `client/src/pages/settings/datatoolstab/types.ts UserFormData`
- `client/src/pages/settings/datatoolstab/utils.ts companyFormSchema`
- `client/src/pages/settings/datatoolstab/utils.ts roleAssignmentSchema`
- `client/src/pages/settings/datatoolstab/utils.ts userFormSchema`
- `client/src/pages/settings/settingsTypes.ts SettingsCompanyRow`
- `client/src/pages/settings/settingsTypes.ts SettingsLedgerAccountRow`
- `client/src/pages/settings/settingsTypes.ts SettingsLocationRow`
- `client/src/pages/settings/settingsTypes.ts SettingsUserRoleRow`
- `client/src/pages/stockentryhistory/derived.ts WorkerCondensed`
- `client/src/pages/stockentryhistory/derived.ts WorkerTarget`
- `client/src/pages/stockentryhistory/derived.ts deriveStockEntryHistory`
- `client/src/pages/vouchers/journalform/types.ts CreatedLedgerAccount`
- `server/excelHelper.ts writeWorkbookToStream`
- `server/helpers/calculateRawMaterialStockValue.ts calculateRawMaterialStockValue`
- `server/helpers/exportAttachmentSource.ts isFileExportAttachment`
- `server/helpers/groupIntercompany.ts intercompanyAccountIds`
- `server/helpers/guardedExportResponse.ts GuardedExportResponseOptions`
- `server/helpers/guardedExportResponse.ts writeGuardedExportResponse`
- `server/lib/aiSnapshots.ts invalidateAISnapshots`
- `server/lib/backendArchitecture.ts BACKEND_LAYER_RULES`
- `server/lib/backendArchitecture.ts BackendLayer`
- `server/lib/backendArchitecture.ts DEFERRED_BACKEND_BOUNDARIES`
- `server/lib/backendArchitecture.ts DeferredBackendBoundary`
- `server/lib/httpHandlers.ts asyncRoute`
- `server/lib/logRedaction.ts __logRedactionTesting`
- `server/lib/logger.ts createScopedLogger`
- `server/lib/parcelsAppClient.ts ParcelsAppResult`
- `server/lib/parcelsAppClient.ts testConnection`
- `server/lib/puppeteerSemaphore.ts puppeteerQueueDepth`
- `server/lib/puppeteerSemaphore.ts puppeteerSlotsBusy`
- `server/lib/requestContext.ts requireSessionRole`
- `server/lib/schedulerObservability.ts __schedulerObservabilityTesting`
- `server/lib/trackingProviders/providerResolver.ts anyDirectProviderPossible`
- `server/netPositionHelper.ts buildBreakdowns`
- `server/netPositionHelper.ts getAccountNetBalanceExact`
- `server/routes/factory/customer-orders/proformaCapacityConcurrency.ts acquireProformaCapacityTransactionLocks`
- `server/routes/factory/customer-orders/proformaCapacityConcurrency.ts getLockedProformaCapacitySnapshot`
- `server/routes/factory/dispatch-batches/_helpers.ts ensureBatchStatus`
- `server/routes/factory/stock-allocation-v5/_helpers.ts TOTAL_LOADED_STATUSES`
- `server/routes/factory/suppliers/balance/factorySupplierLedger.ts ledgerOwed`
- `server/routes/payroll/core/_helpers.ts normUsd`
- `server/routes/pos/posHelpers.ts storeTempFile`
- `server/routes/pos/posHelpers.ts storeTempPdf`
- `server/routes/sp/spMigrationCutoverReadiness.ts restoreCutoverStock`
- `server/routes/sp/spMigrationCutoverReadiness.ts synchronizeCutoverStock`
- `server/routes/sp/spMigrationCutoverState.ts CutoverStatus`
- `server/routes/sp/spMigrationCutoverUsers.ts CutoverRoleSnapshot`
- `server/routes/sp/spMigrationCutoverUsers.ts moveUsersToTarget`
- `server/routes/sp/spMigrationCutoverUsers.ts restoreUsersToSource`
- `server/routes/sp/spMigrationFinalVerification.ts buildFinalSpVerification`
- `server/routes/sp/spMigrationPhase2Common.ts MigrationLedgerAccountRow`
- `server/routes/stats/goldenCoastResidualEquityProjection.ts goldenCoastHassanClaim`
- `server/routes/vouchers/smartTransferPreviewRoutes.ts SmartTransferPreviewRequest`
- `server/services/accounting/accountClassification.ts isProfitAndLossAccount`
- `server/services/accounting/balances/partyLineRules.ts partyOwnedLineSql`
- `server/services/accounting/balances/partyLineRules.ts voucherBookedOnText`
- `server/services/accounting/databasePhase3AccountingAudit.ts runDatabasePhase3AccountingAudit`
- `server/services/accounting/financialCloseService.ts FinancialPeriodStatus`
- `server/services/accounting/goldenCoastOwnerWithdrawalJournal.ts transformGoldenCoastOwnerWithdrawalJournal`
- `server/services/accounting/goldenCoastPhase2Accounts.ts GOLDEN_COAST_PHASE2_ROLES`
- `server/services/accounting/goldenCoastPhase2Accounts.ts GOLDEN_COAST_PHASE2_SUBTYPES`
- `server/services/accounting/infrastructureVoucherIdentity.ts deleteInfrastructurePostingIdentityForVoucher`
- `server/services/accounting/voucherCorrection.ts isVoucherReversedTx`
- `server/services/ais/aisHealth.ts recordAisControlMessage`
- `server/services/ais/aisHealth.ts recordAisError`
- `server/services/ais/aisHealth.ts recordAisMessage`
- `server/services/ais/aisHealth.ts recordAisReconnect`
- `server/services/ais/aisHealth.ts setAisState`
- `server/services/ais/aisHealth.ts setAisSubscriptionCount`
- `server/services/ais/aisLiveTrackingService.ts refreshAisLiveTrackingSubscriptions`
- `server/services/ais/aisLiveTrackingService.ts startAisLiveTracking`
- `server/services/ais/aisLiveTrackingService.ts stopAisLiveTracking`
- `server/services/ais/aisRepository.ts applyAisUpdate`
- `server/services/ais/aisRepository.ts listActiveTrackedMmsis`
- `server/services/ais/aisStreamClient.ts AisStreamClient`
- `server/services/ais/aisStreamClient.ts AisStreamClientOptions`
- `server/services/ais/vesselMapping.ts markVesselMappingStale`
- `server/services/audit/auditLogAppendOnlyGuard.ts AUDIT_LOG_GUARD_TRIGGERS`
- `server/services/audit/voucherAuditTrigger.ts ROW_AUDIT_ACTIONS`
- `server/services/container-tracking/bulk.ts isBulkTrackingRunning`
- `server/services/container-tracking/bulk.ts setBulkTrackingEnabled`
- `server/services/container-tracking/bulk.ts trackAllEnabledNow`
- `server/services/container-tracking/track-due.ts trackDueContainers`
- `server/services/container-tracking/track-now.ts TrackNowResult`
- `server/services/container-tracking/track-now.ts isTrackingAtCapacity`
- `server/services/container-tracking/track-now.ts trackOneContainerById`
- `server/services/container-tracking/track-now.ts trackingInFlightCount`
- `server/services/export-data/fetch.ts fetchCompanyExportData`
- `server/services/factory-container-tracking/capacity-api.ts factoryTrackingInFlightCount`
- `server/services/factory-container-tracking/capacity-api.ts isFactoryTrackingAtCapacity`
- `server/services/factory-container-tracking/capacity-api.ts trackDueFactoryContainers`
- `server/services/factory-container-tracking/capacity-api.ts updateFactoryContainerTrackingSettings`
- `server/services/factory/historical-replay/exactApplyV5.ts applyExactHistoricalCostReplayV5`
- `server/services/factory/historical-replay/exactScopeFinal.ts buildExactHistoricalReplayScopeFinal`
- `server/services/factory/historical-replay/exactScopeV6.ts buildExactHistoricalReplayScopeV6`
- `server/services/factory/mixSourcePricingBasis.ts resolveSourceType`
- `server/services/factory/rawStockLockedRate.ts requireExistingLockedRate`
- `server/services/factoryDocumentLanguage.ts translateFactoryDocumentStatus`
- `server/services/heavyExportCoordinator.ts getHeavyExportState`
- `server/services/inventory/canonicalStockMovementTables.ts CanonicalStockMovement`
- `server/services/inventory/canonicalStockMovementTables.ts CanonicalStockMovementAudit`
- `server/services/inventory/canonicalStockMovementTables.ts CanonicalStockMovementRequest`
- `server/services/inventory/databaseStockTransferConvergenceAdapter.ts createDatabaseStockTransferSnapshotLoader`
- `server/services/pos/goldenCoastPosAccounting.ts reverseGoldenCoastPosAccountingTx`
- `server/services/presenceMaintenance.ts resetPresenceMaintenanceForTests`
- `server/services/remoteSupportAuditRetention.ts resetRemoteSupportAuditRetentionForTests`
- `server/services/retail/retailPricing.ts RETAIL_MONEY_EPSILON`
- `server/services/retail/retailPricing.ts defaultDiscountLimitPercent`
- `server/services/retail/retailPromotions.ts retailPromotionIdsExist`
- `server/services/scheduler/scheduledWhatsAppDelivery.ts hasRetryableScheduledWhatsAppOccurrence`
- `server/services/screenFeedWebSocketTransport.ts resetScreenFeedWebSocketTransportForTests`
- `server/services/security/companyContextEnforcementAdapter.ts CompanyAssertionSource`
- `server/services/security/namedPermissionService.ts KnownSecurityPermission`
- `server/services/security/securityAuditRuntime.ts SecurityAuditWriter`
- `server/services/security/sessionSecurityPolicy.ts assertSessionSecurity`
- `server/services/sp-sales-form-v2/constants.ts MONEY4_FMT`
- `server/services/sp/spLifecyclePolicy.ts buildSpReversalEntries`
- `server/services/syncSalesItemCosts.ts applyInventoryRateDeltaAndSync`
- `server/services/whatsappService.ts getAgentDutyWaGroups`
- `server/services/whatsappService.ts getCompanyTransferWaGroupChatId`
- `server/services/whatsappService.ts sendWhatsAppFileByUrlToChatIdPos`
- `server/storage/accounting/customer-balances.ts addCustomerBalanceEntry`
- `server/storage/accounting/customers.ts deleteCustomer`
- `server/storage/accounting/exchange-rates.ts createExchangeRate`
- `server/storage/accounting/exchange-rates.ts upsertExchangeRate`
- `server/storage/accounting/intercompany.ts createInterCompanyTransfer`
- `server/storage/accounting/intercompany.ts getInterCompanyTransferById`
- `server/storage/accounting/ledger-accounts.ts deleteLedgerAccount`
- `server/storage/accounting/spreadsheets.ts getLiveSpreadsheetById`
- `server/storage/accounting/voucher-writes.ts createVoucherEntry`
- `server/storage/accounting/voucher-writes.ts deleteVoucherEntry`
- `server/storage/accounting/voucher-writes.ts updateVoucherEntry`
- `server/storage/accounting/vouchers.ts getAllVouchers`
- `server/storage/accounting/vouchers.ts getVoucherEntriesByCustomer`
- `server/storage/accounting/vouchers.ts updateVoucher`
- `server/storage/containers-store/sales.ts createContainerSale`
- `server/storage/containers-store/sales.ts getContainerSaleById`
- `server/storage/containers-store/sales.ts updateContainerSalePayment`
- `server/storage/employees.ts createSalaryAdvance`
- `server/storage/employees.ts createSalaryAdvanceDeduction`
- `server/storage/employees.ts getEmployeeById`
- `server/storage/employees.ts getSalaryAdvanceDeductions`
- `server/storage/employees.ts getUnpaidSalaryAdvancesByEmployee`
- `server/storage/employees.ts updateSalaryAdvance`
- `server/storage/factory/production.ts createMixBatch`
- `server/storage/factory/production.ts getProductionBaleById`
- `server/storage/factory/production.ts updateMixBatch`
- `server/storage/factory/production.ts updateProductionBale`
- `server/storage/factory/products.ts bulkCreateBaleProducts`
- `server/storage/factory/products.ts createBaleLabelPrint`
- `server/storage/factory/products.ts getBaleProductByCode`
- `server/storage/factory/transfers.ts createBaleTransfer`
- `server/storage/factory/transfers.ts deleteBaleTransfer`
- `server/storage/factory/transfers.ts deleteBaleTransferItem`
- `server/storage/factory/transfers.ts getAllBaleTransfers`
- `server/storage/factory/transfers.ts getBaleTransferById`
- `server/storage/factory/transfers.ts getBaleTransferItems`
- `server/storage/inventory/codeAliasStorage.ts createCodeAlias`
- `server/storage/inventory/codeAliasStorage.ts deleteCodeAlias`
- `server/storage/inventory/locationInventoryStorage.ts getInventoryByStockItem`
- `server/storage/inventory/locationInventoryStorage.ts getInventorySummary`
- `server/storage/inventory/locationInventoryStorage.ts getStockItemsWithInventory`
- `server/storage/inventory/locationInventoryStorage.ts getTotalInventoryValue`
- `server/storage/inventory/locationPriceStorage.ts getLocationPrices`
- `server/storage/inventory/stockGroupStorage.ts deleteStockGroup`
- `server/storage/inventory/stockItemStorage.ts getStockItemByBarcode`
- `server/storage/pos/shifts.ts updateShiftStats`
- `server/storage/stock-ops/item-history.ts getLastPurchaseOrderForItem`
- `server/storage/stock-ops/item-history.ts getLastSaleForItem`
- `server/storage/stock-ops/item-history.ts getLastSoldPrices`
- `server/vite.ts serveStatic`
- `shared/factoryAccessRegistry.ts FACTORY_SUBPAGE_PARENT`
- `shared/factoryBilingualCatalogPresentation.ts FactoryCatalogCategoryPresentationSource`
- `shared/factoryBilingualCatalogPresentation.ts mapFactoryLegacyCategoryEdit`
- `shared/factoryBilingualCatalogPresentation.ts matchesFactoryCatalogProductSearch`
- `shared/factoryBilingualCatalogPresentation.ts normalizeFactoryCatalogSearch`
- `shared/factoryBilingualCatalogPresentation.ts presentFactoryCatalogCategories`
- `shared/factoryBilingualCatalogPresentation.ts presentFactoryCatalogProducts`
- `shared/factoryBilingualContract.ts FactoryBilingualCategoryApiExtension`
- `shared/factoryBilingualContract.ts FactoryBilingualProductApiExtension`
- `shared/factoryPermissionCatalog.ts FACTORY_CANONICAL_PAGE_KEYS`
- `shared/permissionConfig.ts PERMISSION_TYPES`
- `shared/permissionConfig.ts getCatalogByTypeAndGroup`