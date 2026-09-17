# Remote Support Phase 16 — Observable rollout quality

**Status:** complete. Historical record for merge `d733bc419a39761421c0030403506b87607a309d` / PR #1568.

## Goal

Turn remote-support rollout quality into measurable latency, success, and audit signals rather than relying on subjective observation of the live viewer.

## Delivered

- Added latency and success metrics for remote support.
- Instrumented binary frame delivery timing.
- Reported viewer-visible frame timing from the actual image load/paint path rather than WebSocket receipt alone.
- Added command sent→executed and command sent→visible-frame timing telemetry.
- Added authenticated command timing telemetry on the server.
- Added observability regression coverage for the Phase 15–16 changes.
- Added a rollout metric verifier and two-user Playwright watch scenario.
- Added a manual canary workflow with real login credentials and permanent audit evidence checks.
- Hardened the workflow with pinned Actions, aligned Node version, binary BufferSource typing fixes, and i18n coverage.

## Invariants established

1. Frame cadence and client→viewer latency are measured as distributions with p95 visibility.
2. Viewer delivery is acknowledged from the image load/render path, not merely packet receipt.
3. Remote command quality includes both execution success and latency to visible effect.
4. Rollout verification requires authenticated, real-environment evidence and permanent audit rows.
5. The metric gate is a live-environment probe; it is not a substitute for an offline pull-request policy gate.

## Follow-on

Phase 17 separates live canary automation from offline PR invariants, makes the live canary nightly against staging, restores HTTP transport recovery, and tightens the original permissive 2500 ms frame/client latency budgets.
