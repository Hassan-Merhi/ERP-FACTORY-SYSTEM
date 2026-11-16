// Extracted from ./FactorySupplierReturns.tsx to keep that module under the source-size cap.
import { RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFactorySupplierReturnsState } from "./useFactorySupplierReturnsState";

export function FactorySupplierReturnsSection2({
  addManual,
  busy,
  copy,
  manualCode,
  manualQty,
  mapRows,
  rawRows,
  reason,
  receipt,
  returnDate,
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
  upload,
}: Pick<
  ReturnType<typeof useFactorySupplierReturnsState>,
  | "addManual"
  | "busy"
  | "copy"
  | "manualCode"
  | "manualQty"
  | "mapRows"
  | "rawRows"
  | "reason"
  | "receipt"
  | "returnDate"
  | "setAllocations"
  | "setConfirm"
  | "setManualCode"
  | "setManualQty"
  | "setPreview"
  | "setPreviewSupplierId"
  | "setRawRows"
  | "setReason"
  | "setRequestKey"
  | "setReturnDate"
  | "setSourceFile"
  | "setSupplierId"
  | "sourceFile"
  | "supplierId"
  | "suppliers"
  | "upload"
>) {
  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="cursor-pointer inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium">
          <Upload className="h-4 w-4" />
          {copy.upload}
          <input
            type="file"
            accept=".xlsx,.xls"
            className="sr-only"
            onChange={(event) => void upload(event.currentTarget.files?.[0])}
          />
        </label>
        <span className="text-sm text-muted-foreground">{sourceFile || copy.manualEntry}</span>
        <Button onClick={() => void mapRows()} disabled={busy || !rawRows.length}>
          <RefreshCw className="h-4 w-4 mr-2" />
          {copy.map}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-sm space-y-1 sm:col-span-3">
          <span>{copy.filterSupplier}</span>
          <select
            className="flex h-10 w-full max-w-lg rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={supplierId ?? ""}
            disabled={busy || !!receipt}
            onChange={(event) => {
              setSupplierId(Number(event.target.value) || null);
              setPreview([]);
              setAllocations({});
              setPreviewSupplierId(null);
              setConfirm(false);
              setRequestKey(crypto.randomUUID());
            }}
          >
            <option value="">{copy.allSuppliers}</option>
            {(suppliers.data?.rows ?? []).map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
          {suppliers.isError && <span className="text-destructive">{copy.supplierListError}</span>}
        </label>
        <div className="sm:col-span-3 flex flex-wrap items-end gap-3 rounded-md bg-muted/30 p-3">
          <label className="text-sm space-y-1 min-w-52 flex-1">
            <span>{copy.manualArticle}</span>
            <Input
              value={manualCode}
              maxLength={50}
              onChange={(event) => setManualCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addManual();
                }
              }}
              placeholder={copy.manualArticlePlaceholder}
            />
          </label>
          <label className="text-sm space-y-1 w-28">
            <span>{copy.qty}</span>
            <Input value={manualQty} onChange={(event) => setManualQty(event.target.value)} />
          </label>
          <Button variant="outline" type="button" onClick={addManual} disabled={busy || !!receipt}>
            {copy.addArticle}
          </Button>
        </div>
        {rawRows.length > 0 && (
          <div className="sm:col-span-3 flex flex-wrap gap-2 items-center text-sm">
            <span>
              {rawRows.length} {copy.lines} {copy.staged}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!receipt}
              onClick={() => {
                setRawRows([]);
                setPreview([]);
                setAllocations({});
                setConfirm(false);
                setSourceFile("");
                setPreviewSupplierId(null);
                setRequestKey(crypto.randomUUID());
              }}
            >
              {copy.clearRows}
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-sm space-y-1">
          <span>{copy.date}</span>
          <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
        </label>
        <label className="text-sm space-y-1 sm:col-span-2">
          <span>{copy.reason}</span>
          <Input
            placeholder={copy.reasonPlaceholder}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{copy.warning}</p>
    </div>
  );
}
