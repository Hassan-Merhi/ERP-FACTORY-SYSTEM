# Factory Unification — Phase 3 Implementation Record

**Branch:** `factory/unification-8-phases-2026-11-09`  
**Date:** 2026-11-09  
**Status:** Source implementation completed; runtime verification outstanding.  
**CI:** Not run (requested). No merges, migrations, backfills, stock recodes, accounting mutations or production changes performed.

## Deliverables
1. `shared/factoryUiDefaults.ts` defines typed Factory rename UI defaults, including the historical `HMD13` code-prefix fallback. `factoryRenameDefaults(settings)` accepts optional `renameCodePrefix` from a company-scoped response but **does not assume it is persisted by the existing server**.
2. `client/src/pages/factory/factorysettings/useFactorySettingsModel.ts` reads settings through `companyQueryKey("/api/factory/settings", selectedCompany?.id)`, resets editable rename input/preview on company change, and derives the next default from selected-company settings when supplied. Other Factory Settings default values stay in the existing `factorysettings/utils.ts` to avoid a second source of truth.
3. `FactorySettingsAdminTools.tsx` uses the shared legacy prefix for the placeholder instead of embedding another literal.
4. `shared/factoryStatusPresentation.ts` defines **separate** typed presentation vocabularies for Stock Allocation V5, dispatch trips and containers. Unknown statuses retain their original raw display value rather than being silently reinterpreted.
5. V5 utils, Factory Dispatch page/lifecycle and Container OTW helpers consume the relevant presentation contract. Existing badges/color schemes and server-side workflow transitions are untouched.
6. `tests/factory-unification-phase3.test.ts` contains source-level parity cases for defaults, optional overrides, legacy PENDING_VERIFICATION label, distinct workflows and unknown statuses.

## Important compatibility limitations
- The V5 `PENDING_VERIFICATION` display remains **"Verified"** because Phase 3 targets rendering parity, not a change in order-state meaning. Do not infer that it is the same backend state as `VERIFIED`.
- Dispatch `OPEN/CLOSED/CANCELLED` remains distinct from Stock Allocation states. Dispatch verification must not create invoices, adjust stock or post accounting.
- This pass does **not** introduce a database column or new settings endpoint to persist `renameCodePrefix`; the optional field is a typed adapter only. To make it a fully editable persisted company setting requires a separately specified, reviewed API/storage contract.
- No transition-policy changes were made; authoritative server transitions remain in their existing workflow handlers. V2/V3 status vocabularies remain distinct and are not migrated to V5.
- Company defaults from existing server settings continue to take precedence where already provided. No automatic renaming, storage rewrite or historical migration occurs.

## Verification evidence
- Confirmed through connected GitHub post-write file reads: new shared contracts, import usage and selected-company query scope.
- Regression cases authored, **not run**. No TypeScript build, live API, role session, screenshots or UI checks executed.
- Phase 3 is complete as a **source-level consolidation work item**, not signed off for runtime parity or production.

## Required later non-CI checks
- Type-check in runnable checkout; run `tests/factory-unification-phase3.test.ts`.
- Company A → B → A settings reload and no carryover of rename preview; ensure user-entered prefix remains until settings/refetch or company switch.
- V5, dispatch and container badge snapshots, including `PENDING_VERIFICATION` parity.
- Verify server rejects unsupported status transitions and that all stock/accounting effects are unchanged.

**Merge into main:** intentionally deferred to user/Claude workflow.
