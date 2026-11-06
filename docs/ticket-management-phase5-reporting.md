# Ticket Management — Phase 5 Admin Reporting

## Access
The dashboard is shown from ERP/Factory Ticket Management only to a company-scoped Admin, Developer, Owner, or Manager authorized for `page_ticket_management` and `act_ticket_manage_all`. This is checked again on `GET /api/tickets/dashboard` using the existing session, active-company context, page middleware, and Advanced Restrictions.

CSV additionally requires `exp_ticket_export` on `GET /api/tickets/export`. The frontend hides the export action when the permission is absent; the server is authoritative.

## Dashboard
- Filter by UTC creation date (inclusive range), status, priority, source mode, exact category, and assigned employee.
- Headline total, Open, Seen, Working, Reopened, Finalized, Overdue, and Urgent unresolved.
- Mean time from creation to finalization and number resolved within the ticket's existing `due_at` target.
- Grouped counts by status and category.
- Employee assignment workload, finalized count, overdue count, and mean resolution time. These reflect assignments, **not** findings of employee fault.
- Up to 30 oldest overdue unresolved tickets with links to the permission-checked detail view.
- Most recent 31 UTC creation dates with activity; 'currently finalized' means tickets created on that day that are now finalized, not finalization events on that day.
- Up to 10,000 CSV rows in the active company scope, excluding private photos, record snapshots, and any unrelated financial figures.

No changes to ticket lifecycle, voucher processing, finance records or stock levels.

## Limits and protection
- Report filters are Zod-validated and parameterized. Company is always derived from authenticated server context, never taken from query strings.
- Date ranges cannot exceed 366 days when both ends are provided; unbounded report totals are permitted for existing historical records.
- CSV fields have control characters removed and spreadsheet formulas neutralized.
- Private reporting responses are not cached or shared; files are downloaded on demand.
- A single high-volume company may require pre-aggregated reporting and cursor streaming later. Current export fails closed with an explanatory message when the row cap is exceeded.
- This dashboard is a reporting surface only: it does not reassign, close, or rewrite cases.

## Verification before merge
1. Apply and verify ticket migrations 001–003 on a disposable PostgreSQL environment.
2. Run TypeScript and the existing migration/permission checks.
3. Run `tests/ticket-management-phase5.test.ts` alongside Phase 1–4 regression tests.
4. Test normal users, restricted managers, authorized admins and cross-company sessions; direct API calls must return 403 without `act_ticket_manage_all`.
5. Verify exported CSV for commas, quotes, newlines, spreadsheet-formula prefixes, non-ASCII text and >10,000-record handling.
6. Verify filters, timezone boundaries, mobile tables, overdue links and number formatting.
7. Verify security/CI/UI quality workflows and reconcile the branch with current `main`.

**Do not deploy or mark complete until these checks pass.**
