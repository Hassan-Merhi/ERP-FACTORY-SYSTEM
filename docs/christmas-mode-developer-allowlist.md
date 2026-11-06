# Christmas Mode — Developer-only access and per-user rollout

This update **supersedes the original global/all-users behavior** described in earlier Phase 1–5 implementation notes. The Christmas animations and decorations remain the same; only access and administration have changed.

## New behavior

- Only signed-in users whose **current company role is Developer** see the "Appearance & Seasonal" section in the shared Settings page. Factory has a separate Settings screen, so it additionally renders the same Developer-only access panel there.
- The Developer sees a master ON/OFF switch and a searchable checklist of active user accounts, plus an explicit **Save changes** button.
- Turning the master switch ON is **not enough**: a user must also be individually checked and saved. New users are never automatically selected, and Developer accounts are not automatically exempt.
- Selected users see snowfall, header lights, sidebar Christmas ornaments, the one-time login greeting and an animated Santa sleigh passing over the top bar **every five visible minutes** in all accessible workspaces, including POS and Factory.
- A selected user can go to **My Settings → Christmas Mode** and turn the effects OFF or ON **only for their own account**. The switch is hidden for anyone not on the allowlist, and it never lets a user grant themselves access. Their choice persists across companies, devices and logins. By default, newly selected users have their personal switch ON.
- Santa's sleigh has no sound, does not block pointer events, never changes header layout, and pauses when the tab is hidden, reduced motion/data is requested or a barcode camera is active.
- Unselected users see **no Christmas UI** and cannot access the administration controls. Admin, Owner, Manager, View Only, POS and ERP Tester cannot change the configuration even if they call the API directly.
- The master switch and allowlist are stored as two independent entries in the existing `system_settings` table. Personal choices use a third class of keys, `christmas_mode_user_pref:<userId>`, with value `true` or `false` (missing means ON). Missing, malformed or legacy allowlist settings mean **no eligible users**. This avoids unexpectedly turning Christmas Mode on for everybody after deploying the update.
- Changes propagate immediately to the Developer's shared Query cache and to other signed-in users through the existing active-tab query polling (about 30 seconds) / focus refresh.

## Security and API

| Endpoint | Allowed roles | Data |
| --- | --- | --- |
| `GET /api/seasonal/christmas-mode` | Any authenticated user | `{ enabled, available, preferenceEnabled }` **for the caller only**; never returns master status, usernames or allowlist |
| `PUT /api/seasonal/christmas-mode/preference` | Allowlisted authenticated user only | Sets `{ enabled }` for the caller's personal preference, not the Developer master switch |
| `GET /api/seasonal/christmas-mode/config` | Developer only | Master status, active usernames and selected IDs |
| `PUT /api/seasonal/christmas-mode/config` | Developer only | Atomically saves `{ enabled, userIds }` after validating selected users exist and are active |
| `PUT /api/seasonal/christmas-mode` | Developer only (older API retained) | Changes master status only; cannot grant new user eligibility |

- Developer permission is enforced by `requireAuth` + `requireRole("Developer")` on the server in addition to client-side hiding.
- User allowlist stores account IDs, not usernames or passwords. The users API response for this feature includes only `id` and `username`.
- No migration, background job, or global permissions changes were introduced; the per-user toggle persists in the existing `system_settings` table.
- Existing Phase 2–5 effects subscribe to the **caller-effective** setting, so they stop immediately when that account becomes ineligible on the next refresh.

## Usage

In ERP / Properties: **Settings → General → Appearance & Seasonal** (Developer only).

In Factory: **Factory Settings → Christmas Mode** (Developer only).

1. Search the user directory and check only the people who should receive the effects.
2. Enable the master switch.
3. Select **Save changes**.
4. Turn the master switch OFF to instantly disable eligibility for everybody; their saved individual selections remain available for the next seasonal activation.
5. Uncheck a user and save to revoke their effect without affecting other selected users.
6. An allowlisted user can visit **My Settings → Christmas Mode** to turn all Christmas visuals off just for themselves (or turn them back on). This works when changing workspace, without giving them Developer permissions.

## Verification

- Extended `server/services/seasonalChristmasAccessPolicy.test.ts` for personal opt-out while preserving default OFF, selected vs unselected users, master OFF, malformed data, and duplicate IDs.
- Source-level integration reviewed. **No CI checks, builds, automated test execution, live browser validation or Render deployment were performed**, per the user's no-CI preference.
- The change remains on `feature/global-christmas-mode`, not merged to `main`.
