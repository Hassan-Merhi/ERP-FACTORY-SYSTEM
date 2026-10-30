# Phase 1 — FX monetary valuation source audit and implementation contract

**Status:** Phase 1 source-code audit COMPLETE on `feature/fx-monetary-valuation` (2026-10-27). **No runtime behavior, rate, database schema, historical voucher, production balance, or deployment changed.** Live tenant data has not been inspected; the separate production-data diagnostic is a prerequisite to activating valuation across every account, not evidence that all historical data is resolved.

## Owner policy / required behavior

Saving the effective-dated rate from **Settings → Exchange Rates** or **DailyRateModal** must make the **current reporting USD equivalent** of exactly four eligible monetary categories reflect the newly applicable rate:

1. **Cash / bank** (including genuine cash and bank ledger accounts and separate bank master accounts).
2. **Customer balances / receivables**, including negative customer balances on their correct sign side, but **not** supplier-party rows.
3. **Monetary assets** (contractual rights to a fixed currency amount, e.g. explicitly classified recoverable deposit / receivable). Do **not** translate inventory, stock, goods in transit, prepaid services, buildings, vehicles, equipment, capitalized costs, or other nonmonetary assets. The free-text `Asset` or `Current Asset` type alone is insufficient evidence of monetary nature.
4. **Loans** on both positive (loan receivable) and negative (borrowing payable) sides. Only accounts or instruments explicitly identified as loans; no automatic inclusion of every liability, supplier payable, or intercompany account.

**Explicit exclusions:** suppliers, supplier overpayments, factory supplier settlements, unrelated liabilities/deposits, nonmonetary assets, inventory / raw material / WIP / finished goods, cost prices, revenue, expenses, payroll expense, original source vouchers and base-currency historical posting amounts. If a loan/monetary asset cannot be safely distinguished, label it **NEEDS_REVIEW** instead of assuming eligibility.

**Important distinction:** live/current translated USD is not the stored historical USD book basis. A change to a rate must never rewrite historical transaction rates or original amounts. Formal GL FX gain/loss posting (if later required) is a separate, balanced, reviewed feature: not implicitly triggered by saving a rate. Source tests explicitly prohibit the earlier unsafe automatic `FX-REVAL` journal.

## Confirmed source audit

