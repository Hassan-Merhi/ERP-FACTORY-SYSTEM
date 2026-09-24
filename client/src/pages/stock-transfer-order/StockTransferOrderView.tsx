import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RevisionDialog } from "./dialogs/RevisionDialog";
import { ImportDialog } from "./dialogs/ImportDialog";
import { QuantityPickerDialog } from "./dialogs/QuantityPickerDialog";
import { StockMovementDialog } from "./dialogs/StockMovementDialog";
import { DetailDialog } from "./dialogs/DetailDialog";
import { RevisionHistoryPanel } from "./RevisionHistoryPanel";
import { StockTransferOrderHeader } from "./StockTransferOrderHeader";
import { StockTransferOrderMatrix } from "./StockTransferOrderMatrix";
import { StockTransferOrderPanel } from "./StockTransferOrderPanel";
import type { useStockTransferOrderModel } from "./useStockTransferOrderModel";

type Model = ReturnType<typeof useStockTransferOrderModel>;

interface StockTransferOrderViewProps {
  model: Model;
  onSwitchToNormalView?: () => void;
}

export function StockTransferOrderView({ model, onSwitchToNormalView }: StockTransferOrderViewProps) {
  const {
    hasDraft,
    editVoucherId,
    discardDraft,
    restoreDraft,
    validationErrors,
    existingTransfer,
    revisions,
    revisionsExpanded,
    setRevisionsExpanded,
    computeRevisionItems,
    confirmSaveAsRevision,
    isSavingRevision,
    revisionDialogOpen,
    revisionNote,
    setRevisionDialogOpen,
    setRevisionNote,
    applyImport,
    downloadImportTemplate,
    exportPreviewExcel,
    exportPreviewPDF,
    handleImportFile,
    importDialogOpen,
    importFileRef,
    importLoading,
    importPreview,
    setImportDialogOpen,
    setImportPreview,
    pickerQuantity,
    quantityInputRef,
    quantityPicker,
    setPickerQuantity,
    setQuantityPicker,
    handleAddToOrder,
    formatAmount,
    historyData,
    historyDialogOpen,
    historyItem,
    historyLoading,
    historyLocation,
    historyPeriod,
    matrixRef,
    navigate,
    setDetailDirection,
    setDetailMonth,
    setDetailMonthName,
    setDetailOpen,
    setDetailYear,
    setHistoryDialogOpen,
    setHistoryPeriod,
    detailData,
    detailDirection,
    detailLoading,
    detailMonthName,
    detailOpen,
    detailYear,
  } = model;

  return (
    <div className="min-w-0 max-w-full space-y-4 overflow-x-hidden">
      {hasDraft && !editVoucherId && (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-2 text-sm"
          data-testid="banner-draft-restore"
        >
          <span className="text-amber-800 dark:text-amber-300">
            You have an unsaved draft. Restore it to continue where you left off.
          </span>
          <div className="flex gap-2 flex-shrink-0">
            <Button size="sm" variant="outline" onClick={discardDraft} data-testid="button-discard-draft">
              Discard
            </Button>
            <Button size="sm" onClick={restoreDraft} data-testid="button-restore-draft">
              Restore Draft
            </Button>
          </div>
        </div>
      )}

      <StockTransferOrderHeader model={model} onSwitchToNormalView={onSwitchToNormalView} />

      {validationErrors.length > 0 && (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="py-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium text-destructive">Validation Errors</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {validationErrors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="min-w-0 flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(300px,1fr)]">
        <StockTransferOrderMatrix model={model} />
        <StockTransferOrderPanel model={model} />
      </div>

      <RevisionHistoryPanel
        editVoucherId={editVoucherId}
        transferId={existingTransfer?.id}
        revisions={revisions}
        revisionsExpanded={revisionsExpanded}
        setRevisionsExpanded={setRevisionsExpanded}
      />

      <RevisionDialog
        computeRevisionItems={computeRevisionItems}
        confirmSaveAsRevision={confirmSaveAsRevision}
        isSavingRevision={isSavingRevision}
        revisionDialogOpen={revisionDialogOpen}
        revisionNote={revisionNote}
        revisions={revisions}
        setRevisionDialogOpen={setRevisionDialogOpen}
        setRevisionNote={setRevisionNote}
      />

      <ImportDialog
        applyImport={applyImport}
        downloadImportTemplate={downloadImportTemplate}
        exportPreviewExcel={exportPreviewExcel}
        exportPreviewPDF={exportPreviewPDF}
        handleImportFile={handleImportFile}
        importDialogOpen={importDialogOpen}
        importFileRef={importFileRef}
        importLoading={importLoading}
        importPreview={importPreview}
        setImportDialogOpen={setImportDialogOpen}
        setImportPreview={setImportPreview}
      />

      <QuantityPickerDialog
        editVoucherId={editVoucherId}
        handleAddToOrder={handleAddToOrder}
        pickerQuantity={pickerQuantity}
        quantityInputRef={quantityInputRef}
        quantityPicker={quantityPicker}
        setPickerQuantity={setPickerQuantity}
        setQuantityPicker={setQuantityPicker}
      />

      <StockMovementDialog
        formatAmount={formatAmount}
        historyData={historyData}
        historyDialogOpen={historyDialogOpen}
        historyItem={historyItem}
        historyLoading={historyLoading}
        historyLocation={historyLocation}
        historyPeriod={historyPeriod}
        matrixRef={matrixRef}
        navigate={navigate}
        setDetailDirection={setDetailDirection}
        setDetailMonth={setDetailMonth}
        setDetailMonthName={setDetailMonthName}
        setDetailOpen={setDetailOpen}
        setDetailYear={setDetailYear}
        setHistoryDialogOpen={setHistoryDialogOpen}
        setHistoryPeriod={setHistoryPeriod}
      />

      <DetailDialog
        detailData={detailData}
        detailDirection={detailDirection}
        detailLoading={detailLoading}
        detailMonthName={detailMonthName}
        detailOpen={detailOpen}
        detailYear={detailYear}
        formatAmount={formatAmount}
        historyItem={historyItem}
        historyLocation={historyLocation}
        setDetailOpen={setDetailOpen}
      />
    </div>
  );
}
