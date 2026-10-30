# One-time ERP + Factory automatic web/PWA refresh — 28 October 2026

## Scope

This is one production release campaign, **not** a global forced refresh on every future deployment. It targets users visiting the ERP+Factory web URL on desktop, Android browsers, mobile browsers and installed home-screen progressive web apps (PWAs).

- `client/public/sw.js` advances from `erp-v12` to `erp-v13`. Browser service-worker update checks on startup, window focus, visibility changes and every five minutes while visible fetch `/sw.js` with cache bypass. The existing registration automatically reloads a previously controlled page once on `controllerchange`.
- iOS PWA recovery uses a new one-shot marker `ios-pwa-2026-10-28-v2`. The worker records the marker **before** navigating any open iOS PWA window. The marker cache name starts with `hmd-force-update-`, not `erp-`, so ordinary old-cache removal cannot cause a repeated iOS campaign.
- Navigation and service-worker responses already use `no-store`/network-first handling. The worker deletes only `erp-` Cache Storage entries; it does not delete user IndexedDB databases or session data.
- This is idempotent: the browser does not replace its worker again until the script changes; the iOS campaign marker prevents repeated one-time navigation. Do **not** increment the SW version for regular deployments without a new deliberate rollout.

## Operational limits and safeguards

- A closed or offline browser cannot receive a remote reload. It updates on its next online launch/foreground check. A device with service workers blocked must navigate/reload to fetch new HTML.
- Reloading an existing page **can interrupt an open camera or unsaved form**. A queued pressing scan persists in its existing IndexedDB queue, but an unqueued, in-flight action may need verification. Deploy only after operational staff know the refresh will occur.
- A real installed **Capacitor Android/iOS native binary** packages its own web files and is **not** replaced by a Render website deployment. That requires a separately built and distributed binary/app-store update or an explicitly installed and security-reviewed OTA mechanism. No claim of silent native update is made.
- No update requires any user to press the “Refresh” toast in a normal service-worker-controlled PWA. Cache bypass and the existing `controllerchange` replacement handle the one-time web refresh.

## Verification

1. Confirm `scripts/verify-mobile-web-routing.mjs` accepts the new version/campaign markers.
2. Confirm the Render build has `client/public/sw.js` `erp-v13` and completes successfully.
3. Verify an already-open desktop tab and installed Android/iOS PWA each update when brought online/in focus, without repeated reloads. Do not claim device-specific testing before it is performed.
4. Confirm normal scanning and queued offline writes remain functional after the refresh.
