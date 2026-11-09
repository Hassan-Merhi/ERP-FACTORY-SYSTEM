# Factory Unification — Phase 2 Implementation Record

**Date:** 2026-11-09  
**Branch:** `factory/unification-8-phases-2026-11-09`  
**Validation performed:** Connected GitHub source reads and post-write re-reads only. No CI, local test execution, database connection, browser, or runtime API checks.

## Implemented
1. Added `shared/factoryActionCapabilities.ts` as a typed, pure capability map for dispatch close, discrepancy approval, dispatch reopen, and bonus management. This preserves the preexisting role matrix, including Developer access to dispatch supervision but not bonus management.
2. Applied the same typed policy to client dispatch lifecycle buttons and to server dispatch close/reopen checks. Existing server-side company resolution, Factory tab authorization, transaction and audit logic are retained; this helper does not replace route authorization.
3. Applied the bonus capability map to the Production Targets management UI without changing payroll or bonus calculations.
4. Scoped Factory Containers and OTW Tracking query keys to the selected company while preserving URL-first base prefixes and the OTW suffix, allowing existing prefix invalidation and grouped cache updates.
5. Scoped inventory access, settings, inventory location, available-bales, product, category and customer read keys to company. Cost display is hidden until matching selected-company access is present, including the `hideAllCosts` flag.
6. Added `tests/factory-unification-phase2.test.ts` with role matrix and cache-key characterization cases (authored, not executed).

## Known constraints and remaining verification
- `CompanyContext.tsx` already cancels and removes company-session cache entries during switches. This was retained.
- This is **not yet an exhaustive pass over all Factory read keys**. Additional screens, including staff tracking and domain-specific financial pages, still use some unscoped URL keys and must be audited before the cache workstream is called complete.
- Selected-company `/api/factory/my-access` is reused instead of introducing a separate permission endpoint. No new backend permission payload has been added.
- The selected-company access object is only an input to client controls; server authorization remains authoritative and may reject requests regardless of UI visibility.
- No running repository checkout was available (the connected GitHub API was used; direct Git transport was unavailable). No unit tests, TypeScript checks, UI snapshots or server 403 tests have been run. Do not claim full regression parity.
- Do not merge into main automatically. No CI runs requested.

## Outstanding completion gates
- Audit remaining Factory reads and invalidations, ensuring selected-company correctness without breaking URL-first query functions.
- Confirm the action matrix against real scoped View Only, Create Only, Admin, Owner and Developer sessions.
- Execute the authored unit tests in a suitable checkout and verify cross-company A→B→A and cache cancellation under delayed HTTP responses (manual execution, not CI).
- Verify server 403/200 matrix and signed dispatch closure immutability with a safe nonproduction dataset.

**State: IN PROGRESS — Phase 2 source changes landed; full policy/cache regression remains unverified.**
