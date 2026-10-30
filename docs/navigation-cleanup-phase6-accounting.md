# Phase 6 — Accounting, Reports and Developer Toolbox

Date: 2026-10-26  
Branch: `feature/navigation-usage-cleanup`  
Status: **Source implementation complete; Claude verification pending.**

## Evidence and scope

The live navigation sample in `docs/navigation-usage-study-2026-10-26.md` recorded zero recent route-change events for the unified accounting dashboard and rollout routes. These are Developer-only routes and the activity log is capped at 200 events per user / 30 days; **zero is not proof of nonuse**. No accounting or reporting feature was deleted.

Source inspection before changes confirmed:
- ERP `ErpRoutes` guards twelve existing `/accounting/*` pages with `isDeveloper`.
- Factory `FactoryRoutes` guards eleven existing `/factory/accounting/*` pages with `isDeveloper`.
- Properties `PropertiesRoutes` guards ten existing `/properties/accounting/*` pages with `isDeveloper`.
- ERP and Properties sidebars each rendered a long Accounting Reconciliation section with one entry per Developer-only page. Factory had no corresponding accounting reconciliation sidebar hub.
- Existing ordinary sales reports, Analytics, Daybook, Vouchers, financial statement routes, dashboard reports, and operational navigation remain important and were not removed.

## Implemented

1. Added `client/src/lib/accountingToolboxNavigation.ts`: one mode-aware catalog of existing accounting routes and existing diagnostics/maintenance routes. ERP includes Inventory & COGS and Factory Production accounting; Factory includes its Production accounting route; Properties includes its own rental-focused routes. Paths are mode-specific and never rewritten to another company shell.
2. Added `client/src/pages/AccountingToolbox.tsx`: a **navigation-only** hub grouping Reconciliation, Reporting & history, Release & audit, and Diagnostics & maintenance. The hub itself makes no API calls, edits or accounting postings. Some linked legacy maintenance pages can modify records if an authorized user deliberately submits an action; they retain their own existing guards.
3. Registered `/accounting/toolbox`, `/factory/accounting/toolbox` and `/properties/accounting/toolbox` behind the **same Developer-only route condition** used for the pre-existing accounting pages. The new page is lazy-loaded from `client/src/lazyPages.ts`.
4. Replaced the 12-row ERP Accounting Reconciliation sidebar group with one Developer-only **Accounting Toolbox** entry. Replaced the 10-row Properties group with one Developer-only entry. Added a Developer-only Factory footer shortcut. Standard Accounting/Finance and Reports groups remain.
5. Preserved all 12 ERP, 11 Factory and 10 Properties original accounting URLs and components. Kept each directly searchable in the command palette even after the sidebar collapsed. Added mode-correct Developer-only maintenance/diagnostics palette entries for Factory and Properties. ERP existing admin maintenance palette entries remain unchanged.
6. Preserved ERP page grants, server authorization middleware, data models, all posting code, production DB and history. **Post-implementation source review fixed one dead Factory toolbox link:** the existing unprefixed `/balance-repair` is redirected by the Factory company shell before it reaches `FactoryRoutes`. Added a new Developer-only `/factory/balance-repair` route, registered its canonical Developer-level page key in `shared/factoryAccessRegistry.ts`, and updated the Factory toolbox catalog to use that scoped route. The original unprefixed route remains unchanged for compatibility. Factory command search now includes the Toolbox entry as well. This is navigation/routing only; no Balance Repair operation was run.

## Additional Phase 6 source hardening

Reviewing `client/src/app/authenticatedAppRouteGuard.ts` exposed the previously misdirected Factory Balance Repair link. The guard redirects all unprefixed Factory-company URLs other than explicit exceptions to the Factory default page, so the original `/balance-repair` link was not suitable in the Factory toolbox. The new scoped route is restricted to Developer both by its `FactoryRoutes` registration and by the shared Factory access registry. Recheck this path during Claude's guarded-route and server-authorization review.

## Source-only inspection performed

Re-read the branch versions of the route tables, the three sidebars, the command palette, the catalog and hub after the edits. Confirmed that each of the three new routes is Developer-gated, that the mode-specific accounting route catalogs match the existing route tables, and that the original accounting routes remain registered. No CI, automated tests, lint, typecheck, build, merge, rebase, deploy, or production writes were performed.

## Known limitations / Phase 7 follow-up

- Existing global **Admin & Settings** command entries may point to unprefixed ERP-only paths while the Factory shell expects `/factory/*` routes. This predates Phase 6. Do not treat sidebar or palette visibility as backend authorization; align mode/role parity in Phase 7.
- The existing shells differ in effective-role resolution (`currentRole` versus `role`). Phase 7 must compare route guards, sidebars, command search and recent links during company switches, rather than weakening route guards.
- Developer-only maintenance pages are linked, **not audited for safe write operations**; any actual repair or migration requires separate authorization and verification. No such operation was invoked.
- Visual layout, keyboard navigation, mobile behavior, all deep links and permission combinations require Claude's independent runtime verification. Source review cannot certify 100% runtime correctness.

## Claude verification checklist

1. Typecheck, lint and build the branch independently; verify imports, lazy route registration and Lucide icon typing.
2. For Developer in ERP, Factory and Properties: open the Accounting Toolbox and every link, verify the mode-specific URL and correct page component.
3. For Admin, Owner, Manager, ERP Tester, POS, Retail and restricted users: ensure toolbox is not exposed and direct URLs are denied by the existing route guard; independently inspect server authorization for maintenance endpoints.
4. Test command search for every relocated accounting page and mode-correct diagnostics, plus existing ERP Admin & Settings commands.
5. Confirm standard ERP Analytics/Sales Report, Factory intelligence/reporting, Properties Analytics, financial statements, vouchers and historical reports remain reachable and unchanged.
6. Test bookmarked old accounting URLs, back/forward, refresh, mobile and keyboard navigation, and recent links after company switching.
7. Check accounting reconciliations, historical FX, inventory/COGS, production cost, rentals, consolidation, fiscal close and rollout readiness for regressions. Do not trigger destructive maintenance actions on production.
8. Check source/route parity and update permissions as needed in Phase 7, with independent server-side authorization validation.

**Claude acceptance remains pending; the branch is unmerged and undeployed.**
