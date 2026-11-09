# Factory Unification — Execution Tracker

**Repository:** Hassan-Merhi/ERP-FACTORY-SYSTEM  
**Single working branch:** `factory/unification-8-phases-2026-11-09`  
**Started:** 2026-11-09  
**Merge policy:** No merge into `main` by this implementation. User will arrange a later merge and Claude-led fixes on `main`.  
**Verification policy:** No CI runs/checks requested. Record source checks and explicitly label runtime/test gaps. Do not confuse CI-free with regression-free.

| Phase | Name | State | Evidence / next gate |
|---|---|---|---|
| 1 | Inventory & baseline | **IN PROGRESS** | `docs/factory-unification/phase-1-baseline.md` contains 62 registry keys, 151 route declarations and targeted cache/default/capability evidence; exhaustive source inventory and UI/API fixture capture remain |
| 2 | Permissions & cache isolation | **IN PROGRESS** | Shared capability map, dispatch/server role policy, selected-company Containers/OTW/inventory keys and characterization tests committed. Exhaustive key audit and real-role/runtime checks outstanding; see `docs/factory-unification/phase-2-implementation.md` |
| 3 | Config & status presentation | NOT STARTED | Typed settings, workflow-specific status labels |
| 4 | Navigation & common UI | NOT STARTED | Reconcile navigation metadata and adopt existing UI primitives |
| 5 | Attendance & scanning | NOT STARTED | Common dates, approvals and scanner lifecycle, preserve effects |
| 6 | Stock allocation & proformas | NOT STARTED | V5 shared editor; preserve V2/V3 compatibility |
| 7 | Reports & historical accounting | NOT STARTED | Read-model contracts, historical totals characterization |
| 8 | Final regression & documentation | NOT STARTED | Manual/source regression and documentation without CI |

## Completion protocol
- Mark a phase **DONE** only after its recorded deliverables and source-level validations are complete. Runtime-dependent claims must either be verified or explicitly labeled unverified.
- Update this tracker in a commit after each phase; record paths, commit SHAs, exclusions and unresolved risks.
- Do not alter financial postings, historical costs or inventory movements as a side effect of UI unification.
- Keep all work on the same branch. Any future merge or production changes are outside this tracker.

## History
- 2026-11-09: Phase 2 source changes and unexecuted regression test cases committed; **not** marked DONE because exhaustive cache audit and manual runtime verification remain.
- 2026-11-09: Branch established; Phase 1 source inventory and initial evidence committed. Phase 1 remains in progress because runtime/UI/API baseline fixtures and exhaustive inventory have not been captured.
