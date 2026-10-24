# Zambia ZMW — Phase 5 POS, sales imports, receipts and refunds

**Status:** Phase 5 implementation changes committed to `feature/zambia-zmw-multicurrency`. This is a source-level handoff, **not independently tested or approved for production**. Claude is responsible for final CI, tests, typechecking, builds, financial reconciliation and fixes after all phases.

**DO NOT MERGE/DEPLOY YET.** This phase made no production SQL/data changes, ran no migrations and deliberately did not run CI, unit/integration tests, lint, typechecking or builds.

## Implementation

### Standard POS — cash, credit and edits
- `client/src/pages/pos/hooks/usePosRowCalculations.ts`: USD/CFA/ZMW item prices and per-line conversions. ZMW uses 2-decimal display without CFA rounding; the canonical USD item rate retains 6 decimal places.
- `client/src/pages/pos/utils/posCalculations.ts`: labels Kwacha amounts as K rather than silently showing dollars.
- `client/src/pages/pos/hooks/usePosCheckout.ts`, `client/src/pages/pos/pos-components/posTypes.ts`: sends currency, applicable rate, original typed ZMW unit price and canonical USD rate for each cash/credit sale. Rejects missing/invalid local-currency rates and nonpositive converted prices.
- `client/src/pages/pos/POS.tsx`: Zambia's active sale-date rate comes from company-scoped `/api/exchange-rates/latest?asOf=YYYY-MM-DD`, not the user's clock or an unrelated current rate. Edit mode recovers the voucher's persisted currency and locked rate and reconstructs ZMW input prices from the original USD sale items. Currency/date changes keep native prices and canonical USD rates in sync.
- `server/services/pos/posZmwRatePolicy.ts`: centrally resolves/locks the USD→ZMW rate effective on the sale/refund date for the current configured company; requires matching submitted rate; rejects future-dated, unknown, cross-company, invalid or missing ZMW rates, with a 409 error. Validates original native ZMW prices against converted 6-decimal USD prices before writes.
- `server/services/pos/createSaleService.ts`: enforces approved sale-date rate and native-price consistency for both cash and credit sales before ledger/inventory writes. Voucher currency and rate are saved with the sale; `posSaleLines` posts base USD and original transaction fields at the locked rate.
- `server/services/pos/edit/updateSaleService.ts`: original ZMW currency and date are immutable on a direct edit, to prevent implicit historical-rate restatement. A date/currency correction requires an authorized reversal and rebooking. Existing inventory reversal/rebuild and posting workflows remain intact.

### Excel imports (cash and credit)
- `client/src/pages/pos/posimport/usePosImportModel.ts`, `PosImportForm.tsx`: selectable ZMW/ USD for Zambia, preserving USD/CFA for Mali. A selected import sale date uses an approved, company-specific ZMW rate. The sheet's native ZMW price is transmitted alongside its USD conversion (6dp) and rate.
- `server/routes/posImportRoutes.ts`, `server/routes/creditSalesImportRoutes.ts`: require the matching rate, verify converted item prices against their original ZMW price, and post USD revenue/receivable/cash amounts while preserving the voucher's original currency/rate and native transaction amounts on the sale entries. Both respond with an actionable 409 for missing/mismatched ZMW rate.
- No historical imports or sales were reprocessed. Existing Mali two-decimal CFA import conversion remains as before.

### Receipts and PDFs
- `client/src/pages/pos/pos-components/InvoiceTemplate.tsx`: prints original ZMW sales with Kwacha prices/totals and a banner showing the VOUCHER'S saved rate. USD inventory cost and profit columns are visibly identified; Mali's CFA banner behavior is retained.
- `client/src/pages/pos/posimport/PosImportPrintTemplate.tsx`, `posimport/types.ts`: for ZMW invoices, print original worksheet prices/totals in K and the saved voucher rate (not a later rate). Cash and credit import receipts both use the same rule.
- `server/helpers/generateInvoicePdf.ts`: reads the original voucher currency and exchange rate from the database; ZMW invoices/PDFs display Kwacha prices/totals using only the voucher's historical rate. Cost/profit columns remain explicitly USD. Mali's old-rate banner stays available for its legacy invoices.

