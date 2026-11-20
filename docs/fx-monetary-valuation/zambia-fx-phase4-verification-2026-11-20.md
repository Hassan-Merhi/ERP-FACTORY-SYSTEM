# Zambia FX — Phase 4 controlled correction evidence and operational gate

**Branch** `audit/zambia-fx-phase1-20261120`, draft PR #3357.

## Scope and operational boundary

Phase 4 provides a **read-only, authenticated correction-verification API** and deterministic accounting invariants for the manual FX revaluation mistake. It relies on the application's existing audited, permission-controlled account editor, voucher reversal and rate-save/revaluation posting services. It **does not run those financial mutations**, automatically post a replacement, or enable a bypass of company permissions.

GET `/api/accounting/monetary-fx/manual-revaluation/verify?voucherId=18113`

Authentication: Admin, Owner or Developer; company ID is taken **only from the current server session**. It cannot be supplied or changed through the request. A missing original returns 404. Verification has an independent read-only transaction and is a reporting tool, **not permission to execute a correction**.

A successful verification requires all the following:

1. The source is an active, posted manual journal, with a recognizable FX counter and exactly balancing USD-native monetary movements. No additional unexplained entries are accepted.
2. FX Revaluation Gain/Loss is correctly classified as `Indirect Expense`. A wrong-type account remains untouched and the report explains the required reviewed reclassification.
3. The original manual voucher has **one active, exact, append-only reversal**. Every original debit/credit and original transaction currency line must be mirrored, and the reversal must originate from the audited `voucher-reversal` posting source.
4. A **single** automatic journal has correctly sourced `fx-unrealized-revaluation` metadata. Each affected account has one `BASE_ONLY_REVALUATION` adjustment for the same USD amount that the original manual journal deducted, with a **foreign transaction currency and zero original-currency debit/credit**. It includes a balancing USD `IDENTITY` P&L counter.
5. No second matching revaluation journal, partial conflicting journal or ordinary native-currency-changing FX journal exists on an affected monetary account. Foreign-currency exposure is unchanged by the FX replacement.
6. The posted USD closing balance of each affected cash/loan/customer account equals its current-rate translated USD closing to the nearest cent. Provisional or missing-rate balances cannot be certified.

Results use `status`:

| Status | Meaning | Operator step |
| --- | --- | --- |
| `blocked` | Original, reversal, amount, account, native currency or duplicate evidence is inconsistent | Investigate; no further posting |
| `reclassify_fx_account` | Original identified but FX P&L counter is still an Asset | Admin/Owner reviews account 4404 and uses existing audited account update |
| `reverse_original` | Original and account classification valid, no reversal | Admin/Owner reviews period and posts exact original reversal through existing audited route |
| `post_base_only` | Exact reversal verified, but no proper replacement | Admin/Owner verifies rate, then uses the existing company rate-save/revaluation path |
| `verified` | One matching, native-zero replacement and translated USD equality verified | Reconcile financial statements and sign off; do not repost |

## Zambia reference, from the Phase 1–3 read-only audit

- Company ID 19 (Zambia), base USD / reporting ZMW; FX quote 20.9 ZMW/USD on 2026-11-19.
- Original manual voucher 18113, `JV-19-2026-000001`: Dr $45.63 to incorrectly typed `FXREVGAI` (account 4404); Cr KITWE CASH $11.60 (account 4334); Cr LUSAKA CASH $34.03 (account 4335).
- Expected ledger after audited reversal and correctly posted base-only revaluation:

| Account | Original native ZMW | Original booked USD before revaluation | Revaluation USD | Correct closing USD |
| --- | ---: | ---: | ---: | ---: |
| KITWE CASH | 68,530 | 3,290.55 | -11.60 | 3,278.95 |
| LUSAKA CASH | 161,050 | 7,739.77 | -34.03 | 7,705.74 |
| Total | 229,580 | 11,030.32 | -45.63 | 10,984.69 |

## Production operational runbook (no automatic execution)

**Release prerequisites:** full green CI, current verified backup/snapshot with restore test, explicit accounting signoff, open reversal date, and an exclusive maintenance window. Repeat the read-only verification and current-rate review immediately before each write; stop on drift. The preview and verification endpoints are not a write authorization, because their independent read snapshots do not hold locks on financial posting.

1. Confirm Zambia/current company, voucher 18113, current rate, and correct counter account identity. Review all later postings and other FX journals.
2. If correctly authorized, reclassify account 4404 via the existing controlled account update. Do not alter opening, code, name or historical voucher lines.
3. Reverse voucher 18113 via `POST /api/vouchers/18113/reverse`, with reason and a verified open accounting period. Ensure the original stays visible and the reversal is exactly mirrored.
4. Verify `post_base_only` before using the existing saved 20.9 rate/revaluation route. Never create another manual cash FX journal. Confirm native ZMW is preserved and the replacement source and native-zero entries match exactly.
5. Require `verified`, cross-check balance sheet, Net Position, P&L, account/voucher audit history, and repeat-save idempotency. Stop if any phase is blocked or if the ledger/rate/source snapshots changed.

This PR must **not** be merged/deployed merely because a read-only verifier exists. Production data repairs remain separate, reviewable accounting operations.

## Automated verification

`tests/zambia-fx-phase4-audit.test.ts` covers each stage and rejection: wrong account classification, missing/incorrect/multiple reversals, duplicate and native-currency-changing FX journals, incorrect counter posting, missing or provisional foreign evidence, and closing translation drift.

The Phase 3 disposable-DB test verifies the underlying central posting/reversal/revaluation engine. Final Phase 4 acceptance also requires typecheck, lint/format, repository audits, route access, backend DB tests, build, frontend, security checks and a direct test-environment dry run of the verification endpoint.
