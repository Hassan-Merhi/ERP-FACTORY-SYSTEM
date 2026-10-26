# ERP + Factory Navigation Simplification — Phased Work Plan

Started: 2026-10-26. Single working branch: `feature/navigation-usage-cleanup`.

## Rules
- All commits remain on this branch; never merge, rebase, deploy, or modify production records.
- Do NOT run CI, automated tests, lint, typechecks, or builds. Claude handles those separately.
- Work one phase at a time. Before progressing, inspect the prior phase's changed source, verify completion by read-only source review, fix incomplete parts, and document limitations. A scheduled check is not proof of correctness.
- Preserve accounting, production, inventory, sales, permissions, historical records, APIs, bookmarked routes, and audit trails. Avoid deleting functionality just because it is not exposed in main navigation.
- Use live usage to prioritize. Do not claim usage metrics until supported by actual data, and do not treat API call volume as human page usage.
- Render workspace **My Workspace** was explicitly confirmed by the user on 2026-10-26. Read-only production telemetry and aggregated user navigation activity were inspected. Findings are documented in `docs/navigation-usage-study-2026-10-26.md`; the event history is capped per user and must not be treated as exhaustive.

## Phase sequence and exit criteria

1. **Inventory and safe duplicate cleanup**: document current ERP, Factory, Properties and POS navigation and permission filters; remove proven duplicate navigation without altering routes. **Started**: removed the duplicated Factory Daybook entry from the grouped Finance navigation, preserving its pinned shortcut and route. Remaining work includes auditing role/access parity in the command palette.
2. **Usage ranking and telemetry assessment**: inspect available Render request logs, service metrics and read-only database analytics after user confirms the Render workspace. **COMPLETED (read-only)**: existing `user_activity_log` captures route-change events; retention capped at 30 days and 200 per user. See evidence report for exact counts and uncertainty. New telemetry not installed because route logging already exists.
3. **ERP navigation consolidation**: reorganize Inventory/Stock, Optional Vouchers, Supplier Profit Check, POS Item Replacement, and Sales & Analytics navigation into contextual hubs. Keep deep links.
4. **Factory navigation consolidation**: group Factory operational workflows into Production, Inventory, Sales/Loading and Finance; prevent duplicate pinned/grouped links; keep stock, bale, load, accounting permissions intact.
5. **Properties and POS navigation**: consolidate Properties rentals tabs, make POS cashier-oriented and hide management-only tools according to server permissions. Keep standard ERP, Retail, Factory and Supplier Partner modes separate.
6. **Accounting, Reports and developer toolbox**: group developer-only reconciliation and rollout pages, audit maintenance pages, keep specialized tools available to authorized users.
7. **Navigation/permissions consistency**: align sidebars, command palette, recent navigation, deep-link access, and company-type behavior, retaining server authorization.
8. **Final source-only review and Claude handoff**: check changed files and implementation mapping by inspection, prepare detailed Claude validation checklist, note CI not executed, leave PR unmerged and deployment untouched.

## Phase status (2026-10-26)
- Phase 1: SOURCE CHANGES COMPLETE, pending Claude verification. Removed duplicate Factory Daybook grouped link while keeping pinned/route; shared Properties role-based nav filter; command search now respects Factory page grants/feature flags, developer reconciliation visibility and other core route controls. All committed on this branch; no CI/tests/builds.
- Phase 2: LIVE STUDY COMPLETE WITH LIMITATIONS. Read-only Render service/log/metric checks and primary Postgres aggregate queries documented in `docs/navigation-usage-study-2026-10-26.md` (3,445 navigation events at initial snapshot; 24 users; 11 companies; 122 raw routes). Events are retained only 30 days / max 200 per user. No data mutation.
- Phase 3: SOURCE CHANGES COMPLETE, pending Claude verification. ERP context links, permission-aware sidebar fallbacks, supplier profit tab, Sales Tools replacement tab, optional-voucher link, and related-sales-report links have been committed. All legacy routes preserved. See `docs/navigation-cleanup-phase3-erp.md` for exact changes and Claude checklist.
- Phase 4: SOURCE CHANGES COMPLETE, pending Claude verification. Factory sidebar organized around Production, Inventory, Sales & Loading, Finance while keeping Rentals and developer Intelligence; Bale Explorer shown under Inventory; four low-use specialty pages moved into permission-checked contextual navigation with standalone fallbacks; Factory command search retains direct links. See `docs/navigation-cleanup-phase4-factory.md`. No FactoryRoutes or canonical factory access registry changes.
- Phase 5: SOURCE CHANGES COMPLETE, pending Claude verification. Properties Rentals menu consolidated to one hub with preserved Warehouses/Shops/Payments tabs and Developer Cash Transfer; standard POS focuses on primary cashier pages plus collapsible tools; Retail POS users see only registered Retail routes; company-appropriate command search updated. See `docs/navigation-cleanup-phase5-properties-pos.md`. Existing source routes and server permissions unchanged.
- Phase 6: NEXT ACTIVE PHASE — Accounting, Reports and developer toolbox consolidation.
- Phases 7–8: NOT STARTED.
- Claude acceptance is pending. Never claim 100% production verification before Claude completes it.
