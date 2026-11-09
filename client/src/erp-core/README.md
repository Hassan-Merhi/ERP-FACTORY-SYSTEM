# ERP Core UI — Phases 1–2

Use `@/erp-core` for new ERP-mode page presentation. This folder is a **composition/adoption layer**, not a new visual framework.

## Existing authoritative primitives

- `ErpPage` composes the existing `PageShell` and `PageHeader`. Keep `layout="padded"` for old stock/report pages, `layout="workspace"` for new workspace screens, and `layout="core-erp"` where the ERP phone layout needs it.
- `ErpSection`, `ErpToolbar`, `ErpPageActions`, `ErpDataTableToolbar` and `ErpSearchField` all reuse the existing shared components. Do not copy their markup into a new ERP implementation.
- `ErpLoadingState`, `ErpEmptyState`, `ErpErrorState` and `ErpSuccessState` reuse `page-state.tsx`. Existing specialized stock/report empty states are retained until their dedicated migration.
- `ErpStatCard`, `ErpCard` and `ErpBadge` are aliases, not new KPI/status implementations.

## Theme and boundaries

The ERP-only blue theme stays in `client/src/styles/erp-unified-theme.css`, imported by `ErpShell` and scoped to `html[data-app-shell="erp"]`. Use semantic Tailwind classes (`bg-background`, `bg-card`, `text-foreground`, `text-primary`, `border-border`) in new ERP markup, not inline hex colors. Do **not** import ERP theme tokens into Factory/Properties or remap success, warning, debit/credit, or chart colors.

## Adoption example

```tsx
import { ErpPage, ErpPageActions, ErpDataTableToolbar, ErpEmptyState } from "@/erp-core";

<ErpPage
  title="Inventory"
  subtitle="Current company inventory"
  headerActions={<ErpPageActions>{/* Existing actions */}</ErpPageActions>}
>
  <ErpDataTableToolbar search={search} onSearchChange={setSearch} />
  {!rows.length ? <ErpEmptyState title="No inventory" /> : <ExistingInventoryRows rows={rows} />}
</ErpPage>;
```


## Phase 2: canonical tables, filters and pagination

- `ErpListTable` wraps the existing responsive `Table` implementation, including sticky headings, horizontal overflow, and optional mobile card presentation. It defaults to **compact** density, persisting user choices through the existing `useTablePrefs` hook. Use a unique `pageKey`, and pass `companyId` whenever available. For nested previews, set `showDensityControl={false}` to avoid duplicate selectors.
- `ErpListFilters` reuses the existing `DataTableToolbar` and `ErpMobileFilters` so there is one controlled search/filter experience across desktops and phones. Pages still own their own filter values, query semantics, business sorting and available actions.
- `ErpListPagination` is a presentation-only bounded pager. Stock Query now requests server pages of 100 instead of silently truncating the first 200 items. Search changes and company changes reset its page, and shrinking results recover a valid page.
- Standardized list surfaces: Stock Query, Stock Items, Optional Vouchers, Customers, Suppliers, Stock Transfers, Accounts, condensed and detailed Daybook, Stock & Sales Report, Market Price Analysis, PO Import preview, Supplier Profit Check, Ledger Vouchers and Stock Item History. Existing responsive cards and interactive row actions were retained.
- Specialized **Location Inventory**, stock entry history and voucher forms use bespoke scanning, editable and/or synchronized layouts; preserve their dedicated table/mobile logic until a dedicated regression-tested migration. Do not force these through generic list tables.

**Verification**: unit tests cover ERP page composition, table density persistence, filter delegation, and pagination bounds. Run the frontend Vitest suite and TypeScript checks before merging; the migration itself does not change ledger/voucher arithmetic or stock posting.

## Rollout rules

1. Phase 1 sets the stable API and migrates Opening/Closing Stock Summary as non-accounting pilot pages, retaining their existing shell spacing and header semantics.
2. Phase 2 introduces the standard list table, shared filter toolbar, and pagination controls. Phase 3 handles forms/actions; Phase 4 centralizes permissions/route visibility; Phase 5 standardizes queries and number/date display; Phase 6 handles reports/export; Phase 7 removes proven duplicates.
3. Never move voucher posting, ledger calculations, stock valuation, payroll arithmetic, or company authorization into UI components. Server authorization remains definitive.
4. Do not change data-testid, route URLs, stock balance calculations, or create/edit behavior as part of a presentational migration. Stock Query's former 200-result cap is separately replaced by explicit company-aware server pagination.
