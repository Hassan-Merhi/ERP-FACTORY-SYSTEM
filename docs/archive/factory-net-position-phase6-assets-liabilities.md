# Factory Net Position — Phase 6: Historical Assets, Rent, Deposits, Loans and Worker Advances

Branch: `feature/factory-net-position-historical`  
Status: **Source-code implementation committed**; not CI-tested, not executed against production data. No merge, rebase or deployment.

## Historical date contract

Phase 6 extends the shared `FactoryNetPositionAsOf` from Phase 2. The owner requested a *known-by-that-date* view: both the effective date and the actual recorded timestamp must be on/before the company-local end of the selected date. The current-day results are deliberately unchanged.

## Implemented

1. **Historical operational asset/liability service:** new `server/services/factory/netPositionHistoricalAssets.ts` exposes `computeHistoricalFactoryAssetLiabilityOperations(companyId, scope)`. It performs read-only queries and returns dated rental and worker-advance balances with explicit historical confidence warnings.
2. **Worker advances:** queries only `factory_worker_advances` with `advance_date <= asOf` and original `created_at` through cutoff. Individual `factory_advance_repayments` require BOTH `repayment_date <= asOf` and `created_at` through cutoff. Per-advance value = max(original amount − cumulative eligible repayments, 0), in exact Decimal money, aggregated per advance. It does **not** use current `remaining_balance` on historical dates. It does not create, edit or delete advances, repayments, or vouchers.
3. **Rent asset from the landlord's FACTORY module:** queries only units and contracts that existed and started by the cutoff. Unlike the live source, does not exclude an old contract simply because it is `EXPIRED` or `INACTIVE` today; property units similarly need not still be active. This preserves earlier balances from units subsequently disabled or contracts subsequently terminated.
4. **Dated monthly rent:** `property_monthly_ledger` entries require source `created_at` through cutoff. The existing rental billing-day helper computes whether each month's expected charge was due by selected date. A future-created monthly ledger row cannot increase an earlier balance even if its billing period was backdated.
5. **Dated rental payments:** `property_payments` require `payment_date <= asOf`, row `created_at` before cutoff and—when available—`posted_at` before cutoff. Current `SCHEDULED` rows are not treated as posted. A payment created on October 19 but posted on October 21 cannot reduce October 19's tenant balance. Historical voids lacking their own void time are explicitly uncertain.
6. **Rent valuation:** preserve the current Factory Net Position reporting convention `SUM(ABS(expected − posted))` **per contract**; do not net different tenants against each other. The report historically labels this aggregate `Prepaid Rent` / rental asset; the report's existing `rentPayable = 0` remains unchanged (this is not a change to the underlying rental accounting policy).
7. **Other ledger assets:** historical `ledger_accounts` now require actual account `created_at` before cutoff, and an account deleted *after* cutoff can remain visible in the earlier snapshot when `deleted_at` is present. It is no longer possible for an account first created October 21 to appear in October 19, even if its current opening balance is nonzero.
8. **Liability deposits and loans:** preserve `classifyNetPositionAccounts` exactly as used in the ERP/Factory report: debit-signed liability/deposit accounts go to What We Have, credit-signed liability and loan accounts to What We Owe; no duplicate operational liability injection. The parent route already filters voucher business/effective date, voucher creation time, entry creation time and deletes from Phase 3. Phase 6 additionally filters account masters, so both opening balances and dated voucher movements belong only to historically existing accounts.
9. **No double count:** keep the exclusions for stock/clearing accounts, operational prepaid rent ledger duplicates, worker advance ledger duplicates, customer account allocations, deferred rent revenue, employee payable duplication and supplier payables handled separately.
10. **Integration and error handling:** only historical as-of requests call the new service; current report code path and rental/worker-advance computations remain intact. The new source totals feed the same asset and liability rows, What We Have/What We Owe and Net Position formula. Errors raise `HISTORICAL_NET_POSITION_ASSETS_FAILED` so the main API returns structured HTTP 503 instead of presenting today's values under an older date.
11. **Historical warnings:** source metadata exposes mutable rent expected amounts, undated historical rent status transitions, missing `posted_at` on old rent payments, void timestamps that do not exist, edited advance amounts/deleted repayments and ledger account master/opening balances without saved prior versions. Existing `historyCompleteness: partial` remains intentionally unchanged.
12. **Authored, not executed:** `tests/factory-net-position-phase6-assets.test.ts` captures exact-money advance replay, repayments that cannot make the asset negative, per-tenant absolute rent balances and decimal rounding. CI and tests are intentionally deferred to Claude.

