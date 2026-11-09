# Factory Mix Batch Cost Integrity — Phase 2: Safe Editing and Source Review

**Branch:** `fix/factory-mix-cost-integrity-20261109` (same branch as Phase 1).  
**Scope:** Backend source-edit validation and preview, editor confirmation, inventory-conserving transactions.  
**Schema changes:** None. **TablePlus SQL:** None.  
**Production data changed:** None. **Deployed or merged:** No.  
**CI/test execution:** Deferred by owner instruction; tests are committed but not executed.

## Changes

### 1. Metadata-only editing does not touch valuations

- Edit name, date, or notes without sending material source arrays. Empty name and notes can be cleared.
- Old clients may still submit unchanged source arrays; those are compared against the persisted **aggregate** source IDs and kilograms and reduced to metadata-only updates. No FIFO reversal and no historical reprice.
- No date changes without valid `YYYY-MM-DD` input.

### 2. Preview before applying actual source changes

- The existing `PATCH /api/factory/mix-batches/:id` accepts
  `sourceEditPreview: true` with `supplierSources`, `batchSources`, `sourceEditReason`, and optional `batchDate`.
- It returns a **read-only** review: previous/proposed weight, previous cost, estimated new cost, estimated delta, whether the change is allowed, an issue list and a `reviewHash`.
- The preview never writes raw stock, accounting, audit, or daybook.
- The editor shows historical saved cost separately from this proposal, requires a reason (10–500 characters) and explicit **Apply Reviewed Changes**.
- A source edit PATCH requires `confirmSourceEdit: true` and the original `sourceEditReviewHash`, matching a fresh server-generated review in the transaction. Any change in the batch, source allocations, raw-stock quantities, upstream batches, supplier locked rates, or proposed date/reason rejects the application as stale.

### 3. Safety during source adjustments

- Apply only to **active/open/carry-forward** batches with **zero already-used kilograms and no downstream bale, pressing or daily-usage links**.
- Completed, closed, consumed and dependent batches remain review-only because their valuation can feed produced/sold bales, GL and historical inventory. Editing those safely belongs with Phases 3–5's controlled reconciliation.
- Reject invalid/duplicate IDs, empty or nonpositive sources, over-precision and nonpositive weight, insufficient inventory, missing supplier USD rates, unavailable upstream batches, self-source references, and legacy sources whose exact original container attribution cannot be proven.
- Revert raw consumption **only on the exact originally recorded container** and only if its current recorded usage is sufficient; no clamp-to-zero and no guessed legacy FIFO credits.
- New supplier allocations use FIFO but must stay within available quantity; the edit no longer forces over-consumption into the last stock row.
- Upstream batch reversal preserves its original lifecycle status; it never forcibly reopens a completed source batch.
- Browser-editable cost overrides are removed. Cost of supplier stock and upstream mix sources is determined only by server-authoritative USD rates/batch valuations.
- The source table, raw-stock quantities, mix header, material-price event, audit before/after snapshots and the existing mix daybook reference are changed in **one transaction**.
- This is a change to the existing *daybook* entry, not a new accounting journal voucher.

### 4. Regression coverage

- `tests/mix-batch-edit-exact.test.ts`: preview doesn't write, reviewed edit succeeds for safe active batch, invalid and stale requests refused, completed/used and downstream-linked batches blocked, inventory shortages and legacy owner mismatch rejected, metadata edit remains safe.
- `tests/mix-batch-edit-source-validation-phase2.test.ts`: valid inputs normalize to 3 decimal places, invalid and duplicate inputs fail, unchanged source payloads stay no-op, fingerprint detects changes.
- Phase 1's historical-source/read cost tests are retained.

## Deferred work

- **Phase 3:** review and approve corrections to historical mix source cost valuation. Historical data must not be mass-repriced from current supplier rates.
- **Phase 4:** repair supplier/container attribution issues and stock quantity anomalies before lifting legacy source protection.
- **Phase 5:** downstream bale and GL recost must be implemented before allowing source edits to already-consumed/completed batches.
- **Phases 6–8:** completion status, proactive monitoring, end-to-end validation and production rollout.

The guard on completed batch source edits is intentional and remains in place.
