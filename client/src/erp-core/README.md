# ERP Core UI — Phase 1

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

## Rollout rules

1. Phase 1 sets the stable API and migrates Opening/Closing Stock Summary as non-accounting pilot pages, retaining their existing shell spacing and header semantics.
2. Phase 2 migrates actual table and filter implementations; Phase 3 handles forms/actions; Phase 4 centralizes permissions/route visibility; Phase 5 standardizes queries and number/date display; Phase 6 handles reports/export; Phase 7 removes proven duplicates.
3. Never move voucher posting, ledger calculations, stock valuation, payroll arithmetic, or company authorization into UI components. Server authorization remains definitive.
4. Do not change data-testid, route URLs, state/query identity, stock balance calculations, or create/edit behavior as part of presentational migration.
