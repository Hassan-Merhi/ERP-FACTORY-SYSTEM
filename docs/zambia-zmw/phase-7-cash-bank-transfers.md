# Zambia ZMW integration — Phase 7: Cash, bank, conversion and snapshot translation

**Phase 7 source implementation committed. Independent verification NOT performed.**

Single branch: `feature/zambia-zmw-multicurrency`. User explicitly deferred CI, tests, lint, typechecks and builds to Claude after all implementation phases. No merge, rebase, Render deployment, production schema migration, exchange-rate creation or production accounting data modification.

## Implemented

### Company-specific cash/bank ZMW opening balances

- Extended `shared/schema/accounting.ts` currency input validators to accept ZMW, retaining USD/CFA and the existing native/base opening metadata columns. No migration or conversion of existing stored accounts.
- `server/routes/accountCurrencyRoutes.ts` rejects new ZMW opening metadata for a company not configured with USD base and ZMW display.
- Existing `normalizeOpeningBalanceCurrency` (Phase 6) preserves the native amount, historical rate, original USD base and side. It does NOT use today's exchange rate for old openings.
- Accounts that have unresolved historical native currency amounts remain flagged provisional; they are not silently treated as USD.

### Current cash/bank translation — display/report only

- New `server/services/accounting/cashBankTranslationRates.ts` retrieves the company-scoped, effective-dated USD/ZMW rate only when USD/ZMW is configured; missing/invalid rate is null, not rate=1. It retains the existing Mali CFA/XOF lookup.
- `server/services/accounting/cashBankRevaluationService.ts` and `cashLedgerAccountSummaryService.ts` track *native balances by currency*: USD, CFA and ZMW are never added as if they were all USD. Translate ZMW using `ZMW / ZMW-per-USD` at the selected current snapshot rate. Keep `historicalBaseBalance` unchanged. Report null/provisional translated total when a native currency cannot be translated.
- Added `currentZmwPerUsd` to the cash/bank summary and current Net Position translation response (`server/routes/stats/statsMultiCurrencyRoutes.ts`). Retained `currentCfaPerUsd` for Mali compatibility.
- **IMPORTANT:** `asOf` in these cash/bank functions selects the currency-translation rate cutoff; it does NOT date-cut ledger entries. Any historically dated report must use its dedicated historical aggregation rather than calling this current-state cash/bank function. Phase 10 must verify this boundary.

### Same-company USD / ZMW conversion voucher

- New `server/services/accounting/zambiaCashTransferService.ts` creates a single journal with:
  - One USD-accounting-base credit to the source cash/bank account
  - One USD-accounting-base debit to the destination cash/bank account
  - An explicitly stored original currency amount per line: source/destination USD or ZMW
  - ZMW amount divided by the approved company rate (ZMW per 1 USD), without a Factory USD-per-unit rate
  - The original transaction date, source identity and audit actor
- Transfer input enforces an active Zambia USD/ZMW company and approved date-specific rate, strictly positive two-decimal amount, distinct company-owned active cash/bank accounts, known destination currency, and prohibits transferring between a bank and its own linked ledger representation.
- Requires source native cash/bank balance be fully resolved and contain sufficient funds in that original currency, before the write.
- Uses an advisory transaction lock per company to serialize THIS conversion workflow, and a stable user request ID / existing engine idempotency fingerprint to avoid duplicate replays.
- **Concurrency limitation:** unrelated legacy/manual voucher posting endpoints do not all take the same advisory lock. Therefore this transfer's preflight cannot, on its own, guarantee never to overdraw the account when another writer simultaneously changes source funds. Claude must verify and strengthen authoritative locking/reservations or equivalent cross-writer safeguards before release. Do not claim overdraft race-free security yet.
- Central posting's usual foreign entry validation enforces a strict 6dp balance. `server/services/accounting/centralPostingEngine.ts` permits at most **$0.005** of 6dp base drift for ONLY a source-tagged USD/ZMW transfer with exactly one ZMW and one USD line, then uses the existing rounding-account mechanism for ledger-cent differences. General journals and voucher posting rules are unchanged. No artificial realized gain/loss income entry is generated for a cent-rounding residual.
- Existing engine checks period closure, company ownership, idempotency, target shape, ledger balance and audit. This service creates NEW vouchers only: never resizes or revalues historical vouchers, customer/supplier balances, inventory or openings.

### API and Accounts UI

- `POST /api/accounts/multi-currency/zambia-transfer` in `server/routes/accountCurrencyRoutes.ts` is current-company-scoped, authenticated and restricted to Admin/Owner (Developer accepted by existing role policy).
- New `client/src/pages/accounts/ZambiaCashCurrencyTransfer.tsx` shows cash/bank source and destination, native funds available, transfer date, original currency, amount and dated-rate converted estimate. It rejects incomplete/missing-rate requests and retains request IDs when a network error might require a safe replay.
- The panel mounts under Accounts' View Accounts tab in `client/src/pages/AccountsLegacy.tsx`, but only renders when the active company is USD/ZMW and user's role can post.
- Same-currency USD->USD or ZMW->ZMW cash movements intentionally remain on ordinary journal/accounting workflows; the new dedicated transfer endpoint handles actual USD<->ZMW conversion.

## Claude verification tasks (do NOT run during ChatGPT implementation)

1. Typecheck and lint new import paths/types, including `accountingPostingRequests`, `postErpVoucherTx`, `CompanyContext`, `authenticatedUserQueryOptions` and `ZambiaCashCurrencyTransfer`. Check builds, all CI and tests only after all implementation phases.
2. Verify USD/CFA Mali cash/bank current translation is byte-for-byte equivalent under both legacy and engine attribution; check linked ledger and bank double counting.
3. Check Zambia cash/bank opening creation, historical base lock, native cash/bank buckets and missing-rate provisional flags with authenticated company scope.
4. Verify transfer and reversal accounting: $10->K250 at illustrative 25 ZMW/USD (not a real rate), K250->$10, fractional ngwee, very small amounts, sub-cent rounding, no false gains/profits and actual debit=credit to ledger cent.
5. Verify same-account and linked bank/ledger alias refusal, other-company account ID refusal, insufficient source native currency, unresolved openings, and correct customer/supplier/inventory isolation.
6. Verify stable idempotent replay under network errors and concurrent duplicate posting; check fingerprints reject request ID reuse with changed values.
7. **Release blocker:** check other cash/bank writers and prevent concurrent overdraft races across those endpoints. The advisory lock here only serializes this workflow.
8. Confirm bank/ledger entries and daybook mirrors, new source accounts and existing accounts post correctly with tenant-scoped RLS and accounting-period rules.
9. Ensure all realized FX treatment remains tied to explicit invoice/payment settlement; never revalue receivables/payables, sales, expenses or inventory with current cash rates.
10. Verify current Net Position translation and dated net position are distinct and do not reuse a current-only balance in historical reports.
11. Check accounting source idempotency/audit, cross-company access, viewer/Manager/POS role restrictions, and that Zambia display/rate activation occurs only after approval.

## Phase sequencing

Phase 8: inventory, purchasing and parent intercompany.
Phase 9: Factory.
Phase 10: historical reporting and exports.
Phase 11: full source integration review and one draft PR. Claude then reconciles, runs CI/tests/typecheck/lint/build, repairs issues on THIS branch and signs off. **No merge or deployment without Claude's checks and separate explicit user approval.**

**No tests or production writes were performed in Phase 7.**
