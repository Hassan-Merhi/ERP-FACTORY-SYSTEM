// Extracted from ./FactoryPendingLoadings.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, Download, Link, Package, Pencil, Play, Save, Trash2, Weight, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { PriorityScanLoadingControl } from "./PriorityScanLoadingControl";
import { type PendingLoad } from "./FactoryPendingLoadingsTypes";
import { formatKg } from "@/lib/formatNumber";
import { useFactoryPendingLoadingsStatePart1 } from "./useFactoryPendingLoadingsStatePart1";

export function useFactoryPendingLoadingsState() {
  const {
    refetchLoads,
    loadsError,
    canStartLoading,
    cancelMutation,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    editingNoteId,
    editingNoteText,
    formatDate,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleDelete,
    handleExport,
    handleOpenLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    recordChanges,
    restoreMutation,
    saveNoteMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
    setEditingNoteId,
    setEditingNoteText,
    setSearchTerm,
    setSelectedProformaId,
    setSortOrder,
    sortOrder,
    toggleCustomer,
    totalBales,
    totalKg,
    undoItems,
    visibleLoads,
  } = useFactoryPendingLoadingsStatePart1();
  const { renderLoadCard } = useFactoryPendingLoadingsStatePart2({
    cancelMutation,
    editingNoteId,
    editingNoteText,
    formatDate,
    handleDelete,
    handleExport,
    handleOpenLink,
    navigate,
    recordChanges,
    saveNoteMutation,
    setEditingNoteId,
    setEditingNoteText,
  });
  return {
    refetchLoads,
    loadsError,
    canStartLoading,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    formatDate,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    renderLoadCard,
    restoreMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
    setSearchTerm,
    setSelectedProformaId,
    setSortOrder,
    sortOrder,
    toggleCustomer,
    totalBales,
    totalKg,
    undoItems,
    visibleLoads,
  };
}

function useFactoryPendingLoadingsStatePart2({
  cancelMutation,
  editingNoteId,
  editingNoteText,
  formatDate,
  handleDelete,
  handleExport,
  handleOpenLink,
  navigate,
  recordChanges,
  saveNoteMutation,
  setEditingNoteId,
  setEditingNoteText,
}: Pick<
  Awaited<ReturnType<typeof useFactoryPendingLoadingsStatePart1>>,
  | "cancelMutation"
  | "editingNoteId"
  | "editingNoteText"
  | "formatDate"
  | "handleDelete"
  | "handleExport"
  | "handleOpenLink"
  | "navigate"
  | "recordChanges"
  | "saveNoteMutation"
  | "setEditingNoteId"
  | "setEditingNoteText"
>) {
  const renderLoadCard = (load: PendingLoad, nested = false) => (
    <div
      key={load.id}
      className={
        "group relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all hover:border-primary/50 hover:shadow-md " +
        (nested ? "border-l-4 border-l-primary" : "border-l-4 border-l-primary")
      }
      data-testid={"card-load-" + load.id}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-base"
              data-testid={"text-customer-" + load.id}
            >
              {load.customerName || "Customer #" + load.customerId}
            </span>
            <Badge
              variant="secondary"
              className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 font-semibold text-primary"
              data-testid={"badge-load-id-" + load.id}
            >
              Loading #{load.id}
            </Badge>
            {load.proformaIdUsed ? (
              <Badge
                variant="outline"
                className="max-w-full gap-1 rounded-lg border-slate-200 bg-slate-50/80 text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300"
                data-testid={"badge-proforma-" + load.id}
              >
                <Link className="h-3 w-3 shrink-0" />
                <span className="max-w-56 truncate sm:max-w-72">
                  {load.proformaName || "Proforma #" + load.proformaIdUsed}
                </span>
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground" data-testid={"badge-no-proforma-" + load.id}>
                No proforma linked
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400 sm:text-sm">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Started: {formatDate(load.loadingStartedAt)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" /> {(load.totalQtyBales || 0).toLocaleString()} bales scanned
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Weight className="h-3.5 w-3.5" /> {formatKg(load.totalWeightKg)}
            </span>
          </div>
          {recordChanges.allowed && editingNoteId === load.id ? (
            <div className="flex max-w-xl items-start gap-2">
              <Textarea
                value={editingNoteText}
                onChange={(e) => setEditingNoteText(e.target.value)}
                rows={2}
                autoFocus
                className="min-w-0 resize-none rounded-xl text-sm"
                data-testid={"input-note-" + load.id}
              />
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon"
                  variant="outline"
                  className="rounded-lg"
                  onClick={() => saveNoteMutation.mutate({ id: load.id, note: editingNoteText })}
                  disabled={saveNoteMutation.isPending}
                  data-testid={"button-save-note-" + load.id}
                  title="Save note"
                >
                  <Save className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditingNoteId(null)}
                  data-testid={"button-cancel-note-" + load.id}
                  title="Cancel"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex max-w-xl items-center gap-2">
              <span
                className="min-w-0 truncate text-xs italic text-muted-foreground sm:text-sm"
                data-testid={"text-note-" + load.id}
              >
                {load.containerNotes || "No note"}
              </span>
              {recordChanges.allowed && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 rounded-md"
                  onClick={() => {
                    setEditingNoteId(load.id);
                    setEditingNoteText(load.containerNotes || "");
                  }}
                  data-testid={"button-edit-note-" + load.id}
                  title="Edit note"
                  aria-label={"Edit note for loading " + load.id}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
          <PriorityScanLoadingControl
            load={{
              id: load.id,
              customerName: load.customerName || "Customer #" + load.customerId,
              proformaIdUsed: load.proformaIdUsed,
            }}
          />
          <Button
            variant="outline"
            size="icon"
            className="rounded-xl border-border bg-card"
            onClick={() => void handleExport(load)}
            data-testid={"button-export-" + load.id}
            title="Export Excel"
            aria-label={"Export Excel for loading " + load.id}
          >
            <Download className="h-4 w-4" />
          </Button>
          {recordChanges.allowed && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl border-border bg-card font-medium"
                onClick={() => handleOpenLink(load)}
                data-testid={"button-link-proforma-" + load.id}
                title="Link proforma"
              >
                <Link className="mr-1.5 h-4 w-4" />
                {load.proformaIdUsed ? "Change Proforma" : "Link Proforma"}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="rounded-xl border-red-200 text-destructive hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-950/30"
                onClick={() => handleDelete(load)}
                disabled={cancelMutation.isPending}
                data-testid={"button-delete-" + load.id}
                title="Delete loading (returns bales to stock)"
                aria-label={"Delete loading " + load.id}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Button
                className="rounded-xl bg-primary px-4 font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => navigate("/factory/sales/loading/new?orderId=" + load.id)}
                data-testid={"button-resume-" + load.id}
              >
                <Play className="mr-1.5 h-4 w-4" />
                Resume
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
  return { renderLoadCard };
}
