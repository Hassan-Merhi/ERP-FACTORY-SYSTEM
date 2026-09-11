import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { getErrorDetails } from "@shared/errorUtils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { AlertTriangle, CheckCircle2, Download, Loader2 } from "lucide-react";
import type { useDataToolsModel } from "./useDataToolsModel";

type Props = {
  model: ReturnType<typeof useDataToolsModel>;
};

export function SilentTransferDialog({ model }: Props) {
  const {
    locations,
    silentTransferOpen,
    setSilentTransferOpen,
    silentSrcId,
    setSilentSrcId,
    silentDstId,
    setSilentDstId,
    silentFile,
    setSilentFile,
    silentValidItems,
    setSilentValidItems,
    silentWarnItems,
    setSilentWarnItems,
    silentErrorLines,
    setSilentErrorLines,
    silentIncludeWarnings,
    setSilentIncludeWarnings,
    silentParseError,
    setSilentParseError,
    silentStep,
    setSilentStep,
    isSilentParsing,
    setIsSilentParsing,
    isSilentApplying,
    setIsSilentApplying,
    silentAppliedCount,
    setSilentAppliedCount,
  } = model;

  return (
    <Dialog
      open={silentTransferOpen}
      onOpenChange={(open) => {
        if (!isSilentParsing && !isSilentApplying) setSilentTransferOpen(open);
      }}
    >
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Silent Stock Transfer</DialogTitle>
          <DialogDescription>
            Upload an Excel file to move stock between locations without creating a daybook entry.
          </DialogDescription>
        </DialogHeader>

        {silentStep === "setup" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Source Location</Label>
                <Select value={silentSrcId} onValueChange={setSilentSrcId}>
                  <SelectTrigger data-testid="select-silent-source">
                    <SelectValue placeholder="From location..." />
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
              <div className="space-y-2">
                <Label>Destination Location</Label>
                <Select value={silentDstId} onValueChange={setSilentDstId}>
                  <SelectTrigger data-testid="select-silent-destination">
                    <SelectValue placeholder="To location..." />
                  </SelectTrigger>
                  <SelectContent>
                    {locations
                      .filter((location) => String(location.id) !== silentSrcId)
                      .map((location) => (
                        <SelectItem key={location.id} value={String(location.id)}>
                          {location.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="silent-transfer-file">Excel File</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => window.open("/api/inventory/silent-transfer/template", "_blank")}
                  data-testid="button-silent-transfer-template"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Download Template
                </Button>
              </div>
              <Input
                id="silent-transfer-file"
                type="file"
                accept=".xlsx,.xls"
                onChange={(event) => setSilentFile(event.target.files?.[0] ?? null)}
                data-testid="input-silent-transfer-file"
              />
              {silentFile && <p className="text-sm text-muted-foreground">Selected: {silentFile.name}</p>}
            </div>

            <p className="text-xs text-muted-foreground">
              Template columns: <strong>Barcode</strong> (item code), <strong>Quantity</strong> — duplicate barcodes are
              detected automatically.
            </p>

            {silentParseError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{silentParseError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setSilentTransferOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!silentSrcId || !silentDstId || !silentFile) return;
                  setIsSilentParsing(true);
                  setSilentParseError("");
                  try {
                    const formData = new FormData();
                    formData.append("file", silentFile);
                    formData.append("sourceLocationId", silentSrcId);
                    formData.append("destinationLocationId", silentDstId);
                    const res = await fetch("/api/inventory/silent-transfer/parse", {
                      method: "POST",
                      body: formData,
                      credentials: "include",
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.message);
                    setSilentValidItems(data.validItems || []);
                    setSilentWarnItems(data.warnItems || []);
                    setSilentErrorLines(data.errorLines || []);
                    setSilentIncludeWarnings(false);
                    setSilentStep("validation");
                  } catch (error) {
                    setSilentParseError(getErrorDetails(error).message);
                  } finally {
                    setIsSilentParsing(false);
                  }
                }}
                disabled={!silentSrcId || !silentDstId || !silentFile || isSilentParsing}
                data-testid="button-silent-transfer-parse"
              >
                {isSilentParsing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Validating...
                  </>
                ) : (
                  "Validate File"
                )}
              </Button>
            </DialogFooter>
          </div>
        )}

        {silentStep === "validation" &&
          (() => {
            const applyItems = silentIncludeWarnings ? [...silentValidItems, ...silentWarnItems] : silentValidItems;
            return (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-xs font-medium px-2 py-1">
                    <CheckCircle2 className="h-3 w-3" />
                    {silentValidItems.length} valid
                  </span>
                  {silentWarnItems.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 text-xs font-medium px-2 py-1">
                      <AlertTriangle className="h-3 w-3" />
                      {silentWarnItems.length} insufficient stock
                    </span>
                  )}
                  {silentErrorLines.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 text-xs font-medium px-2 py-1">
                      <AlertTriangle className="h-3 w-3" />
                      {silentErrorLines.length} error{silentErrorLines.length !== 1 ? "s" : ""} (excluded)
                    </span>
                  )}
                </div>

                <div className="max-h-[380px] overflow-y-auto space-y-3 pr-1">
                  {silentErrorLines.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-destructive mb-1">Errors — excluded from transfer</p>
                      <div className="rounded-md border border-destructive/30 overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs py-2 w-14">Row</TableHead>
                              <TableHead className="text-xs py-2">Barcode</TableHead>
                              <TableHead className="text-xs py-2">Reason</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {silentErrorLines.map((errorLine, index: number) => (
                              <TableRow key={index} className="bg-red-50/60 dark:bg-red-950/20">
                                <TableCell className="text-xs py-1.5 text-muted-foreground">
                                  {errorLine.rowNum}
                                </TableCell>
                                <TableCell className="text-xs py-1.5 font-mono">{errorLine.barcode || "—"}</TableCell>
                                <TableCell className="text-xs py-1.5 text-destructive">{errorLine.reason}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {silentWarnItems.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-semibold text-yellow-700 dark:text-yellow-400">
                          Insufficient Stock — will go negative
                        </p>
                        <label className="flex items-center gap-1.5 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={silentIncludeWarnings}
                            onChange={(event) => setSilentIncludeWarnings(event.target.checked)}
                            data-testid="checkbox-include-warnings"
                            className="h-3.5 w-3.5 rounded"
                          />
                          <span className="text-xs text-muted-foreground">Include anyway</span>
                        </label>
                      </div>
                      <div
                        className={`rounded-md border overflow-hidden transition-opacity ${
                          silentIncludeWarnings
                            ? "border-yellow-300 dark:border-yellow-700/50 opacity-100"
                            : "border-muted opacity-60"
                        }`}
                      >
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs py-2">Item</TableHead>
                              <TableHead className="text-right text-xs py-2">Qty</TableHead>
                              <TableHead className="text-right text-xs py-2">Available</TableHead>
                              <TableHead className="text-xs py-2">Issue</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {silentWarnItems.map((item, index: number) => (
                              <TableRow
                                key={index}
                                className={silentIncludeWarnings ? "bg-yellow-50/60 dark:bg-yellow-950/20" : ""}
                              >
                                <TableCell className="py-1.5">
                                  <div className="text-xs font-medium">{item.stockItemName}</div>
                                  <div className="text-xs text-muted-foreground font-mono">{item.barcode}</div>
                                </TableCell>
                                <TableCell className="text-right text-xs py-1.5">
                                  {formatNumber(item.quantity)}
                                </TableCell>
                                <TableCell className="text-right text-xs py-1.5 text-destructive font-medium">
                                  {formatNumber(item.currentStock)}
                                </TableCell>
                                <TableCell className="text-xs py-1.5 text-yellow-700 dark:text-yellow-400">
                                  {item.warnReason}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {silentValidItems.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-green-700 dark:text-green-400 mb-1">
                        Valid — ready to transfer
                      </p>
                      <div className="rounded-md border border-green-200 dark:border-green-800/40 overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs py-2">Item</TableHead>
                              <TableHead className="text-right text-xs py-2">Qty</TableHead>
                              <TableHead className="text-right text-xs py-2">Stock</TableHead>
                              <TableHead className="text-right text-xs py-2">After</TableHead>
                              <TableHead className="text-right text-xs py-2">Rate</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {silentValidItems.map((item, index: number) => (
                              <TableRow key={index} className="bg-green-50/40 dark:bg-green-950/10">
                                <TableCell className="py-1.5">
                                  <div className="text-xs font-medium">{item.stockItemName}</div>
                                  <div className="text-xs text-muted-foreground font-mono">{item.barcode}</div>
                                </TableCell>
                                <TableCell className="text-right text-xs py-1.5">
                                  {formatNumber(item.quantity)}
                                </TableCell>
                                <TableCell className="text-right text-xs py-1.5">
                                  {formatNumber(item.currentStock)}
                                </TableCell>
                                <TableCell className="text-right text-xs py-1.5 text-green-700 dark:text-green-400 font-medium">
                                  {formatNumber(item.afterTransfer)}
                                </TableCell>
                                <TableCell className="text-right text-xs py-1.5 text-muted-foreground">
                                  {formatNumber(item.averageRate, 2)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {silentValidItems.length === 0 && silentWarnItems.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-6">
                      No transferable items found in the file.
                    </p>
                  )}
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setSilentStep("setup")} disabled={isSilentApplying}>
                    Back
                  </Button>
                  <Button
                    onClick={async () => {
                      if (applyItems.length === 0) return;
                      setIsSilentApplying(true);
                      try {
                        const res = await apiRequest("POST", "/api/inventory/silent-transfer/apply", {
                          sourceLocationId: parseInt(silentSrcId),
                          destinationLocationId: parseInt(silentDstId),
                          items: applyItems,
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.message);
                        queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
                        queryClient.invalidateQueries({ queryKey: ["/api/location-summary"] });
                        setSilentAppliedCount(applyItems.length);
                        setSilentStep("done");
                      } catch (error) {
                        setSilentParseError(getErrorDetails(error).message);
                        setSilentStep("setup");
                      } finally {
                        setIsSilentApplying(false);
                      }
                    }}
                    disabled={applyItems.length === 0 || isSilentApplying}
                    data-testid="button-silent-transfer-apply"
                  >
                    {isSilentApplying ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Applying...
                      </>
                    ) : applyItems.length === 0 ? (
                      "No items to transfer"
                    ) : (
                      `Apply Transfer (${applyItems.length} item${applyItems.length !== 1 ? "s" : ""})`
                    )}
                  </Button>
                </DialogFooter>
              </div>
            );
          })()}

        {silentStep === "done" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <div className="text-center">
              <p className="font-semibold text-lg">Transfer Complete</p>
              <p className="text-sm text-muted-foreground">
                {silentAppliedCount} item{silentAppliedCount !== 1 ? "s" : ""} moved silently. No daybook entry was
                created.
              </p>
            </div>
            <Button
              onClick={() => {
                setSilentTransferOpen(false);
                setSilentStep("setup");
                setSilentSrcId("");
                setSilentDstId("");
                setSilentFile(null);
                setSilentValidItems([]);
                setSilentWarnItems([]);
                setSilentErrorLines([]);
                setSilentParseError("");
                setSilentAppliedCount(0);
              }}
              data-testid="button-silent-transfer-close"
            >
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
