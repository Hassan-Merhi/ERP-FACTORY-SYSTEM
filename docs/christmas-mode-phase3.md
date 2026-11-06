# Global Christmas Mode — Phase 3 (decorations)

Branch: `feature/global-christmas-mode` — continues Phases 1 and 2.

## Implementation

- **One master switch** in Settings remains the only source of truth (`GET /api/seasonal/christmas-mode`). No per-company settings or additional database changes.
- `AuthenticatedAppOverlays.tsx` calls `useChristmasMode()` **once** and passes the resulting boolean to both the Phase 2 snow canvas and Phase 3 ornament controller. Existing refresh and global query-cache updates control both instantly on this device; other devices update on focus / periodic refresh.
- `GlobalSeasonalDecorations.tsx` sets `<html data-christmas-mode="on">` only while enabled, and removes that attribute when disabled, on logout, and whenever the authenticated overlay unmounts.
- `christmas-decorations.css` renders a low-contrast green light cable with repeating gold, jade, and ruby bulbs on the top edge of every shared ERP/Factory/Properties/Supplier Partner header and the separate POS/Retail header. It does not change header height, tab positioning, or button hitboxes.
- `SeasonalBrandAccent.tsx` supplies a compact green tree and gold star to `ModuleHeader` (shared ERP, Factory and Properties sidebars) and the separate POS/Retail sidebar. Hidden without Christmas Mode and `aria-hidden` when visible.
- Decoration transitions use only CSS opacity animations and no timers, HTTP assets or per-page component mounts; motion animations are removed when `prefers-reduced-motion: reduce` is requested.
- All decoration surfaces are `pointer-events:none`; they do not affect keyboard focus, inputs, data grids, scroll regions, scanners, or customer/financial workflows.
- Built for both `html.light` and `html.dark`; ornaments remain decorative in both modes and are excluded from print layouts.
- The Settings description now reflects Phase 3 behavior.

## Deliberately not yet implemented

- Enhanced post-login welcome snowfall remains Phase 4.
- Separate configuration for individual ornaments or Christmas colors is out of scope: one master global switch remains by design.
- Runtime browser/device validation remains in Phase 5.
- Per request, CI workflows, builds, and automated test suites have **not** been executed.

## Suggested manual acceptance pass

1. Turn Christmas Mode ON in shared Settings; observe the header lights, sidebar tree, and falling snow. Switch it OFF and confirm all three disappear without page reload.
2. Browse ERP, Factory, Properties, Supplier Partner and standalone POS layouts, including expanded/collapsed sidebar and mobile drawer.
3. Test dark/light palettes, RTL locale, keyboard navigation, dialogs, print preview and scanner camera. Decorations must not obstruct controls or affect functionality.
4. Check another signed-in device receives the global setting after its refresh/focus, and verify logout removes decorative HTML attributes.
5. Enable device reduced-motion preference and confirm lights are static while snowfall is absent.
