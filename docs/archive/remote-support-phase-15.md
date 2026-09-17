# Remote Support Phase 15 — Presence plane and audit hygiene

**Status:** complete. Historical record for merge `d733bc419a39761421c0030403506b87607a309d` / PR #1568.

## Goal

Remove request-path cleanup and cross-company invalidation pressure from remote-support presence, while giving permanent remote-support audit data a bounded retention policy.

## Delivered

- Moved presence cleanup off normal list and route-change request paths.
- Scoped presence invalidation and history access to the relevant company boundary.
- Added and installed retention/pruning for remote-support audit history.
- Added regressions for tenant-scoped presence realtime behavior and audit retention.
- Documented the retention controls introduced by the phase.

## Invariants established

1. Listing presence does not perform stale-row deletion as part of every read.
2. A route change does not invalidate unrelated companies' admin clients.
3. Presence history access remains tenant-scoped.
4. Remote-support audit history has an explicit retention mechanism rather than unbounded growth.
5. Presence cleanup is operational maintenance, not hidden work on the user-facing hot path.

## Follow-on

Phase 16 added measurable transport, rendering, and command observability so rollout quality could be gated rather than judged from logs alone.
