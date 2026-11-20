# Zambia FX — Phase 3: correction preflight and disposable-DB verification

**Branch and PR:** `audit/zambia-fx-phase1-20261120` / #3357

## Phase 3 scope

Phase 3 adds an **administrator-only, strictly read-only** correction preflight and a
CI-only, isolated database scenario covering the original Zambia 20.8 → 20.9
revaluation mistake. It is a code/verification phase, not a production financial
posting. The original production voucher must not be deleted or modified.

### Read-only endpoint

`GET /api/accounting/monetary-fx/manual-revaluation/preflight?voucherId=18113`

- Only authenticated **Admin, Owner or Developer**, and only the **currently
  selected company**; `companyId` is never accepted from a query or body.
- The voucher and its entries are read under a company-scoped, repeatable-read,
  read-only snapshot. The monetary valuation is independently evaluated in its
  own read-only transaction. Preview does not hold locks and is **not** an
  authorization to repair: before an actual corrective write, all assumptions
  must be rechecked *inside the write transaction*.
- Returns original voucher number/date and source, posting state, FX
  counter-account ID/code/classification, candidate cash/bank/customer/loan
  balances, native balances by currency, current USD valuation, posted USD
  balances, per-account expected **base-only** adjustments and total.
- A voucher with a missing or wrong source, a deleted/optional/reversal state,
  no original native-USD FX cash movement, unresolved foreign-currency
  evidence, another live manual FX journal, or a non-USD base is blocked.
- A legacy FX asset counter account returns
  `FX_ACCOUNT_RECLASSIFICATION_REQUIRED`; no in-place reclassification occurs.
- An already-reversed original is reported separately; the preview never
  reverses it again.
- Machine-readable statuses: `not_found`, `blocked`, `requires_review`,
  `ready_for_review`, `already_reversed`. The name `ready_for_review`
  explicitly means **an accountant must review**. It does not mean that an
  automatic production correction was performed.

### Current Zambia evidence (read-only Render query)

Voucher `JV-19-2026-000001` is a **$45.63** balanced USD-native manual FX
journal. The following posted-cents totals were verified against active
ledger entries, excluding that manual voucher for the before column:

| Cash | ZMW original | USD before manual | USD after manual | Correct base-only adjustment at 20.9 |
| --- | ---: | ---: | ---: | ---: |
| KITWE CASH | 68,530 | 3,290.55 | 3,278.95 | -11.60 |
| LUSAKA CASH | 161,050 | 7,739.77 | 7,705.74 | -34.03 |
| **Total** | **229,580** | **11,030.32** | **10,984.69** | **-45.63** |

The historical dual-currency `base_*` columns sum to finer 6dp amounts,
but the live **posted** `debit_amount/credit_amount` balances are cents
per original entry, so those are the correct source for a replacement voucher.
The synthetic USD 45.62 liability in the screenshot is *not* proof that a
replacement should be 45.62; it is evidence of the double-recognition bug.

### Regression coverage

- `tests/zambia-fx-phase3-preflight.test.ts` — pure readiness/blocking
  classifications with zero database access.
- `tests/zambia-fx-phase3.database.test.ts` — **CI only**, on a fresh,
  disposable Postgres instance with a unique synthetic company and
  synthetic entries. Reconstructs the two ZMW cash holdings, the incorrect
  Asset counter, manual identity lines and posting source. Verifies preview
  is read-only, explicit reclassification readiness, audited-reversal
  recognition, exactly one subsequent base-only automatic FX journal,
  zero native amounts on those lines and idempotent same-rate replay.

The database test intentionally does not run outside CI, even when a
developer has a `DATABASE_URL`. This prevents an accidental test against
production data. CI must pass before Phase 3 is marked validated.

## Phase 3 completion gates

1. Read-only endpoint and tests committed on the existing PR branch.
2. GitHub TypeScript, lint/format, build and relevant database test green.
3. Verify original production voucher and native exposure again read-only.
4. No production account-classification change, voucher reversal,
   new revaluation, merge or deployment in this phase.

## Phases 4–6 handoff

After this preflight is green, the **controlled correction** is the next
financial operation: take a verified backup; lock/validate current account,
voucher, reversal, company and rate; use existing audited account-update and
voucher-reversal services; post proper native-zero base-only FX adjustment;
verify ledger, P&L and Net Position and repeat-rate idempotency.
Production changes require a reviewed operational release, not an automatic
mutation from this preflight.
