# Unified Accounting — Phase 5: Advanced Multi-Currency Accounting

**Branch:** `feature/unified-accounting-erp-factory-rentals` (continued from Phases 1–4)  
**Modules:** ERP, Factory, and Rentals/Properties  
**Status:** Code changes committed; *no CI, tests, build, merge, rebase, deploy, database data repair, or manual production accounting operation performed*. Claude owns verification and certification.

## Scope and financial invariants

1. **Original invoices, sales, expenses, costs, balances, and voucher entries retain their historical original currency, original rate, and booked USD/base amount.** A new dated rate cannot rewrite historical entries.
2. ERP and Rentals use the existing `TRANSACTION_PER_BASE` convention (foreign units per USD). Factory raw-material costing and FX wallets can use **the opposite** `BASE_PER_TRANSACTION` (USD per foreign unit). The conventions must never be interchanged without explicit inversion.
3. Only cash/bank *monetary* balances receive a dated, **report-only** unrealized FX translation. No period-end revaluation voucher is automatically posted. Factory raw materials, goods in transit, WIP, bales, finished goods, fixed historic sales, and historic expenses are excluded.
4. Realized settlement FX is a **separate, manually authorized**, idempotent adjustment through the established balanced voucher engine, based solely on an existing verified Phase 3 invoice/payment match. It is not triggered automatically when a payment is entered or allocated.
5. EUR, AUD, GBP, CDF, CFA and USD are covered. The existing currency normalizer now also accepts `AUD`; `XOF` is normalized to the ERP's `CFA` identifier. Rates are **never invented or fetched**.
6. Preserve the Factory supplier **Inside/Outside** currency/exposure rules. Factory supplier open-item matches may be *previewed*, but the realized-FX journal action **refuses** that domain. No adjustment to Factory outside balances or historical supplier invoices is made.

## Implemented files

- `server/services/accounting/monetaryFxRates.ts` — authenticated company-scoped rate calculation on/before the selected business date.
- `server/services/accounting/monetaryFxValuation.ts` — historical/native bank and cash monetary movement buckets and dated USD translation.
- `server/services/accounting/realizedFxService.ts` — matched partial-invoice/payments' prorated historical base basis, gain/loss preview, idempotent authorized posting, source tracking, and reversal status.
- `server/services/accounting/ensureMonetaryFxSchema.ts` — additive ledger-independent recognition evidence (not a new financial ledger).
- `server/routes/monetaryFxRoutes.ts` — secured API.
- `client/src/pages/MonetaryFxAccounting.tsx` — shared tri-module valuation and realization interface.
- `server/services/rental/rentalPaymentRate.ts` — Rental dated payment rate now delegates to the shared convention-aware resolver.
- `server/services/rental/rentalPaymentPostingService.ts` — immediate Rental payments now resolve their dated rate **inside their existing posting transaction**.
- `server/services/accounting/currencyAmounts.ts` — AUD accepted without changing earlier currency IDs.
- `server/services/accounting/systemAccounts.ts` — optional `FX-REALIZED` system account for gain/expense treatment, separate from historical `FX-REVALUATION` entries.
- `server/services/accounting/partyOpenItemService.ts` — linked realized FX journals and their reversals do not masquerade as new open invoices/payments; an active realized-FX voucher must be reversed through the existing audited flow before its source match can be voided.

## Source rates and conventions

`datedMonetaryRateTx(tx,companyId,currency,asOfDate)` reads **persisted `exchange_rates` data only** for a USD-base accounting company. It selects the latest effective date *on or before* the requested date, supports either direction, and blocks inconsistent opposite-direction records saved for that date.

For a saved USD→EUR rate of `1.18 EUR / USD`:

- USD value of EUR = `EUR amount ÷ 1.18`;
- transaction currency per base USD = `1.18`;
- base USD per EUR is displayed as its reciprocal.

For a saved EUR→USD rate of `1.18 USD / EUR`:

