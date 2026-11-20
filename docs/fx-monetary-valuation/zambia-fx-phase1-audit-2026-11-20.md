# Zambia FX revaluation duplication — Phase 1 audit (2026-11-20)

**Status:** Phase 1 complete — production data inspected read-only; remediation NOT performed.
**Scope:** Zambia ERP company `ZM` (company ID 19), USD base / ZMW display, rate change 20.8 → 20.9 ZMW per USD on 2026-11-19.
**Production resource:** Render HMD SYSTEM's attached primary database. The test-copy, QA-agent, and other unrelated databases were not used.
**Evidence rules:** All database calls used Render's read-only query tool with `app.current_company_id = '19'` set for the statement. No data or schema writes, account edits, voucher reversals/deletions, rate saves, or deployment.

## 1. Original voucher — verified against production tables

| Property | Verified value |
| --- | --- |
| Voucher | `JV-19-2026-000001` (voucher ID 18113) |
| Date | 2026-11-19 |
| Created (UTC) | 2026-11-19 14:22:01.856946 |
| Type | Journal; posted by engine |
| Source | `accounting_posting_requests.source_type = manual-journal` |
| Amount | USD 45.63; balanced Dr = Cr |
| Deleted/reversed | Neither (at audit time) |
| Description | FX Revaluation — Rate 20.8 → 20.9 ZMW (FX loss) |

All three voucher lines are native-USD, `rate_convention = IDENTITY` and `historical_exchange_rate = 1`:

| Posting target | Ledger ID | Code | Debit USD | Credit USD | Transaction currency | Native amount |
| --- | ---: | --- | ---: | ---: | --- | ---: |
| KITWE CASH | 4334 | KITCAS | 0 | 11.60 | USD | credit 11.60 |
| LUSAKA CASH | 4335 | LUSCAS | 0 | 34.03 | USD | credit 34.03 |
| FX Revaluation Gain/Loss | 4404 | FXREVGAI | 45.63 | 0 | USD | debit 45.63 |

These entries reduce *book USD cash*, but their cash lines are not foreign-currency `BASE_ONLY_REVALUATION` lines. They are additional native-USD cash movements in the monetary valuation model. Voucher is balanced, but the revaluation source representation is incompatible with the current recognition/overlay contract.

## 2. FX ledger classification defect — confirmed

The actual Zambia account `FXREVGAI`, ID 4404, name `FX Revaluation Gain/Loss`, is classified **`Asset`** with blank sub-type, zero opening balance, and is active. This is the only posted entry to that account in the reviewed history. The reporting asset classifier therefore includes its $45.63 debit under **What We Have**, exactly as seen in the screenshot.

The source registry declares the canonical system account `FX-REVALUATION` as **`Indirect Expense`**. The registry's `ensureSystemAccounts` reuses a matching account **by name** without validating the existing account's type in that by-name path (`reused_by_name`); a different-code/wrong-type legacy account can therefore remain in service.

Files:
- `server/services/accounting/systemAccounts.ts` — canonical system definition, `statusFor` by-name fallback, no by-name type guard.
- `server/netPositionHelper.ts` — excludes income/expense but includes debit `Asset` balances.

**Required:** Treat FX revaluation as P&L, not as a net-position asset. Fix both misclassification detection and the source/posting conventions; simply retyping this account on live data would leave the still-unrealized synthetic FX row and double-reduce Net Position.

## 3. Saved company rates and automatic posting evidence

Zambia `exchange_rates`:

- 2026-11-18 effective USD→ZMW = **20.800000** (saved 2026-11-18 07:03:32 UTC).
- 2026-11-19 effective USD→ZMW = **20.900000** (saved 2026-11-19 13:52:36 UTC).
- Manual journal created about 29 minutes after the 20.9 rate save.

No `accounting_posting_requests` for company 19 had an FX/revaluation source type at audit time, and no automatic revaluation voucher was found in the 2026-11-18 through 2026-11-20 transaction list. This is *not* proof that all future rate changes are safe; it only establishes the posting record as of the audit. The automatic routine described in `docs/fx-monetary-valuation/automatic-revaluation-journal.md` is now present in source, but its deployment/availability at the time of the 2026-11-19 rate save was not certified.

Files:
- `server/services/accounting/fxRevaluationPosting.ts` — automatic `fx-unrealized-revaluation` posting, `BASE_ONLY_REVALUATION` native-zero movements, `FX-REVALUATION` counter-line.
- `server/routes/exchangeRateRoutes.ts` — rate-save entry point.

## 4. Cash source attribution and why the $45.62 virtual loss remains

The *active* posted history for each target cash account comprises exactly two ZMW POS sale debits and one native-USD manual FX credit. No cash account openings were found (openings are 0).

