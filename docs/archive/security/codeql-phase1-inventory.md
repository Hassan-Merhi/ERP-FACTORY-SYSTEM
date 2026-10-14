# CodeQL Phase 1 — Open Alert Inventory

Generated: `2026-08-28T18:19:08.352Z`
Repository: `Hassan-Merhi/etshadierp`
Main ref observed at collection: `00880735f4cb13a8895ff520b50e35a025094708`
CodeQL analyzed main snapshot: `2fb9747d2a8713ecc4dbe7b43dfe0421f20da74d`

## Scope and completeness

The inventory paginated GitHub's code-scanning API with `state=open` and `ref=refs/heads/main`, then verified that `main` had not moved during collection. It fetched **1610** open alerts across **17** page(s), with **1610** unique alert numbers and **0** duplicate numbers.

CodeQL accounts for **1559** open alerts; the remaining **51** are from other code-scanning tools.

The open-alert state was queried for `refs/heads/main`, while CodeQL's most recent analyzed instances all point to `2fb9747d2a8713ecc4dbe7b43dfe0421f20da74d`. Alert locations and line numbers therefore belong to that analyzed SHA, not the newer observed branch head `00880735f4cb13a8895ff520b50e35a025094708`. Remediation must re-check the live alert/scan state after each fix rather than treating stale line numbers as exact current-main locations.

## Tools

| Tool | Open alerts |
| --- | --- |
| CodeQL | 1559 |
| Scorecard | 30 |
| zizmor | 21 |

## CodeQL severity inventory

| Severity | Open alerts |
| --- | --- |
| critical | 10 |
| high | 1539 |
| medium | 10 |

Unique CodeQL rules: **22**  
Unique CodeQL files: **500**  
Unique CodeQL modules: **107**

## Phase targets derived from the inventory

| Phase | Target | Current alert count |
| --- | --- | --- |
| 2 | Critical — type confusion / parameter tampering | 9 |
| 3 | Remaining Critical CodeQL rules | 1 |
| 4 | High CodeQL | 1539 |
| 5 | Medium CodeQL | 10 |
| 6 | Low + non-security severity + false-positive review | 0 |
| 7 | Final re-scan and certification | fresh main scan |

## Critical CodeQL rule groups

| Rule | Name | Alerts | Top modules | CWEs |
| --- | --- | --- | --- | --- |
| js/type-confusion-through-parameter-tampering | js/type-confusion-through-parameter-tampering | 9 | server/routes/inventory-movement (4), server/routes/sp (4), server/routes/accountStatementRoutes.ts (1) | CWE-843 |
| js/request-forgery | js/request-forgery | 1 | server/routes/auth (1) | CWE-918 |

## All CodeQL rule groups

