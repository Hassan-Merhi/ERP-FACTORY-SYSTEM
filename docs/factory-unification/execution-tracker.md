# Factory Unification — Execution Tracker

**Repository:** Hassan-Merhi/ERP-FACTORY-SYSTEM  
**Single working branch:** `factory/unification-8-phases-2026-11-09`  
**Started:** 2026-11-09  
**Merge policy:** No merge into `main` by this implementation. User will arrange a later merge and Claude-led fixes on `main`.  
**Verification policy:** No CI runs/checks requested. Record source checks and explicitly label runtime/test gaps. Do not confuse CI-free with regression-free.

| Phase | Name | State | Evidence / next gate |
|---|---|---|---|
| 1 | Inventory & baseline | **SOURCE DONE — RUNTIME UNVERIFIED** | Complete pinned 62-key access registry, 151-route inventory and 7 source blob SHAs in `phase-1-source-fixture.json`; focused Vitest baseline authored (not run); 12-case manual UI/API capture protocol authored (not captured). See `phase-1-baseline.md` and `phase-1-manual-baseline-protocol.md` |
| 2 | Permissions & cache isolation | **TARGETED SOURCE DONE — FULL AUDIT/RUNTIME OPEN** | High-risk production/attendance, Workers/bonus and nested hubs now use company-scoped reads and matching-company fail-closed access; no server authorization changes. Continuation characterization authored, not run; unscoped reads remain elsewhere. See `docs/factory-unification/phase-2-implementation.md` |
| 3 | Config & status presentation | **SOURCE DONE — RUNTIME UNVERIFIED** | Shared typed UI defaults and independent V5/dispatch/container labels adopted; no migration. Source checks complete, parity tests authored but not run. See `docs/factory-unification/phase-3-implementation.md` |
| 4 | Navigation & common UI | **SOURCE DONE — RUNTIME UNVERIFIED** | Shared nested-nav metadata consumed by sidebar, Workers hub and POS/Dispatch switcher; Daybook debounce and Inventory/Production search controls reuse existing hooks/components. Source review and tests authored (not run); see `docs/factory-unification/phase-4-implementation.md` |
| 5 | Attendance & scanning | **SOURCE DONE — RUNTIME UNVERIFIED** | Shared Beirut date and camera-error/queue feedback helpers consumed by attendance/pressing views; existing scanner gate, server approval and separate offline queues preserved. Tests authored, not run. See `docs/factory-unification/phase-5-implementation.md` |
| 6 | Stock allocation & proformas | **SOURCE DONE — RUNTIME UNVERIFIED** | Shared V5 read-only proforma projection, company-isolated read keys and shared debounce; V2/V3 compatibility and costing/reservations preserved. Tests authored, not run. See `docs/factory-unification/phase-6-implementation.md` |
| 7 | Reports & historical accounting | **SOURCE DONE — RUNTIME UNVERIFIED** | Shared Net Position UI date navigation, Beirut supplier report defaults/range checks, company-scoped supplier read; historical as-of and financial pipeline unchanged. Tests authored, not run. See `docs/factory-unification/phase-7-implementation.md` |
| 8 | Final regression & documentation | NOT STARTED | Manual/source regression and documentation without CI |

## Completion protocol
- Mark a phase **DONE** only after its recorded deliverables and source-level validations are complete. Runtime-dependent claims must either be verified or explicitly labeled unverified.
- Update this tracker in a commit after each phase; record paths, commit SHAs, exclusions and unresolved risks.
- Do not alter financial postings, historical costs or inventory movements as a side effect of UI unification.
- Keep all work on the same branch. Any future merge or production changes are outside this tracker.

## History
- 2026-11-09: Continued Phase 2: scoped staff/attendance, Workers/bonuses, nested hub/settings and inventory reads; fail-closed company-matched controls; added unexecuted source characterization tests. High-risk source hardening done, exhaustive repo-wide and runtime audit still open; no CI.
- 2026-11-09: Continued Phase 1: corrected source parser for commented Production Bonuses entry, pinned all 62 registry pages / 151 routes, created read-only regression test and non-CI manual capture matrix; source inventory complete while UI/API fixtures and runtime checks remain unverified.
- 2026-11-09: Phase 7 source consolidation committed: common Net Position date navigation and supplier report calendar validation. Historical as-of and financial posting/valuation are unchanged; runtime and historical parity unverified. No CI.
- 2026-11-09: Phase 6 source-level V5/proforma read-model consolidation committed; V2/V3 retained and all financial/stock mutation paths preserved. Runtime precision/concurrency parity remains outstanding. No CI.
- 2026-11-09: Phase 5 source-level attendance/scanner UI unification committed; preserving authoritative prior-day approval, pressing queue/idempotency and dispatch stock/accounting isolation. Runtime tests pending; no CI.
- 2026-11-09: Phase 4 navigation presentation and shared UI migrations committed; source complete, runtime parity not verified (no CI). No route, permission, or business-logic refactors attempted.
- 2026-11-09: Phase 3 typed configuration/status presentation committed; marked source complete, runtime unverified (no CI per request). Optional company rename preference is a read adapter only, not a persisted new setting.
- 2026-11-09: Phase 2 source changes and unexecuted regression test cases committed; **not** marked DONE because exhaustive cache audit and manual runtime verification remain.
- 2026-11-09: Branch established; Phase 1 source inventory and initial evidence committed. Phase 1 remains in progress because runtime/UI/API baseline fixtures and exhaustive inventory have not been captured.
