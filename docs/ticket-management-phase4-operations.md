# Ticket Management — Phase 4 delivery operations

## Scope and rollout
Phase 4 processes the outbox created by the Phase 1–3 ticket services. It adds company-scoped user contact preferences, in-app alerts, SMTP email, Green API WhatsApp messages, and the first reminder 24 hours after ticket creation. Repeat overdue alerts are at most once per additional 24-hour interval until finalization.

**Do not enable this worker until migrations `20261105_001`, `20261105_002`, and `20261105_003` are applied and tenant permissions are reviewed.** The default is disabled.

Environment:
- `TICKET_NOTIFICATIONS_ENABLED=true` starts the once-per-minute ticket worker when `ENABLE_SCHEDULERS` is not `false`.
- Optional `TICKET_APP_BASE_URL=https://your-erp.example.com` adds a validated HTTPS deep link to email/WhatsApp messages.
- SMTP email: `TICKET_SMTP_HOST`, `TICKET_SMTP_PORT` (default `587`), `TICKET_SMTP_SECURE=true|false`, `TICKET_SMTP_USER`, `TICKET_SMTP_PASS`, `TICKET_SMTP_FROM`. These are server-only secrets. Do not put passwords in the database, frontend, or commit history.
- WhatsApp: reuses the existing Green API `whatsapp_settings` row `id=1` (enabled, instance ID, API token). The provider must be authorized for the intended recipient messages. There is **no** approved WhatsApp Business template-management or delivery-webhook integration in Phase 4.
- Recipients must set their own company-scoped email/phone details and explicitly enable each external channel in Ticket Management → Notification settings. Without an opt-in, only in-app delivery is created.

## Queue semantics
1. A ticket create, comment, attachment, or status transition writes one uniquely-keyed outbox event within the same transaction as the ticket change.
2. The scheduler creates a uniquely keyed overdue event for the elapsed 24-hour period. `ON CONFLICT DO NOTHING` prevents duplicate reminder events across multiple replicas.
3. A worker transaction locks each event with `FOR UPDATE SKIP LOCKED`, rechecks current company membership and ticket visibility, and materializes the relevant per-user/channel deliveries. A unique `outbox_id,recipient_user_id,channel` constraint makes retries safe.
4. In-app notifications are inserted into the existing `notifications` table **in the same transaction** that marks their delivery as completed.
5. External sends are marked `sending` before the provider call. Successful sends become `sent`; timeout/error/crash outcomes become `uncertain`, and must be reviewed rather than automatically resent. This protects against double WhatsApp messages. Missing provider configuration delays the untouched `pending` delivery 15 minutes and retries later.
6. Deliveries are suppressed if the recipient is no longer a ticket participant/creator/assignee, has left the active company, becomes inactive, opts out, or the overdue ticket is finalized. Existing live ERP/Factory record permissions are **not** broadened.

## Privacy and support
External messages include only a ticket number and basic event type; no uploaded photos, journal amounts, voucher particulars, or fault allegations. In-app messages open an authenticated `/tickets?ticketId=...` or `/factory/tickets?ticketId=...` route, and the ticket route checks permissions again.

Operations can inspect delivery status in `support_ticket_notifications`:
`pending`, `sending`, `sent`, `delivered`, `suppressed`, or `uncertain`.
`sent` means the provider accepted the request, not that the recipient read it. There are no external delivery receipts without verified provider callbacks. Investigate `uncertain` records manually; do not bulk-reset them to `pending` without reconciling with the provider.

## Verification before merge
- `npm run check` for TypeScript.
- `npm run verify:migrations` and `npm run verify:startup-migrations`.
- `npm run test:backend -- tests/ticket-management-phase1.test.ts tests/ticket-management-phase2.test.ts tests/ticket-management-phase3.test.ts tests/ticket-management-phase4.test.ts`.
- CI, UI Quality, Security, CodeQL and database migration verification.
- Test concurrent replica workers, outbox replay, revoked opt-in/company membership, and finalized tickets.
- Sandbox provider deliveries to opted-in test accounts before enabling in production.
