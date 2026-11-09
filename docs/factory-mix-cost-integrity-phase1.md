# Factory Mix Batch Cost Integrity — Phase 1

**Branch:** `fix/factory-mix-cost-integrity-20261109`  
**Scope:** Display/reading integrity and protection against silent repricing.  
**Deployment/merge:** Not performed (Phases 2–8 continue on the same branch).  
**Database changes/migrations:** None.  
**CI/tests:** Regression cases added but intentionally **not executed** at this phase by owner request.

## Historical vs current-rate valuation

- The historical cost is `factory_mix_batches.total_cost / total_weight_kg`.
- Historical source details return **stored** `factory_mix_batch_sources.cost_per_kg` and `total_cost`, including genuinely unvalued zero-cost rows.
- Today's supplier locked rate may be shown for a **proposed edit**, but is never substituted for a historical source rate or used to imply that a completed batch was incorrectly valued.
- The same stored total-cost basis is used for the Raw Materials mix list, general Mix Batches list, Batch Detail, read-only Production Overview, by-date reporting, and batch list API display fields.
- The combined blend across batches is `SUM(stored batch total_cost) / SUM(stored batch total_weight_kg)`, **not** the sum of per-batch rounded rates × weight.

## Example: FMB-2026-0231

- Recorded: 15,353 kg / $8,824.7659100 = $0.5748/kg.
- Edit-window current supplier-rate estimate: $8,698.5852 = $0.5666/kg.
- These are different cost bases, not necessarily an accounting error. A supplier rate changed after the dated consumption.
- The UI now labels historical valuation and proposed current-rate estimate separately.

## Protect completed batches before Phase 2

- A name/date/notes-only edit does not submit the source arrays, so it cannot unintentionally reverse/reprice the materials.
- Source changes on `COMPLETED` or `CLOSED` batches are temporarily locked in the editor and rejected server-side with HTTP 409 and code `MIX_BATCH_COMPLETED_SOURCE_EDIT_REQUIRES_REVIEW`.
- Phase 2 must implement the reviewed edit/correction lifecycle; do not remove this guard before an equivalent history-safe implementation exists.
- If a supplier's current rate is unavailable, the proposed current-rate estimate displays **Unavailable**, not a misleading $0.

## Regression coverage added

- `tests/mix-batch-recorded-valuation-phase1.test.ts`: batch and source historical totals, blended-rate separation, zero-cost preservation, weighted aggregates.
- `tests/mix-batch-sources-exact.test.ts`: source GET preserves recorded zero cost and marks historical unvalued rows.
- `tests/mix-batch-edit-exact.test.ts`: completed-batch source repricing blocked; metadata-only updates allowed.
- Existing historical read and export tests stay in place and should be executed with the final controlled verification.

## Deferred to subsequent phases

- Phase 2: safe, auditable, genuinely editable sources/weights and ledger-preserving historical corrections.
- Phase 3: approved historical batch cost reconciliation.
- Phase 4: supplier ownership and raw-stock issues.
- Phase 5: bale/stock/ledger downstream integrity.
- Phase 6: overconsumption/completion lifecycle review.
- Phase 7: continuous diagnostic.
- Phase 8: full verification, CI as requested, merge and deploy after owner approval.

**Never apply a blanket repricing of the 222 completed mixes using current supplier rates.**