| Severity | Rule | Name | Alerts | Files | Top modules |
| --- | --- | --- | --- | --- | --- |
| critical | js/type-confusion-through-parameter-tampering | js/type-confusion-through-parameter-tampering | 9 | 3 | server/routes/inventory-movement (4), server/routes/sp (4), server/routes/accountStatementRoutes.ts (1) |
| critical | js/request-forgery | js/request-forgery | 1 | 1 | server/routes/auth (1) |
| high | js/missing-rate-limiting | js/missing-rate-limiting | 1502 | 472 | server/routes/factory (589), server/routes/admin (82), server/routes/stock (79), server/routes/payroll (54) |
| high | js/incomplete-url-substring-sanitization | js/incomplete-url-substring-sanitization | 6 | 5 | server/lib (3), desktop/main.js (2), scripts/verify-program1-observability-foundation.mjs (1) |
| high | js/polynomial-redos | js/polynomial-redos | 5 | 3 | server/lib (3), server/routes/factory (1), server/routes/supplierProformaRoutes.ts (1) |
| high | js/insufficient-password-hash | js/insufficient-password-hash | 4 | 4 | scripts/create-admin.ts (1), scripts/init-db-manual.ts (1), server/routes/factory (1), server/routes/helpers (1) |
| high | js/incomplete-sanitization | js/incomplete-sanitization | 3 | 3 | scripts/audit-legacy-route-boundaries.mjs (1), server/lib (1), server/routes/remoteSupportAuditRoutes.ts (1) |
| high | js/insecure-randomness | js/insecure-randomness | 3 | 2 | client/src/components (2), server/services/rental (1) |
| high | js/path-injection | js/path-injection | 3 | 2 | server/helpers (2), server/routes/factory-workers (1) |
| high | js/reflected-xss | js/reflected-xss | 3 | 3 | server/routes/remoteControlSessionRoutes.ts (1), server/routes/remoteKeyboardControlRoutes.ts (1), server/routes/screenFeedRoutes.ts (1) |
| high | js/xss-through-dom | js/xss-through-dom | 3 | 2 | client/src/pages (3) |
| high | js/clear-text-storage-of-sensitive-data | js/clear-text-storage-of-sensitive-data | 2 | 2 | client/src/lib (2) |
| high | js/case-sensitive-middleware-path | js/case-sensitive-middleware-path | 1 | 1 | server/routes/pos (1) |
| high | js/clear-text-logging | js/clear-text-logging | 1 | 1 | scripts/prepare-phase9-browser-smoke-fixture.mjs (1) |
| high | js/incomplete-url-scheme-check | js/incomplete-url-scheme-check | 1 | 1 | client/src/hooks (1) |
| high | js/insecure-helmet-configuration | js/insecure-helmet-configuration | 1 | 1 | server/index.ts (1) |
| high | js/weak-cryptographic-algorithm | js/weak-cryptographic-algorithm | 1 | 1 | server/routes/screenFeedTransportHardening.ts (1) |
| medium | js/stack-trace-exposure | js/stack-trace-exposure | 4 | 4 | server/routes/vouchers (3), scripts/verify-phase9-export-bridge.mjs (1) |
| medium | js/sensitive-get-query | js/sensitive-get-query | 3 | 2 | server/routes/factory (2), server/routes/employees (1) |
| medium | js/bad-code-sanitization | js/bad-code-sanitization | 1 | 1 | artifacts/mockup-sandbox (1) |
| medium | js/clear-text-cookie | js/clear-text-cookie | 1 | 1 | tests/setup.ts (1) |
| medium | js/identity-replacement | js/identity-replacement | 1 | 1 | server/lib (1) |

## CodeQL module groups

