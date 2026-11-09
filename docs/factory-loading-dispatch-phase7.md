# Factory Loading Dispatch — Phase 7: Reports, manifests and exports

**Branch:** `feature/loading-dispatch-verification-20261109`

This phase completes the seven-phase Factory container dispatch **Option A:
verification only** implementation. None of the Phase 7 read/export routes
write to the main loading, inventory, invoices, proformas or ledger. The
existing End Dispatch workflow is extended to freeze the physical manifest.

## Delivered report pages

The Factory UI now has:

- `/factory/sales/loading/dispatch/:orderId/report` — **overall container
  dispatch reconciliation**: all truck trips and combined physical
  verification against currently loaded bale references.
- `/factory/sales/loading/dispatch/:orderId/:dispatchId/report` — **truck
  dispatch manifest**: one truck's physical barcode evidence, expected vs
  actual article lines, discrepancies, KG and operator/time.
- Historical frozen closure: append `?closureId=<id>` to the truck report
  URL. A **Print saved manifest** action is provided beside each closure
  revision in trip history.

Every report screen includes:
- **Print / Save PDF** — browser print with A4 landscape stylesheet, repeated
  table headers and all manifest/discrepancy rows (no "first 30 only" truncation
  on printed barcode lists).
- **Export Excel** — native server-generated `.xlsx` workbook; no image
  screenshots or CSV substitution.
- **Refresh** — live report refresh where relevant.
- Clearly identified **LIVE VERIFICATION** vs **SIGNED CLOSURE RECORD**.
- Loading/container number, company, customer, linked proforma, driver,
  truck, opened/closed operator/date, approval reason, per-article comparison,
  missing/extra references, wrong-truck warnings and latest audit activity.

Navigation:
- **Reports & Excel** in Dispatch Management (overall or the selected trip).
- **Print / Export** on Compare All / Compare This Trip.
- **Print saved manifest** for each finalized/reopened closure revision.

## Authenticated read-only reporting endpoints

All endpoints require the same Factory Invoicing / Loadings tab permission and
scope `company_id` plus order / dispatch IDs before reading.

- `GET /api/factory/customer-orders/:id/loading-dispatches/reports/overall`
- `GET /api/factory/customer-orders/:id/loading-dispatches/reports/overall.xlsx`
- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/reports/manifest`
- `GET /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/reports/manifest.xlsx`

Truck endpoints also accept `?closureId=<positive numeric ID>`, scoped
to that same truck/order/company.

Report queries reuse the Phase 4/5 pure comparator inside a
`REPEATABLE READ, READ ONLY` database transaction for consistent figures.
There are no mutations on report GET or XLSX download requests.

## Excel workbook contents

The multitab workbook contains:
- **Summary** — source, company, customer, proforma, container, truck, operator,
  approval, closure revision, KG and bale KPIs, export generation time and
  warnings.
- **Truck Trips** — per-truck bales, weights, statuses (overall reports only).
- **Article Comparison** — expected/scanned/matched/missing/extra quantities
  and KG differences.
- **Verified Bales** — each physical barcode, article, weight, operator and
  scan timestamp, with truck number.
- **Missing Bales**, **Unexpected Bales**, **Wrong Truck**, optional
  **Duplicate Anomalies** — individually referenced discrepancies.
- **Audit Trail** — up to 10,000 most recent dispatch events, with an explicit
  warning when truncated.

The workbook uses frozen headings, autofilters, numeric cells, row shading,
safe filenames, and escapes formula-like user-supplied text. It uses the
project's existing `exceljs` and buffered
`writeWorkbookToResponse` export helper, including the heavy-export
concurrency slot. No package/lockfile change is needed.

## Historical closure integrity

Phase 6 already stored an immutable comparison snapshot for every closure.
Phase 7 adds idempotent startup schema columns:
`factory_loading_dispatch_closure_history.manifest_snapshot JSONB` and
`truck_snapshot JSONB`.

Every new End Dispatch transaction now captures:
- the active scan manifest (barcode, bale ID, article, product, weight,
  scanner and timestamp) **at close time**;
- the truck's plate/driver/destination/notes/container snapshot;
- the existing frozen comparison, summary, discrepancy approvals and
  immutable closure revision.

A reopened trip may be scanned and closed again, creating another frozen
revision. Downloading a previous revision presents its **original** bale
manifest and truck details, not current rows that may have changed.

**Backward compatibility:** Closures created before Phase 7 do not contain
bale-level frozen manifests. They still expose their saved historical
comparison. The report states explicitly that the historical bale manifest
was unavailable instead of substituting potentially inaccurate current scans
or presenting an empty set as an actual zero-scan closure.

## Manual QA / future CI checklist

1. Create multiple open trips for one loading; open the overall report and
   check loading bales vs verified across all trips.
2. Open one trip's report and confirm truck/container identity, article
   comparisons, reference/weight/operator/time for every scan, including
   multiple pages in browser Print.
3. Export Excel, open every worksheet and check quantity/weight numeric cells,
   tab names, real `.xlsx` bytes, and printable headers in dark/light mode.
4. Scan on another open truck while generating a report; ensure a
   transactionally consistent count and no posted stock/accounting changes.
5. End with discrepancies using a supervisor approval and reason; confirm
   summary, manifest and truck details are frozen.
6. Reopen, change driver and scan more bales, close again; verify closure #1
   and closure #2 independently preserve their original scan/driver records.
7. Simulate an older Phase 6 closure with null manifest snapshot. It should
   display its historical comparison and a clear "manifest not archived"
   notice, never current scan rows as historical evidence.
8. Check cross-company/order/trip/closure access, invalid IDs, and View Only
   report reads through Factory Loadings authorization.
9. Check spreadsheet formula injection using a driver/name beginning with
   `=HYPERLINK(...)`; ensure it is a literal string cell.
10. Check 10,001+ event export and explicit Audit Trail limit warning.
11. Compare report results with live Compare All and each trip comparison for
   the same instant, including missing exact barcodes and wrong-truck scans.

New staged regression source:
`tests/factory-loading-dispatch-report.test.ts` (workbook tabs and cells,
numerical weights, signed closure metadata, formula escaping and older
manifest fallback).

**CI, tests, build, merge and Render deployment were NOT executed**, per
the user's instruction. The branch was updated only; production remains
unchanged. Run app-level authorization, runtime DB migration and Excel
download tests before merging/deploying.

## Implementation status

- Phase 1: company/order-linked schema and access.
- Phase 2: Dispatch button, trip dashboard and editing.
- Phase 3: exact-bale physical verification scans and audit.
- Phase 4: per-trip and loading-wide comparison.
- Phase 5: expected truck allocation, priority-informed assignment.
- Phase 6: End Dispatch, supervisor discrepancy approval and reopening.
- Phase 7: printable report, native Excel, saved physical manifest and
  historical closure export.

All seven phases remain on the **same feature branch** pending CI and
release authorization.
