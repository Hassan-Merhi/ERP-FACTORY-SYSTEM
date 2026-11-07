# Christmas Mode 2.0 — balanced seasonal experience

## How it works

A Developer must turn on the existing master Christmas Mode switch **and** explicitly allowlist each user. Each allowed user retains **My Settings → Christmas Mode** to opt out or back in across companies and devices. Accounts not on the allowlist receive no decorations. This release does not alter those security boundaries.

**Default:** all six visual upgrades are enabled with **Balanced** intensity. Existing 10-second Jingle Bells login playback remains unchanged. All effects are purely cosmetic.

## Developer Christmas Control Center

ERP / Properties: **Settings → Appearance & Seasonal**. Factory: **Factory Settings → Christmas Mode**.

The existing Developer card now includes six independent toggles:

1. **Snowfall & snow caps** — capped, theme-aware particle snow and a gentle snow trim on header/sidebar.
2. **Santa flyover** — the existing Santa and reindeer flyover with a subtle shimmering gold stardust trail.
3. **Garland lights** — evergreen garlands, animated top-edge lights and small ornaments.
4. **Countdown** — a small local-calendar countdown in the top bar that says “Merry Christmas!” on December 25.
5. **Surprise gifts** — an occasional floating mini gift that displays a seasonal greeting when clicked. No financial, inventory or other operational change occurs.
6. **Ambient Christmas corner** — tiny Christmas tree, ornaments and glowing fireplace; collapsible and automatically hidden on narrower screens.

Intensity options are **Subtle**, **Balanced** (default) and **Full Christmas**. Intensity scales the snowfall density, ambient treatment and gift frequency. Every toggle and intensity selection is saved together with the Developer allowlist/master state using the existing Save changes action.

The saved JSON is in the existing `system_settings` row with key `christmas_mode_visuals_v2`. No new table, database migration or manual SQL is needed. Existing installations without this key use the Balanced defaults.

## API and safety

- `GET /api/seasonal/christmas-mode` includes `visuals` **only for an allowlisted caller**, alongside their effective `enabled`, `available` and `preferenceEnabled` flags.
- `GET /api/seasonal/christmas-mode/config` and `PUT /api/seasonal/christmas-mode/config` remain Developer-only and include the validated `visuals` object. The PUT `visuals` property is optional for compatibility with older clients.
- Non-Developer users cannot change visual feature settings or the allowlist, even through API requests.
- No third-party images, scripts, backend jobs or live external data sources are used for the visual effects.
- All visual overlays are non-interactive except the clearly labeled mini gift and ambient minimize control.
- Scanner camera activity pauses/stops motion and gift events. Reduced-motion and data-saver users never start particle/sleigh/gift animation. Print exports hide the decorative elements.
- Mobile and compact workspaces omit or scale decorations to keep business controls usable.
- The countdown uses each browser's current local date; it does not assume a company time zone.

## User preview

Allowed users with Christmas Mode enabled can use **My Settings → Christmas Mode → Preview Santa now** and **Preview a festive gift**. Changes across sessions refresh with the existing effective-settings query.

## Verification

The Developer policy unit tests include missing/malformed visual settings, Balanced defaults and overriding selected visual features. Code was reviewed at source level only, as requested; no CI checks, builds, live browser tests or Render deployment were performed.
