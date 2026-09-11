import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronUp, FileDown, GitBranch, History } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { queryClient } from "@/lib/queryClient";
import { ApproveRevisionDialog } from "./dialogs/ApproveRevisionDialog";
import { ImportTransferExcelDialog } from "./dialogs/ImportTransferExcelDialog";
import { SaveAsRevisionDialog } from "./dialogs/SaveAsRevisionDialog";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function StockTransferFooterAndDialogs({ model }: { model: StockTransferFormModel }) {
  const {
    stockTransferForm,
    transferEntries,
    handleExportStockTransfer,
    stockTransferMutation,
    voucherIdToEdit,
    stockTransferToEdit,
    isTransferSavingRevision,
    handleTransferSaveAsRevision,
    approveRevisionMutation,
    approveRevisionTarget,
    setApproveRevisionTarget,
    pendingTransferRevisions,
    stableTransferId,
    transferRevisions,
    transferRevisionsExpanded,
    setTransferRevisionsExpanded,
    modeApiRequest,
    lastKnownTransferIdRef,
    transferRevisionDialogOpen,
    setTransferRevisionDialogOpen,
    transferRevisionNote,
    setTransferRevisionNote,
    computeTransferRevisionItems,
    confirmTransferSaveAsRevision,
    importDialogOpen,
    setImportDialogOpen,
    downloadImportTemplate,
    handleImportFileChange,
    handleImportParse,
    handleImportSubmit,
    handleImportValidate,
    importDate,
    setImportDate,
    importDestLocation,
    setImportDestLocation,
    importFile,
    importHasErrors,
    importIsValidated,
    importMutation,
    importNotes,
    setImportNotes,
    importParseMutation,
    importPreview,
    importValidItemsCount,
    importValidateMutation,
    importValidationResult,
    locations,
    importConfirmDialogOpen,
    setImportConfirmDialogOpen,
    importTotalItemsCount,
    handleConfirmedImport,
  } = model;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-start gap-2 sm:gap-4">
        <FormField
          control={stockTransferForm.control}
          name="notes"
          render={({ field }) => (
            <FormItem className="flex-1">
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="Notes (optional)"
                  className="resize-none h-9"
                  data-testid="input-transfer-notes"
                />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          control={stockTransferForm.control}
          name="optional"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  data-testid="checkbox-transfer-optional"
                />
              </FormControl>
              <FormLabel className="text-sm">Optional</FormLabel>
            </FormItem>
          )}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={transferEntries.filter((entry) => entry.stockItemId > 0).length === 0}
              data-testid="button-export-stock-transfer"
            >
              <FileDown className="h-4 w-4 mr-2" />
              Export
              <ChevronDown className="h-4 w-4 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleExportStockTransfer(false)} data-testid="export-transfer-summary">
              Summary Export
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExportStockTransfer(true)} data-testid="export-transfer-detailed">
              Detailed Export
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="submit"
          disabled={
            stockTransferMutation.isPending || transferEntries.filter((entry) => entry.stockItemId > 0).length === 0
          }
          data-testid="button-save-transfer-voucher"
        >
          {stockTransferMutation.isPending ? "Saving..." : "Save Transfer"}
        </Button>
        {voucherIdToEdit && stockTransferToEdit?.id && (
          <Button
            type="button"
            variant="outline"
            disabled={isTransferSavingRevision || transferEntries.filter((entry) => entry.stockItemId > 0).length === 0}
            onClick={handleTransferSaveAsRevision}
            data-testid="button-save-transfer-revision"
          >
            <GitBranch className="h-4 w-4 mr-1" />
            Save as Revision
          </Button>
        )}
      </div>

      <ApproveRevisionDialog
        approveRevisionMutation={approveRevisionMutation}
        approveRevisionTarget={approveRevisionTarget}
        setApproveRevisionTarget={setApproveRevisionTarget}
        pendingRevisions={pendingTransferRevisions}
      />

      {voucherIdToEdit && stableTransferId && (
        <div className="mt-4 border rounded-xl overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-left cursor-pointer select-none"
            onClick={() => setTransferRevisionsExpanded((expanded) => !expanded)}
          >
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Revision History</span>
              {transferRevisions.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-xs no-default-active-elevate">
                  {transferRevisions.length}
                </Badge>
              )}
            </div>
            {transferRevisionsExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {transferRevisionsExpanded && (
            <div className="p-4 space-y-4">
              {transferRevisions.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No revisions yet"
                  description='Use "Save as Revision" to record tracked changes to this transfer.'
                />
              ) : (
                transferRevisions.map((revision) => (
                  <div key={revision.id} className="border rounded-md overflow-hidden">
                    {revision.optional && (
                      <div className="flex items-center justify-between gap-3 px-3 py-2 status-warning border-b">
                        <span className="text-xs font-medium">Pending POS adjustment — awaiting admin approval</span>
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => setApproveRevisionTarget(revision)}
                          data-testid={`button-approve-revision-${revision.id}`}
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 p-3 bg-muted/40 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={revision.optional ? "secondary" : "default"}>
                          Rev {revision.revisionNumber}
                        </Badge>
                        {revision.optional && (
                          <Badge variant="outline" className="text-xs">
                            Reference Only
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {revision.revisionDate ? new Date(revision.revisionDate).toLocaleDateString() : ""}
                        </span>
                        {revision.note && (
                          <span className="text-xs italic text-muted-foreground">"{revision.note}"</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Reference only:</span>
                        <Switch
                          checked={revision.optional}
                          onCheckedChange={async (checked) => {
                            try {
                              await modeApiRequest("PATCH", `/api/stock-transfer-revisions/${revision.id}/optional`, {
                                optional: checked,
                              });
                            } finally {
                              setTransferRevisionsExpanded(true);
                              queryClient.invalidateQueries({
                                queryKey: ["/api/stock-transfers", lastKnownTransferIdRef.current, "revisions"],
                              });
                            }
                          }}
                          data-testid={`switch-transfer-revision-optional-${revision.id}`}
                        />
                      </div>
                    </div>
                    {revision.items && revision.items.length > 0 && (
                      <div className="table-responsive">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/30">
                            <tr>
                              <th className="text-left p-2 font-medium">Item</th>
                              <th className="text-left p-2 font-medium hidden sm:table-cell">From</th>
                              <th className="text-right p-2 font-medium">Was</th>
                              <th className="text-right p-2 font-medium">Change</th>
                              <th className="text-right p-2 font-medium">Now</th>
                            </tr>
                          </thead>
                          <tbody>
                            {revision.items
                              .filter((item) => parseFloat(item.delta ?? "0") !== 0)
                              .map((item, index: number) => {
                                const delta = parseFloat(item.delta ?? "0");
                                return (
                                  <tr key={index} className="border-t">
                                    <td className="p-2 font-medium">{item.stockItemName}</td>
                                    <td className="p-2 text-muted-foreground hidden sm:table-cell">
                                      {item.sourceLocationName || "—"}
                                    </td>
                                    <td className="p-2 text-right font-mono text-muted-foreground">
                                      {formatNumber(parseFloat(item.originalQuantity ?? "0"), 0)}
                                    </td>
                                    <td
                                      className={`p-2 text-right font-mono font-semibold ${delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                                    >
                                      {delta > 0 ? "+" : ""}
                                      {formatNumber(delta, 0)}
                                    </td>
                                    <td className="p-2 text-right font-mono font-semibold">
                                      {formatNumber(parseFloat(item.newQuantity ?? "0"), 0)}
                                    </td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      <SaveAsRevisionDialog
        computeTransferRevisionItems={computeTransferRevisionItems}
        confirmTransferSaveAsRevision={confirmTransferSaveAsRevision}
        isTransferSavingRevision={isTransferSavingRevision}
        setTransferRevisionDialogOpen={setTransferRevisionDialogOpen}
        setTransferRevisionNote={setTransferRevisionNote}
        transferRevisionDialogOpen={transferRevisionDialogOpen}
        transferRevisionNote={transferRevisionNote}
        transferRevisions={transferRevisions}
      />

      <ImportTransferExcelDialog
        downloadImportTemplate={downloadImportTemplate}
        handleImportFileChange={handleImportFileChange}
        handleImportParse={handleImportParse}
        handleImportSubmit={handleImportSubmit}
        handleImportValidate={handleImportValidate}
        importDate={importDate}
        importDestLocation={importDestLocation}
        importDialogOpen={importDialogOpen}
        importFile={importFile}
        importHasErrors={importHasErrors}
        importIsValidated={importIsValidated}
        importMutation={importMutation}
        importNotes={importNotes}
        importParseMutation={importParseMutation}
        importPreview={importPreview}
        importValidItemsCount={importValidItemsCount}
        importValidateMutation={importValidateMutation}
        importValidationResult={importValidationResult}
        locations={locations}
        setImportDate={setImportDate}
        setImportDestLocation={setImportDestLocation}
        setImportDialogOpen={setImportDialogOpen}
        setImportNotes={setImportNotes}
      />

      <AlertDialog open={importConfirmDialogOpen} onOpenChange={setImportConfirmDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import with Validation Errors?</AlertDialogTitle>
            <AlertDialogDescription>
              {importValidItemsCount === 0 ? (
                <>All {importTotalItemsCount} items have validation errors. Nothing will be imported.</>
              ) : (
                <>
                  {importTotalItemsCount - importValidItemsCount} of {importTotalItemsCount} items have validation
                  errors and will be skipped.
                  <br />
                  <br />
                  <strong>{importValidItemsCount} valid item(s)</strong> will be transferred.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-import-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmedImport} data-testid="button-import-confirm">
              {importValidItemsCount === 0 ? "OK" : `Import ${importValidItemsCount} Item(s)`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
