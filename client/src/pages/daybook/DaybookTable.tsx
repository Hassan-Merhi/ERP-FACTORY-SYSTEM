import { ErpListTable } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBoundedTableRows } from "@/hooks/useBoundedTableRows";
import { Voucher } from "./types";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { EmptyState } from "@/components/ui/page-state";
import { DaybookTableState } from "@/components/daybook/DaybookFrame";
import type { DaybookTableProps } from "./daybookTableProps";
import { buildDaybookMobileItems } from "./daybookMobileItems";
import { buildDaybookDesktopRows } from "./daybookDesktopRows";
import { renderDaybookCondensedView } from "./DaybookCondensedView";

export function DaybookTable({
  displayedRows,
  visibleRows,
  offloadAlphabetical = false,
  viewMode,
  selectedRowId,
  setSelectedRowId,
  hiddenRowIds,
  setHiddenRowIds,
  showHidden,
  expandedVoucherId,
  setExpandedVoucherId,
  expandedCondensedGroups,
  setExpandedCondensedGroups,
  hideAmounts,
  accountNameCache,
  expandedLoading,
  expandedEntries,
  formatAmount,
  formatTransactionAmount,
  formatDisplayDate,
  formatDisplayTime,
  handleView,
  handleEdit,
  handleDelete,
  canEdit: canEditVoucher,
  canDelete: canDeleteVoucher,
  linkedVoucherIds,
  setDaybookRowLimit,
  DAYBOOK_PAGE_SIZE,
  navigate,
  isLoading = false,
  errorMessage = null,
  onRetry,
}: DaybookTableProps) {
  const { allowed: changesAllowed } = useExistingRecordChangeAccess(); // View Only / Create Only
  const canEdit = (v: Voucher) => changesAllowed && canEditVoucher(v);
  const canDelete = () => changesAllowed && canDeleteVoucher();
  const daybookDesktopWindow = useBoundedTableRows({
    rowCount: displayedRows.length,
    rowHeight: 52,
    minimumRows: 120,
    overscan: 18,
    enabled: viewMode === "detailed" && expandedVoucherId === null,
  });
  const daybookMobileWindow = useBoundedTableRows({
    rowCount: displayedRows.length,
    rowHeight: 86,
    minimumRows: 80,
    overscan: 12,
    enabled: viewMode === "detailed",
  });
  const desktopRows = displayedRows.slice(daybookDesktopWindow.startIndex, daybookDesktopWindow.endIndex);
  const mobileRows = displayedRows.slice(daybookMobileWindow.startIndex, daybookMobileWindow.endIndex);

  // Loading, failure and empty are three different situations. Rendering a bare
  // header for all three makes a failed request look like a day with no
  // transactions, so each one gets its own visible state.
  if (errorMessage || isLoading || visibleRows.length === 0) {
    return (
      <DaybookTableState
        isLoading={isLoading}
        errorMessage={errorMessage}
        onRetry={onRetry}
        isEmpty={visibleRows.length === 0}
      />
    );
  }
  if (viewMode === "condensed") {
    return renderDaybookCondensedView({
      visibleRows,
      offloadAlphabetical,
      setExpandedCondensedGroups,
      daybookDesktopWindow,
      hideAmounts,
      expandedCondensedGroups,
      formatDisplayDate,
      formatAmount,
      navigate,
      accountNameCache,
      handleView,
    });
  }
  const { tableRows } = buildDaybookDesktopRows({
    daybookDesktopWindow,
    hideAmounts,
    desktopRows,
    offloadAlphabetical,
    visibleRows,
    formatDisplayDate,
    formatAmount,
    selectedRowId,
    setSelectedRowId,
    navigate,
    hiddenRowIds,
    expandedVoucherId,
    showHidden,
    setExpandedVoucherId,
    formatDisplayTime,
    accountNameCache,
    handleView,
    handleEdit,
    canEdit,
    setHiddenRowIds,
    canDelete,
    linkedVoucherIds,
    handleDelete,
    expandedLoading,
    expandedEntries,
    formatTransactionAmount,
  });
  const { mobileItems } = buildDaybookMobileItems({
    daybookMobileWindow,
    mobileRows,
    offloadAlphabetical,
    visibleRows,
    formatDisplayDate,
    hideAmounts,
    formatAmount,
    navigate,
    hiddenRowIds,
    accountNameCache,
    showHidden,
    handleView,
    handleEdit,
    canEdit,
    canDelete,
    linkedVoucherIds,
    handleDelete,
  });

  const loadMoreButton = displayedRows.length < visibleRows.length && (
    <div className="flex justify-center pt-3 pb-1">
      <Button
        variant="outline"
        onClick={() => setDaybookRowLimit((prev) => prev + DAYBOOK_PAGE_SIZE)}
        data-testid="button-daybook-load-more"
      >
        Show {Math.min(DAYBOOK_PAGE_SIZE, visibleRows.length - displayedRows.length)} more
        <span className="ml-2 text-xs text-muted-foreground">
          ({displayedRows.length} of {visibleRows.length})
        </span>
      </Button>
    </div>
  );

  return (
    <>
      {/* ── Mobile card list (hidden on sm+) ── */}
      <div ref={daybookMobileWindow.scrollRef} className="sm:hidden -mx-4 overflow-y-auto max-h-[calc(100dvh-260px)]">
        {mobileItems.length === 0 ? (
          <EmptyState title="No transactions found. Create your first voucher to get started." className="mx-4" />
        ) : (
          mobileItems
        )}
        {loadMoreButton}
      </div>

      {/* ── Desktop table (hidden below sm) ── */}
      <div className="hidden sm:block">
        {/* build/vitePhase1PaginationPlugin.ts matches this opening tag on one line. */}
        {/* prettier-ignore */}
        <ErpListTable pageKey="daybook-detailed" scrollLabel="Detailed daybook" scrollRef={daybookDesktopWindow.scrollRef} wrapperClassName="max-h-[calc(100dvh-220px)]">
          <TableHeader className="sticky top-0 z-20 bg-muted [&_th]:bg-muted [&_th]:text-foreground/90">
            <TableRow>
              <TableHead className="sticky left-0 bg-muted z-10">Date &amp; Time</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Description</TableHead>
              {!hideAmounts && <TableHead className="text-right">Amount</TableHead>}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-foreground dark:[&_tr]:border-border/70 dark:[&_td]:border-border/70">
            {tableRows}
          </TableBody>
        </ErpListTable>
        {loadMoreButton}
      </div>
    </>
  );
}
