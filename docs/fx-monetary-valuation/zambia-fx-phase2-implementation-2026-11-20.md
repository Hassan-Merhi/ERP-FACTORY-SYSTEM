# Zambia FX revaluation duplication — Phase 2 implementation and controlled remediation

**Branch:** `audit/zambia-fx-phase1-20261120` / PR #3357  
**Status:** Code protection and DB-free regression fixtures implemented. **Production correction is deliberately NOT executed by GitHub commits**. Follow this review runbook only after all CI gates pass and the new code is deployed in a verified environment.

## 1. Code changes

1. `systemAccounts.ts`: lookup by canonical FX account *name* now checks `account_type`. An existing `Asset` named `FX Revaluation Gain/Loss` returns `type_differs` rather than `reused_by_name`. The automatic writer refuses to post to a wrong-category counter account. No account is silently renamed or retyped.
2. `legacyManualFxGuard.ts`: automatic FX revaluation checks for active manual journal vouchers with an FX revaluation description, FX counter-line, and native USD `IDENTITY` movement against a cash/bank/customer/loan account. These could represent revaluation booked as a genuine native USD cash movement. The route returns a `skipped` reason naming conflicting vouchers; it does not post again. A live reversal unblocks the guard. The check runs before posting and once more under the revaluation posting lock.
3. `fxRevaluationAmount.ts`: the amount posted is **round(current translated USD to cents) − round(ledger book closing USD to cents)**, not raw current translation minus the six-decimal source historical basis. The formula matches how the Balance Engine and Net Position actually present posted cash book balances and is idempotent on repeat saves.
4. `fxRevaluationPosting.ts` uses both safeguards. All other foreign monetary categories follow the same posted-cent rule; the per-account output retains original ZMW-native zero.
5. `tests/system-accounts-registry.test.ts` adds a persisted wrong-type legacy FX account scenario; `tests/zambia-fx-revaluation-phase2.test.ts` adds deterministic 20.8→20.9 math, total USD 45.63, idempotency, no redundant virtual FX line after correction and reversal behavior.

## 2. Authoritative data (production read-only snapshot, Nov 20)

**Zambia** company ID 19, USD base, ZMW display. Effective rate 20.8 on 2026-11-18 and 20.9 on 2026-11-19. Manually created `JV-19-2026-000001` (voucher 18113) on Nov 19 has:

- USD Cr 11.60 to KITWE CASH `KITCAS` (ledger 4334; native USD `IDENTITY`).
- USD Cr 34.03 to LUSAKA CASH `LUSCAS` (ledger 4335; native USD `IDENTITY`).
- USD Dr 45.63 to `FXREVGAI` (ledger 4404), account incorrectly typed `Asset`.
- The voucher is active, source `manual-journal`, unreversed as of audit.
- Native ZMW sale receipts: KITWE 68,530; LUSAKA 161,050.
- No automatic FX revaluation postings were found for this company as of audit.

**Cents-based proof, after a proper native-zero revaluation:**

| Account | USD posted BEFORE FX | Native ZMW | USD at 20.9 (round 2dp) | Correct USD base-only adjustment | USD posted AFTER FX |
| --- | ---: | ---: | ---: | ---: | ---: |
| KITWE | 3,290.55 | 68,530 | 3,278.95 | -11.60 | 3,278.95 |
| LUSAKA | 7,739.77 | 161,050 | 7,705.74 | -34.03 | 7,705.74 |
| Total | 11,030.32 | 229,580 | 10,984.69 | -45.63 | 10,984.69 |

The current manual journal already reduced USD ledger cash by these exact amounts, but incorrectly reduced their *native USD bucket*. Do NOT simply add a second FX voucher or hide the synthetic liability.

## 3. Production repair sequence — gated, explicit, audited, not automatically run

Before any production write, take a backup and a read-only before-snapshot and verify the company is still ID 19, the rate is still 20.9, voucher 18113 still has the three exact lines, account 4404 is still `Asset`, there is no live reversal, and there are no later cash movements or automatic FX journals requiring a fresh recalculation. If any assumption fails, STOP and re-audit. Do not apply direct SQL edits to voucher rows.

Authorized Admin/Owner flow, using the application's *existing audited endpoints* after Phase 2 code passes testing:

1. As the Zambia company, reclassify only ledger account **4404** `FXREVGAI` from `Asset` to `Indirect Expense` through the standard account update (`PUT /api/ledger-accounts/4404`, `{"accountType":"Indirect Expense"}`). Require a privileged accounting editor. Do not touch code/name, opening, or historic entries.
2. Reverse **only** `JV-19-2026-000001` through the standard controlled reversal route (`POST /api/vouchers/18113/reverse`), with a clear reason, approved open-period reversal date and verification that there was no previous reversal. The original is retained, and the new audited mirror must cancel all three USD-native journal lines.
3. Save/re-save the **existing** applicable USD/ZMW rate 20.9 through `POST /api/exchange-rates` (Admin/Owner/Developer, with the original effective date verified). Once the manual voucher has a live reversal, the legacy guard permits the new *automatic* FX revaluation. Its cash lines must be `BASE_ONLY_REVALUATION` with transaction currency ZMW and **zero native amount**, USD Cr KITWE 11.60 / LUSAKA 34.03, and USD Dr 45.63 to the now correctly classified FX P&L counter-account. Its source type must be `fx-unrealized-revaluation`.
4. Verify that there is exactly one live, properly sourced automatic FX revaluation (net of the original/reversal pair); cash ZMW amounts remain 68,530 / 161,050 and USD displayed cash closes at 3,278.95 / 7,705.74. The visible virtual `FX_UNREALIZED_LOSS` should disappear except for independently supported residual exposures. The FX P&L account should not appear as an asset.
5. Repeat the same-rate save in a controlled test environment and confirm `nothing_to_post` and no additional journal. Verify as-of history, source audit, balance sheet, P&L, Net Position and $0.32 independent Sales Report comparison separately. **Do not force Sales Cost Profit to equal Net Position**; they use different valuation scopes.

**Critical transaction sequencing:** Reclassifying and reversing are privileged accounting writes. They can temporarily change report presentation until the new journal is posted. Plan this during a controlled maintenance window with a database snapshot; a failed step requires accounting review rather than editing vouchers by hand.

## 4. Required validation

- DB-free: `npx vitest run tests/zambia-fx-revaluation-phase2.test.ts tests/monetary-fx-phase6-reconciliation.test.ts`.
- Database test environment: `npx vitest run tests/system-accounts-registry.test.ts` (requires disposable DB).
- `npm run check`, `npm run build`, `npm run lint` plus CI policy checks.
- After code deployment **only in a test environment**, create an actual native-ZMW fixture; enter a manual FX journal with the unsafe native-USD convention; verify the guard skips. Reverse it, reclass the FX account and re-save the 20.9 rate; verify one journal and native-zero lines. Compare all balances with the table above.
- Production data repair, production deployment and merge to main are **outside** the GitHub code branch itself and have not been executed by this Phase 2 change.

## 5. Stop/go controls

Do not ship a fix that simply removes the displayed synthetic `FX_UNREALIZED_LOSS`, manually subtracts a liability, changes existing cash native currency values, or posts a second FX loss without reversing the original. Do not auto-correct live financial history on page load or rate-save.

**Acceptance:** Type guard fails closed, old manual FX prevents a second posting, corrected journal is base-only and idempotent, P&L classification is correct after reviewed account edit, only one economic FX loss remains, and the ledger and reports reconcile with explicit audit evidence.
