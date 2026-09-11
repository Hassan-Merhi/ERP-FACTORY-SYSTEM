import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import { Check, FileDown, FileSpreadsheet, Loader2, Search, TrendingDown, TrendingUp, Upload, X } from "lucide-react";
import type { useDataToolsModel } from "./useDataToolsModel";

type Props = {
  model: ReturnType<typeof useDataToolsModel>;
};

export function SilentProductionDialog({ model }: Props) {
  const {
    toast,
    appMode,
    dtCurrentUser,
    locations,
    allStockItems,
    silentLocInventory,
    silentLocInventoryLoading,
    silentProdOpen,
    setSilentProdOpen,
    silentProdType,
    setSilentProdType,
    silentProdLocId,
    setSilentProdLocId,
    silentProdItems,
    setSilentProdItems,
    silentProdSearchTerm,
    setSilentProdSearchTerm,
    silentProdApplying,
    setSilentProdApplying,
    silentProdDone,
    setSilentProdDone,
    silentImportMode,
    setSilentImportMode,
    silentImportPreview,
    setSilentImportPreview,
    silentImportLoading,
    silentImportFileRef,
    downloadSilentTemplate,
    handleSilentImportFile,
    exportSilentExcel,
    exportSilentPDF,
    applySilentImport,
  } = model;

  if (dtCurrentUser?.role !== "Developer" || appMode === "factory") return null;

  return (
    <Dialog
      open={silentProdOpen}
      onOpenChange={(open) => {
        if (!silentProdApplying) {
          if (!open) setSilentProdSearchTerm("");
          setSilentProdOpen(open);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Silent Production / Consumption</DialogTitle>
          <DialogDescription>
            Adjusts inventory directly without creating any accounting or daybook entries. Developer use only.
          </DialogDescription>
        </DialogHeader>

        {silentProdDone > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <Check className="h-5 w-5" />
              <p className="font-semibold">Applied {silentProdDone} item(s) silently</p>
            </div>
            <Button variant="outline" onClick={() => setSilentProdOpen(false)} data-testid="button-silent-prod-close">
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2 border-b pb-3">
              <Button
                variant={!silentImportMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSilentImportMode(false);
                  setSilentImportPreview([]);
                }}
                data-testid="button-mode-manual"
              >
                Manual Entry
              </Button>
              <Button
                variant={silentImportMode ? "default" : "outline"}
                size="sm"
                onClick={() => setSilentImportMode(true)}
                data-testid="button-mode-import"
              >
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />
                Import from Excel
              </Button>
            </div>

            <div className="space-y-1">
              <Label>Location</Label>
              <Select value={silentProdLocId} onValueChange={setSilentProdLocId}>
                <SelectTrigger data-testid="select-silent-prod-location">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!silentImportMode ? (
              <>
                <div className="flex gap-2">
                  <Button
                    variant={silentProdType === "Production" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSilentProdType("Production")}
                    data-testid="button-type-production"
                  >
                    Production (+)
                  </Button>
                  <Button
                    variant={silentProdType === "Consumption" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSilentProdType("Consumption")}
                    data-testid="button-type-consumption"
                  >
                    Consumption (−)
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Items</Label>
                  {silentProdLocId && (
                    <div className="border rounded-md p-3 bg-muted/30 space-y-2">
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Type item name or code to search…"
                          value={silentProdSearchTerm}
                          onChange={(event) => setSilentProdSearchTerm(event.target.value)}
                          className="pl-8"
                          data-testid="input-silent-prod-search"
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto space-y-1">
                        {(() => {
                          const term = silentProdSearchTerm.toLowerCase();
                          if (!term) {
                            return (
                              <div className="text-center text-sm text-muted-foreground py-4">
                                {silentLocInventoryLoading
                                  ? "Loading items…"
                                  : "Type above to search items at this location"}
                              </div>
                            );
                          }
                          const filtered = allStockItems.filter(
                            (stockItem) =>
                              stockItem.name.toLowerCase().includes(term) ||
                              (stockItem.code && stockItem.code.toLowerCase().includes(term))
                          );
                          if (filtered.length === 0) {
                            return <div className="text-center text-sm text-muted-foreground py-4">No items found</div>;
                          }
                          return filtered.map((stockItem) => {
                            const locationRow = silentLocInventory.find(
                              (inventory) => inventory.stockItemId === stockItem.id
                            );
                            const currentQty = locationRow ? parseFloat(locationRow.quantity || "0") : 0;
                            return (
                              <button
                                key={stockItem.id}
                                className="w-full text-left px-2 py-1.5 rounded-md hover-elevate active-elevate-2 flex items-center justify-between gap-2"
                                onClick={() => {
                                  const existingIndex = silentProdItems.findIndex(
                                    (row) => String(row.stockItemId) === String(stockItem.id)
                                  );
                                  if (existingIndex < 0) {
                                    setSilentProdItems((previous) => [
                                      ...previous,
                                      {
                                        stockItemId: String(stockItem.id),
                                        stockItemName: stockItem.name,
                                        quantity: "",
                                        rate: "",
                                        currentQty,
                                      },
                                    ]);
                                  }
                                  setSilentProdSearchTerm("");
                                }}
                                data-testid={`button-silent-prod-search-item-${stockItem.id}`}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium truncate">{stockItem.name}</div>
                                  {stockItem.code && (
                                    <div className="text-xs text-muted-foreground font-mono">{stockItem.code}</div>
                                  )}
                                </div>
                                <div
                                  className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                    currentQty === 0
                                      ? "bg-destructive/10 text-destructive"
                                      : currentQty < 10
                                        ? "bg-chart-3/10 text-chart-3"
                                        : "bg-chart-2/10 text-chart-2"
                                  }`}
                                >
                                  {currentQty.toFixed(0)}
                                </div>
                              </button>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    {silentProdItems.map((item, index) => {
                      const quantity = parseFloat(item.quantity || "0") || 0;
                      const delta = silentProdType === "Production" ? quantity : -quantity;
                      const newQty = (item.currentQty || 0) + delta;
                      return (
                        <div key={index} className="grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-5">
                            <Input
                              readOnly
                              value={item.stockItemName || "Search above and click an item"}
                              placeholder="Search above and click an item"
                              className="w-full"
                              data-testid={`input-silent-prod-item-${index}`}
                              onClick={() => {}}
                            />
                          </div>
                          <div className="col-span-2">
                            <div
                              className="text-right text-sm text-muted-foreground font-mono"
                              data-testid={`text-current-qty-${index}`}
                            >
                              {item.stockItemId ? (item.currentQty || 0).toFixed(0) : "-"}
                            </div>
                            <div className="text-right text-xs text-muted-foreground">Current</div>
                          </div>
                          <div className="col-span-2">
                            <Input
                              type="number"
                              min="0.001"
                              step="0.001"
                              placeholder={silentProdType === "Production" ? "+Qty" : "−Qty"}
                              value={item.quantity}
                              onChange={(event) =>
                                setSilentProdItems((previous) =>
                                  previous.map((row, rowIndex) =>
                                    rowIndex === index ? { ...row, quantity: event.target.value } : row
                                  )
                                )
                              }
                              data-testid={`input-silent-prod-qty-${index}`}
                              className="text-right"
                            />
                          </div>
                          <div className="col-span-2">
                            <div
                              className={`text-right text-sm font-mono font-semibold ${
                                newQty < 0 ? "text-destructive" : "text-foreground"
                              }`}
                              data-testid={`text-new-qty-${index}`}
                            >
                              {item.stockItemId && item.quantity ? newQty.toFixed(0) : "-"}
                            </div>
                            <div className="text-right text-xs text-muted-foreground">New</div>
                          </div>
                          <div className="col-span-1 flex justify-center">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setSilentProdItems((previous) => previous.filter((_, i) => i !== index))}
                              disabled={silentProdItems.length === 1}
                              data-testid={`button-remove-prod-row-${index}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {silentProdType === "Production" && silentProdItems.some((row) => row.stockItemId) && (
                    <div className="space-y-1">
                      {silentProdItems.map(
                        (item, index) =>
                          item.stockItemId && (
                            <div key={index} className="grid grid-cols-12 gap-2 items-center">
                              <div
                                className="col-span-5 text-sm text-muted-foreground truncate"
                                data-testid={`text-rate-item-${index}`}
                              >
                                {item.stockItemName}
                              </div>
                              <div className="col-span-3 col-start-6">
                                <Input
                                  type="number"
                                  placeholder="Rate"
                                  value={item.rate}
                                  onChange={(event) =>
                                    setSilentProdItems((previous) =>
                                      previous.map((row, rowIndex) =>
                                        rowIndex === index ? { ...row, rate: event.target.value } : row
                                      )
                                    )
                                  }
                                  data-testid={`input-silent-prod-rate-${index}`}
                                />
                              </div>
                            </div>
                          )
                      )}
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSilentProdItems((previous) => [
                        ...previous,
                        { stockItemId: "", stockItemName: "", quantity: "", rate: "", currentQty: 0 },
                      ])
                    }
                    data-testid="button-add-prod-row"
                  >
                    Add Item
                  </Button>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setSilentProdOpen(false)}
                    data-testid="button-silent-prod-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={
                      !silentProdLocId ||
                      silentProdItems.every((row) => !row.stockItemId || !row.quantity) ||
                      silentProdApplying
                    }
                    onClick={async () => {
                      const validItems = silentProdItems.filter((row) => row.stockItemId && row.quantity);
                      if (!silentProdLocId || validItems.length === 0) return;
                      setSilentProdApplying(true);
                      try {
                        const res = await apiRequest("POST", "/api/inventory/silent-production", {
                          locationId: silentProdLocId,
                          type: silentProdType,
                          items: validItems.map((row) => ({
                            stockItemId: row.stockItemId,
                            quantity: row.quantity,
                            rate: row.rate || "0",
                          })),
                        });
                        const data = await res.json();
                        setSilentProdDone(data.applied || validItems.length);
                      } catch (error: unknown) {
                        console.error("Silent production error:", error);
                      } finally {
                        setSilentProdApplying(false);
                      }
                    }}
                    data-testid="button-silent-prod-apply"
                  >
                    {silentProdApplying ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Applying...
                      </>
                    ) : (
                      `Apply ${silentProdType}`
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Upload an Excel file with <strong>Code</strong>, <strong>Name</strong>, <strong>Qty Change</strong>,{" "}
                  <strong>Rate</strong> columns. Positive qty = Production (+), Negative qty = Consumption (−). Both can
                  be in the same file.
                </p>

                {silentImportPreview.length === 0 ? (
                  <div className="space-y-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadSilentTemplate}
                      data-testid="button-download-silent-template"
                    >
                      <FileDown className="h-4 w-4 mr-1" />
                      Download Template
                    </Button>
                    <label
                      className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-md p-8 cursor-pointer hover-elevate text-muted-foreground"
                      data-testid="label-silent-import-dropzone"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!silentProdLocId) {
                          toast({ title: "Select a location first", variant: "destructive" });
                          return;
                        }
                        const file = event.dataTransfer.files[0];
                        if (file) handleSilentImportFile(file);
                      }}
                    >
                      <input
                        ref={silentImportFileRef}
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        data-testid="input-silent-import-file"
                        onChange={(event) => {
                          if (!silentProdLocId) {
                            toast({ title: "Select a location first", variant: "destructive" });
                            return;
                          }
                          const file = event.target.files?.[0];
                          if (file) handleSilentImportFile(file);
                          event.target.value = "";
                        }}
                      />
                      <Upload className="h-8 w-8 opacity-40" />
                      <span className="text-sm font-medium">
                        {silentImportLoading ? "Parsing…" : "Click or drag & drop Excel file"}
                      </span>
                      <span className="text-xs">.xlsx / .xls — select a location first</span>
                    </label>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex gap-3 text-xs font-medium">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {silentImportPreview.filter((row) => row.change > 0 && row.status !== "not_found").length}{" "}
                          production
                        </span>
                        <span className="text-destructive">
                          {silentImportPreview.filter((row) => row.change < 0 && row.status !== "not_found").length}{" "}
                          consumption
                        </span>
                        {silentImportPreview.filter((row) => row.status === "not_found").length > 0 && (
                          <span className="text-muted-foreground">
                            {silentImportPreview.filter((row) => row.status === "not_found").length} unmatched
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={exportSilentExcel}
                          data-testid="button-export-silent-excel"
                        >
                          <FileDown className="h-3 w-3 mr-1" />
                          Excel
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={exportSilentPDF}
                          data-testid="button-export-silent-pdf"
                        >
                          <FileDown className="h-3 w-3 mr-1" />
                          PDF
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSilentImportPreview([]);
                            if (silentImportFileRef.current) silentImportFileRef.current.value = "";
                          }}
                          data-testid="button-clear-silent-import"
                        >
                          Clear
                        </Button>
                      </div>
                    </div>

                    <div className="border rounded-md overflow-hidden text-sm">
                      <div className="max-h-[280px] overflow-y-auto">
                        <table className="w-full">
                          <thead className="bg-muted/50 sticky top-0">
                            <tr>
                              <th className="text-left p-2 font-medium">Item</th>
                              <th className="text-right p-2 font-medium">Current</th>
                              <th className="text-right p-2 font-medium">Change</th>
                              <th className="text-right p-2 font-medium">New Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {silentImportPreview.map((row, index) => (
                              <tr key={index} className={`border-t ${row.status === "not_found" ? "opacity-50" : ""}`}>
                                <td className="p-2">
                                  <p className="font-medium truncate max-w-[220px]">{row.stockItemName}</p>
                                  {row.status === "not_found" && (
                                    <p className="text-xs text-destructive">Not found — skipped</p>
                                  )}
                                  {row.status === "to_zero" && (
                                    <p className="text-xs text-amber-600 dark:text-amber-400">Will reach 0</p>
                                  )}
                                </td>
                                <td className="p-2 text-right font-mono text-muted-foreground">
                                  {formatNumber(row.currentQty, 0)}
                                </td>
                                <td
                                  className={`p-2 text-right font-mono font-semibold ${
                                    row.change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                                  }`}
                                >
                                  <span className="inline-flex items-center gap-0.5 justify-end">
                                    {row.change > 0 ? (
                                      <TrendingUp className="h-3 w-3" />
                                    ) : (
                                      <TrendingDown className="h-3 w-3" />
                                    )}
                                    {row.change > 0 ? "+" : ""}
                                    {formatNumber(row.change, 0)}
                                  </span>
                                </td>
                                <td className="p-2 text-right font-mono font-semibold">
                                  {row.status !== "not_found" ? formatNumber(row.newQty, 0) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setSilentProdOpen(false)}
                        data-testid="button-silent-import-cancel"
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={applySilentImport}
                        disabled={
                          silentProdApplying ||
                          silentImportPreview.every((row) => row.status === "not_found") ||
                          !silentProdLocId
                        }
                        data-testid="button-silent-import-apply"
                      >
                        {silentProdApplying ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Applying…
                          </>
                        ) : (
                          "Apply Adjustments"
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
