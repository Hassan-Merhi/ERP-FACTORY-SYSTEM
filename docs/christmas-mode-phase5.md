# Global Christmas Mode — Phase 5: performance, scanner and accessibility hardening

Branch: `feature/global-christmas-mode` (same branch as Phases 1–4).

## Code changes completed

1. **Scanner priority.** Two camera-acquiring components use ref-counted leases from `client/src/lib/seasonalCameraActivity.ts`:
   - `MobileBarcodeScanner.tsx`: camera dialog used by shared ERP, Factory and retail scanning.
   - `ContinuousPressingScanner.tsx`: pressing-worker continuous camera scanner.
   A lease is acquired **after** a successful `getUserMedia` result, and released on camera interruption, decoder startup failure, manual fallback, close/unmount, pagehide, or hidden-tab release. Calls to release are idempotent; two active capture leases require both releases.
2. **Centralized global effect policy.** `AuthenticatedAppOverlays.tsx` retains one global Christmas Mode query subscription and subscribes to live scanner activity with `useSyncExternalStore`. Camera-active state temporarily prevents the canvas and login burst from mounting; the global Christmas Mode setting itself remains ON.
3. **Reduced resource consumption.** `useSeasonalMotionRestricted` honors `prefers-reduced-motion: reduce`, `prefers-reduced-data: reduce`, and `navigator.connection.saveData`. It listens for preference changes, supports legacy MediaQueryList listeners for older Safari, and handles missing support safely. Restricted users retain static ornaments, but snowfall and the four-second welcome burst are suppressed.
4. **Print and background lifecycle.** The snowfall canvas already stopped on hidden tabs/pagehide; it now also clears and stops before print and resumes after print if still enabled. All listeners and scheduled animation frames are removed during unmount.
5. **Mobile resizing.** Canvas backing-store reallocation is coalesced to one `requestAnimationFrame` for bursts of resize events (software keyboard, phone rotation, fold/unfold). Previous Phase 2 pixel / FPS / particle caps remain in force.
6. **CSS performance.** Decorative light/star pulsing stops while a camera capture is active or the OS requests reduced data. All ornament hit-testing stays disabled; there are no new popups, input handlers, remote assets, or layout changes.
7. **Test coverage added (not executed):**
   - `client/src/lib/seasonalCameraActivity.test.ts`: concurrent cameras, ref-counted release, duplicate-release safety and notification lifecycle.
   - `client/src/hooks/useSeasonalMotionRestricted.test.ts`: reduced motion, reduced data, Save-Data and unsupported-browser fallback.
   - Existing Phase 2 snow-density and Phase 4 one-time-login marker tests remain unchanged.

## Manual acceptance matrix for Phase 6 / release review

| Area | Acceptance requirement |
| --- | --- |
| ERP / Factory / Properties / Supplier Partner / Retail | Master toggle ON enables regular snowfall, header lights and tree accents; OFF removes them; state persists between company switches |
| Mobile barcode camera | Snowfall stops when camera capture begins and returns after camera closes; camera stays responsive; barcode confirmation/duplicate alerts remain unchanged |
| Pressing-worker scanner | No animated layer during camera capture; scanning continues uninterrupted; camera interruption, retry and pagehide do not leak pause leases |
| POS | Touch, checkout, payments, barcode scan, dialogs, search and keyboard inputs remain available without overlays capturing pointers |
| iPhone / Android | Portrait, landscape, narrow screen, software keyboard, high DPR, display changes and lock/unlock have no noticeable slowdown |
| Reduced motion / data saver | No moving snow / login burst under either preference; static holiday ornaments remain; live preference changes apply without reload |
| Print / tab lifecycle | Holiday ornaments hidden from print; canvas stops for printing, hidden tabs and pagehide; no animation remains after logout |
| Cross-user visibility | Setting change propagates via query cache on the active device and via focus/polling to other signed-in devices |
| Login | One brief non-blocking welcome per actual successful login; no repeat on refresh, route changes or workspace changes |
| Light / dark / RTL | Snow and decoration contrast appropriate; no navigation/header overlap; bidi layout and keyboard focus unaffected |

## Verification boundary

**Source review complete; actual browser/device validation NOT performed.** At the user's request, no CI, build, typecheck, automated tests or end-to-end browser runs were executed. The test files above are committed but unexecuted. iOS camera hardware and printer behavior in particular cannot be certified from source inspection alone.

All work remains on `feature/global-christmas-mode`. No merge, force merge, deployment, configuration change or production data modification was performed.
