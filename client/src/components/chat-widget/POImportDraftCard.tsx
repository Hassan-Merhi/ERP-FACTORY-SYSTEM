import { useState } from "react";
import { useLocation } from "wouter";
import { ShoppingCart, X, Check, Download, Upload, Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { POImportDraft, POImportResult, PODraftLine } from "./chatWidgetTypes";

export function POImportDraftCard({
  draft,
  onConfirm,
  onDismiss,
  isSubmitting,
  result,
  importError,
}: {
  draft: POImportDraft;
  onConfirm: (resolved: unknown) => void;
  onDismiss: () => void;
  isSubmitting: boolean;
  result: POImportResult | null;
  importError: string | null;
}) {
  const [, setLocation] = useLocation();
  const fmt = (n: number | string) =>
    parseFloat(String(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const [supplierId, setSupplierId] = useState<number | null>(draft.supplierId);
  const [poNumber, setPoNumber] = useState(draft.poNumber);
  const [containerNumber, setContainerNumber] = useState(draft.containerNumber);
  const [importDate, setImportDate] = useState(draft.importDate);
  const [lines, setLines] = useState<PODraftLine[]>(draft.lines);
  const [charges, setCharges] = useState(draft.charges);
  const [showCharges, setShowCharges] = useState(false);

  const resolveItem = (idx: number, itemId: number) => {
    const item = draft.allStockItems.find((s) => s.id === itemId);
    setLines((prev) =>
      prev.map((l, i) =>
        i === idx
          ? { ...l, stockItemId: itemId, stockItemName: item?.name || "", itemName: item?.name || l.rawName }
          : l
      )
    );
  };

  const itemsTotal = lines.reduce((s, l) => s + parseFloat(l.qty) * parseFloat(l.rate), 0);
  const chargesTotal =
    charges.freight +
    charges.surcharge +
    charges.fumigation +
    charges.documentCharges -
    charges.discount +
    charges.otherCharges;
  const grandTotal = itemsTotal + chargesTotal;

  const unresolvedCount = lines.filter((l) => !l.stockItemId).length;
  const canImport = supplierId && poNumber && containerNumber && unresolvedCount === 0;

  const handleImport = () => {
    onConfirm({
      poNumber,
      containerNumber,
      importDate,
      currency: draft.currency,
      supplierId,
      lines: lines.map((l) => ({ ...l, itemName: l.itemName || l.rawName })),
      charges,
    });
  };

  return (
    <div
      className="mt-2 rounded-md border border-orange-500/30 bg-orange-500/5 overflow-hidden"
      data-testid="po-import-draft-card"
    >
      <div className="px-3 py-2 bg-orange-500/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-orange-600 dark:text-orange-400 shrink-0" />
          <span className="text-sm font-semibold text-orange-700 dark:text-orange-400">PO Import Preview</span>
          {unresolvedCount > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 text-orange-600 border-orange-400">
              {unresolvedCount} unresolved
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onDismiss}
          data-testid="button-dismiss-po-import"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {result ? (
        <div className="px-3 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Check className="h-4 w-4 text-green-600" />
            <span className="text-sm font-semibold text-green-700 dark:text-green-400">PO Imported Successfully</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">PO Number</span>
            <span className="font-medium">{result.poNumber}</span>
            <span className="text-muted-foreground">Container</span>
            <span className="font-medium">{result.containerNumber}</span>
            <span className="text-muted-foreground">Items</span>
            <span className="font-medium">{result.lineCount}</span>
            <span className="text-muted-foreground">Items Total</span>
            <span className="font-medium">{fmt(result.itemsTotal)}</span>
            <span className="text-muted-foreground">Grand Total</span>
            <span className="font-semibold text-foreground">{fmt(result.grandTotal)}</span>
          </div>
          {result.crossCompany && (
            <p className="text-[11px] text-muted-foreground mt-2 italic">
              Cross-company transfer vouchers created in parent company.
            </p>
          )}
          <div className="flex gap-2 mt-3 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setLocation(`/containers`)}
              data-testid="button-view-po"
            >
              View Containers
            </Button>
          </div>
          {result.availableProformas && result.availableProformas.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Download Verification Excel</p>
              {result.availableProformas.length === 1 ? (
                <a
                  href={`/api/suppliers/${result.supplierId}/containers/${result.containerId}/verification-export.xlsx?proformaId=${result.availableProformas[0].id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs w-full"
                    data-testid="button-download-verification-excel"
                  >
                    <Download className="h-3 w-3 mr-1.5" />
                    {result.availableProformas[0].reference}
                  </Button>
                </a>
              ) : (
                <div className="space-y-1">
                  {result.availableProformas.map((p) => (
                    <a
                      key={p.id}
                      href={`/api/suppliers/${result.supplierId}/containers/${result.containerId}/verification-export.xlsx?proformaId=${p.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full h-7 text-xs justify-start"
                        data-testid={`button-download-proforma-${p.id}`}
                      >
                        <Download className="h-3 w-3 mr-1.5 shrink-0" />
                        {p.reference}
                      </Button>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          {/* PO header fields */}
          <div className="px-3 pt-2 pb-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
            <div>
              <p className="text-[10px] text-muted-foreground mb-0.5">PO Number</p>
              <Input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                className="h-7 text-xs"
                placeholder="PO-2024-001"
                data-testid="input-po-number"
              />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground mb-0.5">Container</p>
              <Input
                value={containerNumber}
                onChange={(e) => setContainerNumber(e.target.value)}
                className="h-7 text-xs"
                placeholder="CONT-001"
                data-testid="input-container-number"
              />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground mb-0.5">Import Date</p>
              <Input
                type="date"
                value={importDate}
                onChange={(e) => setImportDate(e.target.value)}
                className="h-7 text-xs"
                data-testid="input-import-date"
              />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground mb-0.5">
                Supplier {draft.unresolvedSupplier && <span className="text-orange-500">(not matched)</span>}
              </p>
              <Select value={supplierId ? String(supplierId) : ""} onValueChange={(v) => setSupplierId(Number(v))}>
                <SelectTrigger className="h-7 text-xs" data-testid="select-supplier">
                  <SelectValue placeholder={draft.supplierRaw || "Pick supplier"} />
                </SelectTrigger>
                <SelectContent>
                  {draft.allSuppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name} {s.code ? `(${s.code})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Line items */}
          <div className="border-t mt-1">
            <div className="grid grid-cols-[1fr_48px_56px_60px] gap-x-1 px-3 py-1 bg-muted/40 text-[10px] text-muted-foreground font-medium">
              <span>Item</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Rate</span>
              <span className="text-right">Total</span>
            </div>
            <div className="divide-y max-h-52 overflow-y-auto">
              {lines.map((line, i) => (
                <div key={i} className="px-3 py-1.5">
                  {line.stockItemId ? (
                    <div className="grid grid-cols-[1fr_48px_56px_60px] gap-x-1 items-center">
                      <span className="text-xs truncate" title={line.stockItemName || line.rawName}>
                        {line.stockItemName || line.rawName}
                      </span>
                      <span className="text-xs text-right">{parseFloat(line.qty).toLocaleString()}</span>
                      <span className="text-xs text-right">{fmt(line.rate)}</span>
                      <span className="text-xs text-right font-medium">{fmt(line.lineTotal)}</span>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="text-xs text-orange-600 dark:text-orange-400 truncate">
                          {line.rawName} {line.rawCode ? `(${line.rawCode})` : ""}
                        </span>
                        <span className="text-xs text-right shrink-0">{fmt(line.lineTotal)}</span>
                      </div>
                      <Select value="" onValueChange={(v) => resolveItem(i, Number(v))}>
                        <SelectTrigger className="h-6 text-[11px]" data-testid={`select-item-${i}`}>
                          <SelectValue placeholder="Map to stock item..." />
                        </SelectTrigger>
                        <SelectContent>
                          {draft.allStockItems.map((s) => (
                            <SelectItem key={s.id} value={String(s.id)}>
                              {s.name} {s.code ? `(${s.code})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Charges collapsible */}
          <div className="border-t">
            <button
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/30"
              onClick={() => setShowCharges((s) => !s)}
            >
              <span>Charges &amp; Deductions</span>
              <div className="flex items-center gap-1">
                <span className="text-foreground font-medium">{fmt(chargesTotal)}</span>
                {showCharges ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </div>
            </button>
            {showCharges && (
              <div className="px-3 pb-2 grid grid-cols-2 gap-x-3 gap-y-1">
                {(["freight", "surcharge", "fumigation", "documentCharges", "discount", "otherCharges"] as const).map(
                  (key) => (
                    <div key={key}>
                      <p className="text-[10px] text-muted-foreground capitalize mb-0.5">
                        {key === "documentCharges"
                          ? "Doc Charges"
                          : key === "otherCharges"
                            ? "Other"
                            : key.charAt(0).toUpperCase() + key.slice(1)}
                      </p>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={charges[key]}
                        onChange={(e) => setCharges((prev) => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))}
                        className="h-6 text-xs"
                      />
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {/* Totals + Import */}
          <div className="border-t px-3 py-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-0.5">
              <span>Items Total</span>
              <span>{fmt(itemsTotal)}</span>
            </div>
            {chargesTotal !== 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-0.5">
                <span>Charges</span>
                <span>{fmt(chargesTotal)}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm font-semibold mt-1 mb-2">
              <span>Grand Total</span>
              <span>
                {draft.currency} {fmt(grandTotal)}
              </span>
            </div>
            {unresolvedCount > 0 && (
              <p className="text-[11px] text-orange-600 dark:text-orange-400 mb-2">
                {unresolvedCount} item(s) still need to be mapped before importing.
              </p>
            )}
            {!supplierId && (
              <p className="text-[11px] text-orange-600 dark:text-orange-400 mb-2">
                Please select a supplier before importing.
              </p>
            )}
            {importError && (
              <p className="text-[11px] text-red-600 dark:text-red-400 mb-2 bg-red-50 dark:bg-red-950/30 rounded-sm px-2 py-1.5">
                {importError}
              </p>
            )}
            <Button
              size="sm"
              className="w-full h-7 text-xs bg-orange-600 hover:bg-orange-600 text-white"
              onClick={handleImport}
              disabled={!canImport || isSubmitting}
              data-testid="button-confirm-po-import"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Importing...
                </>
              ) : (
                <>
                  <Upload className="h-3 w-3 mr-1" /> Import PO
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
