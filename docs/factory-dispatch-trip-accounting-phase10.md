# Factory Dispatch Trip Accounting — Phase 10 Release & Accounting Protection

**Date:** 2026-11-10  
**Branch:** `feature/factory-dispatch-trip-accounting-20261110`  
**Status:** Source changes and staged regression scenarios committed. **Not built, runtime-tested, migrated, merged or deployed.**

## Execution rules from owner

No CI checks, no test runner, no SQL execution by assistant, no merge into main and no Render deployment at this stage. Preserve the entire multi-phase implementation on the same feature branch. Owner will manually execute the single final PostgreSQL script in TablePlus later.

## Phase 10 protection work implemented

1. **Manual SQL fail-closed gate.** New `dispatchReleaseReadiness.ts` reads PostgreSQL catalogs and checks all expected physical + financial guards, enabled/forced company RLS, signed reconciliation columns/checks and, for the final invoice, the immutable invoice trigger, unique invoice index and final-voucher immutability triggers. It makes no DDL/data changes. Every signed reconciliation and consolidated invoice action refuses to proceed with `503 FACTORY_DISPATCH_TABLEPLUS_GUARDS_PENDING` and a list of missing safeguards.
2. **Visible readiness and integrity.** Admin/Owner/Developer can access `GET /api/factory/customer-orders/:id/loading-dispatches/release-readiness`; the existing Dispatch Management dashboard shows live read-only status and missing protections with a Refresh button. This endpoint verifies only the active Factory company and selected parent loading.
3. **Financial integrity audit.** Once the final SQL is installed, the same GET returns a read-only per-order audit for:
   - Unique original truck POST references; signed goods, charges, discounts, and existing customer receivable matching the preserved Phase 7 approval.
   - No legacy invoice SALE cache and no `INV-GL` duplicate customer receivable.
   - One combined invoice ID matching the original customer order, final total = existing trip receivable + original charges, and explicit proof that old receivables were not reposted.
   - Unique signed bale IDs, correct combined shipped-bale count, and SOLD stock status only for signed shipped bales.
   - The clearing journal debiting Factory Dispatch Clearing and crediting Factory Bale Sales Income with **zero customer debit**.
   - The optional cost voucher debiting COGS, crediting Factory Finished Goods and touching no customer account, only when an active cutover required it.
   - Active final invoice voucher IDs and original charge-to-voucher links.
   - **Discrepancies are flagged, NEVER automatically adjusted.**
4. **Actual original voucher validation.** Phase 7 no longer accepts original truck POSTs merely because their voucher IDs still exist: it verifies the precise signed FDTR voucher's Factory customer debit, goods clearing credit, source fingerprint and unchanged posting amount; any reversal makes approval fail. A legitimate zero-value posted trip can have no voucher without generating invalid SQL.
5. **Correct batch correction.** An unshipped bale can only be released when it is currently linked to the original loading, never scanned or financially posted, and in a legitimate stock state: legacy `RESERVED_FOR_ORDER` or V5 `IN_STOCK`. Shared links to another active loading block the release. The entire approved correction stays atomic. A signoff upsert that returns no row is now treated as a conflict, not falsely reported as successful.
6. **Post-finalization original charges.** The final invoice now includes **all** valid original loading charge voucher IDs (already posted earlier as well as newly posted) in the immutable final receipt. Reusing one old voucher as multiple distinct loading charges blocks finalization.
7. **Immutable final commercial source.** The Phase 8 manual SQL now also protects finalized original invoice identity, date/currency/totals, its commercial invoice lines and the exact signed SOLD bale status/article/reference/weight/cost from generic historical edits. Only unrelated metadata may change, preserving the existing workflow where appropriate.
8. **Immutable final vouchers.** The staged Phase 8 TablePlus script now installs additional triggers protecting the combined invoice's new clearing, COGS and original charge vouchers, voucher entries and accounting posting identities from generic edits/retirement after finalization. Phase 4 protection already guards the original individual truck FDTR/FDTE vouchers.
9. **SQL script syntax correction.** The Phase 4 manual SQL previously had an invalid lone `$` delimiter around its voucher-protection function. This was fixed to balanced PostgreSQL `$$` delimiters and will be included in the refreshed combined TablePlus script.
10. **Regression source staged.** `tests/factory-dispatch-financial-phase10-release.test.ts` documents no-double-posting, SQL quoting, guard presence, amount math, one invoice, original voucher identity, company scope, manual ERP PO workflow, source fingerprint and idempotent finalization. **Not executed**.

