# ERP + Factory — admin-controlled global force refresh

## Operator control
Settings > Sessions & Users > **Force Refresh All Users** is displayed to Admin,
Owner and Developer roles. The server also verifies those roles, requires an
authenticated session and enforces CSRF protection. Clicking the button requires
confirmation because a forced reload can interrupt an open scanner or unsaved form.
It does **not** log users out or delete offline scan queues.

## Technical behavior
- POST /api/admin/force-refresh-all persists a new UUID token in the shared
  `system_settings` table (key: `global_force_refresh_token`). A database-level
  30-second cooldown prevents rapid repeated requests across Render instances.
- GET /api/build-info returns that token alongside its existing build version.
  Responses remain no-store. Each tab checks every 15 seconds while visible,
  immediately on foreground/focus and after the admin clicks the button.
- Each tab saves its previous token in **sessionStorage** before reloading; this
  prevents repeated reloads and avoids one tab suppressing updates for another.
  The client clears only `erp-` CacheStorage keys, asks the existing service
  worker to flush its application cache, then navigates with a cache-busting
  `_force_refresh` query parameter, removed on stable boot.
- The one-time rollout advances the service worker from `erp-v13` to `erp-v14`
  and the iOS marker to `ios-pwa-2026-10-28-v3`, allowing already open
  web/PWA clients to adopt the **new listener**. Normal deployments must **not**
  bump these markers routinely.

## Operational limits
- A background-throttled or offline browser cannot execute an immediate remote
  command. It checks again on foreground/reconnection; closed apps get current
  files at their next online launch.
- The initial release needs the updated service worker/client loaded before the
  button can command old sessions. A browser that blocks service workers entirely
  may first need a manual reload or navigation.
- Native Capacitor app-store binaries package assets and are not overwritten
  by a Render web deployment; a native update needs separate distribution.
- Review an open camera or unqueued write before triggering this during production.

## Verification
- Unit test covers initial baseline, once-per-token semantics and new tab behavior.
- `scripts/verify-mobile-web-routing.mjs` checks the worker migration markers.
- Production readiness requires checking the Render deployment and an actual
  open-tab/mobile browser (no device testing claimed from repository inspection).
