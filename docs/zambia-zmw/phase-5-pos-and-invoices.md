# Zambia ZMW — Phase 5 POS, imported sales, credit notes, and historical invoices

**Implementation status:** Phase 5 source changes committed on `feature/zambia-zmw-multicurrency`; **UNTESTED** pending Claude's final review. No CI, lint, typechecks, tests or builds were run, and no merge, deployment, production migration, company settings changes, rate updates or accounting data writes were performed.

## Files and implementation

### Rate selection / POS item entry
- `client/src/pages/pos/POS.tsx` obtains an approved company-scoped USD/ZMW rate *as of the sale date* using `/api/exchange-rates/latest?asOf=`. It keeps edited ZMW invoices' locked historical voucher rate and prevents using the current daily rate for an earlier document.
- `client/src/pages/pos/hooks/usePosRowCalculations.ts` supports both legacy CFA whole-franc rates and two-decimal Kwacha rate presentation. USD remains the inventory/ledger cost basis.
- `client/src/pages/pos/hooks/usePosCheckout.ts` protects missing foreign rates, enforces two-decimal ZMW unit prices, submits USD selling prices and the **original typed ZMW prices** on each line (together with voucher currency, rate and date). Cash and credit sales use this path.
- `client/src/pages/pos/pos-components/posTypes.ts` / `server/services/pos/posSaleTypes.ts` carry optional `originalCurrencyRate`; USD/CFA requests remain backward compatible.
- `client/src/pages/pos/utils/posCalculations.ts` labels ZMW with K and leaves CFA/ USD presentation intact.

### Server posted sale protection
- `server/services/pos/posZmwRatePolicy.ts` validates that ZMW is configured for the current company, checks the sale date and approved effective-dated rate, requires the client's supplied rate to agree, and blocks future-dated ZMW postings. The rate is locked to the voucher and native lines; it is not recalculated on a later day.
- The same policy checks that each submitted original Kwacha unit price is consistent (within 6dp USD conversion tolerance) with its USD unit price. No invalid, missing or invented rate can post as 1:1.
- `server/services/pos/createSaleService.ts` validates ZMW rate and native vs USD unit prices before any inventory movement or voucher posting. Existing central ERP posting, idempotency, stock validation, COGS and audit paths remain in place.
- `server/services/pos/edit/updateSaleService.ts` preserves the original edited sale's currency and historical rate; attempts to re-date a ZMW sale or change its currency must be reversed/rebooked instead of retroactively repriced.

### Excel cash/credit import
- `client/src/pages/pos/posimport/usePosImportModel.ts` supports ZMW sheets, date-specific approved rates, original ZMW unit prices, and USD conversion before posting. It clears stale company import choices/validation when switching companies.
- `client/src/pages/pos/posimport/PosImportForm.tsx` offers USD/ZMW for Zambia and USD/CFA for Mali and displays rate-unavailable warnings.
- `server/routes/posImportRoutes.ts` and `server/routes/creditSalesImportRoutes.ts` verify ZMW rate and every native/converted USD unit price before posting cash or credit sales.
- Corrected a source-level credit-import bug: the ZMW rate check had been inserted in the preview endpoint with undefined variables, while the import route used an undefined locked rate. The lock and original-price check now occur inside the actual credit import route before customer, inventory, ledger or other financial writes.

### Refunds, returned stock and credit/debit notes
- `client/src/components/vouchers/CreditNoteTab.tsx` presents ZMW refund entry when selected for Zambia, fetches the rate for the note date, and records the original ZMW and converted USD refund values. Inventory costs continue in USD. Editing an existing ZMW credit note uses the original voucher rate, not the current rate.
- `server/routes/creditNoteRoutes.ts` supports ZMW original-price checks and locked note rate in cash/bank voucher entries, while inventory costs and stock value movements remain USD. Changing a ZMW note's date/rate requires reversal and rebooking.
- The existing credit note inventory reversal and accounting audit code is reused. Do not allow a currency change to silently rewrite a prior refund.
- The existing credit-note flow is an accounting return workflow, not proof of a one-click POS refund linked to a specific original sale; Claude must explicitly examine end-to-end original-sale linkage/return caps and whether a dedicated refund path is needed. No unsupported linkage is claimed here.

### Receipt and PDFs
- `client/src/pages/pos/pos-components/InvoiceTemplate.tsx`, `client/src/pages/pos/posimport/PosImportPrintTemplate.tsx` and `server/helpers/generateInvoicePdf.ts` show ZMW amounts and the voucher's **stored** historical USD/ZMW rate for a ZMW sale instead of today's rate, retaining existing Mali/CFA receipts.
- Print and WhatsApp invoice generation reuse the historical voucher rather than the current currency-context selection.

## Invariants

1. Zambia company 19 remains USD base, and its live display currency is NOT changed in Phase 5.
2. Each ZMW sale, credit sale, import or note must lock its original currency, approved as-of-date exchange rate and historical USD accounting value. Current rates may not reprice existing vouchers or inventory costs.
3. No mixed USD/ZMW aggregation without explicit rate conversion, no negative/zero/unknown rate defaulting to 1.
4. A change of financial date on a posted ZMW sale/note requires reversal/rebooking, not mutating the original locked rate.
5. Mali USD/CFA pricing and historical documents must remain unchanged.
6. Company and source-document permissions, idempotent keys, stock availability and posting audit must remain in place.

## Claude's mandatory verification / fixes before merge/deploy

- Run typecheck/build/lint, CI and tests only after completion of all phases, per the owner's workflow. **None were executed by ChatGPT.**
- Verify direct USD/ZMW cash and credit checkout, multi-line rounding, input with fractional ngwee, impossible/zero prices, and stale-rate rejection.
- Verify effective-dated backdated sale and refund rates; future dates blocked; invoice PDF reprints remain identical after a new daily rate is entered.
- Verify sales import preview, validation, native ZMW worksheet unit amounts, normal and credit imports, replay/idempotency and prices after 6dp USD round-trip.
- Verify credit note and debit note account lines, refund settlement, inventory receipt/issue, original-price locking, and edit/reversal with correct per-line rates.
- Verify the end-to-end linkage between a return and its source sale, repeated refund limits and any necessary exchange difference entries. The generic credit note flow must not be represented as guaranteed sale-linked returns without this review.
- Verify actual posted USD debits/credits balance to the cent after native ZMW-to-USD rounding, including high-volume and very small line prices. Resolve any mismatch using ledger rounding/variance rules, not historical repricing.
- Verify old Mali and all other companies remain unchanged, especially CFA price rounding and invoices, before release approval.
- Verify no extra refunds, overreturns, duplicate stock postings, incorrect receivables, or duplicate import vouchers under concurrency.
- Confirm authorized company-scoped before/after reconciliations and all audit entries. No production data access or mutations in this phase.
- On failed checks, Claude fixes **on the same feature branch and draft PR**, then reruns checks; only after Claude's approval can a merge or Render deploy be discussed separately.

## Phase handoff

Continue Phase 6 on `feature/zambia-zmw-multicurrency`. Full ERP vouchers/parties/payments are Phase 6, cash/banks Phase 7, inventory/intercompany Phase 8, Factory Phase 9, reporting Phase 10 and integration Phase 11. No main merge/Render deployment until Claude clears the full set of checks.
