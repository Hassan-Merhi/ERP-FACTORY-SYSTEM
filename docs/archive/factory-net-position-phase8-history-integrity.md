# Factory Net Position — Phase 8 historical data integrity, coverage, and optimization

**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Single branch:** `feature/factory-net-position-historical`  
**Status:** Phase 8 source implementation committed. **No live database sampling, migrations, indexes, CI, tests, merge, rebase or deployment executed.** Actual financial certification requires separately approved read-only comparison and Phase 9 testing.

## Purpose and boundaries

Phases 1–7 implement the *company-local end-of-business-date* financial snapshot based on both `effective_date` and `created_at` / event-recorded time. Phase 8 adds measurable evidence coverage, documented nonfabricating legacy reconstruction policy, stricter report invariants, a reviewable SQL index plan, and a read-only comparison worksheet.

**Do not create or edit production accounting vouchers to make an old balance reconcile.** An immutable event missing from the original system cannot be recreated from today's mutable balance alone. Showing `historyCompleteness: "partial"` is intentional and correct until actual prior-version evidence exists.

## Source implementation

### A. Historical evidence coverage (read-only)

New `server/services/factory/netPositionHistoryCoverage.ts`:

- Requires the physical `customer_order_bales.scanned_at` and `customer_order_bales_history.scanned_at` columns *before* the report invokes historical stock/order queries. Those columns are intentionally installed by `server/customerOrderBaleScanAuditBridge.mjs`, not declared by the original Drizzle model. If missing, fail closed with `HISTORICAL_SCAN_AUDIT_SCHEMA_MISSING`. Do not auto-populate old NULLs.
- Runs a single scoped, parameterized aggregation of record counts for one company and selected date. Does **not** return user information, financial amounts, passwords, free-text fields, or private contact records.
- Measures legacy cumulative raw-stock receipts lacking individual receipt events, receipts lacking original USD unit prices, undated live/archived scans, known cancellation/restoration ambiguity, missing finalized bale timestamps, current container masters updated after the selected date, manually entered backdated FX rates, rental payments without an original posted-at timestamp, mutable ledger opening balances, and unresolved mix-source ownership.
- For counts the original data cannot prove, describes uncertainty rather than inferring transaction values or treating `updated_at` as proof of a particular change.
- Validates every count is a safe nonnegative integer; bad or missing SQL results fail closed.
- Returns `historyCoverage: {asOf, basis: "known-at-cutoff", certified: false, status: "partial", gaps: [...]}`, and appends each finding to `historyWarnings` with the affected record count.
- A zero finding from these ten checks is **not** certification. Not every mutable source has a prior-version log.

### B. Confirmed legacy scan-audit mechanism

`server/customerOrderBaleScanAuditBridge.mjs` contains existing startup work to create the `scanned_at` columns and triggers, preserve scan time on later cancellation, and leave older unsupported scans NULL. This bridge is **not run by Phase 8**. A missing column or NULL provenance is *not* solved by inserting the currently observed date as a historical scan time.

The historical Stock in Hand allocation predicate was brought into agreement with the Phase 5 order scan replay: an existing active row reusing its earlier `scanned_at` after an earlier cancellation must not automatically appear allocated before the undocumented restoration. Archive rows cancelled *after* the selected cutoff still count during their actual earlier active interval. Phase 8 records the ambiguous restoration as a coverage gap.

### C. Historical FX knowledge cutoff

The main Factory Net Position source now filters manual `factory_fx_rates` by both:

- `effective_date <= asOf`; and
- `created_at < next company-local business day` for a historical request.

This prevents an exchange rate entered October 21 with an October 19 effective date from silently changing what was known on October 19. The newest eligible rate is selected deterministically by effective date, creation time, and stable ID. The existing current-day FX behavior is retained. No FX rate is invented when missing.

### D. Historical financial and UI reconciliation

New `server/services/factory/netPositionHistoricalIntegrity.ts` enforces before a historical API response:

- What We Have = signed sum of asset account rows = displayed asset header and grouped asset breakdown;
- What We Owe = signed sum of liability account rows = displayed liability header and grouped liability breakdown;
- Net Position = What We Have minus What We Owe;
- Inventory, Raw Material, Balance on Table and Factory Stock OTW account rows match their individual historical source values;
- Payroll Payable and supplier debt/overpayments match their own displayed, cent-rounded employee and supplier account rows;
- verified/loading/pending order nested sums match the report's source order lists, and verified/loading totals equal their displayed asset account rows;
- nonfinite or mismatched totals raise `HISTORICAL_INTEGRITY_*` so the historical endpoint returns an error rather than copying current-day totals.

The source supplier summary fields are recomputed from the same rounded party rows the user sees, eliminating differences introduced by a separate floating-point subtotal. The normal current-day reporting path is not reclassified or recalculated by this guard.