## Boundaries: what the historical snapshot still cannot prove

- Account opening balance and `account_type`/`sub_type` are *current mutable fields* with no complete prior-version log. If someone edits a loan's original opening balance after October 19, the historical row could still reflect that edited opening. This is surfaced as a limitation and should be addressed in Phase 8, not invented by reversing today's values.
- The independent `fixed_assets` register has purchase dates, recorded creation dates, currencies and depreciation settings. However, the existing Factory Net Position's shared classifier *intentionally excludes Fixed Asset account types* and does **not** add the `fixed_assets` register directly. Phase 6 preserves that policy to avoid changing today's Net Position or double-counting registered property/vehicles. If including registered fixed assets in Net Position is a desired valuation-policy change, that is separate from adding the historical filter.
- A changed contract status (active, expired, terminated, reactivated) has no full lifecycle record; eligibility is reconstructed from its original creation/start date. Closed contracts are not silently discarded, but that is not sufficient proof of the exact status on every earlier day.
- Historical monthly rent expected amounts and original worker-advance amounts can be changed after creation with no complete previous-version record. Past `VOID` transitions and deleted/recreated repayment records are also not guaranteed reconstructible.
- No independent, comprehensive valuation of all registered assets, depreciation schedules, or revenue-recognition changes has been added. Those must be grounded in recorded schedules/vouchers and an approved accounting treatment, not assumptions.

## Phase 7 and Phase 8 handoff

**Phase 7 — UI and reconciliation:** confirm the date selection updates all nested group rows, all optional hidden-account custom totals and side panels, worker advances and rental assets; preserve cost/selling toggle; ensure What We Have = sum asset rows and What We Owe = sum liability rows. Verify absence of future-created account masters, tenant contracts and worker advances in earlier snapshots.

**Phase 8 — historical integrity:** inspect live DB records and edit histories where available, measure opening balance/contract/advance edit coverage, reconcile rent and loan/deposit balances against independent source vouchers and contracts, and design evidence-based backfills or a timestamped forward-looking event log when old history is irrecoverable. No fabricated vouchers, phantom offloads, synthetic rent payments or guessed asset values.

### Concrete future acceptance cases (for Claude, not executed)

- A ledger asset, liability deposit or loan account created on October 21 with a backdated opening does not exist in the October 19 report.
- A deposit/loan voucher actually entered October 21 with effective date October 19 must not appear on October 19; October 21 should include it, subject to posting validity.
- An October 19 worker advance of $100, $20 repaid October 20 and $30 repaid October 21: historical balances are $100, $80, $50.
- An advance **created** October 21 with advance_date October 19 must not exist on October 19.
- A tenant contract terminated October 21 can still contribute its documented October 19 expected/paid amount.
- A rental payment dated October 19 but posted October 21 does not alter October 19.
- Rent balances are calculated per contract, then absolute values summed; $50 receivable plus $20 tenant credit = $70, not $30.
- Confirm all dated customer/supplier/stock values from Phases 3–5 continue to be accounted for exactly once.
- No writes to production accounting, asset, rental, employee or worker-advance data when switching `asOf`.

No CI, test execution, main merge, rebase, deploy or production DB mutation occurred.
