import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ChevronDown, FileDown, GitBranch } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { StockTransferRevisionHistory } from "../StockTransferRevisionHistory";
import { ApproveRevisionDialog } from "./dialogs/ApproveRevisionDialog";
import { ImportTransferExcelDialog } from "./dialogs/ImportTransferExcelDialog";
import { SaveAsRevisionDialog } from "./dialogs/SaveAsRevisionDialog";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { VoucherPhoneActionBar, useVoucherEditCancel } from "../VoucherPhoneActionBar";
import type { StockTransferFormModel } from "./useStockTransferFormModel";
import { PosStockTransferImportDialog } from "./PosStockTransferImportDialog";

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
    isPOS,
    formatAmount,
    transferTotal,
  } = model;
  const isPhone = useErpPhoneLayout();
  const cancelEdit = useVoucherEditCancel(!!voucherIdToEdit);
  const filledEntries = transferEntries.filter((entry) => entry.stockItemId > 0).length;
  const totalQuantity = Math.floor(transferEntries.reduce((sum, entry) => sum + parseFloat(entry.quantity || "0"), 0));

  return (
    <>
      <div className="mt-4 flex flex-wrap items-start gap-2 sm:gap-4">
        <FormField
          control={stockTransferForm.control}
          name="notes"
          render={({ field }) => (
            <FormItem className="flex-1 max-sm:basis-full">
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="Notes (optional)"
                  className="resize-none h-9 max-sm:h-20"
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
        {!isPhone && (
          <Button
            type="submit"
            disabled={
              stockTransferMutation.isPending || transferEntries.filter((entry) => entry.stockItemId > 0).length === 0
            }
            data-testid="button-save-transfer-voucher"
          >
            {stockTransferMutation.isPending ? "Saving..." : "Save Transfer"}
          </Button>
        )}
        {!isPhone && voucherIdToEdit && stockTransferToEdit?.id && (
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

      <VoucherPhoneActionBar
        summary={`${filledEntries} items · ${totalQuantity} qty${isPOS ? "" : ` · ${formatAmount(transferTotal)}`}`}
        saveLabel="Save Transfer"
        saving={stockTransferMutation.isPending}
        disabled={filledEntries === 0}
        onCancel={cancelEdit}
        extra={
          voucherIdToEdit && stockTransferToEdit?.id ? (
            <Button
              type="button"
              variant="outline"
              disabled={isTransferSavingRevision || filledEntries === 0}
              onClick={handleTransferSaveAsRevision}
              data-testid="button-save-transfer-revision"
            >
              <GitBranch className="h-4 w-4 mr-1" />
              Save as Revision
            </Button>
          ) : undefined
        }
        data-testid="transfer-phone-actions"
      />

      <ApproveRevisionDialog
        approveRevisionMutation={approveRevisionMutation}
        approveRevisionTarget={approveRevisionTarget}
        setApproveRevisionTarget={setApproveRevisionTarget}
        pendingRevisions={pendingTransferRevisions}
      />

      <StockTransferRevisionHistory
        voucherIdToEdit={voucherIdToEdit}
        stableTransferId={stableTransferId}
        transferRevisions={transferRevisions}
        transferRevisionsExpanded={transferRevisionsExpanded}
        setTransferRevisionsExpanded={setTransferRevisionsExpanded}
        setApproveRevisionTarget={setApproveRevisionTarget}
        formatNumber={formatNumber}
      />

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

      {isPOS ? <PosStockTransferImportDialog model={model} /> : <ImportTransferExcelDialog
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
      /> }

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
