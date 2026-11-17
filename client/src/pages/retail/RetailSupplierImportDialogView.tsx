// Extracted from ./RetailSupplierImportDialog.tsx to keep that module under the source-size cap.
import { RetailLabelPrintDialog } from "./retailLabels";
import { RetailSupplierImportHistory } from "./RetailSupplierImportHistory";
import {
  AlertTriangle,
  FileSpreadsheet,
  FileText,
  History,
  Image as ImageIcon,
  Printer,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RetailSupplierImportPreview } from "./RetailSupplierImportPreview";
import { downloadSupplierTemplate } from "./retailSupplierImportSpreadsheet";
import { useRetailSupplierImportDialogState } from "./useRetailSupplierImportDialogState";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function RetailSupplierImportDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const {
    busy,
    catalogChecking,
    catalogFailed,
    catalogPreview,
    checkPurchaseStatus,
    companyId,
    currency,
    deliveryReference,
    exchangeRate,
    fileError,
    fileName,
    handlePhotoArchive,
    handleSpreadsheet,
    historyOpen,
    imageIssueCount,
    imageMatchedCount,
    imageMatches,
    importKey,
    invoiceDate,
    invoiceFile,
    invoiceFileError,
    invoiceReference,
    knownLocation,
    knownSupplier,
    locationId,
    locations,
    locationsFailed,
    needsRate,
    onOpenChange,
    open,
    partialReceipt,
    photoArchive,
    photoArchiveName,
    photoBusy,
    photoError,
    photoPreviewUrls,
    postingError,
    purchaseResult,
    readyForPosting,
    receiptLabelItems,
    receiptLabelsOpen,
    rows,
    saveMutation,
    setCurrency,
    setDeliveryReference,
    setExchangeRate,
    setHistoryOpen,
    setImportKey,
    setInvoiceDate,
    setInvoiceFile,
    setInvoiceFileError,
    setInvoiceReference,
    setLocationId,
    setPartialReceipt,
    setPostingError,
    setPurchaseResult,
    setReceiptLabelItems,
    setReceiptLabelsOpen,
    setShowProblemsOnly,
    setSupplierId,
    showProblemsOnly,
    startNextDelivery,
    summary,
    supplierId,
    suppliers,
    suppliersFailed,
    toast,
    uploadProgress,
    uploadedInvoiceCache,
    validRate,
  } = useRetailSupplierImportDialogState(props);

  return (
    <>
      <Dialog open={open && !receiptLabelsOpen && !historyOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5" />
                Supplier Stock Import
              </DialogTitle>
              <Button type="button" size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
                <History className="mr-2 h-4 w-4" />
                Import history
              </Button>
            </div>
          </DialogHeader>
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            <strong>Supplier stock import.</strong> Confirming receives additional units, posts the inventory debit and
            supplier payable credit together, then opens the barcode label dialog with one label per unit received (in
            printable batches). The selected Retail company must have completed its inventory accounting opening before
            importing supplier purchases.
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="retail-import-supplier">Supplier *</Label>
              <Select
                value={supplierId || "__none__"}
                onValueChange={(v) => {
                  setSupplierId(v === "__none__" ? "" : v);
                  setPurchaseResult(null);
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
              >
                <SelectTrigger id="retail-import-supplier" className="h-10 w-full text-sm">
                  <SelectValue placeholder="Select an existing supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select an existing supplier</SelectItem>
                  {suppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={String(supplier.id)}>
                      {supplier.legalName || supplier.name || supplier.code || `Supplier #${supplier.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {suppliersFailed && <p className="text-xs text-destructive">Suppliers could not be loaded.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retail-import-location">Receiving location *</Label>
              <Select
                value={locationId || "__none__"}
                onValueChange={(v) => {
                  setLocationId(v === "__none__" ? "" : v);
                  setPurchaseResult(null);
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
              >
                <SelectTrigger id="retail-import-location" className="h-10 w-full text-sm">
                  <SelectValue placeholder="Select a stock location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select a stock location</SelectItem>
                  {locations
                    .filter((location) => location.active !== false)
                    .map((location) => (
                      <SelectItem key={location.id} value={String(location.id)}>
                        {location.name} ({location.code})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {locationsFailed && <p className="text-xs text-destructive">Locations could not be loaded.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retail-import-invoice">Supplier invoice / reference</Label>
              <Input
                id="retail-import-invoice"
                value={invoiceReference}
                onChange={(event) => {
                  setInvoiceReference(event.target.value);
                  setPurchaseResult(null);
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
                placeholder="INV-0001"
                maxLength={100}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="retail-import-date">Receipt date *</Label>
                <Input
                  id="retail-import-date"
                  type="date"
                  value={invoiceDate}
                  onChange={(event) => {
                    setInvoiceDate(event.target.value);
                    setPurchaseResult(null);
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="retail-import-currency">Invoice currency</Label>
                <Select
                  value={currency}
                  onValueChange={(v) => {
                    setCurrency(v);
                    setPurchaseResult(null);
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                >
                  <SelectTrigger id="retail-import-currency" className="h-10 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["USD", "EUR", "CDF", "CFA", "GBP", "AUD"].map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="retail-supplier-partial" className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  id="retail-supplier-partial"
                  type="checkbox"
                  className="mt-1"
                  checked={partialReceipt}
                  onChange={(event) => {
                    setPartialReceipt(event.target.checked);
                    setDeliveryReference("");
                    setPurchaseResult(null);
                    setPostingError("");
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                />
                <span>
                  <strong>Partial delivery against this supplier invoice</strong>
                  <span className="block text-xs text-muted-foreground">
                    Use only the actually received units in this Excel file. Each shipment needs a unique delivery
                    reference; earlier delivered stock and debt remain unchanged.
                  </span>
                </span>
              </label>
              {partialReceipt && (
                <div className="space-y-1">
                  <Label htmlFor="retail-supplier-delivery">Delivery / packing list reference *</Label>
                  <Input
                    id="retail-supplier-delivery"
                    value={deliveryReference}
                    maxLength={100}
                    placeholder="DELIVERY-001"
                    onChange={(event) => {
                      setDeliveryReference(event.target.value);
                      setPurchaseResult(null);
                      setPostingError("");
                      setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                    }}
                  />
                </div>
              )}
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="retail-supplier-invoice-file">Supplier invoice attachment (optional)</Label>
              <Input
                id="retail-supplier-invoice-file"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  const valid =
                    !file ||
                    (/\.(pdf|jpe?g|png)$/i.test(file.name) &&
                      ["application/pdf", "image/jpeg", "image/png"].includes(file.type) &&
                      file.size > 0 &&
                      file.size <= 10 * 1024 * 1024);
                  setInvoiceFile(valid ? file : null);
                  setInvoiceFileError(valid ? "" : "Use a PDF, JPG or PNG invoice, maximum 10 MB.");
                  uploadedInvoiceCache.current = null;
                  setPurchaseResult(null);
                  setPostingError("");
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
              />
              {invoiceFile && (
                <p className="text-xs text-muted-foreground">
                  <FileText className="mr-1 inline h-3 w-3" />
                  {invoiceFile.name} — saved with the receipt
                </p>
              )}
              {invoiceFileError && (
                <p role="alert" className="text-xs text-destructive">
                  {invoiceFileError}
                </p>
              )}
            </div>
            {needsRate && (
              <div className="space-y-1.5">
                <Label htmlFor="retail-supplier-exchange">Historical exchange rate *</Label>
                <Input
                  id="retail-supplier-exchange"
                  inputMode="decimal"
                  value={exchangeRate}
                  onChange={(event) => {
                    setExchangeRate(event.target.value);
                    setPurchaseResult(null);
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                  placeholder="USD value of 1 unit of invoice currency"
                />
                <p className="text-xs text-muted-foreground">
                  Enter USD per 1 unit of invoice currency (e.g. 1 EUR = 1.18 USD, enter 1.18). The converted historical
                  rate is saved on the voucher.
                </p>
                {!validRate && <p className="text-xs text-destructive">A positive exchange rate is required.</p>}
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">1. Download the supplier Excel template</h3>
                <p className="text-xs text-muted-foreground">
                  One line per product color/size. Cost Price is in the supplier invoice currency; Selling Price is the
                  Retail POS price in USD. Keep SKU and Barcode columns formatted as Text to preserve leading zeros.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadSupplierTemplate().catch((error) =>
                    toast({
                      title: "Template download failed",
                      description: error instanceof Error ? error.message : String(error),
                      variant: "destructive",
                    })
                  )
                }
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" /> Download template
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="retail-supplier-excel">2. Upload Excel / CSV *</Label>
                <Input
                  key={importKey}
                  id="retail-supplier-excel"
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={(event) => void handleSpreadsheet(event.target.files?.[0])}
                  disabled={busy}
                />
                {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="retail-supplier-photos">3. Product image ZIP (optional)</Label>
                <Input
                  key={importKey}
                  id="retail-supplier-photos"
                  type="file"
                  accept=".zip"
                  disabled={photoBusy}
                  onChange={(event) => void handlePhotoArchive(event.target.files?.[0])}
                />
                <p className="text-xs text-muted-foreground">
                  <ImageIcon className="mr-1 inline h-3 w-3" />
                  {photoArchiveName
                    ? `${photoArchiveName} — ${photoArchive?.imageCount ?? 0} verified images`
                    : photoBusy
                      ? "Checking picture ZIP…"
                      : "Choose ZIP with JPG/PNG/WEBP/GIF files referenced by their filenames in Excel."}
                </p>
                {photoError && (
                  <p role="alert" className="text-xs text-destructive">
                    {photoError}
                  </p>
                )}
              </div>
            </div>
            {fileError && (
              <p role="alert" className="text-sm text-destructive">
                {fileError}
              </p>
            )}
          </div>

          {rows.length > 0 && (
            <RetailSupplierImportPreview
              rows={rows}
              summary={summary}
              currency={currency}
              imageMatches={imageMatches}
              imageMatchedCount={imageMatchedCount}
              imageIssueCount={imageIssueCount}
              catalogPreview={catalogPreview}
              catalogChecking={catalogChecking}
              catalogFailed={catalogFailed}
              knownSupplier={knownSupplier}
              knownLocation={knownLocation}
              invoiceReference={invoiceReference}
              invoiceDate={invoiceDate}
              purchaseRecorded={Boolean(purchaseResult)}
              showProblemsOnly={showProblemsOnly}
              onToggleProblemsOnly={() => setShowProblemsOnly((value) => !value)}
              photoPreviewUrls={photoPreviewUrls}
              readyForPosting={readyForPosting}
            />
          )}
          {uploadProgress && <p className="text-xs text-muted-foreground">{uploadProgress}</p>}
          {postingError && (
            <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <strong>
                  {purchaseResult ? "Posted receipt needs reconciliation" : "Supplier import needs attention"}
                </strong>
              </div>
              <p>{postingError}</p>
              {purchaseResult ? (
                <p className="text-xs text-muted-foreground">
                  The purchase is recorded. Do not re-import this invoice; review its stock movements and barcodes in
                  import history.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Your Excel and uploaded pictures are retained for retry. Check whether the previous request posted
                    before retrying with the same invoice and request ID.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={() => void checkPurchaseStatus()}>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Check whether receipt was posted
                  </Button>
                </>
              )}
            </div>
          )}
          {purchaseResult && (
            <div className="rounded-md border p-3 text-sm">
              <strong>Purchase successfully recorded.</strong> Voucher #{purchaseResult.voucherId} ·{" "}
              {purchaseResult.items.length} variants · {purchaseResult.currency} {purchaseResult.purchaseTotal} credited
              to supplier.
              <p className="text-xs text-muted-foreground">
                Barcodes are saved. You can print or skip received-unit labels without affecting the posted stock or
                supplier balance.
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {purchaseResult && (
              <Button type="button" variant="outline" onClick={startNextDelivery}>
                {partialReceipt ? "Start next delivery" : "New supplier import"}
              </Button>
            )}
            {purchaseResult && receiptLabelItems.length > 0 && (
              <Button type="button" variant="outline" onClick={() => setReceiptLabelsOpen(true)}>
                <Printer className="mr-2 h-4 w-4" />
                Print received labels
              </Button>
            )}
            <Button
              type="button"
              disabled={!readyForPosting || saveMutation.isPending || Boolean(purchaseResult)}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending
                ? "Processing…"
                : purchaseResult
                  ? "Purchase recorded"
                  : "Confirm supplier purchase"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <RetailSupplierImportHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        companyId={companyId}
        onReprint={(items) => {
          setReceiptLabelItems(items);
          setHistoryOpen(false);
          setReceiptLabelsOpen(true);
        }}
      />
      <RetailLabelPrintDialog
        open={receiptLabelsOpen}
        onOpenChange={setReceiptLabelsOpen}
        items={receiptLabelItems}
        currency="USD"
        purpose="supplier-receipt"
      />
    </>
  );
}
