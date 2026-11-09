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
  FormActionBar as ErpStickyFormActionBar,
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
export { ErpListPagination } from "./ErpListPagination";
export type { ErpListPaginationProps } from "./ErpListPagination";

export { ErpField } from "./ErpField";
export type { ErpFieldProps, ErpFieldControlProps } from "./ErpField";
export { ErpFormActions, ErpPendingButton } from "./ErpFormActions";
export type { ErpFormActionsProps, ErpPendingButtonProps } from "./ErpFormActions";
export { ConfirmDialog as ErpConfirmDialog } from "@/components/ConfirmDialog";
export type { ConfirmDialogProps as ErpConfirmDialogProps } from "@/components/ConfirmDialog";
// Keep React Hook Form exports out of this barrel: eager evaluation can
// break lightweight pages and tests that mock only the hooks. Import the
// existing canonical form primitives directly from components/ui/form.
export { ErpNativeSelect } from "./ErpNativeSelect";
export { ErpRecordAction } from "./ErpRecordAction";
export type { ErpRecordActionProps } from "./ErpRecordAction";

/** Re-export existing action policies; the ERP UI layer does not make new grants. */
export { useCan as useErpCan, canDenialMessage as erpCanDenialMessage } from "@/hooks/useCan";
export { useExistingRecordChangeAccess as useErpRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
export { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";

/** Phase 5: company-scoped requests, compatible invalidation and server pagination. */
export {
  erpDataKeys,
  erpReferenceKeys,
  erpStockItemKeys,
  erpRequestUrl,
  erpCompanyDataKey,
  erpUnwrapList,
  erpUnwrapPage,
  invalidateErpDataFamilies,
} from "./erpData";
export { useErpServerPagination } from "./useErpServerPagination";
export type { ErpServerPaginationOptions } from "./useErpServerPagination";
export {
  useErpDateFormat,
  ErpMoneyAmount,
  formatErpMoneyDisplay,
  formatErpMoneyNumber,
  formatErpNumber,
  formatErpCurrencyNumber,
  formatErpFixedQuantity,
  erpDebitCreditClass,
} from "./erpDisplay";

/** Phase 6: one export presentation and file contract across ERP reports. */
export { ErpReportExportMenu } from "./ErpReportExportMenu";
export type { ErpReportExportMenuProps, ErpReportExportOption } from "./ErpReportExportMenu";
export { ErpReportPrintFooter } from "./ErpReportPrintFooter";
export {
  erpReportFileName,
  exportErpReportRowsExcel,
  buildErpReportCsv,
  exportErpReportCsv,
} from "./erpReportExports";
export type { ErpReportFileExtension } from "./erpReportExports";
