# Christmas Mode — Developer-only access and per-user rollout

This update **supersedes the original global/all-users behavior** described in earlier Phase 1–5 implementation notes. The Christmas animations and decorations remain the same; only access and administration have changed.

## New behavior

- Only signed-in users whose **current company role is Developer** see the "Appearance & Seasonal" section in the shared Settings page. Factory has a separate Settings screen, so it additionally renders the same Developer-only access panel there.
- The Developer sees a master ON/OFF switch and a searchable checklist of active user accounts, plus an explicit **Save changes** button.
- Turning the master switch ON is **not enough**: a user must also be individually checked and saved. New users are never automatically selected, and Developer accounts are not automatically exempt.
- Selected users see snowfall, header lights, sidebar Christmas ornaments, extra festive corner ambience, and a one-time post-login greeting with an approximately 10-second original bell arrangement of the public-domain Jingle Bells chorus plus a Santa-like synthesized \"Ho! Ho! Ho!\" in **all their accessible company workspaces**, including POS and Factory. The sound plays only on actual sign-in, never on refresh; browser autoplay restrictions may require tapping a small Play control. A Stop control can mute playback. Other users never see decorations or hear the sound.
- Unselected users see **no Christmas UI** and cannot access the administration controls. Admin, Owner, Manager, View Only, POS and ERP Tester cannot change the configuration even if they call the API directly.
- The master switch and allowlist are stored as two independent entries in the existing `system_settings` table. Missing, malformed or legacy allowlist settings mean **no eligible users**. This avoids unexpectedly turning Christmas Mode on for everybody after deploying the update.
- Changes propagate immediately to the Developer's shared Query cache and to other signed-in users through the existing active-tab query polling (about 30 seconds) / focus refresh.

## Security and API

| Endpoint | Allowed roles | Data |
| --- | --- | --- |
| `GET /api/seasonal/christmas-mode` | Any authenticated user | `{ enabled }` **for the caller only**; never returns master status, usernames or allowlist |
| `GET /api/seasonal/christmas-mode/config` | Developer only | Master status, active usernames and selected IDs |
| `PUT /api/seasonal/christmas-mode/config` | Developer only | Atomically saves `{ enabled, userIds }` after validating selected users exist and are active |
| `PUT /api/seasonal/christmas-mode` | Developer only (older API retained) | Changes master status only; cannot grant new user eligibility |

- Developer permission is enforced by `requireAuth` + `requireRole("Developer")` on the server in addition to client-side hiding.
- User allowlist stores account IDs, not usernames or passwords. The users API response for this feature includes only `id` and `username`.
- No migration, background job, or global permissions changes were introduced.
- Existing Phase 2–5 effects subscribe to the **caller-effective** setting, so they stop immediately when that account becomes ineligible on the next refresh.

## Usage

In ERP / Properties: **Settings → General → Appearance & Seasonal** (Developer only).

In Factory: **Factory Settings → Christmas Mode** (Developer only).

1. Search the user directory and check only the people who should receive the effects.
2. Enable the master switch.
3. Select **Save changes**.
4. Turn the master switch OFF to instantly disable eligibility for everybody; their saved individual selections remain available for the next seasonal activation.
5. Uncheck a user and save to revoke their effect without affecting other selected users.

## Verification

- Added `server/services/seasonalChristmasAccessPolicy.test.ts` for default OFF, selected vs unselected users, master OFF, malformed data, and duplicate IDs.
- Source-level integration reviewed. **No CI checks, builds, automated test execution, live browser validation or Render deployment were performed**, per the user's no-CI preference.
- The change remains on `feature/global-christmas-mode`, not merged to `main`.