| Component | Verified source and existing behavior | Phase 2+ action |
| --- | --- | --- |
| Rate save | `server/routes/exchangeRateRoutes.ts` POST `/api/exchange-rates` calls `saveCompanyExchangeRate` and explicitly states no automatic FX-REVAL journal. `server/services/accounting/exchangeRateWrites.ts` saves and audits rate atomically by company/date/pair. | Continue to use **one** server save path; after a successful committed write make live valuation caches/version invalidation consistent. Do not post a journal. |
| Both UIs | `client/src/components/ExchangeRateSettings.tsx` and `DailyRateModal.tsx` both POST the endpoint. Their query invalidation includes account and rate paths but is incomplete for Net Position, customer screens, Factory/group reports and server TTL. | No divergent frontend math; centralize refresh of all dependent read models and enforce company-specific invalidation. |
| Rate direction | ERP `exchange_rates` represents **foreign units per 1 base unit** (e.g. 1 USD = 612 CFA). Factory `factory_fx_rates.rate_to_usd` means **USD per 1 foreign unit**. `server/services/accounting/cashBankTranslationRates.ts` currently enumerates CFA and ZMW instead of an arbitrary configured currency pair. | Introduce a convention-aware company/currency/date resolver. For USD-base quote CFA-per-USD: USD = CFA / 612. For a rate-to-USD quote: USD = native × rateToUsd. Never silently use 1 for an unresolved foreign rate. |
| Cash / bank | `server/services/accounting/cashBankRevaluationService.ts` returns `nativeBalancesByCurrency`, `historicalBaseBalance`, `currentTranslatedBaseBalance`, `translationDifference` and provisional flags; operates on cash/bank only. It has **legacy** versus **engine** attribution modes. | Reuse native source reconstruction / unresolved detection, but choose one canonical ownership model per consuming report. Do not force a cash + bank pair into one account or count an entry twice. |
| Cash in Net Position | `server/routes/stats/statsMultiCurrencyRoutes.ts` wraps live `/api/stats/net-profit` and replaces only cash/bank rows. Requests with `toDate` are intentionally skipped; it also clones the cached report object to avoid repeated translation. | Replace this cash-only composition with four-category live-valuation composition; preserve strict historical cutoff and once-only row replacement. |
| Account classification | `server/services/accounting/accountClassification.ts` normalizes account types case-insensitively; `Loan`/`Loans` classify as `liability`, `Cash`/`Bank` as `asset`, `Customer`/`Supplier`/`Intercompany` as `party`. `server/netPositionHelper.ts` classifies by signed closing and excludes stock and physical fixed assets. | Revaluation **eligibility** must be independent of sign or display `asset/liability` bucket. The loan asset or liability changes by currency, but must not become a new asset/loss account. Add explicit monetary-asset flags/registry rather than free-text substring matching. |
| Customer ownership | `server/services/accounting/balances/ledgerBalanceEngine.ts` assigns posted lines by priority ledger > bank > fixedAsset > supplier > employee > factorySupplier > customer, with special linked-customer-ledger ownership; customer master opening is counted once and linked ledger opening is omitted. `server/services/accounting/balances/netPositionParties.ts` already excludes customer-owned ledger IDs from ledger classification. | Build customer native buckets using **the same** customer-linked-ledger and voucher attribution rules. Never value both customer and its linked ledger separately, and never use `customers.current_balance` in addition to the authoritative ledger as though both were movements. |
| Bank ownership | `cashBankRevaluationService.ts` `engine` mode separates ledger-attributed and bank-only lines and retains their separate openings; `legacy` mode omits linked bank rows. `statsMultiCurrencyRoutes.ts` replaces rows by `ledger:id` and `bank:id`. | Use typed row keys `ledger:id`, `bank:id`, `customer:id`, `fixedAsset:id` instead of only `id`. Every source voucher entry and opening belongs to exactly one aggregate. |
| Opening / voucher evidence | `server/routes/openingBalanceResolutionRoutes.ts` declares native amount, currency, historical rate and base columns for ledger, bank, customer, supplier, employee; `fixedAssets` carry purchase native/base fields. Voucher entries carry transaction currency/native amounts and historical base amounts. | Never derive native CFA/ZMW by multiplying cumulative historical USD at today's rate. If an old opening/entry lacks trusted currency evidence, report **PROVISIONAL / UNRESOLVED**, preserve book USD and do not invent a translated USD. |
| Fixed assets | `fixed_assets.purchase_native_amount` and `purchase_base_amount` record a *purchase*; `server/netPositionHelper.ts` deliberately excludes physical fixed assets. | Do not translate equipment purchase cost as a monetary receivable. Review any true monetary receivable classified in a generic `Asset` ledger separately. |
| Main report | `server/routes/stats/statsNetProfitRoutes.ts` builds Net Position from `classifyNetPositionAccounts` and `loadNetPositionParties`; contains explicit comments locking loans and receivables at historical USD. It also has a server TTL cache keyed by company/date. | Remove cash-only assumptions; server cache MUST invalidate or include a rate revision/version after a successful save. Make no double-count when applying four-category differences to `forUs`, `onUs` and net total. |
| Factory | `server/routes/factory/employee-pos/employeeNetPositionRoutes.ts` sources balances separately, uses dated `factory_fx_rates`, computes customer/supplier/operational assets, and supports historical Net Position. | Do not apply an ERP-company rate to a different factory company or factory supplier/stock valuation. Adapt only authoritative, eligible monetary ledger/customer/loan rows for that company, with exactly-once replacement. |
| Existing regression safeguards | `tests/money-exact-batch-18.test.ts`, `tests/wave9-ledger-safety-routes.test.ts` assert that rate changes create **no** unsafe `FX-REVAL` voucher. Zambia Phase 7 docs enforce historic USD immutability. | Preserve these tests. New tests validate report-time four-category results without contradicting the no-voucher contract. |

## Canonical valuation contract for Phase 2

Use a server-side **read-only** valuation provider with an explicit `companyId`, `asOfBusinessDate`, `valuationMode` (`CURRENT` vs `HISTORICAL`), and currency-rate resolver. No UI computes independent balances.

**Source key:** `companyId + accountKind + accountId` where `accountKind` is `ledger`, `bank`, `customer`, or an explicitly eligible monetary instrument kind. Document ownership of customer-linked ledger entries and master bank entries before processing.

**Deterministic eligibility (no guessing):**

- Cash/bank: matching cash/bank type and canonical owned bank rows (normalize case, not just exact `Cash`/`Bank` strings); do not include bank accounts already owned by customer or another target.
- Customer: `partyKind=customer`, all nonzero signs; customer-linked ledger attribution solely to customer.
- Loan: ledger account type `Loan`/`Loans` (including normalized spelling) and any explicitly registered loan instrument with posted evidence; no automatic `Liability` or `Intercompany` blanket inclusion.
- Monetary asset: `Asset`/`Current Asset` only with verified `monetary=true` metadata or an approved code registry; physical/fixed/nonmonetary asset and stock/perpetual accounts always excluded. Ambiguity => opt out + diagnostic.
- Supplier/factorySupplier, income/expense/equity, unrelated liability and unassigned account => excluded by default.

**Native balance:** signed opening in its original currency (one opening only) + net native posted movements, attributed once using the existing one-balance-engine ownership rules. Keep separate currency buckets, never add unlike currencies.

**USD translated current:** sum of each USD bucket unchanged plus each eligible foreign native bucket translated by its **company-scoped applicable effective rate**, using decimal arithmetic and explicit direction. If any material bucket lacks a trusted currency or rate, the account is unresolved (return null current translated figure, old historical book basis preserved for context) rather than falsely translate all its USD as CFA.

