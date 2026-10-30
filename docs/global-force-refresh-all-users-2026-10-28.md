# ERP + Factory — role-scoped force refresh

## Operator controls
In **Settings > Sessions & Users**, available to Admin, Owner, and Developer:

- **Force Refresh Regular Users** sends a reload only to other roles (pressing workers, POS, managers, etc.). Admin, Owner and Developer devices do **not** refresh.
- **Force Refresh Admin / Owner / Dev** separately reloads only Admin, Owner and Developer devices; regular users are unaffected.

Both buttons act immediately with **no confirmation prompt**. Targeted users see the same visible **five-second countdown** before an automatic refresh. It does not log users out or delete offline scan queues, but unsaved forms/scanner views may be interrupted. Neither button is clicked as part of deployment.

## Technical behavior
- `POST /api/admin/force-refresh-all` now targets **regular users only**. This legacy route remains available for backwards compatibility.
- `POST /api/admin/force-refresh-privileged` targets **Admin, Owner, and Developer only**.
- Both endpoints verify an authenticated Admin/Owner/Developer session, enforce CSRF, and never accept user-supplied roles or company IDs. Actions are audited with actor and target group.
- Each target has a separately persisted `system_settings` key and independent **30-second database-enforced cooldown**:
  - Regular: `global_force_refresh_token` (legacy key).
  - Privileged: `global_force_refresh_privileged_token`.
- On the **first regular command after upgrading**, the server freezes the privileged token at its previous legacy value **before** issuing a new regular token. Privileged build-info reads fall back to the legacy value only until their own key exists. This avoids inadvertently refreshing admin/owner/developer tabs during rollout or following subsequent regular commands.
- `GET /api/build-info` uses the **server-side authenticated session's effective role** to return only that group's `forceRefreshToken`; the browser cannot choose the scope. This preserves the response field consumed by already-open web tabs.
- The server response remains no-store; per-process token reads are cached up to 2 seconds. Visible authenticated tabs poll every 15 seconds and immediately on foreground/focus. After a privileged button click, the issuing administrator's tab checks immediately; clicking regular refresh does not affect that tab.
- Each tab remembers the last token in its own `sessionStorage` before reloading. A fixed banner counts down 5, 4, 3, 2, 1 and reloads automatically. During countdown, the client clears only `erp-` CacheStorage keys plus service-worker application caches; it leaves cookies, sessions and IndexedDB offline queues intact, and navigates with a `_force_refresh` cache-busting query.
- Existing `erp-v14` service-worker and `ios-pwa-2026-10-28-v3` rollout markers remain unchanged because this release changes server-side routing and the operator UI, not the client refresh listener. Do not bump them routinely.

## Operational limits
- A background-throttled or offline browser cannot execute an immediate remote command. It checks on resume/reconnection; closed apps load current files at next online launch.
- The five-second countdown begins **after each device notices its targeted signal**. Visible tabs poll at most every 15 seconds, so they may not begin together.
- Native Capacitor app-store binaries package assets and are not overwritten by a Render web deployment; those apps need separate updates.
- Some devices still on a very old frontend without the refresh listener may need to visit/reload the app first.

## Verification
- Server unit tests cover independent keys, privileged baseline seeding and per-group cooldowns.
- Existing client token/countdown unit tests remain valid because the `forceRefreshToken` response shape is unchanged.
- Production readiness requires verifying the Render deployment and optionally manually testing real users' tabs; no production-wide force refresh should be sent merely to test deployment.
