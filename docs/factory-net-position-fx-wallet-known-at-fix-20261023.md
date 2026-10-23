# Factory Net Position — October 23 historical fixes on Claude's active branch

**Repository:** Hassan-Merhi/ERP-FACTORY-SYSTEM  
**Target branch / existing open PR:** `feature/unified-accounting-erp-factory-rentals` / #2423  
**Status:** Source changes committed. **No tests, CI, type-check, lint, build, branch merge/rebase, deployment or database writes were run.**

## Why this branch

The historical Net Position PR #2424 has already been merged to `main` and its branch was removed. The live Claude accounting work exists on `feature/unified-accounting-erp-factory-rentals`, which already contains the 9-phase history engine. This branch was 5 commits behind `main` when audited, so the important #2429 Raw Material fix is ported explicitly without pulling/rebasing unrelated main commits. Avoid resurrecting the deleted original feature branch.

## Fix 1 — FX agent wallet recorded-at and company-local cutoff

Changed:

- `server/services/factory/fxAgentWalletDb.ts`
- `server/routes/factory/employee-pos/employeeNetPositionRoutes.ts`

For the historical Net Position **only** (when `scope.isHistorical`):

1. Wallet activation requires both `wallet.activated_on <= asOf` and `wallet.created_at < start of next company-local day` (`TIMESTAMPTZ`). Also confirm that the linked ledger account existed by that cutoff (`created_at` UTC-naive) and was not yet soft-deleted.
2. Each FX wallet operation requires **both** `effective_date <= asOf` and `created_at < next local midnight` (`TIMESTAMPTZ`). Backdated movements entered later do not leak into older reports.
3. A date mismatch between a query's `asOf` and its history scope raises `HISTORICAL_FX_WALLET_DATE_MISMATCH` rather than showing a false balance.
4. `getFxAgentWalletSnapshot` compares wallet book USD to the **same historical ledger balance already reconstructed by Factory Net Position**, which uses effective and recorded cutoffs. Calling an ordinary `getPartyBalance(asOf)` for that comparison would use effective date alone and could incorrectly suppress FX valuation.
5. All other callers (current-day view, FX agent wallet page, settlements and reversals) omit the new optional history argument, so their existing behavior and ledger postings remain unchanged.

**NO** wallet records, vouchers, bank balances, or FX rates are modified.

## Fix 2 — Warn when FX wallet history was backdated

New `server/services/factory/netPositionFxWalletCoverage.ts` adds a read-only count of:

- Wallet rows activated on/before the selected date but physically created afterward.
- FX wallet movements effective on/before the selected date but physically created afterward.

The main Net Position route runs this only for a historical date and only if the optional FX-agent tables exist. It appends the findings to the existing `historyCoverage.gaps`, which are included in the visible `historyWarnings`. A missing/invalid count fails closed, never masquerading as zero gaps.

`historyCompleteness` remains **partial** regardless of zero counts: old wallet opening amounts and other legacy source edits are not comprehensively versioned.

## Fix 3 — Preserve latest Raw Material correction (#2429)

The Claude branch predates `main` commit `228804453bcdd17a0d89aeab4210575cff7199e8` (#2429). The historical Raw Material replay now consumes from a container's **actual supplier** only when the container has a corresponding raw-stock record. A recorded supplier conflicting with the container is flagged as `HISTORICAL_RAW_SOURCE_OWNER_CONFLICT`.

This is necessary to avoid reverting the live production correction for 31 legacy mix-source rows / 146,208 kg. No legacy mix record was rewritten. The frontend historical warning text now describes this mismatch.

When Claude later incorporates newer `main`, confirm the #2429 change is preserved exactly once, with no conflict resolution silently choosing the older supplier key.

## Prepared verification (authored, NOT executed)

`tests/factory-net-position-fx-wallet-cutoff.test.ts` includes:

- Historical wallet activated-on and recorded-at SQL predicates.
- TIMESTAMPTZ recorded-at SQL predicates for FX wallet movements and company timezone.
- Preservation of current-day queries (no new historical cutoff for existing callers).
- Historical wallet's book comparison to the authoritative dated Factory ledger, not a second asOf-only ledger.
- Date/scope mismatch refusal.
- Reportable counts of late-entered wallet activations and operations, including malformed counter refusal.

The tests compile SQL through Drizzle without changing any database. These tests have NOT been run; Claude should execute and strengthen them with a PostgreSQL fixture as appropriate.

## Outstanding source-data limitations / production read-only reconciliation

- Old scans lacking original `scanned_at`, historical deleted voucher lines, raw-stock cumulative entries without receipt events, unversioned product prices, reverified orders, cancelled/restored scans and previous account openings cannot be made exact merely by changing a query.
- Existing `historyCompleteness: partial` and warnings must stay visible; do not fill original event times or alter accounting vouchers.
- Previous authorized read-only findings for company 12: 24,603 live bale scans and 1,658 archived scans without timestamps; 78 cumulative raw-stock rows with no individual receipt history; 31 mismatched legacy mix-source owners already reconciled in #2429. Those are source-evidence counts, **not** proof of an identical dollar discrepancy in every October historical snapshot.
- **October 23 query blocker:** a fresh independent read-only Oct 19/20/21 SQL query through the Render PostgreSQL connector failed with `app.current_company_id is required for tenant data access`. No records were written. Do **not** interpret this as a successful reconciliation or bypass the tenant isolation guard.
- Claude must run read-only verification only via an authorized company-scoped application session or its approved isolation/replica test environment. Cross-check three full Factory Net Position snapshots, both Cost/Selling valuation modes, all customer/supplier/account/OTW/inventory/rental/payroll breakdowns and the FX wallet rows against original transactions.
- Check that a wallet operation effective Oct 19 but entered Oct 21 is excluded on Oct 19 and Oct 20 and included Oct 21. Test a 21:30 UTC Oct 19 event against `Asia/Beirut` (that is Oct 20 company-local).
- Check current-day reports and FX wallet settlements are unchanged. Verify no duplicate raw material or supplier valuation after incorporating #2429.

## Next steps for Claude

1. Stay on `feature/unified-accounting-erp-factory-rentals`. Do **not** create another branch for these fixes.
2. Fetch the latest branch, review these commits, and run TypeScript, focused tests, full CI and accounting regression checks in approved nonproduction infrastructure (user delegated CI to Claude).
3. Add isolated PostgreSQL fixture tests for backdated FX operations/activations and midnight boundary, including branch reconvergence with main's #2429.
4. Repair any failures on the same branch. Independently reconcile real historical dates using properly authorized **read-only tenant-scoped access**.
5. Keep `historyCompleteness` partial for unversioned records. Explain each unknown instead of inventing or altering amounts.
6. Do **not** merge, rebase, deploy, apply migrations/indexes, or modify production vouchers without a new explicit user instruction.

**No CI, test execution, merge, rebase, deployment, migrations, index creation or production accounting modifications performed here.**
