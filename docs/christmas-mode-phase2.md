# Global Christmas Mode — Phase 2 (snowfall engine)

Branch: `feature/global-christmas-mode` (continues Phase 1).

## Implemented

- `client/src/components/GlobalSnowfall.tsx` adds an interactive-safe snowfall canvas.
- `client/src/app/AuthenticatedAppOverlays.tsx` mounts it **once above every authenticated workspace shell**, covering ERP, Factory / Factory V2, Properties, Supplier Partner and Retail/POS routes. It does not render on the login page.
- A shared `useChristmasMode()` subscription reads the Phase 1 database switch. OFF removes the canvas, ON displays snow; the shared React Query cache updates immediately from Settings; other sessions detect changes through the existing 30-second active-tab polling and focus refresh.
- Flakes fall at randomized speeds and sizes with mild sideways drift; some are six-point crystals.
- Dark mode uses pale white-blue particles; light mode uses subtle blue particles for contrast.
- The canvas has `pointer-events: none` and `aria-hidden`, is fixed to the viewport, does not intercept scanner, touch, keyboard or pointer input, and is hidden on print output.
- Bounded flake counts: desktop 24–64; mobile 12–24. Frame pacing is capped at roughly 30fps desktop / 24fps phone; devicePixelRatio is capped; resizing updates canvas dimensions without inserting DOM elements for each flake.
- `prefers-reduced-motion: reduce` disables the animation. Visibility/pagehide handlers pause the animation in hidden tabs; all animation frame and event listeners are cleaned up on unmount.
- Updated Settings explanation so the switch accurately describes active snowfall.
- Added density-policy tests under `client/src/components/GlobalSnowfall.test.ts` (not executed, per request for no CI checks).

## Excluded intentionally

- Phase 3 sidebar / top bar decorations and Christmas lights.
- Phase 4 enhanced first-login animation.
- Phase 5 broader interactive browser/device validation and performance certification.
- No CI, tests, build, or automated checks were run.
- No merge or deployment was performed; changes remain on the shared feature branch.

## Manual acceptance checklist for the next integration pass

1. Enable global Christmas Mode in Settings, confirm snowfall on ERP/Factory/Properties/retail pages, and verify OFF hides it without reload.
2. Confirm one user's update reaches another connected device within a poll/focus cycle.
3. Check light/dark modes, phone and tablet layouts, scanner camera behavior, menus, dialogs, form input, and scroll.
4. Check reduced-motion OS setting (no snowfall) and switching browser tabs (animation pauses).
5. Confirm printing hides the canvas and logging out destroys the effect.