## Release gates: all must be explicitly verified before production

| Gate | Required evidence | Current status |
|---|---|---|
| SQL prerequisite | Correct Factory ERP PostgreSQL connection, backup and expected company-scope RLS support | Not verified |
| SQL migration | Single final TablePlus script applied in correct order; stop on any error | Not executed |
| Database security | Enabled/forced company RLS, immutable financial posts, signed source and final voucher triggers | Not runtime-verified |
| Backend validation | TypeScript build/import paths, HTTP route manifest, no duplicate handlers | Not executed |
| Accounting | Test order ledger sums, clearing balance, existing customer receivable, costs, source vouchers | Not executed |
| Concurrency | Two simultaneous signoffs, two finalizations, retries after timeout, concurrent bale scans/edits | Not executed |
| Stock and charges | Unshipped bales restored once; signed scanned bales SOLD once; no double charge posting | Not executed |
| Normal ERP | Manually imported Factory PO Excel, exact article codes, independent ERP purchase prices, supplier account | Not executed |
| Permissions | Admin/Owner/Developer vs Worker/View Only/Create Only; company isolation; Excel rights | Not executed |
| Invoice documents | One correct PDF/Excel matching signed goods, charges, discounts and final invoice number | Not executed |
| Production release | Approved merge, Render deployment, operational monitoring | Not authorized |

A source-stage implementation is **not production-ready** until the above blockers are resolved.

## Human-led scenario test matrix (controlled staging database ONLY)

**A. Multi-truck physical control**

- Parent Pending Loading has 3 trucks, each scanning only its actual barcode bales; there is **no expected per-truck allocation**.
- Re-scan same bale on another truck -> duplicate/blocked; a bale not in loading -> unexpected/blocked.
- Close truck and sign financial posting; scan attempts, truck edits, replacing posted bale/prices and generic linked voucher editing must be rejected.
- Unshipped bales (never scanned on any truck) -> supervisor selects exact links, reason, atomic return to stock. Inject one invalid/posted/SOLD bale in the batch: **zero links removed and zero stock state changed**.
- Before and after signing, concurrent truck reopen/change/scan should fail to modify immutable evidence.
- One signoff fingerprint/one consolidation per parent loading; rerun same fingerprint is idempotent; altered fingerprint is rejected.

**B. One combined Factory customer invoice**

- For each posted trip, inspect the original FDTR journal: Dr actual customer ledger once; Cr goods to Dispatch Clearing; extra billable charges to correct income; discounts to correct contra account. Internal trip expense creates its own FDTE debit/credit, not customer receivable.
- Sum customer-facing truck POST vouchers. Add only original order charges **not already counted in trip postings** to arrive at one invoice total. Preexisting original charge vouchers must not be posted again.
- Sign all-trucks reconciliation, click **Finalize one combined invoice**, verify one invoice ID and exactly the signed shipped bale count.
- Validate **Dr Dispatch Clearing / Cr Factory Bale Sales Income** for goods only, with **no customer entry**. Confirm clearing attributable to this loading is zero after finalization, considering its original truck credits.
- Under active perpetual cutover verify **Dr COGS / Cr Finished Goods** for the precise signed bale cost summed at original 7-decimal cost precision then rounded once to cents. Test pre-cutover separately: no COGS voucher.
- Original charge vouchers must remain live, linked and protected. Confirm no `INV-GL` duplicate sale journal and no extra `customer_balances SALE/INVOICE` row.
- Refresh or repeat POST finalize, including retries after an intentional lost response: return original invoice number and voucher IDs without a second invoice, sale, charge, clearing transfer or COGS entry.
- Try ordinary `/finalize` and `/unfinalize` on dispatch-managed loading: blocked.
- Try delete/edit signed reconciliation and final clearing/COGS/original charge vouchers via generic editors: blocked.

