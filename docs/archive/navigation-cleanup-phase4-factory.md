# Phase 4 — Factory Navigation Consolidation

Date: 2026-10-26  
Branch: `feature/navigation-usage-cleanup`  
Status: **Source implementation complete; Claude verification required**

## Purpose and observed use

Real route-change data is recorded in `docs/navigation-usage-study-2026-10-26.md`, subject to the existing 30-day retention and 200-events-per-user cap. Factory Stock Entry (452 recent events), new container loading (209), Overview (136), and Invoicing (103) are essential production routes and remain directly reachable. Contacts and Sheets & Sacks have zero recent recorded navigations, **not** proof that no one needs them. Stock Allocation recorded seven recent visits from two users. These workflows remain intact; only their navigation changes.

## Implemented source changes

1. **Clearer Factory sidebar grouping** in `client/src/components/FactorySidebar.tsx`:
   - Core operational groups display in order: **Production**, **Inventory**, **Sales & Loading**, **Finance**.
   - Existing **Rentals** and developer **Intelligence** groups are retained pending Phases 5 and 6.
   - Bale Explorer is displayed in **Inventory**, keeping the same `factory/bales-hub` canonical page key and URL.
   - Sales becomes **Sales & Loading**, and Invoicing is displayed as **Invoicing & Loadings**. All underlying business routes and access-control group names remain unchanged.
   - Pinned pages are excluded from the grouped sidebar to prevent redundant shortcuts.
2. **Permission-aware contextual navigation**, via `client/src/components/FactoryRelatedLinks.tsx`, using the existing role and company-scoped `/api/factory/my-access` grants (without logging or exposing user activity). It renders links only after access is available; original page and server authorizations are unchanged:
   - `/factory/contacts` is reachable from **Factory Parties**.
   - `/factory/sheets-sacks` and `/factory/stock-allocation-v5` are reachable from **Location Inventory**.
   - `/factory/stock-allocation-v5` is also reachable from **Containers**.
   - `/factory/cost-centers` is reachable from **Factory Accounts**, with Admin/Owner/Manager/Developer restrictions and the pre-existing Accounts-grant exception.
3. **Per-user standalone fallbacks**: Contacts, Sheets & Sacks, Stock Allocation and Cost Centers are suppressed in the grouped sidebar **only if that user's corresponding parent workflow is accessible**. Otherwise their existing sidebar link remains.
4. **Command search**: added the four relocated destinations plus directly searchable Factory Overview, Agent Ledger, Accounts, and Vouchers shortcuts. Uses the existing Factory page access checks and the active user role.
5. No change to routes, database schemas, accounting calculations, production data, APIs, loading transaction flows, or access keys in `shared/factoryAccessRegistry.ts`. All work remains committed to this feature branch only.

## Source review performed (not CI or automated tests)

Re-read the changed files on the feature branch and checked:
- Sidebar groups and Bale Explorer group mapping are present.
- Pinned/group duplicates are structurally excluded.
- All four contextual fallbacks are present and conditional on accessible parent pages.
- Contextual links require resolved page access for the selected company and user role.
- Original FactoryRoutes entries are retained for Contacts, Sheets & Sacks, Stock Allocation, Cost Centers and new loadings.
- Command palette contains the relocated direct routes.
- The shared Factory registry retains canonical route keys and aliases.

These are **source-level checks only**; full runtime behavior is not certified.

## Claude acceptance checklist

1. Typecheck, lint, build and independently run targeted navigation integration tests (not performed by ChatGPT).
2. Verify Factory user roles Admin, Developer, Owner, Manager, ERP Tester, limited user; verify access after switching Factory companies.
3. Confirm **Production** still shows Stock Entry, Raw Materials and Waste Dispatch when authorized; **Inventory** shows Bale Explorer, Location Inventory, Containers, and relevant eligible links; **Sales & Loading** shows Factory POS and Invoicing & Loadings.
4. Confirm Stock Entry, new loading scan, pending loadings, Invoice/Proformas and finished bale workflows behave exactly as before, including mobile screens and WhatsApp/printing.
5. Contacts-only user retains standalone Contacts when Parties is inaccessible; if Parties accessible, Contacts is reached contextually.
6. Sheets-only or Stock-Allocation-only user keeps a sidebar entry when location/containers are unavailable; authorized users can open contextual links.
7. Cost Centers may be reached via Accounts grants but only by eligible roles; owners/managers without grant or authorized page must not see a shortcut. Confirm accounting data does not change.
8. Confirm clicking context links works, Back returns to expected place, command search works, and role/company switches never expose an unauthorized route.
9. Confirm `FACTORY_NAV_SECTIONS` changes do not break any other code that assumes a literal section called `Sales`. Search for consumers and update safely if needed.
10. Review screenshot layouts on desktop/mobile and that no redundant empty header rows or duplicate pinned entries appear.
11. Verify Factory Analytics, Rentals, and developer Intelligence were not unintentionally hidden.

**No CI, tests, typechecks, lint, builds, merge, rebase, deployment, or production writes were performed.** All final verification belongs to Claude.
