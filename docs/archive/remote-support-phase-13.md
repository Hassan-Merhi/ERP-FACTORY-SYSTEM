# Remote Support Phase 13 — Binary, tab-scoped transport

**Status:** complete. Historical record for merge `7515677dac364a1594b1976704429be4cd648d1a` / PR #1565.

## Goal

Remove the base64/JSON frame path from the normal hot path and make screen sharing and remote-control traffic identify the exact ERP browser tab being watched.

## Delivered

- Added the versioned binary remote-support packet protocol and authenticated `/ws` frame transport.
- JPEG frames are encoded as blobs and sent as binary bytes instead of base64 embedded in JSON.
- Relayed frames are keyed by user and tab; viewer binding targets the selected tab rather than a user-wide feed.
- Producer, viewer, cursor/status traffic, mouse commands, and keyboard commands moved onto the authenticated WebSocket hot path.
- Recovery state and the retained legacy HTTP routes were made tab-aware with `screenFeedStoreKey`.
- Controller context requests and reconciles the exact selected target tab.
- Removed the legacy 650 ms upload ceiling and remeasured capture cadence after the transport rewrite.
- Added WebSocket command backpressure and regression coverage for the binary packet protocol.
- Removed the producer bind race by relying on tab heartbeat identity.

## Invariants established

1. Binary WebSocket is the primary frame transport.
2. A frame or command is scoped to an authenticated user and a concrete `tabId`.
3. Legacy recovery storage is keyed with the same user/tab identity and cannot collapse multiple tabs into one feed.
4. The binary packet has explicit protocol, header, and frame-size limits.
5. Remote commands remain fail-closed unless the target surface is explicitly authorized.

## Follow-on

Phase 14 expanded usable safe-control coverage. Phase 17 later restored the retained HTTP routes as an active recovery path without making base64 the normal transport again.
