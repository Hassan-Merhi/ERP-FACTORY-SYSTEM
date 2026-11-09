# Properties Mode Navigation Registry

## Purpose

This document is the authoritative navigation contract for the Properties company shell. It records every routed Properties screen, normal entry point, permission boundary, deterministic parent, Escape target, visible Back target, direct-link behavior, and compatibility exception.

The audit is navigation-only. It does not change rental, property, voucher, accounting, ledger, analytics, or administrative business logic.

## Implemented frontend registry (2026-11-09 — unification Phase 5)

The executable navigation manifest lives in `client/src/properties/config/propertiesNavigation.ts`. It defines canonical route labels, deterministic parents, required capabilities, pinned root order, rental tab names/query URLs and legacy rental redirects. Its capability helpers are consumed by `PropertiesRoutes.tsx`, `PropertiesSidebar.tsx`, `PropertiesRentalsHub.tsx`, command search and the Properties Help & Training catalog.

**Selected-company policy:** where an active Properties company has an assigned role, that role determines frontend visibility; otherwise the active session role (or legacy role fallback) applies. A selected non-Properties company does not receive Properties capability visibility. This policy is strictly client-side and **does not authorize any API write**. Company/session authorization in the backend remains authoritative. The earlier Phase 7 backend rental-reconciliation action now uses the canonical active-company permission context; authorization remains entirely server-owned.

Legacy rental routes keep replacement-history redirects. The Phase 1 Shops tab and `?tab=shops` deep link remain supported. Permission-gated route components are not mounted by the Properties route switch when capability checks fail.

**Verification scope:** structural source inspection only; runtime navigation, selected-company role switching, command palette behavior and backend authorization must be independently verified before merge. No CI, tests, deployment or merge were run.

## Shell and fallback behavior

| Concern | Final behavior |
| --- | --- |
| Company shell | A company with `companyType === "properties"` renders `PropertiesShell`. |
| Canonical namespace | All normal Properties workspace routes live under `/properties/*`. |
| Historical aliases | `/my-settings` and `/balance-repair` redirect to their canonical Properties routes with replacement history when a Properties company is selected. |
| Wrong-mode route | A Properties company entering a non-Properties route is redirected to `/properties/daybook` with replacement history. |
| Unknown Properties route | The Properties route switch redirects to `/properties/daybook` with replacement history. |
| Unauthorized Properties route | Permission-gated route components are not mounted; the route falls through safely to `/properties/daybook`. |
| Root Back behavior | Root pages do not expose arbitrary browser-history Back behavior. |

## Final sidebar structure

### Reorderable top-level pages

| Label | Route | Permission | Classification |
| --- | --- | --- | --- |
| Daybook | `/properties/daybook` | Properties user | Root |
| Agent Ledger | `/properties/agents` | Properties user | Root |
| Rentals | `/properties/rentals` | Properties user | Root hub |
| Accounts | `/properties/accounts` | Properties user | Root |
| Vouchers | `/properties/vouchers` | Properties user | Root |
| Analytics | `/properties/analytics` | Properties user | Root |

All six are displayed together at the top of the Properties sidebar, without redundant Rentals or Accounting collapsible groups. Drag their handles to reorder them. The order is saved in browser storage; when pages are added later, existing choices stay in order and new pages are appended.

### Rentals hub routes

| Label | Canonical route | Permission | Parent |
| --- | --- | --- | --- |
| Properties (Warehouses) | `/properties/rentals` | Properties user | Root hub |
| Shops Rented | `/properties/rentals?tab=shops` | Properties user | Root hub tab |
| Payments Log | `/properties/rentals?tab=payments` | Properties user | Root hub tab |
| Cash Transfer | `/properties/transfer` | Developer only | Rentals hub |

Legacy rental URLs remain supported and redirect with replacement history:

- `/properties/rental/warehouses` → `/properties/rentals`
- `/properties/rental/shops` → `/properties/rentals?tab=shops`
- `/properties/rental/payments` → `/properties/rentals?tab=payments`

### Accounting

| Label | Route | Permission | Classification |
| --- | --- | --- | --- |
| Accounts | `/properties/accounts` | Properties user | Root |
| Vouchers | `/properties/vouchers` | Properties user | Root |
| Analytics | `/properties/analytics` | Properties user | Root |

### Footer

| Label | Route | Permission | Classification |
| --- | --- | --- | --- |
| My Settings | `/properties/my-settings` | Authenticated Properties user | Root |
| Settings | `/properties/settings` | Admin or Developer | Root |

## Complete route hierarchy

