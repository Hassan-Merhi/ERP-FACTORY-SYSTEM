# Factory Unification — Phase 8 Source Regression & Release Handoff

**Date:** 2026-11-09  
**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**One branch:** `factory/unification-8-phases-2026-11-09`  
**Phase 8 state:** SOURCE AUDIT AND DOCUMENTATION DONE — RUNTIME/FINANCIAL RELEASE GATES OPEN  
**Change policy:** No CI run, no merge into `main`, no production database or financial inventory writes.

## Scope covered

This phase consolidates source verification and regression evidence for the eight-phase Factory UI/config/navigation/access/attendance/scanner/stock/proforma/report program. Existing source characterization tests for Phases 1–7 remain authoritative tests to run in a checkout; they are NOT test results.

### Source-review results observed through the connected GitHub repository

| Source assertion | Result | Meaning |
|---|---|---|
| Shared Factory access registry has 62 page definitions | SOURCE CHECK PASS | Matching the pinned Phase 1 baseline |
| Inner Factory router has 151 declared unique paths | SOURCE CHECK PASS | Original aliases, V2/V3/V5 routes and utility routes still declared |
| Full registry metadata equals pinned JSON baseline | SOURCE CHECK PASS | No unexpected page registry drift |
| Route declaration sequence equals pinned JSON baseline | SOURCE CHECK PASS | No route source drift |
| Nine focused cross-file source fragments for company access, allocation projection, historical cutoff and attendance | SOURCE CHECK PASS | Expected strings found in current branch; not behavioral tests |
| `scripts/verify-factory-unification-phase8.mjs` committed | SOURCE CHECK PASS | A dependency-free Node source gate exists; **not executed** |
| Existing Phase 1–7 characterization suites | AUTHORED | The suites were not executed here |
| TypeScript build, Vitest, browser, API, DB, role matrix, stock/ledger parity | NOT RUN | No runnable checkout/test environment was accessible |

The source-check results do **not** establish operational correctness.

## Phase 8 fixes committed

- `client/src/pages/factory/factoryworkers/useFactoryWorkersModel.tsx`: disabled six company-sensitive worker reads until a selected company exists; keys remain URL-first for legacy invalidations. No worker payroll or amount-due arithmetic changed.
- `client/src/pages/factory/FactoryProductionTargets.tsx`: include selected-company ID in the effect that clears local editable production rows/dialogs when the query scope changes. No target, bonus or payroll calculations changed.
- `client/src/pages/factory/factoryproformas/useFactoryProformasModel.ts`: selected-company-scope the location picker cache and disable its read until a selected company exists.
- `scripts/verify-factory-unification-phase8.mjs`: dependency-free, read-only Node source audit for registry, routing, selected-company guards, V5 projection, accounting cutoff and suite presence. It performs **no** server calls or writes, does not start CI and is not a Vitest replacement.

## Local/manual verification instructions (no CI)

A developer with a safe checkout and the project's installed dependencies should run:

```bash
git switch factory/unification-8-phases-2026-11-09
node scripts/verify-factory-unification-phase8.mjs
npx tsc --noEmit
npx vitest run \
  tests/factory-unification-phase1-baseline.test.ts \
  tests/factory-unification-phase2.test.ts \
  tests/factory-unification-phase2-continuation.test.ts \
  tests/factory-unification-phase3.test.ts \
  tests/factory-unification-phase4-navigation.test.ts \
  tests/factory-unification-phase5.test.ts \
  tests/factory-unification-phase6.test.ts \
  tests/factory-unification-phase7.test.ts
```

These commands are suggested manual actions, **not commands already run**. TypeScript command may need adjustment to repository tsconfig/project scripts; use the project's own approved check command if so. Do not turn on GitHub Actions or CI.

