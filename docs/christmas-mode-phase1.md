# Global Christmas Mode — Phase 1 (configuration)

Branch: `feature/global-christmas-mode`.

## Completed scope

- One master, globally scoped switch, defaulting to **OFF**.
- Stored in the existing `system_settings` table as `key=christmas_mode_enabled` with text value `true` or `false`; no migration required.
- `GET /api/seasonal/christmas-mode`: authenticated users in any company type can read `{ enabled: boolean }`. Unset means OFF.
- `PUT /api/seasonal/christmas-mode` with JSON `{ "enabled": true|false }`: only Admin, Owner or Developer; strict boolean validation and atomic insert/upsert.
- `Settings → General → Appearance & Seasonal` includes the global switch, available in the shared Settings page used by ERP, Factory and Properties. Saving is immediate and reports success/error. Read-only roles can view it if they have access to that Settings page.
- Reusable `useChristmasMode()` hook exposes the global flag to subsequent phases; it refetches on mount/focus and every 30 seconds while visible when mounted.
- Existing application layout, business pages, and light/dark theme remain unchanged.

## Out of scope until later phases

- Snowfall, animated overlays, Christmas decorations and login animation are NOT enabled by Phase 1.
- POS-only user workspaces consume the global API in future visual-effect phases; POS users cannot edit this admin setting.
- No CI checks were run, as requested.

## Next-phase integration

Mount the visual effect once in `client/src/app/AuthenticatedAppOverlays.tsx` and read `useChristmasMode().settingQuery.data?.enabled`. The global toggle has no company ID, so it remains consistent during company switches. Animation must not capture pointer events, compromise mobile scanner performance, or ignore reduced-motion preferences.
