# Phase 18 — control surface coverage and RTL accuracy

Phase 18 extends the remote-control safe surface beyond the sidebar, makes per-route coverage measurable, and fixes RTL horizontal-scroll coordinate drift. It depends on the Phase 17.2 binary transport path.

## 18.1 — Annotate beyond the sidebar

`client/src/hooks/remote-control-surface-coverage.ts` must no longer limit automatic safe navigation annotation to `[data-sidebar='sidebar']`, `[data-sidebar='content']`, and `[data-testid*='sidebar']`.

Requirements:

- Cover real navigation/control landmarks such as the app shell/top bar, navigation regions, command palette/menu regions, tab strips, pagination controls, row-openers, and toolbars where controls are demonstrably navigation/read-only safe.
- Language-independent classification only. Semantic matching may use `aria-label`, `title`, `data-testid`, roles, element type, same-origin `href`, and explicit remote-control safety attributes. It must not depend on visible text/textContent, so EN/FR/AR renderings behave identically.
- Existing blocked/sensitive/destructive gates remain fail-closed and take precedence over automatic annotation.
- Same-origin navigation checks remain in force.
- Add regression tests proving controls outside the sidebar are covered and visible-text-only lookalikes are not classified.

## 18.2 — Per-route reachability ratchet

Extend `scripts/generate-remote-control-action-registry.mjs` (or a dedicated verifier invoked by the same CI path) to emit a deterministic per-route remote-control reachability report for the client route tables.

Requirements:

- Report every literal client route and whether it has a reachable reviewed remote-control surface, including the source evidence used for that determination.
- Do not use a global percentage threshold: some routes are intentionally all-sensitive or redirect-only.
- Add an exact reviewed unreachable-route allowance to `config/ci-ratchet-allowances.json`.
- CI fails when a newly introduced route is unreachable without an explicit reviewed allowance.
- When an allowed route gains reachability, the stale allowance must be removable/ratchetable rather than silently becoming permanent debt.
- Keep the existing generated action registry exactness checks intact.

## 18.3 — RTL `scrollX` and protocol v2

Negative horizontal offsets are valid in RTL Chromium layouts and must survive capture, sanitization, transport, and command remapping.

Required production changes:

1. `client/src/hooks/screen-feed-capture-engine.ts`: stop clamping `window.scrollX` to zero in captured viewport metadata; keep finite rounding and keep `scrollY` non-negative.
2. `server/services/screenFeedService.ts`: accept finite `scrollX` in the symmetric supported range while retaining the existing positive bound magnitude and all other viewport validation.
3. `server/services/remoteControlCommandService.ts`: make `sanitizeRemoteMouseFrameViewport` accept the same symmetric negative `scrollX` range; keep `scrollY` non-negative.
4. `shared/remoteSupportTransport.ts`: current producers emit binary protocol/header version 2. Updated decoders remain able to accept protocol v1 frames from independently deployed older Capacitor builds, while v2 is the contract that permits negative RTL `scrollX`. Packet-prefix and JSON-header versions must agree.

The existing target-side remapping (`finiteOffset` / frame→document→live viewport math) is sign-symmetric and should not be weakened or special-cased.

## Verification

Add/extend focused tests for:

- non-sidebar semantic control annotation;
- EN/FR/AR independence (no visible-text classifier dependency);
- per-route reachability report and exact ratchet behavior;
- negative RTL `scrollX` through capture metadata, screen-feed sanitizer, command sanitizer, binary v2 encode/decode, and target-side remapping;
- v1 binary decode compatibility and mismatched prefix/header-version rejection;
- existing blocked/sensitive controls remaining blocked.

Run the focused remote-support tests, the registry/reachability verifier, TypeScript check, and relevant repository audit/CI checks. Do not bypass checks or loosen unrelated ratchets.