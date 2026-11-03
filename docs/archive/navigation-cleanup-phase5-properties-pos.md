# Phase 5 — Properties and POS Navigation Simplification

Date: 2026-10-26  
Branch: `feature/navigation-usage-cleanup`  
Status: **Source changes complete — Claude verification pending**

## Scope

Simplify navigation only. Existing sales, inventory, billing, cash handling, properties records, API endpoints and history are unchanged; no database or server-side permission edits, and no production deployment.

## Properties

- The `PropertiesSidebar` Rentals section now links once to `/properties/rentals` instead of repeating Warehouses, Shops and Payments as three sidebar rows.
- `PropertiesRentalsHub` already supports `?tab=warehouses|shops|payments` and retains all three tab bodies unchanged.
- Developer-only Cash Transfer remains accessible as a contextual link from Rentals (role read via `/api/auth/me`). The existing `/properties/transfer` route is unchanged and registered only for Developer.
- Properties command search retains shortcuts to Shops and Payments tabs and offers Cash Transfer only to Developer.
- Properties accounting, Daybook, Agent Ledger and existing developer reconciliation routes are unchanged pending Phase 6.

## POS

- `usePosNavigationItems` now assigns each standard POS destination to **primary** or **tools**.
- Primary navigation: Point of Sale, Daybook, Inventory, Orders and Containers OTW. Keep Containers OTW visible because nonretail POS `/` is currently that page.
- Secondary **More tools** (collapsible): Price List, Transfer, Customers when supported by existing `canAccessCustomers` setting, Import only when `posImportEnabled`, Chat only for Developer, and Settings (the existing personal password page). The section opens automatically on an active secondary route, preserves each original link and original test id, and can be toggled using an accessible button with `aria-expanded` / `aria-controls`.
- **Retail POS company type**: only renders links to the registered `/retail/pos` and `/my-settings` pages. Standard POS links would have redirected in the Retail-specific `PosRoutes` switch; those incorrect links are no longer offered. Retail cashier product, accounting and stock business functions remain untouched.
- POS shell's full-height detection now recognizes `/retail/pos`.
- Command search uses the correct Retail vs standard POS entries, and no longer sends Retail users to standard POS-only destinations. It does **not** invent extra permissions or expose Import/Customers outside their gated sidebar paths.
- Direct routes such as `/pos-containers`, `/pos-price-list`, `/pos-transfer-orders`, `/vouchers`, `/pos-import`, and `/pos-settings` remain registered exactly as before for standard POS.

## Changed source files

- `client/src/components/PropertiesSidebar.tsx`
- `client/src/pages/properties/PropertiesRentalsHub.tsx`
- `client/src/app/usePosNavigationItems.ts`
- `client/src/app/PosShell.tsx`
- `client/src/components/CommandPalette.tsx`
- This report and `docs/navigation-usage-cleanup-plan.md`

## Source-only checks performed

Reviewed existing `client/src/app/PropertiesRoutes.tsx` and `client/src/routes/PosRoutes.tsx` and cross-checked that:
- Properties Rentals canonical route, three hub tabs, compatibility redirects and Developer Cash Transfer route still exist.
- POS navigation preserves ordinary direct routes while Retail links point only at pages in the Retail-only route switch.
- POS essential pages and tool categories are present with their original handlers and test ids.
- Properties command search retains Shops and Payments tab links, with developer Cash Transfer gated.
- No backend logic or canonical data records were modified.

These checks are inspection, **not** a typecheck, build, browser session or automated test. They cannot establish 100% runtime correctness.

## Claude acceptance checklist

1. Run independent TypeScript, lint, build and role-specific tests; fix any failures.
2. Properties user / Admin / Developer / ERP Tester: verify Rentals tabs, historical bookmarks, permitted settings, Daybook and reconciliation visibility.
3. Developer Cash Transfer link appears only to Developer; attempt the destination with a normal user to confirm the **route guard**, not only UI filtering.
4. Standard POS cashier: sale screen, Daybook, Inventory, Orders and Containers OTW visible in primary sidebar; More tools opens/closes, remains expanded on tool routes and mobile drawer, preserves keyboard navigation.
5. POS permissions: Customers only when `canAccessCustomers`, Import only when enabled; Chat and sensitive management actions follow existing real server authorization. Sidebar hiding is not server-side authorization.
6. Retail cashier: root, `/pos`, `/retail/pos` checkout and `/my-settings` navigate without 404/incorrect mode links; no standard POS inventory/transfer/price-list menu items; checkout remains full-height.
7. Company switching: no prior company's menu state, access or reports leak into new company.
8. Command search: Retail and standard POS destinations are available only when their route tree supports them; Properties Shops/Payments tab URL search functions.
9. Accessible accordion control, focused keyboard navigation, aria-expanded state, hover/touch and responsive POS sidebar layout.
10. Complete end-to-end sale, refund, credit, voucher and inventory flows for regression before any production merge.

**No CI, automated tests, builds, typechecking, lint, rebase, merge, deployment or production data mutations performed.**