| Cash | Native ZMW from sales | ZMW posted base USD (6dp) | Manual native USD credit | Base USD after manual (6dp) | Net Position visible USD (approx.) |
| --- | ---: | ---: | ---: | ---: | ---: |
| KITWE CASH | 68,530.00 | 3,290.552539 | -11.60 | 3,278.952539 | 3,278.95 |
| LUSAKA CASH | 161,050.00 | 7,739.763526 | -34.03 | 7,705.733526 | 7,705.73 |
| **Total** | **229,580.00** | **11,030.316065** | **-45.63** | **10,984.686065** | **10,984.68** |

At 20.9, retranslation of the ZMW sales alone is approximately USD **10,984.6890**. But the valuation code also carries the separate native USD balance of **-45.63**, so its translated total is approximately **10,939.0590**. Comparing this against the already-reduced book USD cash creates a further apparent translation difference of approximately **-45.6271**. The per-account *display-row* rounding in the FX overlay explains the extra **$45.62** synthetic `FX_UNREALIZED_LOSS` row shown by Net Position.

Important: the FX account's `Asset` debit (+45.63) and the synthetic FX loss liability (-45.62) nearly offset **in Net Position**, while the voucher cash credits already reduced cash (-45.63). Thus the user's current net position may look economically right, even though its lines are wrong and the revaluation expense has been misclassified. Never remove only one of these rows; doing so would create an incorrect additional $45+ position movement.

Source:
- `server/services/accounting/monetaryFxValuationService.ts` — native currency bucket and USD historical-base collector.
- `server/services/accounting/monetaryFxValuationCore.ts` — independent USD and ZMW buckets.
- `server/services/accounting/monetaryFxReportOverlay.ts` — `showFxAsRows` generates `FX_UNREALIZED_LOSS`, rounds by visible account row and includes it in liabilities.
- `server/routes/stats/statsMultiCurrencyRoutes.ts` — live ERP Net Position calls overlay with `showFxAsRows: true`.

## 5. Sales Report vs Net Position clarification

The screenshots give sales cost profit USD 3,506.22; minus manual FX 45.63 is **3,460.59**, while displayed Net Position is **3,460.91** (USD 0.32 difference). This calculation is a diagnostic, **not an accounting identity**: Sales Report is recorded sales less recorded cost, while Net Position is operational assets minus liabilities and may reflect stock, openings, timing, and different report scopes. Phase 1 did not certify the remaining $0.32. No unexplained journal should be created to force the two values to match.

## 6. Phase 2 repair contract — do not execute as part of Phase 1

1. **Preserve the economic intent** and the authoritative original vouchers. Review and approve a controlled reversal/corrective revaluation of `JV-19-2026-000001`, not a direct SQL edit or silent deletion. If posting a replacement, it must be properly native-zero `BASE_ONLY_REVALUATION` on the ZMW monetary balances with an FX P&L counter-account. Round each account independently; KITWE and LUSAKA adjustment split may differ by one cent from the manual voucher.
2. **Fix type mapping safely.** New `FX-REVALUATION` must be an `Indirect Expense`; matching-by-name with incompatible type must fail closed/report a remediation requirement instead of silently reusing. Historical `FXREVGAI` needs a reviewed accounting migration; do not change the live account master in Phase 1.
3. **Count FX exactly once.** Once a revaluation is recognized in book USD by proper native-zero lines, the remaining translated-vs-book delta should be sub-cent (or explicitly provisional). Do not add a synthetic unrealized FX row for an already recognized amount. Verify both per-account and company totals and idempotency on subsequent rate saves.
4. **Keep reporting stable.** No duplicate P&L / Balance Sheet / Net Position rows, no synthetic FX asset, and no unexplained $45.62 loss; true residual unposted differences must remain visible.
5. **Regression gates:** fixture with 20.8→20.9 and Zambia cash balances above, replay same-rate save, multiple saves, reversal and re-post, historical as-of, company isolation, missing foreign evidence, native ZMW invariance, round-to-cent reconciliation, correct account classification, and no accidental production DB writes.

## Phase 1 completion checklist

- [x] Identify authoritative company and rate
- [x] Verify journal ID, source, status, timestamp and all debits/credits
- [x] Verify posting convention/native transaction currency
- [x] Verify cash account type and ledger balances from active entries
- [x] Verify FX account type and opening
- [x] Check automatic revaluation postings for this company
- [x] Trace duplicate presentation to live valuation + wrong account classification
- [x] Identify next-phase remediation gates
- [ ] Phase 2 implementation, test run, accounting correction, merge or deploy — **not authorized by Phase 1 alone**

**Audit conclusion:** Confirmed account setup and posting-convention mismatch. The Net Position currently has competing representations of the same revaluation; do not hide or reclassify one entry in isolation. No mutation was carried out in the audit.
