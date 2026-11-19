import { CheckCircle2, Download, PackageMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFactorySupplierReturnsState } from "./useFactorySupplierReturnsState";
import { FactorySupplierReturnsSection } from "./FactorySupplierReturnsSection";
import { FactorySupplierReturnsSection2 } from "./FactorySupplierReturnsSection2";
import { FactorySupplierReturnsContent } from "./FactorySupplierReturnsContent";

export default function FactorySupplierReturns() {
  const {
    addAllocation,
    addManual,
    busy,
    changeAllocation,
    combined,
    confirm,
    copy,
    detailRows,
    downloadTemplate,
    exportPostedBatch,
    exportPreview,
    exporting,
    exportingBatch,
    history,
    manualCode,
    manualQty,
    mapRows,
    openBatch,
    post,
    preview,
    previewSupplierId,
    rawRows,
    ready,
    reason,
    receipt,
    removeAllocation,
    returnDate,
    selectedBatch,
    setAllocations,
    setConfirm,
    setManualCode,
    setManualQty,
    setPreview,
    setPreviewSupplierId,
    setRawRows,
    setReason,
    setRequestKey,
    setReturnDate,
    setSourceFile,
    setSupplierId,
    sourceFile,
    supplierId,
    suppliers,
    totalBales,
    upload,
  } = useFactorySupplierReturnsState();
  return (
    <div className="space-y-5 max-w-full" data-testid="factory-supplier-returns">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <PackageMinus className="h-5 w-5" />
            {copy.header}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{copy.intro}</p>
        </div>
        <Button variant="outline" onClick={() => void downloadTemplate()}>
          <Download className="h-4 w-4 mr-2" />
          {copy.template}
        </Button>
      </div>
      <FactorySupplierReturnsSection2
        addManual={addManual}
        busy={busy}
        copy={copy}
        manualCode={manualCode}
        manualQty={manualQty}
        mapRows={mapRows}
        rawRows={rawRows}
        reason={reason}
        receipt={receipt}
        returnDate={returnDate}
        setAllocations={setAllocations}
        setConfirm={setConfirm}
        setManualCode={setManualCode}
        setManualQty={setManualQty}
        setPreview={setPreview}
        setPreviewSupplierId={setPreviewSupplierId}
        setRawRows={setRawRows}
        setReason={setReason}
        setRequestKey={setRequestKey}
        setReturnDate={setReturnDate}
        setSourceFile={setSourceFile}
        setSupplierId={setSupplierId}
        sourceFile={sourceFile}
        supplierId={supplierId}
        suppliers={suppliers}
        upload={upload}
      />
      {preview.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="px-4 py-3 border-b flex flex-wrap gap-3 justify-between">
            <strong>
              {copy.mapping}: {combined.entries.filter((entry) => entry.valid).length}/{preview.length} {copy.validRows}
            </strong>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                {copy.totalRequested}: <strong>{totalBales}</strong>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void exportPreview()}
                disabled={busy || exporting || previewSupplierId !== supplierId}
              >
                <Download className="h-4 w-4 mr-1" />
                {exporting ? copy.exporting : copy.exportPreview}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <FactorySupplierReturnsContent
              addAllocation={addAllocation}
              busy={busy}
              changeAllocation={changeAllocation}
              combined={combined}
              copy={copy}
              preview={preview}
              receipt={receipt}
              removeAllocation={removeAllocation}
            />
          </div>
        </div>
      )}
      {preview.length > 0 && (
        <div className="rounded-lg border p-4 flex flex-wrap gap-4 items-center justify-between">
          <label className="flex gap-2 items-start text-sm">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
              disabled={!ready || !!receipt}
              className="mt-1"
            />
            {copy.confirmation}
          </label>
          <Button disabled={!ready || !confirm || busy || !!receipt} onClick={() => void post()}>
            {busy ? copy.processing : copy.confirmButton}
          </Button>
        </div>
      )}
      {receipt && (
        <div className="border rounded-lg p-4 text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 inline mr-2" />
          {copy.batch} #{receipt.id}: {copy.successBody}
        </div>
      )}
      <FactorySupplierReturnsSection
        busy={busy}
        copy={copy}
        detailRows={detailRows}
        exportPostedBatch={exportPostedBatch}
        exportingBatch={exportingBatch}
        history={history}
        openBatch={openBatch}
        selectedBatch={selectedBatch}
      />
    </div>
  );
}
