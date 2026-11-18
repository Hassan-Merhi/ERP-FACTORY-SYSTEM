import { Suspense } from "react";
import { Plus, Package, Link2, Pencil, Trash2 } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateMixBatchDialog } from "../components/CreateMixBatchDialog";
import { EditMixBatchDialog } from "../components/EditMixBatchDialog";
import { formatNumber } from "@/lib/formatNumber";
import { recordedMixBatchCost, summarizeRecordedMixBatches } from "@/lib/recordedMixBatchCost";
import { BatchDetail, useMixBatchesState } from "./useMixBatchesState";
import { MixBatchesDialogSection } from "./MixBatchesDialogSection";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export default function MixBatches() {
  const {
    batches,
    refetch,
    isError,
    activeBatchesWithStock,
    assignDialogOpen,
    assignMutation,
    availableKg,
    canCreateBatch,
    createDialogOpen,
    deleteBatch,
    deleteId,
    deleteMutation,
    editBatch,
    filteredBatches,
    formatDisplayDate,
    handleExportReport,
    isLoading,
    overLimit,
    recordChanges,
    selectedBaleIds,
    selectedBatchId,
    selectedKg,
    setAssignDialogOpen,
    setCreateDialogOpen,
    setDeleteId,
    setEditBatch,
    setSelectedBaleIds,
    setSelectedBatchId,
    setShowAllBatches,
    setSourceBatchId,
    setStatusFilter,
    showAllBatches,
    sourceBatch,
    sourceBatchId,
    statusFilter,
    unlinkedBales,
  } = useMixBatchesState();

  if (selectedBatchId !== null) {
    return (
      <Suspense
        fallback={
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        }
      >
        <BatchDetail
          batchId={selectedBatchId}
          onBack={() => setSelectedBatchId(null)}
          onDeleted={() => setSelectedBatchId(null)}
        />
      </Suspense>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <PageHeader
            title="Mix Batches"
            subtitle="Combine raw stock containers and existing batches for bale production"
          />
        </div>
        <div className="flex items-center gap-2">
          <ExportButton onClick={handleExportReport} data-testid="button-report" />
          {recordChanges.allowed && (
            <Button
              variant="outline"
              onClick={() => {
                setSourceBatchId("");
                setSelectedBaleIds(new Set());
                setAssignDialogOpen(true);
              }}
              data-testid="button-assign-to-bales"
            >
              <Link2 className="h-4 w-4 mr-2" />
              Assign to Bales
            </Button>
          )}
          {canCreateBatch && (
            <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-mix-batch">
              <Plus className="h-4 w-4 mr-2" />
              Create Batch
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle>Batch List</CardTitle>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-48" data-testid="select-status-filter">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
                <SelectItem value="COMPLETED">Completed</SelectItem>
                <SelectItem value="all">All Batches</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : isError && !batches ? (
            <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="py-12" />
          ) : filteredBatches && filteredBatches.length > 0 ? (
            <div>
              <Table wrapperClassName="overflow-visible" mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Total (kg)</TableHead>
                    <TableHead className="text-right">Cost/kg</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const sorted = [...filteredBatches].sort((a, b) => {
                      const da = a.batchDate || a.createdAt || "";
                      const db = b.batchDate || b.createdAt || "";
                      return db > da ? 1 : db < da ? -1 : b.id - a.id;
                    });
                    return showAllBatches ? sorted : sorted.slice(0, 15);
                  })().map((batch) => {
                    const total = parseFloat(batch.totalWeightKg || "0");
                    return (
                      <TableRow
                        key={batch.id}
                        className="hover-elevate cursor-pointer"
                        onClick={() => setSelectedBatchId(batch.id)}
                        data-testid={`row-batch-${batch.id}`}
                      >
                        <TableCell className="font-medium" data-testid={`text-batch-name-${batch.id}`}>
                          {batch.name || batch.batchCode}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(total)}</TableCell>
                        <TableCell className="text-right font-mono">
                          ${recordedMixBatchCost(batch).costPerKg.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDisplayDate(batch.batchDate || batch.createdAt)}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {recordChanges.allowed && (
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setEditBatch(batch)}
                                data-testid={`button-edit-batch-${batch.id}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setDeleteId(batch.id)}
                                data-testid={`button-delete-batch-${batch.id}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                {(() => {
                  const { totalWeightKg: summaryTotal, costPerKg: blendedCost } =
                    summarizeRecordedMixBatches(filteredBatches);
                  return (
                    <tfoot className="border-t-2 border-border bg-muted/40">
                      <tr>
                        <td className="px-4 py-3 text-sm font-semibold text-foreground">
                          Combined Total
                          <div className="text-xs text-muted-foreground font-normal">
                            {filteredBatches.length} batch{filteredBatches.length !== 1 ? "es" : ""}
                          </div>
                        </td>
                        <td
                          className="px-4 py-3 text-right font-mono font-semibold text-sm"
                          data-testid="text-summary-total-kg"
                        >
                          {formatNumber(summaryTotal)}
                        </td>
                        <td
                          className="px-4 py-3 text-right font-mono font-semibold text-sm"
                          data-testid="text-summary-blended-cost"
                        >
                          ${blendedCost.toFixed(4)}
                          <span className="text-xs text-muted-foreground font-normal">/kg</span>
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  );
                })()}
              </Table>
              {filteredBatches.length > 15 && (
                <div className="flex justify-center py-3 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllBatches((v) => !v)}
                    data-testid="button-toggle-show-all-batches"
                  >
                    {showAllBatches ? `Show less` : `Show all ${filteredBatches.length} batches`}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Package}
              title="No batches found"
              description={
                statusFilter === "all" || statusFilter === "ACTIVE"
                  ? "Create your first mix batch to get started"
                  : `No batches with status: ${statusFilter}`
              }
              action={
                canCreateBatch && (statusFilter === "all" || statusFilter === "ACTIVE") ? (
                  <Button onClick={() => setCreateDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create First Batch
                  </Button>
                ) : undefined
              }
              className="py-12"
            />
          )}
        </CardContent>
      </Card>

      <CreateMixBatchDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      <EditMixBatchDialog
        batch={editBatch}
        open={!!editBatch}
        onOpenChange={(open) => {
          if (!open) setEditBatch(null);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Batch</DialogTitle>
            <DialogDescription>
              This will permanently delete the batch and unlink any bales associated with it. The bales themselves are
              not deleted — they will simply become unlinked and available to reassign.
            </DialogDescription>
          </DialogHeader>
          {deleteBatch && (
            <div className="p-3 rounded-md bg-muted text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Batch:</span>{" "}
                <span className="font-medium">{deleteBatch.name || deleteBatch.batchCode}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Total weight:</span>{" "}
                <span className="font-mono">{formatNumber(parseFloat(deleteBatch.totalWeightKg || "0"))} kg</span>
              </p>
              <p>
                <span className="text-muted-foreground">Status:</span>{" "}
                <span className="font-medium">{deleteBatch.status}</span>
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Batch"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Assign to Bales Dialog */}
      <MixBatchesDialogSection
        activeBatchesWithStock={activeBatchesWithStock}
        assignDialogOpen={assignDialogOpen}
        assignMutation={assignMutation}
        availableKg={availableKg}
        overLimit={overLimit}
        selectedBaleIds={selectedBaleIds}
        selectedKg={selectedKg}
        setAssignDialogOpen={setAssignDialogOpen}
        setSelectedBaleIds={setSelectedBaleIds}
        setSourceBatchId={setSourceBatchId}
        sourceBatch={sourceBatch}
        sourceBatchId={sourceBatchId}
        unlinkedBales={unlinkedBales}
      />
    </div>
  );
}
