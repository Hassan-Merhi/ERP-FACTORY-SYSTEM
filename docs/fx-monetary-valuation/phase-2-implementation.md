# Phase 2 — Centralized monetary FX valuation (read-only backend)

**Implemented** on `feature/fx-monetary-valuation` (2026-10-27), following `phase-1-source-audit.md`. No merge, deploy, production rate edit, accounting voucher/journal posting, schema migration, or production data repair. **Automated tests / typecheck / production reconciliation have not been executed** and require the normal verification gate.

## What was added

1. `server/services/accounting/monetaryFxValuationCore.ts`: deterministic four-category eligibility plus side-preserving Decimal USD translation. Nonmonetary stock, fixed assets, physical assets, unrelated liabilities, suppliers and intercompany are excluded. Generic `Asset` or `Current Asset` requires an explicitly approved monetary-asset code, otherwise `needs_review`.
2. `server/services/accounting/monetaryFxValuationService.ts`: one company-scoped read-only repeatable-read database transaction. The service uses the exact `customerLinksBody` and `noNonCustomerTarget` shared with `ledgerBalanceEngine`, to attribute posted source entries once to customer / ledger / bank, along with independent master openings. Each voucher line contributes at most once to its owner. It keeps local amounts separate by currency, translates only eligible monetary accounts into current USD using `datedMonetaryRateTx`, and preserves historical USD book basis separately.
3. `server/routes/stats/statsMultiCurrencyRoutes.ts`: authenticated, non-POS `GET /api/accounts/multi-currency/monetary-valuation` that takes company identity **only from the session** and returns `Cache-Control: private, no-store`. It does not accept currency/account approvals from request parameters.
4. `tests/monetary-fx-valuation-phase2.test.ts` and `tests/monetary-fx-valuation-source-contract.test.ts`: pure calculation, eligibility, sign, missing-rate and source-attribution tests are committed, but **not executed**.

## API contract

```
GET /api/accounts/multi-currency/monetary-valuation
```

Returns (all string-valued monetary amounts are 6-decimal fixed strings):
- `companyId`, `businessDate`, `valuationMode: "CURRENT"`, `baseCurrency`;
- `bookBalancesModified: false`, `fxVouchersPosted: false`;
- `accounts[]` with unique `accountKey = kind:id`, `accountKind` (`ledger`, `bank`, `customer`), category (`cash_bank`, `customer`, `loan`, `monetary_asset`, or `needs_review`), `nativeBalancesByCurrency`, `historicalBaseUsd`, `currentTranslatedUsd`, `translationDifferenceUsd`, and unresolved/provisional flags;
- company-specific dated `rates[]` including quote direction;
- counts of eligible, unresolved, needs-review and excluded masters.

An unresolved nonzero opening, incomplete foreign entry, missing/invalid FX quote, or unsupported non-USD functional-currency accounting base blocks translated USD on its affected account. No guessed identity rates, retroactive base rewrite or arbitrary USD conversion. Account rows with unapproved generic assets stay `needs_review` and do not expose an automatically translated USD equivalent.

For a verified customer holding `61,200 CFA` at `1 USD = 612 CFA`, current USD is `100.000000`; its original native CFA balance and locked historical USD book value remain unchanged. A signed CFA loan payable yields a negative translated USD balance and stays on the liability side when a future report consumes it.

## Critical preservation details

- **Do not double count:** linked customer ledgers belong solely to their customer; their master ledger openings are not added independently. Bank-only lines belong to bank; ledger-attributed lines belong to ledger. Existing `cashBankRevaluationService` remains intact for old screens until later integration.
- **No rate guessing:** `datedMonetaryRateTx` is the shared authority for historical effective date, company scope, exact recorded direct/inverse quote and conflicting same-day rates. Factory `rate_to_usd` is not silently used as an ERP company quote. Unexpected conflicts reject the read rather than generate inaccurate totals.
- **Historical protected:** posted voucher and opening native/USD metadata are read, not updated. Period-closing and historical valuation are NOT changed. This is a current business-date valuation only and must not be passed an arbitrary past date and represented as a historical reconstruction.
- **Reconciliation boundary:** the original `/api/stats/net-profit` cash-only wrapper and other account screens are NOT yet modified. Phase 3 handles dual entry-screen rate-save refresh/invalidation, Phase 4 consumes the new read model in authorized report views; do not add its translated values to existing historic USD rows.
- **Scope:** `assertTransactionCompanyScope` binds RLS to session company; all read queries share a repeatable-read, read-only transaction. No client-provided companyId, account list, or monetary asset approval is trusted.
- **Generic monetary assets:** the calculation core supports a trusted per-company approved monetary code set, but **no production code is approved by default**. Before enabling named asset codes, confirm whether each is a fixed receivable or a physical/nonmonetary balance (Phase 3/4 review).

## Verification / release gate remaining

1. Run unit, typecheck, lint and source contract tests; fix any compile/integration failures on this same branch. No execution claimed here.
2. In a permissioned tenant-scoped environment, run Phase 1 diagnostic, verify native opening and entry completeness for Mali, Zambia and any other enabled currency company. RLS scopes every transaction; run per company.
3. Compare new `cash_bank` rows with existing `cashBankRevaluationService` and with `ledgerBalanceEngine` posted entries using the same date. Investigate deleted masters, customer-linked cash accounts, bank links and any implicit openings.
4. Test multi-currency customers, customer CR, loan Dr/Cr, negative cash, USD-only accounts, mixed native amounts, missing rates, malformed legacy entries, XOF alias, no approved generic assets, multiple rate revisions and opposite-direction conflicts.
5. Validate unauthorized role / cross-company requests, performance of aggregate SQL, RLS, and no DB writes. Nothing from this Phase 2 is deployed or activated in the live Net Position.
6. On later integration, refresh only the relevant company/read-model caches after **committed** effective rate saves; avoid retranslation of cached rows and never create duplicate FX adjustment vouchers.

**Phase 2 deliverable:** eligible-account native exposure engine and read-only API committed for verification. Automatic changed-rate presentation in Settings, the daily popup, customer balances, loans, balance sheet and Net Position is still **Phase 3–5**; it is not yet live.
