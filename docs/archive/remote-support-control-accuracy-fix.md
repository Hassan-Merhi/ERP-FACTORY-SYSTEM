# Remote support — control accuracy fix

## Scope

Corrects four control-accuracy defects reported as "remote mouse doesn't
work". It does not expand control beyond the authenticated ERP tab and does
not weaken any existing permission, password, sensitive-action, rollout, or
audit protection. No SQL or schema migration is required.

This supersedes the Phase 11 rejection behavior and the Phase 7
`visualViewport` mapping; both phase docs remain in `docs/archive/` as
history.

## One coordinate space

Phase 7 mapped normalized points through `window.visualViewport` while the
capture engine photographs the **layout viewport**
(`window.innerWidth × window.innerHeight` at `scrollX/scrollY`). On a
pinch-zoomed or visually offset browser the two viewports disagree, so:

- clicks landed away from where the controller aimed, and
- the Phase 11 staleness check compared the frame's `innerWidth` against the
  live `visualViewport.width` and reported every frame as stale — every click
  and scroll was dropped.

There is now exactly one coordinate space: normalized `0..1` over the
photographed layout viewport.

- The controller normalizes pointer input against the frame's rendered
  content box (`object-fit: contain` letterboxing included), derived from the
  image's natural dimensions or the `data-frame-viewport-*` snapshot.
- The target maps points back through the same layout-viewport space for
  pointer display, click hit testing, and scroll anchoring
  (`mapRemoteMouseFramePoint`).
- `visualViewport` offsets/scale no longer participate in any mapping. The
  `visualScale` field is still captured, sanitized, and forwarded as
  diagnostic metadata.

## Remap instead of reject

Phase 11 ignored click/scroll commands whose frame viewport had scrolled,
resized, or zoomed more than 2 px / 0.01 scale since capture, with reason
`stale-frame-viewport`. In practice almost every command was stale — frames
arrive every ~2 s while the employee scrolls constantly — so the controller
saw "The screen changed since this frame was captured" and remote clicking
felt dead.

The target now remaps the normalized point through document space:

```
documentX = frame.scrollX + x · frame.width
clientX   = documentX − live.scrollX        (clamped into the live viewport)
```

Pure scroll drift cancels exactly, so a click keeps landing on the content
the controller aimed at, even after the employee (or an earlier remote
command) scrolled. Resize and zoom drift remap best-effort through the same
formula instead of being dropped.

The only remaining rejection is `frame-point-offscreen`: the remapped point
fell outside the live viewport (beyond a 2 px edge slop), meaning the aimed
content is no longer visible and there is nothing accurate to click. The
controller message for the old `stale-frame-viewport` reason was replaced
with an off-screen message.

## Scroll is exempt from frame staleness

Scrolling is precisely what invalidates the captured scroll position: the
first remote scroll changed `scrollY`, so every subsequent scroll command
was compared against a frame captured before the scroll and dropped as
stale. Remote scrolling died after one command until the next frame
arrived.

Scroll commands no longer pass any frame-staleness gate. Their anchor point
is still remapped through the frame snapshot so the correct scroll container
is chosen, and the click allowlist is irrelevant to scrolls (they never
activate controls).

## `deltaMode` fixed

The controller forwarded `event.deltaX/deltaY` raw. Wheel deltas are only
pixels when `deltaMode` is `DOM_DELTA_PIXEL`:

- Firefox reports lines (`deltaY ≈ 3` per notch), which the target's
  `scrollBy` treated as 3 px — no visible scrolling.
- Page-mode platforms report whole pages, which scrolled ~1 px.

`normalizeRemoteWheelDelta` now converts on the controller, where the event
and its units live: lines × 40 px (the standard normalize-wheel heuristic,
restoring ~120 px per notch) and pages × the captured frame's viewport size
(1024×768 fallback). The target only ever receives pixel deltas; the server
bounds (±1200) are unchanged.

## Malformed snapshots and legacy controllers

The pre-existing tolerance is preserved: a missing or malformed frame
snapshot is dropped, not rejected, and the command falls back to the
live-viewport mapping (verified by focused tests, one of which had itself
rotted — it read `frameViewport` off the phase-10 publication wrapper
instead of `.command` — and is repaired here).

## Known limitation — RTL page scroll

`buildViewportMetadata` clamps `scrollX` to `>= 0`, and the screen-feed
upload sanitizer (`sanitizeScreenFeedViewport`) enforces that bound, so an
RTL page that is already horizontally scrolled at capture time records
`scrollX: 0`. Remapping such a frame shifts the click horizontally by the
clamped amount (the click still passes the full allowlist). When the scroll
happens *after* capture — the common case — remapping is exact. Before this
fix both cases were rejected outright. Lifting the bound requires changing
the shared screen-feed viewport metadata contract and is deliberately left
out of scope.

## Preserved protections

This change does not alter:

- controller ownership and exact-tab binding;
- password-confirmation requirements;
- runtime and rollout flags;
- command rate limits (pointer 20/s, click 4/s, scroll 12/s; ±1200 delta
  bounds);
- sensitive-route blocking;
- protected-element and action allowlists (they still gate every click
  after remap);
- keyboard-field safety;
- command auditing.

## Verification

Focused coverage verifies:

- one-space mapping: `visualViewport` offsets/scale no longer shift points;
  pointer display, hit testing, and scroll anchoring share one transform;
- remap: scrolled/horizontally-drifted/resized/zoomed frames remap and
  execute; off-screen aim points are ignored with `frame-point-offscreen`;
- scroll exemption: a scroll command executes against a frame the scroll
  itself made stale, with a remapped anchor;
- `deltaMode`: pixel passthrough, line ×40, page × frame size, fallbacks;
- letterboxing: pointer input normalizes against the frame content box, and
  letterbox-bar clicks produce no command;
- overlay wiring: line/page/pixel wheel events POST pixel deltas; click and
  scroll payloads carry the frame snapshot;
- server snapshot sanitization, forwarding, and malformed-snapshot tolerance
  (repaired assertions).
