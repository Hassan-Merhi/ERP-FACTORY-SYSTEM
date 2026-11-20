# Zambia FX — Phase 6 release verification and signoff

**Branch:** `audit/zambia-fx-phase1-20261120` · **PR:** #3357 · **Date:** 2026-11-20

## Scope

Phases 1–5 provide a read-only production audit, posting safeguards, controlled correction preflight, read-only correction verification, and a source-backed Sales Report ↔ Net Position reconciliation. Phase 6 is the release and operational acceptance gate; **it does not authorize financial mutations merely because source code exists**.

## Accounting acceptance criteria

- The 2026-11-19 manual journal `JV-19-2026-000001` (voucher 18113) remains auditable. Its original USD-native cash credits are KITWE $11.60 and LUSAKA $34.03, with a $45.63 FX debit.
- Correct replacement is **one** audited reversal and **one** sourced base-only revaluation with zero native foreign-currency movement; neither a second manual FX expense nor a synthetic FX plug is permitted.
- The FX counter account must be an `Indirect Expense`. The reconciliation must fail closed even if no unique counter account exists (Phase 6 regression added).
- For the audited Zambia snapshot, Sales Report profit $3,506.22, posted-sales difference +$0.01, actual stock relief difference +$0.30, and FX loss -$45.63 reconcile to **book-economic $3,460.90**. The screenshot's $3,460.91 is a historical *display* value, **not** an approval to post a $0.01 or $0.32 adjustment.
- Production account reclassification, reversal and replacement posting require independent finance approval, verified backup/restore, an open accounting period and fresh preflight/verification evidence. No direct SQL edits or historical stock-cost changes.

## Required automated gates (not marked passed without run evidence)

Run on the latest head:

```bash
npm ci
npm run check
npm run format:check
npm run lint
npm run audit:company-scope
npm run audit:write-routes
npm run audit:write-evidence
npm run verify:route-access-coverage
npm run check:security
npm run test:backend
npm run test:frontend
npm run build
```

Database-backed `zambia-fx-phase3.database.test.ts` and `zambia-fx-phase4.database.test.ts` additionally require a **disposable** properly configured PostgreSQL test database; they must never target production. Confirm these tests actually ran, rather than silently skipping due to missing configuration. Check GitHub Actions results, log failures and rerun after repairs.

## Controlled release order

1. Green latest-head CI and security checks; review diff and obtain independent accounting approval.
2. Stage a protected test copy, prove the exact reversal and base-only replacement and assert repeat-save idempotency.
3. Capture a fresh verified backup and restoration evidence. Confirm the original voucher, account master, rate, company and open period are unchanged immediately before each production operation.
4. Only the approved operator can reclassify the FX account and reverse the original through the existing audited UI/API, then trigger the designated company FX rate posting. Stop on any preflight blocker or drift.
5. Require read-only verifier status `verified` and inspect Net Position, P&L, foreign native balances, GL history, and the Phase 5 reconciliation. Do not force an exact match to a stale screenshot.
6. Final reviewer checks one and only one active source-owned FX revaluation journal; archive evidence and signoff before merging/deploying any additional change.

## Current gate state (as of branch changes on 2026-11-20)

**Source remediation:** Phases 1–5 implemented; Phase 6 fail-closed counter-account check and regression added.

**Automated acceptance:** **NOT VERIFIED** — no associated GitHub Actions workflow runs were returned for the latest branch commit through the available GitHub integration. A successful local/typecheck/database result has not been established here.

**Production correction:** **NOT EXECUTED OR AUTHORIZED** by this branch. Keep PR draft, do not merge or deploy until automated acceptance, code review and finance signoff are complete.
