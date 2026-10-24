# Zambia ZMW — Phase 6 ERP vouchers, journals and parties

**Status: Phase 6 source implementation committed to the same branch; NOT independently verified.** No CI, tests, lint, typechecks or builds were executed. No merge, rebase, Render deployment, production migration or production accounting data mutation was performed.

## Scope delivered

### ZMW schema and historical amounts

- \`shared/schema/erp/vouchers.ts\` and \`client/src/pages/voucher-edit/VoucherEditSchemas.ts\` allow ZMW in voucher currency fields and form types.
- \`server/services/accounting/openingBalanceCurrency.ts\` accepts ZMW per USD for an explicitly supplied historical opening balance, retaining original ZMW amount and locked historical USD base amount separately. Existing balances are NOT backfilled or changed automatically.
- \`server/routes/openingBalanceResolutionRoutes.ts\` verifies the active company is configured USD/ZMW before allowing a ZMW opening-balance resolution.
- \`client/src/pages/accounts/HistoricalOpeningResolver.tsx\` offers ZMW only when configured for the company; it labels the historical-rate direction, isolates fetched opening values and unsaved drafts by company, and requires manual historical-rate review.
- \`client/src/pages/daybook/voucherdetailsdialog/utils.ts\` labels original Kwacha amounts using K and two decimals.

### Approved voucher-date rate enforcement

- New shared \`server/services/accounting/zambiaVoucherRatePolicy.ts\` rejects new ZMW postings without an approved, effective-dated, positive company USD/ZMW rate. It checks the active company, voucher date, future-date refusal, rate and pair, returning a controlled 409 error on mismatches. It never guesses a rate or converts history at a later rate.
- Applied to \`server/routes/vouchers/centralJournalCreateRoute.ts\`, \`server/routes/vouchers/centralPaymentReceiptCreateRoute.ts\`, \`server/routes/vouchers/voucherJournalRoutes.ts\`, \`server/routes/vouchers/voucherPaymentRoutes.ts\`, and the generic \`server/routes/vouchers/voucherCreateRoutes.ts\`. Existing USD and Mali CFA posting conventions remain unchanged.
- Standalone ZMW voucher header \`totalAmount\` is converted to historical USD at six-decimal precision, instead of saving Kwacha as USD.
- The generic voucher-line creator rejects ZMW lines with other transaction currencies and reconstructs original/native amount, historical rate and USD accounting amounts server-side.

### Native amounts on payment, receipt and journal edits

- \`client/src/hooks/useZmwVoucherRate.ts\` requests USD/ZMW as of the selected voucher's own date, with company+date-specific cache keys; never reuses today's rate for a backdated entry.
- \`client/src/pages/Vouchers.tsx\`, \`client/src/pages/vouchers/PaymentDraftAndRateBar.tsx\`, \`client/src/pages/vouchers/journalform/useJournalFormModel.tsx\`, and \`client/src/pages/vouchers/journalform/JournalFormView.tsx\` display the date-specific rate, show missing-rate warnings, and prevent ZMW form submission without a valid rate.
- Existing ZMW journal and payment/receipt editing uses the original voucher's currency and locked rate even if the operator changed the screen currency selection.
- \`client/src/pages/vouchers/useVoucherHydration.ts\`, \`client/src/pages/vouchers/journalform/types.ts\`, \`client/src/pages/voucher-edit/useFormInitialization.ts\`, \`client/src/pages/voucher-edit/VoucherEditHelpers.tsx\`, \`client/src/pages/VoucherEdit.tsx\`, and \`client/src/pages/voucher-edit/VoucherSubmitHelpers.ts\` hydrate and submit original transaction ZMW amounts; historical USD amounts remain in the stored base fields.
- Corrected a source-level issue in the legacy Edit Voucher flow where its payment main leg had already been converted to USD but the contra legs were passed as ZMW. The legacy editor now passes both legs in native ZMW for the server to convert together.

### Fail-closed historical voucher edits

- \`assertLockedZmwVoucherEdit\` rejects changes to posted ZMW voucher currency, financial date or historical rate. The lock recognizes that a correctly stored rate may be padded to 10 fractional digits by PostgreSQL.
- \`server/routes/vouchers/voucherJournalRoutes.ts\` and \`server/routes/vouchers/voucherPaymentRoutes.ts\` recheck the immutable header inside their edit transaction and refuse editing ZMW vouchers with missing original/native amounts or rates, before replacing any lines.
- \`server/routes/vouchers/transfer/with-entries.ts\` refuses unresolved historical ZMW entries; reconstructs USD entry amounts from native Kwacha using original rate; checks conflict between supplied debit/credit and transaction amount fields; stores historical USD voucher totals to six decimals and distinguishes native versus USD daybook amounts.
- \`server/routes/voucherEntryCurrencyEditRoutes.ts\` stops direct edits from changing a posted ZMW line's currency/rate and refuses unresolved native amounts. Such historical repairs require a separately reviewed reconciliation/reversal process.
- Generated engine ROUNDING entries are USD-only even on a ZMW voucher. `assertResolvedZmwVoucherEntriesTx` recognizes **only** a USD line belonging to the company's ROUNDING account with the engine's exact narration; unrelated/missing native lines still block the edit. The journal form, payment/receipt form and legacy editor exclude this synthetic line from user-entered ZMW amounts. This was a source-level fix and requires Claude regression coverage.
- Existing tenant checks, intercompany mutation locks, accounting-period editing controls and audited source paths remain in effect.

### Existing credit/debit notes and party ledgers

- ZMW credit/debit note handling was implemented in Phase 5 via \`server/routes/creditNoteRoutes.ts\` and \`client/src/components/vouchers/CreditNoteTab.tsx\`: historical rate and original ZMW refund amounts are captured for reviewed notes.
- Customer/supplier/ledger voucher entries already have currency-aware fields. Phase 6 changes ensure ZMW vouchers route to these existing posting structures with native ZMW and historical USD amounts instead of creating separate Zambia ledgers.
- The current accounting codebase also has open-item allocation and realized FX recognition modules on independently advancing \`main\`: \`server/services/accounting/partyOpenItemService.ts\` and \`server/services/accounting/realizedFxService.ts\`. They were **not cherry-picked, merged, rebased or activated on this feature branch**. At final integration, Claude must reconcile the branch with current \`main\` safely and verify matched ZMW charges/payments, partial allocations, FX gain/loss and double-posting prevention.
- **Do not claim automated realized FX gains/losses are fully wired for Zambia.** Exact settlement allocation and approved realized-FX recognition must be verified before release. Never create a guessed FX journal solely because invoice and payment rates differ.

## Accounting invariants

1. Zambia is company 19, parent HADI L'SHI company 1, with USD accounting base and optional ZMW transaction/display currency. Neither setting nor any rate was changed in production.
2. Existing posted sales, journals, openings, customer/supplier balances, inventory costs and accounting history are untouched.
3. For a new ZMW transaction, native debit/credit remains original ZMW, voucher/entry historical base is USD computed once from the **approved rate effective on the voucher date**.
4. The voucher's stored date, currency and rate cannot be silently changed. Existing ZMW records missing native fields are blocked from edits until reviewed.
5. Foreign currency is not converted as USD at 1:1 because a rate is missing.
6. The independent Mali USD/CFA workflows remain coded as before. Tests are deferred to Claude.

## Claude verification / release blockers — NOT RUN

- Typecheck, lint, build, all CI, unit, integration and E2E tests on the complete implementation branch.
- Full Zambia cash/credit POS to customer/vendor postings; ZMW journals and optional vouchers; supplier bills and payments, receipts, returns and credits; edit permissions and closed periods.
- Correct USD/ZMW historical rate locking, 6dp rounding, debit=credit in USD, native amount parity, system ROUNDING lines and factory-daybook mirrored values.
- Explicitly check synthetic USD rounding lines on ZMW vouchers: editors should distinguish generated balancing lines from user-entered native ZMW lines. A ZMW voucher with a generated USD rounding line must not be mistakenly treated as an unresolved native line, nor stripped or incorrectly converted on edit.
- Verify customer/supplier open-item allocation and recognized FX differences using the latest accounting modules; ensure no duplicate FX adjustment or retroactive invoice repricing.
- Legacy Edit Voucher payment, journal, credit-note and direct-line edit behavior, including prevention of re-dating, unsupported currency changes and historical USD-vs-native confusion.
- Tenant boundaries, party balance reconciliation, permissions and accounting journals in both Mali and Zambia. Tenant-scoped baseline totals must be gathered with authorized access; Phase 1 read-only tenantless query could not establish these.
- Review latest \`main\` divergence and carefully integrate using the same branch and PR only when Claude begins verification; do not merge into main or deploy until successful review and authorization.

**Next implementation: Phase 7 cash/bank currency balances and revaluation.** Later phases: inventory/intercompany (8), Factory (9), reports/Net Position (10), final integration review (11), draft PR and Claude CI/reconciliation. No main merge or Render deployment until Claude clears all checks.