**C. Normal ERP manual PO receipt**

- Export individual trip Excel after pricing the ERP supplier purchase independently of the Factory customer sale amount. `Item_Barcode` is the **article code**, not bale reference.
- On Normal ERP PO Import, verify exact supplier code, case-sensitive/alias article match, integer shipped qty, purchase rates/charge totals in USD and one canonical origin per file.
- Attempt double import under a new filename, bad article alias, changed supplier, different rates and cross-company source identity: block appropriately.
- Interrupt purchase import after source identity reservation: receipt remains `PENDING_REVIEW`, no unsafe retry or fabricated success. Reconcile any existing ERP stock/vouchers manually.
- Generated Factory PO Excel must NOT show ERP receipt as confirmed; ERP supplier ledger changes only when the operator actually completes Normal ERP manual import.

**D. Permission & date edge cases**

- Worker cannot view charge rates, customer receivables, final invoice action or release integrity; View Only cannot finalize or remove bales; a user in another company cannot read this order or its audit.
- Excel permission `exp_excel` is required in addition to Factory role for the multi-sheet finance workbook.
- Invoice posted on period boundary: use business date and verify closed-period refusal, inventory cutover transition and no unexpected UTC day rollover.
- Concurrent 2-admin finalize submissions must result in one invoice number and one set of new vouchers; server transaction/row locks must serialize.
- Audit history pages list complete original physical, financial and closure events with stable cursor, no mixed-company records. 1,000-event Excel limit must be explicitly labeled.

## SQL handoff — owner will run later

**SINGLE script:** `docs/sql/manual/2026-11-10-factory-dispatch-all-phases-tableplus.sql`

Order inside it: Phase 2 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8 plus the Phase 10 strengthening incorporated into the staged Phase 4 and 8 definitions. **Phase 9 and Phase 10 require no additional separate migration files.**

Important: some RLS prerequisites are expected from earlier ERP migrations. Check that `erp_company_scope_matches(integer)` is available, confirm you are connected to the correct database, and take a verified backup before applying. Do not blindly continue after the first SQL error.

The assistant **has not run the SQL** and must not assume an empty or ready production database.

## Deployment / rollback preparation, no actions taken

- Prior to merge: compare the feature branch against the *current* `main`; resolve only necessary conflicts and record the exact approved commit. Do not skip required permission or financial safeguards even if CI is disabled.
- Prior to Render release: verify manual schema readiness and controlled staging end-to-end posting results. Confirm backup, correct branch, correct Render service, environment variables and feature access.
- During release: perform staged smoke checks of loading scanner, trip POST, all-truck approval, combined invoice, full PDF/Excel, manual ERP PO export/import and accounting integrity dashboard before enabling unrestricted users.
- If a deploy fails **before any new transaction posts**, roll back the application release while leaving the additive schema migration in place if compatible (after DBA review).
- If *any* financial posting occurred, **NEVER** fix it by dropping tables, deleting vouchers, editing signed originals, replaying the failed POST blindly or reversing the underlying SQL migration. Freeze the affected workflow, preserve audit evidence, compare the original voucher IDs and reconcile through a specifically approved compensating accounting procedure.
- Only request merge and Render deployment once the owner authorizes it explicitly.

## Current completion boundary

Phase 10 implementation, manual release diagnostics, immutable final vouchers/orders/lines/bales protections, staged tests and operational instructions have been committed. **No SQL, CI/tests, merge to main or Render deployment has occurred.** This is a source-stage completion with unverified runtime behavior; it cannot be represented as a production-ready financial release.
