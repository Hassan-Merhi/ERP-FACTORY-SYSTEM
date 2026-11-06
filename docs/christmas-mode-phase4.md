# Global Christmas Mode — Phase 4: one-time post-login entrance

Branch: `feature/global-christmas-mode`. Builds on Phases 1–3 without merging.

## Implemented

- A four-second enhanced snowfall burst appears **after a confirmed successful sign-in**, while the normal Phase 2 global snowfall and Phase 3 header/sidebar accents remain enabled underneath.
- An understated "Welcome back" holiday greeting appears briefly with gold and evergreen detailing. It does **not** block or delay using the workspace, clicking controls, scanning, or typing.
- `client/src/lib/christmasLoginEntrance.ts` uses a short-lived, sessionStorage-only **one-time pending flag** without any usernames, identifiers, or credentials. It is marked at each of the successful password, native biometric, and passkey navigation paths in `Login.tsx`.
- `ChristmasLoginEntrance.tsx` consumes the flag only after the global Christmas Mode setting has resolved. When disabled, unavailable, reduced-motion, or in a background tab, it **discards** the hint; switching Christmas Mode ON later cannot create a stale login animation.
- Ordinary refreshes, changes between ERP/Factory/Properties/retail companies, regular route navigation, and repeated render/mounts never create a new login hint.
- The entrance is mounted alongside existing global effects in `AuthenticatedAppOverlays.tsx`, so it covers all supported authenticated company types (including standalone POS).
- CSS-based lightweight falling snowflake/sparkle characters; max 56 on desktop, with only the first 28 shown on narrow screens. They animate via transforms, not layout changes. One four-second timeout cleans up the component; all timers and media listeners are cleaned up on unmount.
- `prefers-reduced-motion: reduce` suppresses the entrance, and `@media print` hides it. The overlay is visually decorative with `pointer-events: none` and `aria-hidden`, and respects light/dark appearance and mobile safe areas.
- `useAuthenticatedUser.handleLogout` clears any pending login hint.
- Settings description now mentions the brief welcome animation.
- Added `client/src/lib/christmasLoginEntrance.test.ts` covering one-time behavior, age expiration, invalid hints, logout, and sessionStorage access failures. **Not run**, per explicit request for no CI checks.

## Exclusions

- No server authentication contract, database schema, finance records, access permissions, or company preference rules were changed.
- No full-screen loading screen, reload requirement, navigation delay, sound, or external image assets were added.
- Phase 5 end-to-end browser/device validation remains outstanding; no CI, build, or automated tests were run.
- The feature stays on the existing branch and has **not** been merged or deployed.

## Acceptance checklist for a later test pass

1. Enable Christmas Mode, sign out and log back in with a password. Confirm a four-second non-blocking greeting and snowfall burst, then regular snow continues.
2. Refresh the same logged-in page and switch between workspaces; confirm no additional entrance.
3. Turn Christmas Mode OFF then log back in; confirm no greeting or snow.
4. Test native Face ID/fingerprint, passkey sign-in (where enabled), and device light/dark styles.
5. Check `prefers-reduced-motion`, background tab return, scanner input, dialogs, and phone navigation.
