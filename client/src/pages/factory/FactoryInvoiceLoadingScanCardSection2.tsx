// Extracted from ./FactoryInvoiceLoadingScan.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle, Play } from "lucide-react";
import { useFactoryInvoiceLoadingScanState } from "./useFactoryInvoiceLoadingScanState";

export function FactoryInvoiceLoadingScanCardSection({
  activeSessionId,
  doneLineCount,
  pendingLines,
  setBaleRefLine,
}: Pick<
  ReturnType<typeof useFactoryInvoiceLoadingScanState>,
  "activeSessionId" | "doneLineCount" | "pendingLines" | "setBaleRefLine"
>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Remaining Lines</CardTitle>
          {doneLineCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400 font-medium">
              <CheckCircle className="h-3.5 w-3.5" />
              {doneLineCount} line{doneLineCount !== 1 ? "s" : ""} fully loaded
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {pendingLines.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-green-700 dark:text-green-400">
            <CheckCircle className="h-5 w-5" />
            <span className="font-medium text-sm">All lines fully loaded</span>
          </div>
        ) : (
          <div className="table-responsive">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Article Code</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Invoice Qty</TableHead>
                  <TableHead className="text-right">Loaded</TableHead>
                  {activeSessionId && <TableHead className="text-right">This Session</TableHead>}
                  <TableHead className="text-right">Remaining</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingLines.map((line) => (
                  <TableRow key={line.lineId} data-testid={`row-line-${line.lineId}`}>
                    <TableCell className="font-mono text-xs">{line.articleCode}</TableCell>
                    <TableCell className="text-sm">
                      <button
                        className="text-left hover-elevate rounded-md px-1 -mx-1 py-0.5 font-medium underline-offset-2 hover:underline"
                        onClick={() => setBaleRefLine({ code: line.articleCode, name: line.productName })}
                        data-testid={`button-scan-bale-refs-${line.lineId}`}
                        title="Click to see all reference numbers"
                      >
                        {line.productName}
                      </button>
                    </TableCell>
                    <TableCell className="text-right text-sm">{line.invoiceQty}</TableCell>
                    <TableCell className="text-right text-sm text-green-700 dark:text-green-400">
                      {line.alreadyLoaded}
                    </TableCell>
                    {activeSessionId && (
                      <TableCell className="text-right text-sm text-blue-700 dark:text-blue-400">
                        {line.currentSessionLoaded}
                      </TableCell>
                    )}
                    <TableCell className="text-right text-sm font-bold text-amber-700 dark:text-amber-400">
                      {line.remaining}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FactoryInvoiceLoadingScanCardSection2({
  autosaveForm,
  createSessionMutation,
  driverName,
  notes,
  setDriverName,
  setNotes,
  setShowStartForm,
  setTruckNo,
  showStartForm,
  truckNo,
}: Pick<
  ReturnType<typeof useFactoryInvoiceLoadingScanState>,
  | "autosaveForm"
  | "createSessionMutation"
  | "driverName"
  | "notes"
  | "setDriverName"
  | "setNotes"
  | "setShowStartForm"
  | "setTruckNo"
  | "showStartForm"
  | "truckNo"
>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Start New Loading Session</CardTitle>
          {!showStartForm && (
            <Button size="sm" onClick={() => setShowStartForm(true)} data-testid="button-show-start-form">
              <Play className="h-4 w-4 mr-1" />
              Start Loading
            </Button>
          )}
        </div>
      </CardHeader>
      {showStartForm && (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="input-truck-no">Truck No.</Label>
              <Input
                id="input-truck-no"
                placeholder="e.g. ABC-1234"
                value={truckNo}
                onChange={(e) => {
                  setTruckNo(e.target.value);
                  autosaveForm({ truckNo: e.target.value });
                }}
                data-testid="input-truck-no"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="input-driver-name">Driver Name</Label>
              <Input
                id="input-driver-name"
                placeholder="Driver's name"
                value={driverName}
                onChange={(e) => {
                  setDriverName(e.target.value);
                  autosaveForm({ driverName: e.target.value });
                }}
                data-testid="input-driver-name"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-notes">Notes</Label>
            <Textarea
              id="input-notes"
              placeholder="Optional notes..."
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                autosaveForm({ notes: e.target.value });
              }}
              data-testid="input-notes"
              className="resize-none"
              rows={2}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => createSessionMutation.mutate()}
              disabled={createSessionMutation.isPending}
              data-testid="button-create-session"
            >
              <Play className="h-4 w-4 mr-1" />
              {createSessionMutation.isPending ? "Starting…" : "Start Session"}
            </Button>
            <Button variant="ghost" onClick={() => setShowStartForm(false)} data-testid="button-cancel-start-form">
              Cancel
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