- USD value of EUR = `EUR amount × 1.18`;
- USD per EUR is the stored rate;
- EUR per USD is displayed as its reciprocal.

**Do not assume both examples represent the same rate.** The exact stored *direction* determines conversion; a mismatch between recorded directions is rejected. Direct USD→foreign conversion divides by the original exact foreign-per-USD rate. It does **not** multiply by a ten-decimal display-rounded inverse, avoiding measurable drift in large CFA/CDF balances.

The Factory `factory_fx_rates` and Factory-specific settlement conventions remain separate. A Factory rate (including an agreed EUR/AUD settings rate) is **not silently substituted** for a missing company `exchange_rates` rate. When one must be used for an actual Factory transaction, the existing Factory posting workflow and its explicit stored convention remain authoritative. The unified reporting page flags a missing company rate for review.

No rate is obtained from the Internet, from a later date, or from a default of 1 for a foreign currency.

## Cash/bank valuation

A user selects a company Cash/Bank account and as-of date. As in Phase 4, a bank can contain direct bank voucher lines and lines to a linked bank ledger. Each **individual voucher line is selected once**, with historical base and original transaction debit/credit kept separately.

The report returns per currency:

- **native cash/bank balance** (including verified opening balance);
- **historical USD basis** from *posted* voucher entries' original base debit/credit;
- recorded dated company rate and its effective date/direction;
- as-of **translated USD** balance;
- **unrealized USD difference**, the difference between dated translation and historical USD basis;
- explicit missing-rate, unknown historical opening, or incomplete original/base-entry warnings.

Legacy non-USD amounts with missing original-currency columns are **not guessed or backfilled**. If any bucket has unverified evidence, the aggregate translated USD and unrealized total are **withheld**, not presented as a certified amount. Historical cash/bank presentation is also constrained by any subsequent changes to existing account-master opening values or retired vouchers; Phase 10 owns full historical source reconstruction.

This valuation is report-only. It does not write `vouchers`, `voucher_entries`, `exchange_rates`, `bank_accounts`, `ledger_accounts`, inventory costing, factory balances, Net Position, or financial statements.

## Realized gains/losses

`previewRealizedFxTx` requires a live, nonoptional, same-company Phase 3 matching record, directly owned by the same ERP customer or ERP supplier at both ends, with equal **verified original currencies** and non-null historical base columns.

For a partial match of `N` native units:

```
historical_charge_USD = charge_original_USD × N / charge_original_native
historical_settlement_USD = settlement_original_USD × N / settlement_original_native

customer_realized_gain_USD = historical_settlement_USD − historical_charge_USD
supplier_realized_gain_USD = historical_charge_USD − historical_settlement_USD
```

The final recognized difference rounds to USD cents for posting through the established voucher engine. An FX gain **credits** `FX-REALIZED`, a loss **debits** `FX-REALIZED`, and the opposing line adjusts the same receivable or payable party. This does not affect the invoice's native amount or its original currency/rate. A correctly classified `FX-REALIZED` account is required; a similarly named account with mismatched code/type does not silently qualify.

Only an authorized user choosing **Recognize FX** with a reason can create this journal. The request locks its source matching record and uses source identity `fx-realized-open-item:{matchId}`, so repeating the same instruction returns the prior recognition instead of posting twice. The receipt/payment source module is preserved on the new journal when available. The recognition record contains source match, voucher, native amount, historical charge/settlement USD, FX gain/loss, actor, and date.

**No automatic settlement adjustment for Factory supplier balances.** Linked customer-ledger accounts that cannot be shown to belong directly to the party also require manual review instead of unsupported auto-recognition.

If an FX journal is reversed through the normal audited reversal lifecycle, recognition remains in history and cannot be re-posted automatically as a fresh gain/loss. The source match cannot be voided while its linked realization voucher is active and unreversed; it must first be reversed.

## New metadata schema