**Structural reconciliation is not an audit of the underlying source data.** A balance can add up exactly while containing historically unprovable customer, container, product-price or supplier-master edits. The coverage field remains `partial`.

### E. Performance / SQL review, staged but unapplied

`scripts/sql/factory-net-position-historical-indexes.sql` records optional concurrent indexes for company + effective/recorded date filters across receipts, raw stock, mix sources, bales, customer orders, order bale scans/history, recorded order transitions, worker advances/repayments, rent payments and historical manual FX. All statements use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`; this file **was not executed**. The database owner should check duplicate/equivalent indexes, storage and planner estimates before applying each index in a later authorized maintenance window.

`scripts/sql/factory-net-position-historical-readonly-audit.sql` is a **read-only review worksheet** for a separately authorized reviewer, with placeholders for actual factory company ID and its configured timezone. It includes a scan-audit schema prerequisite, Oct 19/20/21 daily comparison of recorded vouchers, partial receipts, bale scans and late FX records, a short list of legacy raw-stock containers lacking a receipt log, and an order lifecycle audit. It is wrapped in an explicitly read-only transaction and was **not run**. Run the schema prerequisite first; if either scan column is missing, do not run scan-dependent queries.

Neither SQL artifact is a migration applied to any live database. No database indexes, audit timestamps, vouchers or business records were created or modified.

## Evidence standard for financial certification

| Area | Historically provable when | Uncertainty / action |
| --- | --- | --- |
| Voucher-backed assets, deposits and loans | Actual booked date, header and entry creation times, reversal dates and original account values are documented | Changed original account openings, edited classifications and hard-deleted voucher history cannot be guessed |
| Employee and worker advances | Employee openings and dated vouchers or worker advance/repayment events survive intact | Changed base amounts or removed repayments without an audit version remain partial |
| Raw Materials | Each receipt, its immutable USD cost, source mix consumption, chronology and adjustments can be replayed | Cumulative legacy `received_kg`, missing FX, unowned source or ambiguous event ordering need original documentation |
| Stock in Hand | Press/stock-entry times, original bale cost/price, scan/cancel/restore events and return/removal dates exist | Undated scan, changed catalogue prices, removal without timeline or edited bale cost remains provisional |
| OTW | Planned weight/price/charges have historic versions; every receipt has a dated increment | Later changes to planned amounts and freight are not recovered by reversing current amounts |
| Pending / Loading / Verified orders | Scan amount and loading/verification/finalization event recorded time is known | Backdated entered verification, undated restore and edited selling price cannot be treated as an original event |
| Supplier debt and overpayments | Opening amount, currency, broker relationship, payments and FX have historical versions | Current supplier relationships or mutable cost/amount history cannot certify old positions |
| Prepaid Rent | Monthly expected amounts, payment posting, voids and contract dates are preserved | Later edits, expired/reactivated contracts without a timeline are provisional |

## Phase 8 completion limits

Source implementation and safeguards are committed, but **historical balances are not independently certified**. No external production database was accessed to quantify actual missing rows, no indexes were executed, and no old accounting data was corrected. A complete reconstruction is mathematically impossible where no relevant old event or value was retained. Such cases must stay partial and be listed for human evidence-based review, not fake-completed.

Do not make `historyCompleteness = "complete"` merely because sums reconcile. Exact source accounting must be independently checked by owner-approved business-date snapshots before declaring completion.

## Deferred tests and Phase 9 handoff

`tests/factory-net-position-phase8-evidence-integrity.test.ts` documents coverage count validation, explicit partial status, fiscal row reconciliation, and fail-closed mismatches in OTW, supplier, payroll, invoice/order and category totals. **Not run** per user instruction.

In Phase 9, Claude should:

1. Run TypeScript/static, unit and integration checks in its approved CI environment and inspect reports for breaking regressions in today's Factory Net Position.
2. Confirm the audit bridge columns are installed in the designated database. Never backfill NULL `scanned_at` with row import/creation time without original evidence.
3. With approved read-only access, compare Oct 19, 20, 21 across all categories and exact party/container/order IDs. Confirm period-end business date and recorded-at timezones, including an Oct 21-entered voucher/FX value with Oct 19 effective date.
4. Determine which older opening balances, supplier/broker relationships, bale prices and rental charge edits can be supported by immutable original records or invoices. If not, retain `partial` and cite the exact source gap.
5. Verify sums of all nested and top report rows in cost and selling modes against independently reconstructed source ledgers and records. Avoid validating one derived output against itself as proof of accounting accuracy.
6. Review `EXPLAIN (ANALYZE, BUFFERS)` only on a safe designated environment under separate approval before deciding which optional indexes are worth building.
7. Do not merge, rebase or deploy automatically. Await the user's explicit instruction after Claude's verification.

**Restrictions honored:** one feature branch only; no CI/tests, merge, rebase, deploy, migration execution, index creation, or production accounting voucher/source-data mutation.
