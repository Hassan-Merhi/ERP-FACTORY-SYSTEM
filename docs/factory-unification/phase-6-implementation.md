# Factory Unification — Phase 6 Implementation Record

**Date:** 2026-11-09  
**Branch:** `factory/unification-8-phases-2026-11-09`  
**Assessment:** SOURCE IMPLEMENTATION COMPLETE — RUNTIME UNVERIFIED.  
**Policy:** No CI, no merge to main, no financial or inventory mutations.

## Implemented
1. `client/src/lib/factoryAllocationReadModel.ts` provides one typed, pure V5 proforma article projection. It copies the existing server-provided `stockAvailable`, `totalLoaded`, `expectedToLoad` and `freeToPromise` values; no recalculation, rounding, currency conversion, or write side effect is introduced. The existing product-name ordering is preserved.
2. Both `FactoryStockAllocationV5CreateProforma.tsx` and `FactoryStockAllocationV5EditProforma.tsx` consume that same projection and URL-first selected-company query keys. Create Only and existing-record edit restrictions remain unchanged; full-data fetches still use `fetchAllV5AllocationData`.
3. `factorystockallocationv5/useFactoryStockAllocationV5Model.tsx` uses the existing `useDebounce` with the same 300ms delay and company-scoped keys for V5 allocation, unlinked-order and recently-cancelled-container reads. Legacy URL-prefix invalidations are retained.
4. `factoryproformas/useFactoryProformasModel.ts` scopes my-access, customers, summary, expanded proforma and destination-specific customer price-list reads to the selected company. Proforma price UI is hidden until matching-company access arrives, and also honors `hideAllCosts`.
5. `tests/factory-unification-phase6.test.ts` captures no-recalculation / six-decimal-input-preservation projection parity, original-row immutability, and company-specific V5 cache keys. Tests were authored, **not executed**.
6. Post-write source reads confirmed imports and key use in the above files; no compiler, browser, database or API checks were run.

## Preservation boundaries
- **V5 is the canonical Stock Allocation sidebar destination.** V2 (`/factory/stock-allocation`) and V3 (`/factory/stock-allocation-v3`) remain live compatibility routes. Neither page nor its backend handlers were changed in Phase 6.
- Server stock totals, order states, proforma reservation capacity/concurrency, linked customer orders, physical bale scans, supplier-average cost basis, partially received container balances and six-decimal cost persistence remain authoritative in existing server modules.
- No changes were made to costing services (`server/services/factory/factoryCostingEngine.ts`, `rawStockLockedRate.ts`, `baleCostBasis.ts`), proforma creation/update handlers, reservation SQL, stock write APIs, invoice posting, vouchers or ledger.
- A proforma editor receives display/read-model values only. Neither dispatch verification nor allocation UI can create unintended stock/accounting effects from this Phase 6 change.
- Only cache/read-model consolidation is claimed here: **this is not a complete migration of all V2/V3 business features into V5**, and no claim of live parity or permission enforcement based on UI alone is made.
- No SQL migrations, production adjustments, data backfills, six-decimal rounding changes, or supplier rate changes.

## Outstanding verification / release gates
- Run source TypeScript check and Phase 6 Vitest characterization tests in a checkout (no CI required); none run during this turn.
- Compare V2/V3/V5 with a safe nonproduction dataset for stock on hand, reserved, loading, free-to-promise, partial offload, linked containers, proforma add/edit/cancel/restore and historical cost precision.
- Exercise company A → B → A, delayed reads, role-level proforma price visibility and relevant query invalidations.
- Verify reservation concurrency and proforma oversell prevention with isolated backend transactions; no runtime API access was used.
- Preserve supplier-average costing, voucher and historical accounting independently before any merge/release.

**Result:** Source consolidation complete; acceptance as fully DONE awaits the above runtime/financial parity gates. The user retains control of merging, with Claude expected to handle main after merge.