| Route pattern | Screen | Permission | Deterministic parent |
| --- | --- | --- | --- |
| `/properties/dashboard` | Hidden compatibility dashboard | Properties user | Root |
| `/properties/daybook` | Properties daybook | Properties user | Root |
| `/properties/agents` | Agent ledger | Properties user | Root |
| `/properties/rentals` | Shared Rentals hub | Properties user | Root |
| `/properties/rental/warehouses` | Legacy warehouse alias | Properties user | Warehouses hub tab |
| `/properties/rental/shops` | Legacy shops alias | Properties user | Shops hub tab |
| `/properties/rental/payments` | Legacy payments alias | Properties user | Payments hub tab |
| `/properties/create` | Create property | Properties user | Warehouses hub tab |
| `/properties/transfer` | Company cash transfer | Developer | Rentals hub |
| `/properties/accounts` | Accounts | Properties user | Root |
| `/properties/ledger-monthly/:accountId` | Monthly account ledger | Properties user | Accounts |
| `/properties/ledger-vouchers/:accountId/:year/:month` | Monthly ledger vouchers | Properties user | Exact monthly ledger |
| `/properties/vouchers` | Vouchers | Properties user | Root |
| `/properties/voucher-detail/:voucherId` | Voucher detail | Properties user | Vouchers |
| `/properties/vouchers/:id/edit` | Voucher edit | Properties user | Vouchers |
| `/properties/analytics` | Properties analytics | Properties user | Root |
| `/properties/settings` | Properties settings | Admin or Developer | Root |
| `/properties/net-position-details` | Net position details | Admin or Developer | Settings |
| `/properties/deleted-items` | Deleted items | Admin or Developer | Settings |
| `/properties/orphaned-records` | Orphaned records | Admin or Developer | Settings |
| `/properties/chatbot-settings` | Chatbot settings | Admin or Developer | Settings |
| `/properties/import-cycle-diagnostics` | Import-cycle diagnostics | Admin or Developer | Settings |
| `/properties/inventory-repair` | Inventory repair | Admin or Developer | Settings |
| `/properties/company-data-reset` | Company data reset | Admin or Developer | Settings |
| `/properties/account-groups` | Account groups | Admin or Developer | Accounts |
| `/properties/balance-repair` | Balance repair | Admin or Developer | Settings |
| `/properties/my-settings` | Personal settings | Authenticated Properties user | Root |

## Back, Escape, and browser history contract

1. Close the newest open dialog, menu, popover, command palette, or layered control first.
2. Do not navigate away while an editable control is actively handling Escape.
3. On child pages, Escape and visible Back use the same deterministic parent.
4. Root pages do not expose a Back action based only on browser history.
5. Hub tab changes replace history instead of adding repetitive entries.
6. Direct links to valid child screens remain supported.
7. Invalid and retired aliases canonicalize with replacement history.
8. Unknown or unauthorized routes land safely on Properties Daybook.

## Permission contract

| Role | Expected Properties navigation access |
| --- | --- |
| Regular Properties user | Daily work, Rentals, Accounts, Vouchers, Analytics, My Settings |
| Admin | Regular access plus Properties Settings and admin repair/diagnostic routes |
| Developer | Admin access plus Company Cash Transfer |

Unauthorized routes must not mount hidden page content before redirecting to a safe permitted Properties page.

## Remaining phase

### Phase 5 — final regression verification

- Verify direct entry, Back, Forward, Escape, visible Back, permissions, and unknown routes.
- Reconcile the branch with the latest `main`.
- Confirm the final diff remains navigation-only before merge.

## Unification Phase 10 — compatibility and deep links (2026-11-09)

- **Legacy dashboard retained deliberately.** `/properties/dashboard` is hidden in pinned navigation and command discovery but remains a directly routed, fully functional compatibility screen. Its cash-account and payable-account management actions still exist; do not delete the page, its support components or its related endpoints without a separate feature migration and usage analysis.
- **Rental bookmarks retained.** The three `/properties/rental/*` aliases are now rendered from `PROPERTIES_LEGACY_RENTAL_REDIRECTS` using `<Redirect replace>` so the canonical path, tabs and route registration cannot silently drift. The canonical hub and its Warehouses, Shops and Payments tabs remain unchanged.
- **Parameterized deep links.** `findPropertiesNavigationEntry` resolves the canonical registry for concrete voucher-edit, voucher-detail, ledger-monthly and ledger-vouchers URLs, as well as `?tab=shops` and `?tab=payments`. It matches full path segments, not similar-looking prefixes, so absent or extra segments do not grant UI capability visibility.
- **Sidebar icons.** Pinned icons are bound to canonical path identities, not array positions; the six pinned paths, labels and drag-reorder behavior remain unchanged.
- **Unknown and forbidden links.** The existing fallback remains `/properties/daybook` with replacement navigation. Selected-company frontend role checks are maintained; server permission and tenant boundaries remain authoritative.
- **Verification.** `tests/properties-unification-phase10-navigation.test.ts` was committed to cover redirects, deep links, gating, sidebar pins, dashboard reachability and fail-safe unknown paths. This implementation was source-inspected, **not** browser-tested or Vitest-executed. Phase 11 must test actual navigation and account-management actions before any release.

## Unification Phase 13 — deterministic parent routes (2026-11-09)

- `client/src/properties/config/propertiesNavigation.ts` is now the single source for Properties route parents; `getPropertiesParentRoute` resolves concrete route IDs and historical rental aliases.
- `client/src/lib/parent-routes.ts` delegates Properties Back/Escape targets to that resolver. Factory and ERP parent logic is untouched.
- Resolved registry drift: `/properties/account-groups` returns to `/properties/accounts`; `/properties/create` returns to the Warehouses tab; ledger voucher details return to the corresponding `/properties/ledger-monthly/:accountId`.
- Preserved historical one-segment ledger period bookmarks as a parent-navigation compatibility rule and `/properties/rental/*` alias behavior.
- Dynamic route parents use exact path-segment matching. Unknown and malformed URLs receive no invented parent; root Properties pages still have no deterministic Back target.
- Added Phase 13 test cases to `tests/properties-parent-routes.test.ts`. **Source authored and inspected, not executed**; browser Escape, Back/Forward and tests require execution before release.