### Credit-note refunds and stock returns
- `client/src/components/vouchers/CreditNoteTab.tsx`: supports Kwacha refund-rate input when Zambia's ZMW display mode is selected, uses a valid rate for the note date, displays refund totals in K, and keeps inventory cost/variance in USD. Edits restore ZMW amounts from the saved note rate. Changing currency before posting clears staged native prices rather than silently reinterpreting them.
- `server/routes/creditNoteRoutes.ts`: locks the credit/debit note's ZMW date/rate on create; validates the original native refund price against its converted USD rate; persists ZMW currency and rate on the note; labels the cash/bank refund entry with original native amount and historical rate, while inventory and cost entries remain USD. Updates retain the locked ZMW rate and reject date/currency changes requiring reversal. Existing USD notes keep their previous posting paths.
- Existing independent credit notes are not automatically linked to an original sales voucher. A standalone refund uses the rate effective on the REFUND NOTE DATE. Correcting an original sale's historical currency/date requires the existing reversal/rebook workflow, not applying today's rate retroactively.

## IMPORTANT limitations / follow-ups
1. All new ZMW functionality depends on Phase 3 USD/ZMW company settings and approved company daily rates. Zambia production settings remain unchanged until release approval.
2. Original per-item ZMW rates on normal sales and imports are validated at posting; canonical `sales_items` USD prices remain the source for stock/profit. Printed K values are obtained using the SAVED voucher rate, not any current rate.
3. Phase 6 owns full multi-currency voucher/party settlement, partial payments and exchange differences. Phase 7 owns cash/bank native-account reconciliation and translation. Phase 10 owns final financial report/date filtering.
4. Claude must review any legacy POS editor, credit-note, refund, customer-statement, and WhatsApp print consumers that use only USD and confirm they preserve ZMW currency metadata correctly.
5. Changes include no schema migration or backfill. No existing voucher, return, sale item, stock cost, balance or FX rate was changed.

## Claude verification gate (do not run during implementation)
- USD/ZMW sale at 1 USD=25 ZMW: typed K250.00 yields USD10.00 with consistent credit/debit and original native currency/rate fields.
- Backdated ZMW sale picks the approved rate effective on sale date, not the latest. Stale/missing/zero/unapproved/future date rates must fail before any voucher, inventory or customer updates.
- Round-trip original price checks for tiny/large/decimal ZMW unit prices; reject forged original price or client USD price; check six-decimal and cent rounding for balanced postings.
- Cash and credit POS, customer receivables, retry/idempotency, refunds, return notes, stock reversal, credit-note edits and cancellation/void routes.
- Editing a ZMW sale uses the original voucher rate and does not silently change date or currency. Historical reprints must show the exact saved exchange rate.
- Cash and credit Excel imports use the native ZMW worksheet price and dated rate with correctly posted USD figures and original entry amounts. Old USD/CFA imports continue to work.
- Receipts, WhatsApp/PDF invoices and reprints: K amount and locked ZMW rate, explicit USD cost/profit columns, unaffected Mali CFA layout.
- Currency switching or rate changes with staged items never reinterpret typed Kwacha as USD.
- Permission/tenant isolation and the company-specific query cache, including concurrent company switches and bad requests.
- Full CI, tests, typechecking, lint, builds and accounting reconciliations only AFTER all implementation phases. Fix problems on the SAME feature branch and draft PR. Do not merge or deploy until Claude signs off and the user authorizes release.

## Phase 5 release status

- [x] Phase 5 source changes committed on the single Zambia branch
- [x] POS, cash and credit imports, receipts/PDF and note entry paths modified
- [x] Manual source inspection conducted; no runtime checks executed
- [x] No production accounting/data changes, merges or deployments
- [ ] CI/tests/typecheck/lint/builds and regression verification — reserved for Claude
- [ ] Signed financial reconciliation — reserved for Claude
- [ ] Activation of Zambia company display currency/timezone and initial rates — release configuration only
