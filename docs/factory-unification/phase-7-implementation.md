# Factory Unification — Phase 7 Implementation Record

**Date:** 2026-11-09
**Branch:** `factory/unification-8-phases-2026-11-09`
**Status:** SOURCE CONSOLIDATION COMPLETE — FINANCIAL/RUNTIME PARITY NOT VERIFIED

## Implemented changes
1. `FactoryNetPositionDetails.tsx` now imports the **same** `shiftDate` and `formatDateLabel` already used by `FactoryNetPosition.tsx` from `factorynetposition/utils.tsx`. Removed duplicate date-shift/label implementations without changing current/historical API requests, chart values, or company-specific cache keys.
2. New `shared/factoryReportDateRange.ts`: pure supplier report filter defaults based on the Beirut business calendar, calendar-day shifting with ISO validation and a start <= end validation predicate. Does not determine the historical accounting cutoff.
3. `FactorySupplierReport.tsx`: supplier report initial date filter uses stable Beirut date-only strings instead of locale-dependent `toLocaleDateString("en-CA")`; export range validates real dates and ordering. Supplier query cache keys remain URL-first and are scoped to its explicitly selected report company. Report POST contract/format remains unchanged.
4. `tests/factory-unification-phase7.test.ts`: characterization for Beirut midnight and date shifting, report range ordering, and the existing `factoryNetPositionAsOf` company's timezone and future-date rejection. Test file created but **not run**.
5. GitHub source files were fetched after writing to inspect committed imports, helper use and preserved backend as-of contracts.

## Accounting contracts explicitly retained
- `shared/factoryNetPositionAsOf.ts` and `server/services/factory/netPositionAsOf.ts` already implement **company-local inclusive effective dates** and **recorded-by-cutoff** historical semantics, including UTC fallback when the company's timezone is missing/invalid. They remain unchanged.
- Existing historical pipeline, inventories, assets/liabilities, report totals and historical completeness/warning evidence remain unchanged. Historical reports must disclose partial coverage; never silently substitute today's balances for unavailable past evidence.
- No alteration of the historical source evidence, supplier-average costs, six-decimal inventory valuation, multi-currency FX, voucher reversals, posting timestamps or accounting journal totals.
- No account/vendor/customer ledger writes, backfills, schema migrations, SQL migrations, or output value recalculations.
- `FactoryLoadingDispatchReport.tsx` already distinguishes live reports and immutable closed snapshots with dedicated Excel export. It remains unchanged. A frozen closure must not be regenerated from mutable live state.
- `server/routes/factory-reports/supplier-usage.ts` remains the authority for report generation and company authorization.

## Manual/non-CI verification required for full acceptance
- Run TypeScript and focused Phase 7 tests in a runnable checkout; these were **not executed**.
- Compare Net Position main/details (today, one-day past, month boundary and company timezone) against existing server `known-at-cutoff` snapshots. Check partial history warnings and historical report completeness.
- Verify Supplier Usage Report UI filters and PDF/XLSX exports for company selection, DST, invalid ranges, zero rows and cross-company access.
- Compare historical valuation at cost/selling, supplier-average costs, partial offload, payroll, invoices/vouchers and FX using controlled fixtures.
- Verify historic dispatch closures against signed manifests; no live recomputation of a closed record.

**Completion statement:** Phase 7 source-level reporting presentation and filter harmonization complete. This is **not** a signoff of all financial/operational historical parity or production deployment.

**Branch rule:** All commits remain on the one unification branch. No CI run. No merge to main.
