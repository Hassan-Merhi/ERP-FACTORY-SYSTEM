# Pressing Machines — Phase 6: Daily History, Saved Filters and Excel

**Branch:** `feature/pressing-machine-tracking`  
**Scope:** Reporting and user-specific saved views only. No merge, deploy, rebase or accounting changes.

## Delivered

- Factory → Stock Entry → Pressing Machines now includes `Permanent Pressing History` immediately below the camera and local sync status.
- `GET /api/factory/pressing-machines/report` serves PostgreSQL-backed records, not the device IndexedDB offline queue.
- Date presets: Today, This Month, All Time, plus any From/To period. The factory-local date (based on configured pressing timezone; UTC fallback) comes from the report-options endpoint, not the scanning phone.
- Filters: active / voided / all, machine, operator, article code, barcode/reference/name search and shift ID.
- Strict paginated (up to 250 records/page) detailed and condensed views.
- Detail columns: reference, article, name, KG, machine, employee, shift, factory-local date, exact scan date/time (seconds), client capture time, seconds since previous accepted scan on that machine, void/correction status.
- Condensed group: factory-local date + machine + operator + shift + article + active/void state, with bale count, KG, and first/last scan instants.
- Saved report views per user and company: named filters, mode, visible columns and optional default. View names can be updated by saving again. Only its owner can retrieve/delete a saved view.
- XLSX export using the project's ExcelJS-backed helper. It fetches all pages for the **selected report filters**, not just the visible page, and includes styled headings, borders, accepted totals, void totals and frozen headers. Exports are frozen to one server-issued as-of cutoff to prevent new scans from shifting pages.
- Operators can view only **their own** confirmed scan history; supervisor roles (Manager/Owner/Admin/Developer) may see company-wide records, if their Factory tab permission allows access. All APIs use authoritative active-company context; never accept user/company scope from the browser.

## Database guarantees

The existing immutable factory_pressing_confirmations event is the sole reporting source. The report calculates:
- Accepted bale total: count of rows with `voided_at IS NULL`.
- Accepted KG total: sum of their stored `weight_kg`.
- Voided scan total: count of rows with `voided_at IS NOT NULL`, **excluded from accepted KPIs**.
- Seconds since previous: difference between the current server-confirmation timestamp and previous active timestamp on the **same machine**, independent of the report date/employee filters.

Phase 6 adds a non-destructive composite index on (company_id, machine_id, confirmed_at DESC, id DESC) for active rows to accelerate prior-scan lookup. Migration stage 038 follows stage 037, and the versioned SQL migration is journal-registered. No historical confirmation, bale, stock or voucher data is updated.

Production history is permanent on the server. Pending/failed offline scans remain visible only in the Phase 5 local queue until accepted by the server. Their local timestamps are not counted as production confirmations.

## Excel export safety limit

A browser workbook can consume substantial memory. For stability this implementation refuses to create any export of **more than 30,000 detailed rows or condensed groups** in one file; it shows an explicit error instructing the operator to narrow the dates. It never silently drops rows. For larger all-time exports, a future server-streamed multi-sheet export is recommended. The All Time report filter itself remains available without this export limit.

If pressing records are voided by a supervisor during a multi-page export (Phase 8), the query snapshot fixes confirmation-time inclusion but not later correction status. The user should rerun an export after corrections.

## Executed verification (2026-10-27, isolated PostgreSQL 16.15)

`tests/pressing-machine-tracking.database.test.ts`: supervisors see every company record and the summary equals the database's active/voided counts; an operator sees only their own rows and is refused another operator's filter (403); a second company's supervisor sees zero rows; invalid calendar dates and inverted ranges are 400; condensed groups sum to the detailed total; report options return the factory timezone and this company's machines only; saved views are per user and company (another operator cannot list or delete them). Free-text filters are now debounced in the UI. The Excel workbook itself was not opened in a spreadsheet application in this environment; `pressingReportClient.test.ts` covers the page-fetch loop, totals and the 30,000-row refusal.

## Manual verification before merge

- `npx vitest run tests/pressing-machine-phase6-contract.test.ts tests/startup-schema-integrity.test.ts tests/pressing-machine-schema-contract.test.ts`
- `npm run test:frontend -- client/src/pages/factory/pressing-scanner/pressingReportClient.test.ts`
- `npm run check` and `npm run verify:migrations`
- Isolated PostgreSQL test: create confirmed pressing rows for two companies, two operators, multiple machines, timezones and days. Worker cannot see another user; supervisor sees all of their company; company A never sees company B. Confirm count/KG aggregates match accepted rows and voids are excluded.
- Confirm per-machine seconds intervals remain correct when filtering to a single day, operator, or article. Confirm server timezone midnight/overnight boundaries.
- Export with multiple pages and compare counts/weights to report; verify visible columns, styles, Excel file opens without warnings.
- Switch companies and users while history is loaded; ensure previous identity's report/history is not rendered on the new scope.
- Test 30,001-row export returns explicit message rather than incomplete data.
- Verify no stock, production costing, material consumption, or accounting voucher writes.

## Phase boundary

Phase 7 adds configured shifts, downtime events and machine productivity analytics.
Phase 8 adds supervisor corrections and a complete immutable audit workflow.

**Source implementation is not a claim of production deployment or executed CI tests.**
