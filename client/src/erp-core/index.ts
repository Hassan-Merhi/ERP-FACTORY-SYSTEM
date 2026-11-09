/**
 * ERP UI foundation.
 *
 * These are aliases of existing canonical components, not competing copies.
 * Prefer this import surface for newly built ERP-mode pages.
 * Shared base components remain available to Factory, POS, and Properties.
 */
export { ErpPage } from "./ErpPage";
export type { ErpPageProps } from "./ErpPage";

export { PageActions as ErpPageActions } from "@/components/ui/page-shell";
export { financialNumberClassName as erpFinancialNumberClassName } from "@/components/ui/page-shell";
export {
  WorkspaceSection as ErpSection,
  WorkspaceSectionHeader as ErpSectionHeader,
  WorkspaceToolbar as ErpToolbar,
  WorkspaceToolbarGroup as ErpToolbarGroup,
  WorkspaceActions as ErpResponsiveActions,
  ResponsiveTableFrame as ErpTableFrame,
  FormActionBar as ErpFormActions,
} from "@/components/ui/workspace-layout";
export { DataTableToolbar as ErpDataTableToolbar } from "@/components/DataTableToolbar";
export { SearchField as ErpSearchField } from "@/components/ui/search-field";
export { PeriodFilter as ErpPeriodFilter } from "@/components/ui/period-filter";
export {
  LoadingState as ErpLoadingState,
  EmptyState as ErpEmptyState,
  ErrorState as ErpErrorState,
  SuccessState as ErpSuccessState,
} from "@/components/ui/page-state";
export { StatCard as ErpStatCard } from "@/components/StatCard";
export { Card as ErpCard } from "@/components/ui/card";
export { Badge as ErpBadge } from "@/components/ui/badge";

export { ErpListTable } from "./ErpListTable";
export type { ErpListTableProps } from "./ErpListTable";
export { ErpListFilters } from "./ErpListFilters";
export {
  TableHeader as ErpTableHeader,
  TableBody as ErpTableBody,
  TableFooter as ErpTableFooter,
  TableRow as ErpTableRow,
  TableHead as ErpTableHead,
  TableCell as ErpTableCell,
} from "@/components/ui/table";