**Historical USD book:** original base amounts and locked historical FX never changed. `translationDifference = currentTranslatedUSD - historicalBaseUSD` is reporting metadata, not a voucher/journal. Preserve signs. A negative cash account or customer credit remains on the appropriate liability side; do not clamp to zero. Revaluation is applied once to totals by replacing existing account rows, not appending the same balance.

**Dated semantics:** Current valuation uses the business-day-effective rate (latest valid on or before that date). Historical report uses only transactions/openings actually existing by the selected cutoff AND rate effective for that cutoff *if* a translated historical view is explicitly supported. Never pass a date to a rate lookup over **today's** balances and label the result historical. Past original USD book and historic profit remain immutable. Editing a prior date can change a corrected management comparison, but must never silently restate closed period postings.

**Refresh:** invalidate both UI query caches and affected server caches (including TTL net profit / group), scoped to company and rate revision; no other company's rate or balances touched. If a save updates a future-effective rate, current valuation should not change until its effective date. A repeat save of the same rate produces no new valuation delta.

**Audit:** retain old/new effective rate save audit; expose which accounts are eligible/unresolved and their translated USD deltas. No mutating voucher side effects. Strict company/permission scoping must match the existing rate route; no cross-company `companyId` injection.

## Source-of-truth / double-count rules

1. **Customer master vs linked ledger:** customers own their opening and their eligible linked-ledger entries; linked ledger must not reappear in assets or cash.
2. **Ledger vs bank:** a voucher line with `ledger_account_id` and `bank_account_id` has ONE owner by existing engine priority. A bank-only line is assigned to bank. Own openings stay with their masters in engine mode; never additionally count a legacy combined account representation.
3. **Factory:** any confirmed voucher-based customer/loan/cash amount must not also be counted as an operational unposted memo; Factory customer unfinalized memo stays in its existing separate bucket until authoritative posting.
4. **Loan direction:** one signed loan balance may be asset or liability; do not recognize both or add an FX delta in both totals.
5. **Inventory:** stock/cost/value accounts are never translated via monetary FX and never re-added from both GL and operational inventory.
6. **Group/intercompany:** aggregate only already-scoped company valuations and preserve existing group intercompany-elimination rules; do not revalue the same cross-company transfer twice.

## Phase 1 acceptance matrix (to be implemented/tested Phase 2 onward)

| Case | Expected |
| --- | --- |
| Mali 61,200 CFA customer, 605 → 612 CFA per USD | Native **61,200 CFA** remains; current USD 101.15702479… → 100.00; no voucher posted. |
| 61,200 CFA loan **payable** | Liability USD changes with rate; original CFA credit unchanged. |
| 61,200 CFA loan **receivable** | Asset USD changes with rate; original CFA debit unchanged. |
| CFA cash ledger + linked bank same entry | One native movement / one translated USD exposure, never two. |
| Customer with linked ledger | One customer opening + owned movements; no duplicate ledger revaluation. |
| USD-only customer / loan | USD value unchanged, independent of foreign rate. |
| Supplier and supplier overpayment | No automatic USD change under owner policy. |
| Equipment / stock / prepaid service | No automatic USD change. |
| Monetary-asset account with no explicit classification | No revaluation; diagnostics state `NEEDS_REVIEW`. |
| Missing native opening, unresolved transaction, or FX rate | Current translation null/provisional for the affected account; preserve original historical USD and surface details. |
| Rate backdated/future-effective | Correct dated applicability; do not revalue original history or immediately apply future rate. |
| Both Settings and popup save | Identical backend valuation and refreshed UI; rate history remains audit preserved. |
| Two companies with differing local currency | Company isolation and correct rate direction; no bleed. |
| Historical Net Position versus current Net Position | Proper date-specific source balances and rate; no mislabeled current snapshot. |
| Zero / negative / mixed USD and foreign amounts | Signed precision retained, no sign flip/double addition; round only at display boundary. |
| Repeated or concurrent rate submissions | Idempotent presentation, no duplicate FX journal or double-applied delta. |

## Execution boundary / outstanding gates

**Completed in Phase 1:** locate write entry points, current valuation and cache consumers; trace customer, ledger, bank and loan classification; identify monetary-asset ambiguity, the opposite Factory quote direction, current-vs-dated semantics and prior unsafe journal regression; specify inclusion, exclusion, attribution and acceptance contracts.

**Not performed:** no production database reads or schema migrations, no changes to rate endpoints or UI, no CI/tests/typecheck/build, no merge/rebase/deploy. Source inspection cannot reveal how many *live* customer, loan or generic Asset rows have unresolved native openings / foreign voucher metadata, nor whether each free-text Asset is monetary. Before enabling the service for an account, run a permissioned read-only per-company inventory of actual account types, native opening and voucher coverage, duplicates and account purpose; leave ambiguous accounts unresolved until verified. This is a **Phase 2 activation gate**, not a claim of complete live-data reconciliation.

**Phase 2 starting point:** implement the canonical eligibility/ownership registry plus typed account native-bucket collector and read-only valuation API, preserving the cash service and old historical book columns. No automatic journal posting. Wire interfaces/reports only in subsequent phases.