| Module | Open alerts |
| --- | --- |
| server/routes/factory | 593 |
| server/routes/admin | 82 |
| server/routes/stock | 79 |
| server/routes/vouchers | 56 |
| server/routes/payroll | 54 |
| server/routes/sp | 46 |
| server/routes/auth | 43 |
| server/routes/containers | 43 |
| server/routes/pos | 26 |
| server/routes/location | 23 |
| server/routes/stats | 23 |
| server/routes/whatsappRoutes.ts | 20 |
| server/routes/erp-payroll | 19 |
| server/routes/baleRoutes.ts | 18 |
| server/routes/productionBaleRoutes.ts | 18 |
| server/routes/baleProductRoutes.ts | 17 |
| server/routes/employeeGroupRoutes.ts | 15 |
| server/routes/employees | 13 |
| server/routes/accountTransactionRoutes.ts | 12 |
| server/routes/intercompanyNotificationRoutes.ts | 11 |
| server/routes/remoteControlSessionRoutes.ts | 11 |
| server/routes/inventory-movement | 10 |
| server/routes/ledger | 10 |
| server/routes/reportsDashboardAccountRoutes.ts | 10 |
| server/routes/accounts | 9 |
| server/routes/bankAssetRoutes.ts | 9 |
| server/routes/container-loaded-items | 9 |
| server/routes/employeeRoutes.ts | 9 |
| server/routes/fiscal-transfers | 9 |
| server/routes/screenFeedRoutes.ts | 9 |
| server/lib | 8 |
| server/routes/customers | 8 |
| server/routes/productionRawStockRoutes.ts | 8 |
| server/routes/supplierRoutes.ts | 8 |
| server/routes/voucher-entries | 8 |
| server/routes/approvalRoutes.ts | 7 |
| server/routes/notificationRoutes.ts | 7 |
| server/routes/passkeyRoutes.ts | 7 |
| server/routes/stockAdjustmentWasteRoutes.ts | 7 |
| server/routes/transporterStatementRoutes.ts | 7 |
| server/routes/accountStatementRoutes.ts | 6 |
| server/routes/accountTransactionPaginationRoutes.ts | 6 |
| server/routes/baleTransferRoutes.ts | 6 |
| server/routes/businessAlertsRoutes.ts | 6 |
| server/routes/factory-workers | 6 |
| server/routes/import | 6 |
| server/routes/offloadRoutes.ts | 6 |
| server/routes/remoteKeyboardControlRoutes.ts | 6 |
| server/routes/stockTransferImportRoutes.ts | 6 |
| server/routes/transfers | 6 |
| server/routes/baleLookupRoutes.ts | 5 |
| server/routes/debug | 5 |
| server/routes/financialSalesRoutes.ts | 5 |
| server/routes/userPresenceRoutes.ts | 5 |
| server/routes/exchangeRateRoutes.ts | 4 |
| server/routes/historicalCurrencyRepairCenterRoutes.ts | 4 |
| server/routes/reportsClosingStockRoutes.ts | 4 |
| server/routes/reportsNetProfitStatementRoutes.ts | 4 |
| server/routes/stock-summary-location | 4 |
| client/src/pages | 3 |
| server/routes/accountCurrencyRoutes.ts | 3 |
| server/routes/adminRoutes.ts | 3 |
| server/routes/creditNoteRoutes.ts | 3 |
| server/routes/creditSalesImportRoutes.ts | 3 |
| server/routes/posImportRoutes.ts | 3 |
| server/routes/remoteSupportRolloutRoutes.ts | 3 |
| server/routes/whatsappFastSendRoutes.ts | 3 |
| client/src/components | 2 |
| client/src/lib | 2 |
| desktop/main.js | 2 |
| server/helpers | 2 |
| server/index.ts | 2 |
| server/routes/factory-intelligence | 2 |
| server/routes/factory-payroll | 2 |
| server/routes/import-cycle | 2 |
| server/routes/inventory | 2 |
| server/routes/openingBalanceResolutionRoutes.ts | 2 |
| server/routes/remoteSupportAuditRoutes.ts | 2 |
| server/routes/reportsLedgerRoutes.ts | 2 |
| server/routes/stockSummaryRoutes.ts | 2 |
| server/routes/userNotesRoutes.ts | 2 |
| artifacts/mockup-sandbox | 1 |
| client/src/hooks | 1 |
| scripts/audit-legacy-route-boundaries.mjs | 1 |
| scripts/create-admin.ts | 1 |
| scripts/init-db-manual.ts | 1 |
| scripts/prepare-phase9-browser-smoke-fixture.mjs | 1 |
| scripts/verify-phase9-export-bridge.mjs | 1 |
| scripts/verify-program1-observability-foundation.mjs | 1 |
| server/routes/balance-repair | 1 |
| server/routes/barcodeImageBandwidthMiddleware.ts | 1 |
| server/routes/daybookPaginationRoutes.ts | 1 |
| server/routes/factoryAttendanceRoutes.ts | 1 |
| server/routes/factoryRoutes.ts | 1 |
| server/routes/helpers | 1 |
| server/routes/historicalCurrencyGuardRoutes.ts | 1 |
| server/routes/ledgerAccountPaginationRoutes.ts | 1 |
| server/routes/ledgerRoutes.ts | 1 |
| server/routes/performance | 1 |
| server/routes/reportsContainerTrackingRoutes.ts | 1 |
| server/routes/reportsVoucherDetailRoutes.ts | 1 |
| server/routes/screenFeedTransportHardening.ts | 1 |
| server/routes/supplierProformaRoutes.ts | 1 |
| server/routes/voucherEntryCurrencyEditRoutes.ts | 1 |
| server/services/rental | 1 |
| server/vite.ts | 1 |
| tests/setup.ts | 1 |

