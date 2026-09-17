# Remote mouse control accuracy (task 13)

Symptom was "remote mouse doesn't work". Four defects compounded in the
remote-support control path (`client/src/hooks/remote-mouse-control-policy.ts`,
`RemoteMouseControllerOverlay.tsx`, `RemoteMouseControlTarget.tsx`):

1. **Two coordinate spaces.** The capture engine photographs the *layout*
   viewport (`innerWidth/innerHeight` at `scrollX/scrollY`) but Phase 7 mapped
   points through `window.visualViewport`. With pinch zoom/offsets the frame
   and the mapping disagree → clicks land offset, and the Phase 11 staleness
   check (frame `innerWidth` vs live `visualViewport.width`) flags EVERY frame
   stale → every click/scroll dropped. Fix: one space = normalized 0..1 over
   the photographed layout viewport; `mapRemoteMouseFramePoint` is the single
   mapping for pointer display, hit testing, and scroll anchoring;
   `visualViewport` no longer participates in mapping (visualScale is metadata
   only).
2. **Reject instead of remap.** `stale-frame-viewport` ignored any command
   whose frame drifted >2 px — but frames arrive ~every 2 s while the employee
   scrolls, so nearly everything was rejected. Fix: remap through document
   space (`docX = frame.scrollX + x·frame.width; clientX = docX −
   live.scrollX`, clamped). Only a point that remaps outside the live viewport
   is ignored, with reason `frame-point-offscreen` (2 px edge slop).
3. **Scroll self-staleness.** The first remote scroll changes `scrollY`, so
   every later scroll command was "stale" vs the pre-scroll frame → scrolling
   died after one command. Fix: scroll is exempt from frame staleness; only
   its anchor is remapped.
4. **`deltaMode` ignored.** Firefox sends line-mode deltas (≈3/notch) → target
   scrolled 3 px; page-mode → ~1 px. Fix: `normalizeRemoteWheelDelta` on the
   controller (line ×40 px, page × frame viewport size); the target only ever
   receives pixels.

Gotchas:

- The controller also normalizes against the *rendered content box*
  (`object-fit: contain` letterboxing), from `naturalWidth` or the
  `data-frame-viewport-*` snapshot — jsdom images never decode
  (`naturalWidth === 0`), so component tests must stamp the dataset.
- `publishRemoteMouseCommand` returns a `{ command, supersededCommandIds }`
  publication (phase 10) — assertions must read `.command`;
  `tests/remote-control-command-service.test.ts` had rotted this way on main.
- Wheel normalization MUST live on the controller (the event's units are a
  property of the controller's browser); the server just bounds ±1200.
- The old `stale-frame-viewport` UI message was replaced by the
  `frame-point-offscreen` message in `remoteSupportPhase5Translations.ts`
  (en/ar/fr).
