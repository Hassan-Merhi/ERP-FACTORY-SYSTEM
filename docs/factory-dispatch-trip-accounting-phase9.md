# Factory Dispatch Accounting — Phase 9 Report, History & Interface

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Scope:** one order-wide Dispatch Management dashboard, all trips, separate charge ledger, original customer receivables, final combined invoice, manual ERP PO export evidence, paginated immutable audit history and multi-tab Excel report.

**Important:** Code and staged tests are committed on this feature branch. **No CI, tests, SQL execution, merge to main, or Render deployment** were performed. The feature requires the previous manual financial migrations before real financial numbers can be reported.

## Operator experience

In Factory → Pending Loading → Dispatch Management, Admin/Owner/Developer users now see a compact **Order-wide dispatch dashboard** above the existing individual truck cards. All ordinary physical dispatch and scanner tools remain available for their existing roles, but sensitive receivable/charge/account reports are role-gated.

### Order overview

- Parent loading, container, customer and order status, including the single consolidated invoice identity.
- Total trips / completed trucks, active physical scans, distinct scanned bale IDs, unshipped bales and unexpected scanned bale references.
- The **existing posted customer receivable** from the original trip POSTs, shown separately from original loading charges and the **single final combined invoice**.
- Signed reconciliation, approval signer and date, consolidated invoice finalization date, included original trip POST IDs and final invoice voucher counts.
- A clear missing-schema state when the user has not yet run TablePlus SQL. Physical progress remains visible; financial values are **unknown**, not fabricated as zero.
- Manual ERP PO Excel generated count; a file download is never labeled as imported or as a confirmed ERP supplier balance.

### Four report tabs

**Trucks:** one entry per physical trip with physical and financial status, scan count/KG, posted goods, billable charges, discounts, existing receivable and original immutable POST ID. Search by trip number, status, notes, ERP PO or supplier code. Click *Open trip* for its existing detail and manual ERP export.

**Charges:** customer-billable trip charges, discounts, internal expenses and original parent-loading charges all displayed as distinct rows. Each carries the configured ledger account code/name, offset account where present, and existing voucher ID and status. Internal expenses are **not** added to customer totals; original loading charges are not double-counted with previously posted trip charges.

**ERP PO Files:** per-truck PO number, ERP container number, supplier code and generated-at timestamp. Explicitly states *Import not confirmed by Factory*. Opens the **existing** trip PO export workflow. **No automatic import button or cross-company balance write** has been introduced.

**History:** date-descending, cursor-paginated, source-filterable events: physical dispatch scans/events, financially posted or reversed trip / approved order / combined invoice records, and immutable signed closure revisions. Filter by event source and individual truck. Rows expose their original actor, timestamp, reason and detail JSON. History is read-only and may be paged to older entries via *Load older events*, without replacing original evidence.

The dashboard inherits the system's light and dark styling and uses responsive cards for mobile/tablet/desktop.

## Reports and exports

**New read-only API endpoints:**

`GET /api/factory/customer-orders/:id/loading-dispatches/order-overview`

`GET /api/factory/customer-orders/:id/loading-dispatches/order-overview/history?source=ALL&limit=25&cursor=...`

`GET /api/factory/customer-orders/:id/loading-dispatches/order-overview/report.xlsx`

All require authentication and the existing Factory invoicing tab access; sensitive finance reports additionally require Admin/Owner/Developer. Every database query is company- and original-order-scoped, with **REPEATABLE READ / READ ONLY** consistency for a report. The Excel endpoint additionally follows the existing Excel export permission policy.

**Excel workbook tabs:** Order Overview, Truck Trips, Charge Ledger, ERP PO Files, Invoice & Postings, Audit History.

- Landscape page setup, frozen headers, filters, readable amounts, alternating row contrast and safe text escaping to prevent Excel formula injection.
- Audit sheet includes up to the **latest 1,000 events**; if older events exist, the sheet includes an explicit truncation notice. The in-app timeline is paginated without that limit.
- Reuses the existing buffered `ExcelJS` workbook response bridge (not a broken streaming writer).
- The existing *physical* dispatch reconciliation and per-truck manifest Excel exports are retained separately; they still preserve frozen closure snapshots, so Phase 9 reports never overwrite physical history.

## Files added

- `server/routes/factory/customer-orders/loadingDispatchOrderOverviewData.ts`
- `server/routes/factory/customer-orders/loadingDispatchOrderHistoryData.ts`
- `server/routes/factory/customer-orders/loadingDispatchOrderOverviewWorkbook.ts`
- `server/routes/factory/customer-orders/loadingDispatchOrderOverviewRoutes.ts`
- `client/src/pages/factory/FactoryDispatchOrderDashboard.tsx`
- `tests/factory-dispatch-order-dashboard-phase9.test.ts` — staged only, NOT EXECUTED.

## Existing files updated

- `client/src/pages/factory/FactoryLoadingDispatch.tsx`: mount the supervisor dashboard within the existing order Dispatch Management page; no new separate navigation/ERP import workflow.
- `server/routes/factoryRoutes.ts`: static dashboard routes registered before legacy dynamic trip routes.
- `server/services/security/operationalPermissionRoutePolicy.ts`: new Excel workbook requires `exp_excel`.
- `config/route-manifest.json`: records three new routes.
- `shared/schema/factory/dispatch-financials.ts`: **repaired malformed, duplicated Phase 7/8 consolidation declaration** and preserved existing signed/finalized constraints. This was a pre-existing source defect found while inspecting for Phase 9.
- `docs/sql/manual/2026-11-10-factory-dispatch-all-phases-tableplus.sql`: refreshed from the latest current manual Phase 2/4/5/6/7/8 SQL scripts.

## Manual TablePlus SQL

**Phase 9 requires NO new tables, SQL migrations or manually executed code.** It reads the existing physical Dispatch tables and the signed financial tables prepared by the earlier phases.

The **one complete final TablePlus handoff** remains:

`docs/sql/manual/2026-11-10-factory-dispatch-all-phases-tableplus.sql`

Script includes Phase 2 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8. It has not been run. When ready for SQL, use the approved database/backup and prerequisite checks first; do not install or post accounting records automatically.

## Source-stage completion and boundaries

The Phase 9 report API, Excel workbook, client panel and history reader are committed, but **not validated by a live database, browser, unit tests or CI**, by the owner's explicit no-CI instructions. Runtime finance data remains unavailable until the pending TablePlus migrations are installed. No SQL, billing, vouchers, stock changes, PO imports, merge or deployment occurred in this phase.

**Phase 10 remaining:** validate the full end-to-end accounting protection, concurrency, historical documents, permissions and finalized balances against a controlled database, then prepare release/deployment according to the owner's instructions.
