# ERP + Factory Navigation Simplification — Phased Work Plan

Started: 2026-10-26. Single working branch: `feature/navigation-usage-cleanup`.

## Rules
- All commits remain on this branch; never merge, rebase, deploy, or modify production records.
- Do NOT run CI, automated tests, lint, typechecks, or builds. Claude handles those separately.
- Work one phase at a time. Before progressing, inspect the prior phase's changed source, verify completion by read-only source review, fix incomplete parts, and document limitations. A scheduled check is not proof of correctness.
- Preserve accounting, production, inventory, sales, permissions, historical records, APIs, bookmarked routes, and audit trails. Avoid deleting functionality just because it is not exposed in main navigation.
- Use live usage to prioritize. Do not claim usage metrics until supported by actual data, and do not treat API call volume as human page usage.
- Render workspace requires user confirmation before accessing services, logs, metrics or databases. No live usage data verified as of plan creation.

## Phase sequence and exit criteria

1. **Inventory and safe duplicate cleanup**: document current ERP, Factory, Properties and POS navigation and permission filters; remove proven duplicate navigation without altering routes. **Started**: removed the duplicated Factory Daybook entry from the grouped Finance navigation, preserving its pinned shortcut and route. Remaining work includes auditing role/access parity in the command palette.
2. **Usage ranking and telemetry assessment**: inspect available Render request logs, service metrics and read-only database analytics after user confirms the Render workspace. Distinguish human page views from API traffic and identify unused low-traffic pages. If instrumentation is insufficient, add privacy-respecting page visit aggregation *in source only* with role/company-type separation, no raw personal browsing trail, and do not assert historical zero usage.
3. **ERP navigation consolidation**: reorganize Inventory/Stock, Optional Vouchers, Supplier Profit Check, POS Item Replacement, and Sales & Analytics navigation into contextual hubs. Keep deep links.
4. **Factory navigation consolidation**: group Factory operational workflows into Production, Inventory, Sales/Loading and Finance; prevent duplicate pinned/grouped links; keep stock, bale, load, accounting permissions intact.
5. **Properties and POS navigation**: consolidate Properties rentals tabs, make POS cashier-oriented and hide management-only tools according to server permissions. Keep standard ERP, Retail, Factory and Supplier Partner modes separate.
6. **Accounting, Reports and developer toolbox**: group developer-only reconciliation and rollout pages, audit maintenance pages, keep specialized tools available to authorized users.
7. **Navigation/permissions consistency**: align sidebars, command palette, recent navigation, deep-link access, and company-type behavior, retaining server authorization.
8. **Final source-only review and Claude handoff**: check changed files and implementation mapping by inspection, prepare detailed Claude validation checklist, note CI not executed, leave PR unmerged and deployment untouched.

## Phase status
- Phase 1: IN PROGRESS. Completed initial deduplication of Factory Daybook; further navigation/access review pending.
- Phases 2–8: NOT STARTED.
- Render live usage study: BLOCKED pending explicit workspace confirmation.
