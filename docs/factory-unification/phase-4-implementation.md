# Factory Unification — Phase 4 Implementation Record

**Date:** 2026-11-09  
**Working branch:** `factory/unification-8-phases-2026-11-09`  
**Scope:** Navigation presentation and shared UI primitives. Source-only verification; no CI, tests, browser runs, API requests, or production operations.

## Changes committed
- **Factory navigation metadata:** added `client/src/factory/config/navigationPresentation.ts` to define tab/section hide-key lookup, six Workers hub tab visibility keys, POS/Waste Dispatch switcher destinations, and two Others comparison links. The existing `shared/factoryAccessRegistry.ts` remains the authoritative page/role/route registry. This is presentation metadata only, not a new permission authority.
- **Sidebar:** `FactorySidebar.tsx` now reads the shared Others items, tab restriction lookup and POS/Dispatch route constant instead of maintaining separate literal tables. Existing ordering, labels, query destinations, hide keys, role guards, feature flag checks and special pending/priority restrictions remain.
- **Sales switcher:** `FactorySalesDispatchSwitcher.tsx` uses the same two destinations as the sidebar; `useFactoryNavigationAccess` continues to authorize each route independently.
- **Workers:** `FactoryWorkersHub.tsx` consumes typed tab hide keys and selected-company settings/access cache keys. Access cannot carry over from a mismatched selected company. `useHubQueryState` already handles allowed tab query values; it was retained.
- **Daybook:** `daybook/useFactoryDaybookModel.ts` substitutes the existing `useDebounce(searchQuery, 250)` helper for its private timeout/effect. Search filter delay stays at 250ms; date, voucher, transaction expansion, session persistence and exports untouched.
- **Inventory:** `FactoryLocationInventoryLocationView.tsx` adopts existing `SearchField` for location search without changing the model, inventory totals, frozen product headers, export logic, or cost visibility. Input test ID preserved.
- **Production:** `FactoryProductionTargets.tsx` adopts existing `SearchField` for a controlled filter input. Status logic, target editor, attendance integration, and report calculations untouched.
- **Tests authored:** `tests/factory-unification-phase4-navigation.test.ts` captures Others links, worker tab keys, nested visibility tokens, POS/Dispatch independent route resolution and unknown-tab fallback. Tests have not been executed.

## Compatibility boundaries
1. Do **not** fuse the POS and Waste Dispatch routes; they retain their own access and business workflows.
2. Do **not** change Factory route aliases, top-level guards, hidden field meanings, data exports, report arithmetic or date policies during this UI extraction.
3. The typed navigation file is client-only presentation; never use it as the server authorization boundary. Existing server Factory access restrictions continue to apply.
4. Registry and history docs contain legacy navigation notes; update only verified behavior. Some old route entries are compatibility routes and have not been deleted.

## Review conducted
After writing, re-read each of the eight affected/new files through the connected GitHub API to confirm presence of the new imports, hooks and test cases. No CI was invoked, and no build, Vitest, screenshot or interactive browser checks were run.

## Completion assessment
**Source implementation complete; runtime parity not verified.** A later manual, non-CI verification should cover: TypeScript compile, navigation/role matrix in each company, deep links and query tab persistence, keyboard search focus, inventory location filtering, Production Targets search and 250ms Daybook filter parity. This must be completed before claiming full verified completion or approving a release.

**Merge policy:** All commits remain on the single user-requested branch; main is unchanged.