### Mandatory manual P0 checks before release
| Gate | Required evidence | Current state |
|---|---|---|
| Role + permission 200/403 matrix | View Only, Create Only, Factory User, Admin, Owner, Developer per-company; bonus Admin/Owner only | OPEN |
| Company A→B→A, delayed responses | No stale data, hidden cost, worker amount-due, approvals or pricing crosses company | OPEN |
| Factory router/sidebar | Deep links and query tabs, legacy Stock Allocation V2/V3 and canonical V5, back links | OPEN |
| Inventory & proforma | Read-only V2/V3/V5 free-to-promise comparison, reservation locks, concurrent oversell prevention in isolated fixture | OPEN |
| Pressing scanner | Browser permission/cleanup, duplicate gate, offline queue, true confirmed vs queued, retry idempotency | OPEN |
| Attendance | Beirut DST/midnight, historical Admin approval, denied roles | OPEN |
| Loading dispatch | Frozen closure/verification report and discrepancy reopen, **no** unintended stock/invoice/voucher posts | OPEN |
| Historical accounting | Known-at-cutoff, incomplete-history warnings, supplier-average and six-decimal cost, FX, vouchers, reversal | OPEN |
| Exports | Report date ranges and PDF/Excel output, hidden costs, column integrity | OPEN |
| TypeScript + focused tests | Actual command log with exit codes and failing tests if any | OPEN |

The preexisting detailed Phase 1 baseline capture matrix is in `docs/factory-unification/phase-1-manual-baseline-protocol.md`.

## Financial and operational scope exclusions

No accounting route, finance posting/reversal code, supplier average-cost engine, inventory stock movement, proforma reservation transaction, pressing confirmation endpoint, attendance authorization, production bonus posting, SQL schema or migration was changed in Phase 8. Historical report dates remain company-local and require the recorded-at/effective-date known-at-cutoff contract.

V5 remains the canonical Stock Allocation interface. V2 and V3 remain live compatibility routes pending parity signoff. Pressing's persistent queue and dispatch's separate in-memory queue are intentionally not collapsed into one storage model.

## Open source/program risks

1. Phase 2 is **not an exhaustive repository-wide permission/cache audit**. Remaining Factory-related queries in other pages, dialogs and shared domain modules can be URL-only. `CompanyContext` clears session cache on switch, but that does not eliminate the need for runtime verification or guarantee no local React state lingers.
2. UI tab hiding is not server enforcement. API authorization requires 200/403 matrix checks on server handlers.
3. Source tests are unexecuted. No TypeScript diagnostics or app/browser check was observed; hard-coded expectations might need correction after a real run.
4. Stock and financial parity cannot be inferred from untouched handlers or static UI checks.
5. Company change during an active edit, offline pending synchronization, or report export is not verified.
6. Phase 8 source verification is **not** approval to merge into `main` or deploy.

## Merge/handoff guidance

**Recommended release decision: NO-GO pending open gates above.** Preserve this unification branch for a controlled later merge. The user retains merge control and intends to have Claude handle main-branch fixes. Before a merge: run manual source/test commands, capture redacted role/route/financial parity evidence, fix actual failures, and review all branch diff changes. Do not silently rebase/migrate data or alter historical costing to make UI tests pass.

### References
- `docs/factory-unification/execution-tracker.md`
- `docs/factory-unification/phase-1-baseline.md`
- `docs/factory-unification/phase-1-source-fixture.json`
- `docs/factory-unification/phase-1-manual-baseline-protocol.md`
- `docs/factory-unification/phase-2-implementation.md` through `phase-7-implementation.md`
- `tests/factory-unification-phase1-baseline.test.ts`, `tests/factory-unification-phase2.test.ts`, `tests/factory-unification-phase2-continuation.test.ts`, `tests/factory-unification-phase3.test.ts`, `tests/factory-unification-phase4-navigation.test.ts`, `tests/factory-unification-phase5.test.ts`, `tests/factory-unification-phase6.test.ts`, `tests/factory-unification-phase7.test.ts`

**Bottom line:** Phase 8 static source review, final source fixups, read-only regression audit and handoff documentation are complete. Full end-to-end verification and release acceptance remain outstanding.
