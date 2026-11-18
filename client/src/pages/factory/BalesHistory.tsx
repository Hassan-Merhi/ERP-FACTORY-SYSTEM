import { Package, CheckSquare, ChevronLeft, ChevronRight, Lock, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { queryClient } from "@/lib/queryClient";
import { BaleWeightEditDialog } from "@/components/BaleWeightEditDialog";
import { BalesHistoryOverview } from "./baleshistory/components/BalesHistoryOverview";
import { BalesHistoryDialog1 } from "./baleshistory/components/BalesHistoryDialog1";
import { BalesHistoryDialog2 } from "./baleshistory/components/BalesHistoryDialog2";
import { BalesHistoryDialog3 } from "./baleshistory/components/BalesHistoryDialog3";
import { BalesHistoryDialog4 } from "./baleshistory/components/BalesHistoryDialog4";
import { BalesHistoryDialog5 } from "./baleshistory/components/BalesHistoryDialog5";
import { useBalesHistoryState, type EmbeddablePageProps } from "./useBalesHistoryState";
import { BalesHistoryTableBodySection } from "./BalesHistoryTableBodySection";
import { BalesHistorySection, BalesHistorySection2 } from "./BalesHistorySection";
import { EmptyState } from "@/components/ui/page-state";

/** `embedded`: rendered as the Bales hub "History" tab, whose PageHeader already titles the page. */
export default function BalesHistory(props: EmbeddablePageProps) {
  const {
    AdminDialog,
    authError,
    balesData,
    bulkStatus,
    bulkUpdateNamesMutation,
    bulkUpdateStatus,
    canChangeExistingRecords,
    currentPage,
    dateFilter,
    downloadExport,
    editingNameId,
    editingNameValue,
    embedded,
    expandedGroups,
    filtered,
    groupedFiltered,
    handleReprint,
    importingNames,
    isLoading,
    mhd,
    model,
    myAccess,
    nameInputRef,
    namesFileRef,
    reimportFileRef,
    reimportMutation,
    reimporting,
    removalReason,
    removeDialogOpen,
    removeMutation,
    saveEditName,
    searchTerm,
    selectedIds,
    serverTotal,
    serverTotalPages,
    setAuthError,
    setBulkStatus,
    setCurrentPage,
    setDateFilter,
    setDeleteConfirm,
    setEditingNameId,
    setEditingNameValue,
    setImportingNames,
    setReimporting,
    setRemovalReason,
    setRemoveDialogOpen,
    setRepackConfirm,
    setReturnToStockBale,
    setSearchTerm,
    setSelectedIds,
    setStatusFilter,
    setSupervisorPassword,
    setSupervisorUsername,
    setWeightEditBale,
    startEditName,
    statusFilter,
    supervisorPassword,
    supervisorUsername,
    toggleGroup,
    toggleSelect,
    toggleSelectAll,
    updateStatus,
    weightEditBale,
    wrapAdminAction,
  } = useBalesHistoryState(props);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const inStockSelectedCount = Array.from(selectedIds).filter((id) =>
    (balesData || []).some((r) => r.bale.id === id && r.bale.status === "IN_STOCK")
  ).length;

  return (
    <div className="bales-history-modern">
      {!embedded && (
        <PageHeader
          title="Bales"
          subtitle="Stock history, status management and removal"
          icon={<Package className="h-5 w-5" />}
        />
      )}
      <BalesHistoryOverview model={model} />

      {/* ── Main table card ── */}
      <div className="bales-modern-table-card">
        {/* Toolbar */}
        <BalesHistorySection
          bulkUpdateNamesMutation={bulkUpdateNamesMutation}
          canChangeExistingRecords={canChangeExistingRecords}
          dateFilter={dateFilter}
          downloadExport={downloadExport}
          importingNames={importingNames}
          namesFileRef={namesFileRef}
          reimportFileRef={reimportFileRef}
          reimportMutation={reimportMutation}
          reimporting={reimporting}
          searchTerm={searchTerm}
          setDateFilter={setDateFilter}
          setImportingNames={setImportingNames}
          setReimporting={setReimporting}
          setSearchTerm={setSearchTerm}
          setStatusFilter={setStatusFilter}
          statusFilter={statusFilter}
        />

        {/* Selection action bar */}
        {selectedIds.size > 0 && (
          <div className="bales-modern-selection flex items-center gap-3 px-3 py-2 flex-wrap">
            <CheckSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            {canChangeExistingRecords && (
              <>
                <Select value={bulkStatus} onValueChange={setBulkStatus}>
                  <SelectTrigger className="w-[170px] h-7 text-xs" data-testid="select-bulk-status">
                    <SelectValue placeholder="Change status to..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PENDING_PRESSING">Pending Pressing</SelectItem>
                    <SelectItem value="LABEL_PRINTED">Label Printed</SelectItem>
                    <SelectItem value="PRESSED">Pressed</SelectItem>
                    <SelectItem value="FINALIZED">Finalized</SelectItem>
                    <SelectItem value="IN_STOCK">In Stock</SelectItem>
                    <SelectItem value="RESERVED">Reserved</SelectItem>
                    <SelectItem value="SOLD">Sold</SelectItem>
                    <SelectItem value="REPACKED">Repacked</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!bulkStatus || bulkUpdateStatus.isPending}
                  onClick={() =>
                    wrapAdminAction(
                      () => bulkUpdateStatus.mutate({ ids: Array.from(selectedIds), status: bulkStatus }),
                      "Bulk Update Status"
                    )
                  }
                  data-testid="button-bulk-update"
                >
                  {bulkUpdateStatus.isPending ? "Updating..." : "Apply"}
                </Button>
                {inStockSelectedCount > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setRemoveDialogOpen(true);
                      setSupervisorUsername("");
                      setSupervisorPassword("");
                      setRemovalReason("");
                      setAuthError("");
                    }}
                    data-testid="button-remove-bales"
                  >
                    <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
                    Remove ({inStockSelectedCount})
                  </Button>
                )}
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedIds(new Set());
                setBulkStatus("");
              }}
              data-testid="button-clear-selection"
            >
              Clear
            </Button>
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No bales found"
            description={searchTerm ? "Try a different search term" : undefined}
          />
        ) : (
          <div>
            <Table>
              <TableHeader className="sticky top-0 z-30 border-b border-border/60">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={filtered.length > 0 && filtered.every((r) => selectedIds.has(r.bale.id))}
                      onCheckedChange={() => toggleSelectAll(filtered)}
                      data-testid="checkbox-select-all"
                    />
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Ref #
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Product
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Article
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Qty
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Weight (kg)
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Last Printed
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <BalesHistoryTableBodySection
                canChangeExistingRecords={canChangeExistingRecords}
                editingNameId={editingNameId}
                editingNameValue={editingNameValue}
                expandedGroups={expandedGroups}
                groupedFiltered={groupedFiltered}
                handleReprint={handleReprint}
                mhd={mhd}
                myAccess={myAccess}
                nameInputRef={nameInputRef}
                saveEditName={saveEditName}
                selectedIds={selectedIds}
                setDeleteConfirm={setDeleteConfirm}
                setEditingNameId={setEditingNameId}
                setEditingNameValue={setEditingNameValue}
                setRepackConfirm={setRepackConfirm}
                setReturnToStockBale={setReturnToStockBale}
                setSelectedIds={setSelectedIds}
                setWeightEditBale={setWeightEditBale}
                startEditName={startEditName}
                toggleGroup={toggleGroup}
                toggleSelect={toggleSelect}
                updateStatus={updateStatus}
                wrapAdminAction={wrapAdminAction}
              />
            </Table>
          </div>
        )}

        {/* ── Pagination ── */}
        {serverTotalPages > 1 && (
          <div className="bales-modern-pagination flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {serverTotalPages} &mdash; {serverTotal.toLocaleString()} bales total
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(serverTotalPages, p + 1))}
                disabled={currentPage >= serverTotalPages}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Remove from Stock Dialog ── */}
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Supervisor Authorization Required
            </DialogTitle>
            <DialogDescription>
              Removing {inStockSelectedCount} IN STOCK bale(s) requires supervisor credentials. This action will be
              logged.
            </DialogDescription>
          </DialogHeader>
          <BalesHistorySection2
            authError={authError}
            removalReason={removalReason}
            setAuthError={setAuthError}
            setRemovalReason={setRemovalReason}
            setSupervisorPassword={setSupervisorPassword}
            setSupervisorUsername={setSupervisorUsername}
            supervisorPassword={supervisorPassword}
            supervisorUsername={supervisorUsername}
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!supervisorUsername || !supervisorPassword || removeMutation.isPending}
              onClick={() => {
                const idsToRemove = Array.from(selectedIds).filter((id) =>
                  (balesData || []).some((r) => r.bale.id === id && r.bale.status === "IN_STOCK")
                );
                removeMutation.mutate({
                  ids: idsToRemove,
                  supervisorUsername,
                  supervisorPassword,
                  reason: removalReason,
                });
              }}
              data-testid="button-confirm-remove"
            >
              {removeMutation.isPending ? "Removing..." : "Remove from Stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BalesHistoryDialog1 model={model} />

      <BalesHistoryDialog2 model={model} />

      <BalesHistoryDialog3 model={model} />

      {/* ── Stock Register Export Dialog ── */}
      <BalesHistoryDialog4 model={model} />
      {/* Return to Stock Dialog */}
      <BalesHistoryDialog5 model={model} />

      {AdminDialog}

      <BaleWeightEditDialog
        bale={weightEditBale}
        onClose={() => setWeightEditBale(null)}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
          setWeightEditBale(null);
        }}
      />
    </div>
  );
}
