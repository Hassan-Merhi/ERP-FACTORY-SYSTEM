# Remote Support Phase 17 — Transport resilience and target-side cost

**Status:** current reference. Binary WebSocket remains the normal transport; HTTP is an authenticated recovery path.

## 17.1 Transport resilience

### Producer

`sendScreenFeedBinaryFrame` first attempts the versioned binary WebSocket packet. If the socket is unavailable or the binary send fails, the client immediately reuses the already-encoded JPEG `Blob` for `POST /api/screen-feed`.

The fallback intentionally does **not** call `canvas.toDataURL()` and does not perform a second JPEG encode. `FileReader.readAsDataURL(blob)` only converts the already-compressed JPEG bytes into the legacy endpoint's required representation. This restores recovery while minimizing extra work on the employee's tab.

The fallback body carries the same `tabId`, click/cursor/viewport/capture metadata, and client capture timestamp as the binary header. Server-side storage remains keyed by `screenFeedStoreKey(userId, tabId)`.

### Viewer

The viewer remembers its exact `{userId, tabId}` binding even while the WebSocket is unavailable. During that period it conditionally polls:

`GET /api/screen-feed/:userId?tabId=...`

The client retains the server ETag, sends `If-None-Match`, treats `304 Not Modified` as success without retransmitting a frame, and converts a returned legacy JPEG into the same in-memory binary-frame shape consumed by the normal viewer. Polling stops as soon as the WebSocket becomes ready and is aborted/cleaned up when the viewer unbinds.

The server recovery routes remain subject to their existing login/controller permission checks, tenant authorization, exact tab key, watch audit, frame-size limits, and conditional-response hardening.

## 17.2 Target-side annotation cost

`installRemoteControlSurfaceCoverage` still performs one full initial annotation, then observes `childList` mutations only.

After initial setup:

- added element roots are queued rather than rescanning the document;
- multiple mutation callbacks are coalesced into one animation frame;
- nested queued roots collapse to the shallowest changed subtree;
- only those changed subtrees are passed to `annotateRemoteControlSurface`;
- coverage attributes are written only when their value actually changes;
- teardown disconnects the observer and cancels pending work.

No attribute observer is needed: the observer remains `childList`-only, so the annotation attributes do not recursively trigger it.

## 17.3 Rollout gate topology

`.github/workflows/remote-support-rollout-e2e.yml` has two different responsibilities:

1. **Pull requests:** run the offline `verify-remote-support-phase17-invariants.mjs` gate. It needs no live URL or credentials and pins protocol/policy properties such as recovery endpoints, ETag/304 fallback, subtree annotation, and the workflow topology itself.
2. **Nightly/manual:** run the real two-user Playwright canary and rollout metric verifier against staging. Scheduled runs read `REMOTE_SUPPORT_STAGING_BASE_URL`; manual runs may override it with `base_url`. Controller and target credentials remain required secrets.

The frame-interval and client→viewer p95 budgets are now **1500 ms** instead of 2500 ms. The prior 2500 ms budget allowed roughly 0.4 frames/second to pass and was too permissive for the live-support target. The nightly report remains the evidence used for future downward ratchets; thresholds should only be relaxed with an explicit documented reason.

Required scheduled-run secrets:

- `REMOTE_SUPPORT_STAGING_BASE_URL`
- `REMOTE_SUPPORT_E2E_CONTROLLER_USERNAME`
- `REMOTE_SUPPORT_E2E_CONTROLLER_PASSWORD`
- `REMOTE_SUPPORT_E2E_TARGET_USERNAME`
- `REMOTE_SUPPORT_E2E_TARGET_PASSWORD`

### What an unconfigured staging target looks like

Until those secrets exist, every scheduled run is red, and that is deliberate
rather than a defect to mute. The canary job stops at its `Require staging
target` step with:

```
REMOTE_SUPPORT_STAGING_BASE_URL is required for scheduled runs, or provide base_url for workflow_dispatch.
```

Read the two jobs separately before treating that red as a transport
regression. `Offline protocol & policy invariants` needs no URL and no
credentials, so it runs on every event and is the job that actually gates
pull requests. `Live staging canary` carries `if: github.event_name !=
'pull_request'`, so it never runs on a pull request at all. A workflow that is
green on every pull request and red on its nightly schedule is therefore the
expected shape of "the invariants hold, the live canary has nowhere to point" —
not evidence that anything regressed.

Setup, by an authorized operator:

1. Add the five secrets above under Settings → Secrets and variables → Actions.
   `REMOTE_SUPPORT_STAGING_BASE_URL` is the staging origin the canary drives,
   with scheme and no trailing path (for example `https://staging.example.com`);
   the canary appends `target_path`, which defaults to `/`.
2. The two credential pairs are ordinary staging application logins, one for the
   controller and one for the target. They must be able to complete a remote
   support session against each other. Never point them at production.
3. Confirm with a manual `workflow_dispatch`. A dispatch may pass `base_url` to
   override the secret for that run, which is the cheapest way to test a
   candidate origin without storing it first — but the four credential secrets
   are read from the repository regardless, so they must exist even for a
   dispatch.

The base URL alone is not sufficient: it is only the first thing checked.
With the URL set and the credentials missing, the run gets further and then
fails in the Playwright canary instead.

## 17.4 Historical documentation

The implementation history that previously lived mainly in merge commit bodies is archived as:

- `docs/archive/remote-support-phase-13.md` — binary, tab-scoped transport;
- `docs/archive/remote-support-phase-14.md` — conservative usable control coverage;
- `docs/archive/remote-support-phase-15.md` — presence/audit hygiene;
- `docs/archive/remote-support-phase-16.md` — rollout observability and measurement.

## Non-negotiable invariants

- Binary WebSocket is the primary transport; HTTP is recovery only.
- Recovery is exact-tab and tenant-authorized.
- A socket outage must not turn a produced frame into a long capture-failure backoff when HTTP recovery is healthy.
- Conditional polling must not repeatedly retransmit an unchanged image.
- Mutation-driven remote-control coverage must not rescan the whole document for every child insertion.
- PR validation must not depend on staging credentials.
- Live rollout quality must be measured against a real authenticated environment.
