# Factory Phase 2 — 2026-11-10 continuation and acceptance evidence

**Source of truth:** `docs/factory-unification/execution-tracker.md`  
**Original program merge:** PR #3078.  
**Current follow-up branch:** `fix/factory-phase2-audit-certification-20261110`  
**Phase status:** SOURCE HARDENING IN PROGRESS; NOT RUNTIME CERTIFIED.

## Source implementation completed

Additional main-branch source hardening scoped the selected-company cache keys and failed-closed sensitive views in:
- Daily Production Overview: `my-access`, valuation/report, worker attendance and monthly salary summary reads
- Wipers Re-entry: selected-company permission and tab checks; product, location, category, worker and bale reads; old-company cart/cleanup reset
- Bales History: selected-company access, paginated bales and return-to-stock details; previous-query placeholder reuse removed; selections cleared
- Bale Product History All Months and Month Detail: company-scoped reads, missing/mismatched access and `hideAllCosts` fail closed on cost columns
- Opening Balance Edit, Mix Optimizer, Stock Bale List, Waste Dispatch, Status Builder and Dispatch Batch Detail: scoped reads; some draft cleanup
- Factory Invoice Create: initial `?orderId=` hydration retained while clearing old-company draft state on actual company changes

The new PR branch adds company-scoped Transporters list, statement and account-picker reads and selected-transporter cleanup. Mutating API endpoints, accounting formulas, inventory movements, supplier-average costs, voucher postings and dispatch verification-only semantics were not intentionally changed.

## Actual verification evidence

A connected GitHub source re-read of 11 newly hardened files checked required query-scope and access statements; **11/11 static string checks passed**. This is NOT an executed application or TypeScript test.

Authored but **not executed here**:
- `tests/factory-unification-phase2-permission-cache-followup.test.ts`
- `tests/factory-unification-phase2-transporter-cache.test.ts`
- Other existing Factory Phase 2 regression suites

A checkout is not accessible to this session's local runtime; GitHub source access alone cannot run the repository scripts, start an authenticated Factory browser or exercise real company/role fixtures. A temporary Git clone attempt failed to resolve github.com. No manual CI workflow was launched.

## Blocking acceptance gates

1. Run `node scripts/audit-factory-phase2.mjs --strict` in an actual checkout and triage all remaining findings, including dynamic `useQueries`, `fetchQuery`, local edit state and shared financial-domain screens. Github code searches still find URL-only Factory reads in other modules.
2. Run repository-approved TypeScript and Vitest checks, including the two new suites and existing Phase 2 suites. Retain actual exit codes and failures.
3. Verify backend 200/403 outcomes with actual nonproduction selected-company sessions for View Only, Create Only, User, Admin, Owner and Developer. Test missing permission contexts and other-company IDs, not just button visibility.
4. Exercise company A→B→A with delayed reads, active mutations, cost-hidden data, payroll balances, attendance approvals, POS drafts and saved reports.
5. Confirm backend authorization holds even when requests are manually crafted; verify Factory/ERP/Properties boundaries and cost information cannot cross tenants.
6. Confirm branch merge and resulting main status, then record check artifacts and phase signoff.

## Governance observation

On 2026-11-10, the repository's automatic Release Governance workflow rejected direct main commits because it requires each new main SHA to be associated with a merged pull request. The follow-up therefore moved to a dedicated PR branch. This release-governance failure is not evidence of a TypeScript or Factory application error, and the in-progress Main Certification result must be inspected separately.

**No-go for fully claiming Phase 2 DONE** until source audit and runtime/role evidence above are satisfied. Do not treat an authored test as a passing test or a clean source search as proof of cross-company authorization.