## Highest-density CodeQL files

| File | Open alerts |
| --- | --- |
| server/routes/whatsappRoutes.ts | 20 |
| server/routes/baleRoutes.ts | 18 |
| server/routes/productionBaleRoutes.ts | 18 |
| server/routes/baleProductRoutes.ts | 17 |
| server/routes/employeeGroupRoutes.ts | 15 |
| server/routes/factory/employee-pos/employeeAdvancesBonusRoutes.ts | 14 |
| server/routes/factory/shipping-containers/documents.ts | 14 |
| server/routes/accountTransactionRoutes.ts | 12 |
| server/routes/admin/userManagementRoutes.ts | 11 |
| server/routes/auth/companyAccessRoutes.ts | 11 |
| server/routes/auth/userAdministrationRoutes.ts | 11 |
| server/routes/factory/factoryStockAllocationV3Routes.ts | 11 |
| server/routes/intercompanyNotificationRoutes.ts | 11 |
| server/routes/remoteControlSessionRoutes.ts | 11 |
| server/routes/admin/import-export/files.ts | 10 |
| server/routes/factory/bales/balesCrudRoutes.ts | 10 |
| server/routes/factory/docs-users/docsRoutes.ts | 10 |
| server/routes/reportsDashboardAccountRoutes.ts | 10 |
| server/routes/admin/import-export/spreadsheets.ts | 9 |
| server/routes/bankAssetRoutes.ts | 9 |
| server/routes/employeeRoutes.ts | 9 |
| server/routes/factory/docs-users/chatRoutes.ts | 9 |
| server/routes/factory/docs-users/freightRoutes.ts | 9 |
| server/routes/factory/factoryStatusBuilderRoutes.ts | 9 |
| server/routes/factory/raw-stock/rawStockAdjRoutes.ts | 9 |
| server/routes/factory/shipping-containers/rows.ts | 9 |
| server/routes/screenFeedRoutes.ts | 9 |
| server/routes/stock/stockItemManageRoutes.ts | 9 |
| server/routes/customers/customerMasterRoutes.ts | 8 |
| server/routes/employees/salaryAdvanceRoutes.ts | 8 |
| server/routes/factory/bales/balesImportRoutes.ts | 8 |
| server/routes/factory/factoryContainerTrackingRoutes.ts | 8 |
| server/routes/factory/factoryStatusBuilderSheetsRoutes.ts | 8 |
| server/routes/factory/factoryTransporterRoutes.ts | 8 |
| server/routes/factory/raw-stock/rawStockContainerRoutes.ts | 8 |
| server/routes/factory/suppliers/crud/suppliers.ts | 8 |
| server/routes/location/locationCrudRoutes.ts | 8 |
| server/routes/productionRawStockRoutes.ts | 8 |
| server/routes/stock/stockPriceListImportRoutes.ts | 8 |
| server/routes/supplierRoutes.ts | 8 |
| server/routes/vouchers/immutableStockTransferRevisionRoutes.ts | 8 |
| server/routes/admin/companySettingsRoutes.ts | 7 |
| server/routes/approvalRoutes.ts | 7 |
| server/routes/auth/userAccessRoutes.ts | 7 |
| server/routes/containers/containerCrudRoutes.ts | 7 |
| server/routes/factory/bales/balesReportRoutes.ts | 7 |
| server/routes/factory/customer-orders/orderCrudRoutes.ts | 7 |
| server/routes/factory/factoryInsuranceRoutes.ts | 7 |
| server/routes/factory/factorySheetsAndSacksRoutes.ts | 7 |
| server/routes/factory/factorySheetsRoutes.ts | 7 |
| server/routes/notificationRoutes.ts | 7 |
| server/routes/passkeyRoutes.ts | 7 |
| server/routes/payroll/advanceManagementRoutes.ts | 7 |
| server/routes/payroll/worker-stats-advances/deductionsRoutes.ts | 7 |
| server/routes/sp/spContainerRoutes.ts | 7 |
| server/routes/stockAdjustmentWasteRoutes.ts | 7 |
| server/routes/transporterStatementRoutes.ts | 7 |
| server/routes/vouchers/voucherQueryRoutes.ts | 7 |
| server/routes/accountStatementRoutes.ts | 6 |
| server/routes/accountTransactionPaginationRoutes.ts | 6 |
| server/routes/admin/import-export/accounts.ts | 6 |
| server/routes/baleTransferRoutes.ts | 6 |
| server/routes/businessAlertsRoutes.ts | 6 |
| server/routes/containers/containerTrackingRoutes.ts | 6 |
| server/routes/factory/customers-core/crud.ts | 6 |
| server/routes/factory/customers-core/logos.ts | 6 |
| server/routes/factory/employee-pos/employee-crud/crud.ts | 6 |
| server/routes/factory/employee-pos/employeeLedgerWasteRoutes.ts | 6 |
| server/routes/factory/employee-pos/wasteDispatchBandwidthRoutes.ts | 6 |
| server/routes/factory/factoryArabicTranslationRoutes.ts | 6 |
| server/routes/factory/factoryFrenchTranslationRoutes.ts | 6 |
| server/routes/factory/products/productBulkRoutes.ts | 6 |
| server/routes/inventory-movement/movement.ts | 6 |
| server/routes/offloadRoutes.ts | 6 |
| server/routes/pos/posDraftRoutes.ts | 6 |
| server/routes/remoteKeyboardControlRoutes.ts | 6 |
| server/routes/sp/spExportRoutes.ts | 6 |
| server/routes/stats/statsReportsRoutes.ts | 6 |
| server/routes/stock/groups-items/bulk-ops.ts | 6 |
| server/routes/stockTransferImportRoutes.ts | 6 |
| server/routes/transfers/companyTransferRoutes.ts | 6 |
| server/routes/vouchers/stockTransferLifecycleRoutes.ts | 6 |
| server/routes/admin/import-export/account-migration.ts | 5 |
| server/routes/auth/coreAuthRoutes.ts | 5 |
| server/routes/auth/sessionRoutes.ts | 5 |
| server/routes/baleLookupRoutes.ts | 5 |
| server/routes/containers/containerFreightReadRoutes.ts | 5 |
| server/routes/employees/erpWorkerDocumentRoutes.ts | 5 |
| server/routes/factory/bales/balesPressingRoutes.ts | 5 |
| server/routes/factory/customer-orders/orderPricingRoutes.ts | 5 |
| server/routes/factory/customer-proformas/proformas.ts | 5 |
| server/routes/factory/dispatch-batches/batches.ts | 5 |
| server/routes/factory/docs-users/daybookEditRoutes.ts | 5 |
| server/routes/factory/employee-pos/pos-financial/production-positions.ts | 5 |
| server/routes/factory/factoryBilingualDocumentRoutes.ts | 5 |
| server/routes/factory/factoryDailyScanRoutes.ts | 5 |
| server/routes/factory/factoryFxRatesRoutes.ts | 5 |
| server/routes/factory/factoryGroundScanRoutes.ts | 5 |
| server/routes/factory/factoryProductionPlannerRoutes.ts | 5 |
| server/routes/factory/factoryRawStockRoutes.ts | 5 |

## Phase 1 completion criteria

- [x] Enumerate every open code-scanning alert on `main` across all API pages.
- [x] Isolate the CodeQL subset.
- [x] Group CodeQL alerts by severity, rule, module, and file.
- [x] Derive Phase 2–7 remediation targets from the live snapshot.
- [x] Preserve normalized per-alert evidence in the JSON companion artifact.
- [x] Do not dismiss, suppress, or weaken any scanner finding.

The JSON companion file is the machine-readable baseline for later phases. Alerts are expected to close through code fixes and fresh CodeQL analysis, not through bulk dismissal.
