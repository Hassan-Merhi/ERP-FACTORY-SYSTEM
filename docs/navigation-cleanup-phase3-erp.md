# Phase 3 — ERP Navigation Consolidation

Branch: `feature/navigation-usage-cleanup`  
Status: **Implemented in source; Claude verification pending**  
Date: 2026-10-26

## Goal
Reduce ERP sidebar clutter without deleting accounting, inventory, POS, supplier, or reporting functions. Continue to support restricted page grants and existing bookmarks. Live study: `docs/navigation-usage-study-2026-10-26.md`.

## Source changes

| Area | Existing route retained | New contextual entry | Permission and company behavior |
|---|---|---|---|
| Inventory / Stock | `/stock` and `/stock?tab=items|query|offload` | `Inventory` offers **Stock items & search** | Shows only for an eligible Stock feature; hidden from Retail; **standalone Stock sidebar link remains** for users without Inventory hub access |
| Supplier Profit Check | `/supplier-profit-check` | `/parties?tab=profit-check` | Requires supplier access; not shown as tab in Retail; old route remains |
| Optional Vouchers | `/optional-vouchers` | Optional voucher drafts link in ERP `/vouchers` header | Requires `optional_vouchers` grant; hidden from Retail, Factory and POS-only interfaces; standalone link remains if Vouchers unavailable |
| POS Item Replacement | `/pos-item-replacement` | `/sales-tools?tab=replacement` | Requires POS access, active role must not be POS, not shown in Retail; legacy direct route remains |
| Stock In & Sales | `/stock-in-sales-report` | Contextual link in `/sales-report` | Same sales-report access; hidden for Retail |
| Item Market Analysis | `/item-market-analysis` | Contextual link in `/sales-report` | Same sales-report access; shown only to ERP-type companies |
| Discoverability | Existing command palette direct paths | Added permission-filtered entries for all relocated routes | Search results retain deep-link discoverability even when sidebar entries collapse |

`client/src/components/AppSidebar.tsx` still defines the old routes, but suppresses the standalone menu item **only when the parent hub is accessible** to the user's effective role/ERP page access. This prevents a stock-only or optional-voucher-only user from being stranded.

Business logic and back-end routes in `client/src/routes/ErpRoutes.tsx` remain unchanged. No database tables, queries, accounting postings, stock movements, or server-side permissions were modified.

## Files changed

- `client/src/components/AppSidebar.tsx`
- `client/src/components/CommandPalette.tsx`
- `client/src/pages/InventoryHub.tsx`
- `client/src/pages/PartiesHub.tsx`
- `client/src/pages/SalesToolsHub.tsx`
- `client/src/pages/Vouchers.tsx`
- `client/src/pages/SalesReport.tsx`
- This documentation and the master plan

## Source-only review

Checked on the working branch that:
- all six relocated routes remain present in `client/src/routes/ErpRoutes.tsx`;
- each new contextual entry exists in its intended page;
- fallback sidebar rules for Stock, Optional Vouchers, Supplier Profit Check, POS Item Replacement, and secondary reports exist;
- the command palette retains direct entries, filtered by existing ERP access logic;
- no route is removed or redirected and no CI, builds or tests were run.

These source inspections do **not** prove that every interaction works at runtime.

## Claude verification checklist

1. Run typecheck and build; identify any TSX typing / bundled import errors.
2. ERP admin / owner / manager / staff: verify visible links and the parent hub's tab navigation.
3. Stock-only but no Inventory feature: Stock remains in sidebar. Inventory-enabled users use contextual link and original `/stock` deep links still open.
4. Optional-vouchers-only user: still has standalone entry; normal voucher users with optional access can open drafts from Vouchers.
5. Supplier-only user: Parties can open Profit Check; Retail does not inherit that tab.
6. POS-authorized non-cashier: Sales Tools Item Replacement tab works; cashiers and Retail don't get the tab. Check replacement transaction independently before production.
7. Sales-report-only user sees contextual subreports; stock report remains unavailable in Retail and item analysis only in ERP.
8. Keyboard navigation, mobile tabs, back behavior, active item highlighting, command search and direct URLs across company switches.
9. Confirm actual server authorizations and full end-to-end accounting / stock scenarios unchanged.
10. Investigate pre-existing broad `/sales-tools` route exposure separately rather than treating sidebar hiding as server authorization.

**No CI, tests, lint, typecheck, build, merge, deploy, or production write by ChatGPT.** Leave the changes on one working branch for Claude verification.
