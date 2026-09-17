# Remote Support Phase 14 — Usable, conservative control coverage

**Status:** complete. Historical record for merge `7515677dac364a1594b1976704429be4cd648d1a` / PR #1565.

## Goal

Make remote support useful across ordinary ERP navigation and safe filter/search fields without broadening the control boundary over accounting, payment, credential, destructive, or other sensitive inputs.

## Delivered

- Added conservative field classification for safe search/filter/name/code/date-style inputs.
- Kept credential, financial, approval, transfer, offload, delete, and other sensitive descriptors excluded.
- Added navigation annotations only inside real sidebar roots rather than arbitrary `aside` elements.
- Allowed explicitly safe controls inside forms while leaving unannotated form actions fail-closed.
- Installed target-tab surface coverage and aligned the remote action registry with the deployed annotation rules.
- Added exact allowlist, sidebar-boundary, keyboard classifier, Enter-key, and safe-form regression coverage.
- Kept protected containers (`data-remote-control-blocked`, sensitive/destructive surfaces, and screen-feed ignored surfaces) outside remote-control coverage.

## Invariants established

1. Remote-control coverage is opt-in by annotation, never inferred from a generic clickable element.
2. Sensitive or destructive controls stay blocked even if nested inside otherwise safe navigation or form surfaces.
3. Sidebar navigation must be same-origin and must live inside a recognized sidebar root.
4. Unknown form actions remain denied.
5. Keyboard behavior is constrained by the same safe-surface policy as pointer actions.

## Follow-on

Phase 17 reduces the employee-tab cost of maintaining these annotations by coalescing child-list mutations and scanning only newly added subtrees.
