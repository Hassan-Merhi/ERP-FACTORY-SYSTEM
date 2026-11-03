# Phase 7 — Cross-mode Navigation & Permission Consistency

Date: 2026-10-26  
Branch: `feature/navigation-usage-cleanup`  
Status: **Source implementation complete; independent Claude validation pending**

## Purpose

Inspect and align the navigation shown in desktop sidebars, pinned destinations, contextual shortcuts, command search, ERP mobile menu, and recent pages with the *existing* role, company, feature-flag and route-guard policies. This phase does not authorize user rights, alter backend access checks, or remove operational routes.

## Source findings and repairs

1. **Factory grouped / pinned / recent menu mismatch:** `useFactoryVisibleSections` previously checked grants only when `pageKeys.length > 0` for grouped sidebar pages, while pinned links required actual grants even for an empty allow-list. The grouped sidebar now reuses `isPinnedVisible`, which requires the company-scoped `myAccess` result, applies role restrictions and feature flags, and defaults to denied when grants are empty. Admin, Owner and Developer bypass ordinary page allow-lists in line with `computeFactoryGuardRedirect`; Cost Centers continues to require its separately implemented role/grant check on the destination route.
2. **Factory contextual shortcuts:** `FactoryRelatedLinks` now follows the privileged-role bypass used by the Factory route guard for ordinary Factory pages, while preserving Cost Centers' explicit grant logic. It still waits for the resolved selected-company access result.
3. **ERP phone menu:** `ErpMobileNavSheet` previously rebuilt its page menu from the raw `ERP_NAV_SECTIONS`, bringing back redundant standalone links already consolidated by the desktop sidebar. It now builds its groups from `useErpVisibleSections().sections`, sharing desktop access, role and hub suppression rules. Pinned and utility links remain permission-filtered.
4. **ERP command search:** `ERP_HUB_TABS` entries previously skipped ERP visibility checks. Search now requires `erpVis.isItemVisible` for the actual hub, checks the dedicated `/suppliers` or `/customers` feature grant for those tabs, and respects Retail route exclusions. This prevents supplier-only access from advertising Customers and vice versa.
5. **Factory command search:** Every Factory Admin & Settings item previously came from an unprefixed global ERP list such as `/settings`, `/inventory-repair` or `/account-migration`. Under a Factory company, the outer route guard redirects most unprefixed links away. Added a Factory-scoped admin catalog containing only routes registered by `FactoryRoutes`: Settings, Chatbot Settings, Deleted Items, Orphaned Records, Inventory Repair, Import Cycle Diagnostics, Account Groups and Company Data Reset. The ERP admin catalog remains intact.
6. **Invalid Factory Bale Explorer tab:** Removed the stale search entry `/factory/bales-hub?tab=imports`; the actual Bale Explorer supports `history`, `barcode`, `products` and `customer-loading`, not `imports`. Other direct module routes are unchanged.
7. **Intercompany command search:** The Intercompany Requests group now appears only in ERP or Factory shells, both of which register this route; it is not advertised to Properties-only and POS shells where it cannot be opened.
8. **Factory hub-tab restrictions:** Added `isHubTabVisible` to the Factory visibility hook and required it for Factory command shortcuts. It respects the existing per-user hidden tab keys for Bale Explorer, Invoicing, Loadings, Parties and Payroll, plus feature flags for barcode and pending loadings. Hidden pages are not shown as searchable tab shortcuts, even if the parent hub is otherwise accessible.

## Files changed in Phase 7

- `client/src/components/FactorySidebar.tsx`
- `client/src/components/FactoryRelatedLinks.tsx`
- `client/src/components/ErpMobileNavSheet.tsx`
- `client/src/components/CommandPalette.tsx`
- This report and the master plan

## Route and access preservation

No existing accounting, POS, inventory, factory, Properties or Supplier Partner route was deleted. Factory canonical access keys, backend authorization, sales postings, accounting, stock balances, loading operations, migration and repair actions were not modified. Users with narrowly granted page keys still use permitted fallbacks. The changes affect client-side navigation and search only; they are not a substitute for server authorization checks.

## Read-only source review performed

Fetched the committed branch versions and inspected the key guards, menu entries, dynamic tab lists and target routes. Checked that:
- Factory menu checks now default-deny empty page grants and use the same permission predicate for grouped, pinned and recent entries.
- Factory privilege policy matches its outer route guard for ordinary pages; the exceptional Cost Centers route retains separate controls.
- Factory hidden-tab keys and settings are checked before surfacing Factory command-search tab links.
- ERP mobile navigation uses consolidated sections and command search checks the actual Suppliers/Customers feature.
- Factory admin destinations have `/factory/` URLs registered by `FactoryRoutes`, whereas ERP keeps its original admin URLs.
- The stale `imports` Bale Explorer search tab is absent; `Intercompany` search is hidden outside ERP/Factory.
- No server-side or production database writes occurred.

This was **source inspection**, not an automated test, a TypeScript compilation, or user-session simulation.

## Claude verification checklist

1. Build, TypeScript, lint and automated tests independently; check new hook return type, client icon and JSX imports, query cache behavior and the command palette's memo dependencies.
2. Factory user without page grants: no unauthorized grouped, pinned, recently visited or searched pages; check access loading and error states.
3. Factory roles Admin/Owner/Developer/Manager/User/ERP Tester with partial permissions: validate parity with `computeFactoryGuardRedirect` and backend middleware, including Cost Centers' special route-level grant.
4. Factory hidden tab settings for Bales history/barcode/products, Invoicing/Loadings, Parties customers/suppliers and Payroll workers/employees. Ensure command search does not offer a hidden tab even when the parent hub is visible.
5. ERP supplier-only vs customer-only permissions: command palette must not show the opposite Parties tab; deep URLs and internal tab selection should still enforce the original independent permissions.
6. ERP desktop vs phone navigation: relocated pages appear only where intended, but are still accessible under the parent workspace or standalone fallback; verify keyboard focus and mobile navigation.
7. Factory command search Admin & Settings destinations should open the intended `/factory/*` page rather than redirecting to Factory Overview. Directly verify route gates on accounts groups and maintenance endpoints.
8. Properties-only and Retail/POS command search: no ERP/Factory-only Intercompany or admin destinations; no redirects into the wrong company shell.
9. Company switches must invalidate/reload company-scoped access and recent page lists; do not flash old-company links during loading.
10. Confirm original routes/bookmarks, back/forward, command search, pinned reorder and recent links remain correct on mobile and desktop.
11. **Known Phase 8 follow-up:** audit whether all ERP Sales Tools sub-tabs need finer direct-route feature restrictions beyond existing `/sales-tools` access, and whether every Factory Intelligence sub-tab has an applicable separate hidden flag. Do not change business permissions without confirming backend intended policy.

**No CI, automated tests, typecheck, lint, build, merge, rebase, deploy, or production mutations were performed. Phase 8 must confirm broader integration and prepare Claude's final acceptance review before any merge.**