`accounting_fx_realizations` — references a Phase 3 matching row and its already-posted voucher. Uniqueness is enforced per company+match and per company+voucher; RLS restricts every row to the active company. It records no new party/inventory/account opening and has no independent balance engine. Runtime initialization creates the table idempotently after the earlier Phase 3 metadata tables.

## API and UI

All endpoints require authentication, Admin/Owner/Developer role, the selected session company, and tenant database scope. Factory requests additionally require the Factory Accounts page permission.

| Verb | API | Function |
| --- | --- | --- |
| GET | `/api/accounting/monetary-fx/rates?asOfDate=YYYY-MM-DD` | Saved USD/EUR/AUD/GBP/CDF/CFA company rates and provenance |
| GET | `/api/accounting/monetary-fx/rate?currency=EUR&asOfDate=YYYY-MM-DD` | One saved dated rate pair |
| GET | `/api/accounting/monetary-fx/cash-bank?accountKind=bank&accountId=1&asOfDate=YYYY-MM-DD` | Cash/Bank native, historical and translated balances |
| GET | `/api/accounting/monetary-fx/realized?domain=customer&partyId=1&asOfDate=YYYY-MM-DD` | Eligible recorded invoice/payment matches and realized FX differences |
| GET | `/api/accounting/monetary-fx/realized/:id` | One match's read-only preview |
| POST | `/api/accounting/monetary-fx/realized/:id/recognize` + `{reason}` | Explicitly post exactly one audited, balanced realized FX journal |

Screen shared through Accounts and direct routes:

- ERP: `/accounting/monetary-fx`;
- Factory: `/factory/accounting/monetary-fx`;
- Rentals / Properties: `/properties/accounting/monetary-fx`.

The selected as-of date makes realized-FX posting **read-only** in the UI (the server always independently uses today's business date and period guard). In the current Phase 5 report, the date filters matched documents by application date, while recognition/reversal *status* is current; it is **not claimed** to reconstruct the full history of how status evolved on a past day. Phase 10 will extend that capability.

## Out of scope / deferred

- Automatic period-end revaluation GL vouchers. The existing ERP policy intentionally removed automatic rate-change FX-REVAL posting; **report-only** is preserved.
- Factory supplier Inside/Outside inter-currency settlement journals and special FX agent wallets; those already have their own accounting paths and their historical rates/settlements remain untouched.
- Exchange of currencies within one bank statement transaction, fully automated currency exchange transfers, external rate feeds, new multi-currency cash boxes, split FX clearing, and full consolidated remeasurement.
- Historical document mass normalization or any mutation of production vouchers; in particular, no historical sales/expense/inventory FX rewriting.
- Exact past-date reconstruction when old vouchers or opening balances were modified after that date (Phase 10).

## Claude certification checklist — not performed by this implementation

Claude should independently review the following, with read-only/reversible test fixtures where permitted:

- TypeScript/SQL compatibility and schema boot order with accounting Phase 3 and Phase 4;
- source-linked transaction currencies, USD functional-currency enforcement, and 1.18 direct/inverse conventions;
- saved same-day opposite-direction conflict, future dated rates, no missing-rate fallback, and CFA/XOF alias;
- EUR, AUD, GBP, CDF and CFA handling, precision on large CFA amounts;
- same-transaction Rental rate resolution and non-USD payment refusal;
- Factory special supplier exposures unchanged;
- direct customer/supplier owner validation, partial match pro rata FX, correct gain/loss sign, 2-decimal voucher balance, accounting period locks and the existing central posting engine;
- repeated or concurrent FX-recognition requests, active-realization match cancellation and reversal;
- the accounting open-item UI exclusion of adjustment journals without dropping GL balances;
- as-of disclosure accuracy, tenant RLS and permissions in ERP/Factory/Properties;
- report-only unrealized cash/bank valuation with unresolved historical/native data, bank master vs linked ledger ownership, and safe FX display;
- no unintended change to invoice, supplier, stock, Factory, rental or Net Position postings.

**No CI, automated tests, build, accounting certification, rebase, merge, deployment, or live accounting voucher operation has been run here.**
