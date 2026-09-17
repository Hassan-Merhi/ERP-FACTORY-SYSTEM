# Remote support — audit + authorization hardening

## Scope

Low–medium compliance hardening on top of the existing remote-support program.
No new interactive capability is introduced. Accounting, inventory, and voucher
logic are untouched.

## Delivered

### `screen_watch_started` / `screen_watch_ended`

Passive screen viewing previously left no permanent trail. Opening a live or
polling frame stream now records `remote_support_screen_watch_started` on first
observation of a controller/target pair, and `remote_support_screen_watch_ended`
when the live stream closes or the watch TTL expires. Rows use the existing
`remote_support_sessions` module so the company-scoped audit endpoint surfaces
them without a new table. Metadata only — no frames, field values, or secrets.

### Tenant gate on frame routes

`GET /api/screen-feed/:userId` and `GET /api/screen-feed/live/:userId` now pass
through `assertScreenFeedTenantAccess`:

- Developer retains the cross-company support role.
- Every other controller must share an active company with the target, proven by
  a live ERP tab heartbeat or a fresh `user_presence` row.
- Failures return a uniform 404 so the route cannot be used to map user IDs
  across tenants.

The Active Users list is company-scoped for non-Developer roles for the same
reason.

### Aggregate pointer audit rows

Consecutive `pointer-move` command audits for the same session collapse into one
row carrying `pointerCount`. Clicks, scrolls, keyboard commands, and results
still create discrete rows. Accountability is preserved without flooding
`audit_log` under a steady cursor stream.

### Expose queue health

- `GET /api/screen-feed/admin/runtime` includes a `commandAuditQueue` block.
- `GET /api/screen-feed/admin/audit-queue-health` returns the same snapshot for
  Developers. The queue still fails closed on the command path when it cannot
  promise a record.

### `user_presence` compliance indexes

One index-only migration (also applied at boot via startup-schema stage 029):

- `user_presence_last_seen_idx`
- `user_presence_company_last_seen_idx`
- `user_presence_user_last_seen_idx`

These cover the Active Users TTL filter, company-scoped list, and the
screen-feed tenant gate lookup.

## Verification

Focused tests in `tests/remote-support-audit-authorization.test.ts` cover watch
audit lifecycle, tenant gate allow/deny, pointer aggregation, and queue health
exposure. Existing remote-support and screen-feed suites remain green.
