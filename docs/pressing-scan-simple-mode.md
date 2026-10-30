# Pressing Scan — Simplified Ground Scan Mode

This specification supersedes the previously implemented complicated Phase 2 and Phase 7 UI.

## What workers see

Factory > Stock Entry > Pressing Machines uses a simplified role-specific layout:
- **Admin / Owner:** full barcode input, Scan action, continuous camera, scan status/sync details, full-company date/user/status filters, corrections and Excel export.
- **All other roles:** **Open Camera / Close Camera**, a date-selectable, today-by-default **daily per-worker totals** table (Beirut calendar day) for only the dedicated P1, P2 and P3 pressing worker accounts (confirmed bale count, KG), including their own row and a grand total, and a read-only **Hourly KG targets** comparison directly below it (07:00–17:00 Beirut time, date selector, per-worker targets and above/below results). Do not show individual bale references, articles, scanned-by timestamps or a paginated history table. No manual barcode field, sync/settings panel, report filters, export, or supervisor actions. When Pressing Machines is their only Stock Entry section, omit the Stock Entry header, print settings, daily production KPIs and tab switcher as well. The camera starts on Open Camera and releases on Close Camera; confirmations appear in the camera panel.

Only the existing user/page permission must be configured. A permitted employee opens the page, and the server automatically creates an internal station and assignment if needed. Every accepted scan records the authenticated user, not a configured shift operator. Workers can see only P1/P2/P3 **aggregate totals**, but the detailed history endpoint remains restricted to their own confirmations. Admin and Owner can filter full history by employee; Manager and Developer do not receive elevated detailed pressing history or correction permissions. The summary is company-scoped, requires an active-company standard worker role, includes the three worker logins even if their scan count is zero, and excludes voided confirmations. Admin, Owner, Manager, Developer and other non-pressing accounts never appear in the worker scoreboard.

## Removed from the active system

- Configured shifts, shift schedules, shift selection and shift productivity analysis.
- Machine downtime controls and machine-down scan blocking.
- Machine productivity reports, downtime, shift goals and machine-level targets. Admin/Owner pressing overview now has a separate, simple hourly worker KG target table.
- Manual machine management, employee-machine assignments and machine history UI.
- Advanced report saved-view/column configuration UI.

The Phase 7 operation routes are no longer registered. The former manual machine management routes are replaced by restricted authenticated GET /me and POST /activate endpoints under /api/factory/pressing-machines. The shared internal station is needed only for existing schema foreign keys. New pressing confirmations have shift_id=NULL and use company timezone settings for production_date.

## Preserved

Permanent server history, barcode uniqueness across users, immutable audit corrections, supervisor-only voids and rescans, safe offline retries, original request IDs, exact timestamps including seconds, and Excel export of filtered rows.

The existing PostgreSQL pressing schema remains untouched. Do not drop shift/machine/downtime tables because earlier records or foreign keys may reference them. If the two pressing migrations were already executed in TablePlus, no additional SQL is required for this simplification.

A pressing scan NEVER changes Factory bale stock status, stock counts, raw-material costs, or accounting vouchers.

## Verification

Updated tests include simplified permission and user initialization contracts, offline confirmation, report filtering and a real-PostgreSQL integration suite covering automatic activation, concurrent duplicate scans, actor/company isolation, immutable corrections and unchanged stock.

Local TypeScript checks, Vitest tests, isolated PostgreSQL tests and real-phone camera verification remain required before merging/deploying.

October 28, 2026 follow-up: Workers now see team totals for the three dedicated P1, P2 and P3 logins rather than individual bale history; this uses a separate company-scoped aggregate read endpoint.

October 27, 2026 follow-up: feature/pressing-worker-camera-only-20261027 narrows the operator UI and Admin/Owner-only report/correction authorization.
October 28, 2026 hourly targets: The Admin/Owner Pressing Overview shows an independent hourly comparison for dedicated P1/P2/P3 workers, default 850 KG/hour. Admin/Owner may edit each company's per-worker target, stored atomically in factory_settings.extra_settings. Completed Beirut-local hours with scans show above, met or below; the current hour is in progress; zero-scan hours remain neutral without a shift/work schedule. No stock/costing/accounting posting is made.

October 28, 2026 worker hourly targets: The worker-only page now reuses the company-scoped Hourly KG targets view directly after the aggregate scoreboard. Workers may view every dedicated pressing worker's hourly totals and date filter, but only Admin/Owner may edit targets. The panel requests the server's current Beirut day by default rather than relying on admin-only report options.

October 29, 2026 worker totals follow-up: The worker scoreboard aggregates only server-confirmed, non-voided scans for the selected Beirut calendar day, defaults to today, and provides a calendar selector for earlier days. Midnight and DST boundaries use Asia/Beirut in the SQL query; ranking and grand totals use only the selected day's figures. The hourly target panel remains independent.
