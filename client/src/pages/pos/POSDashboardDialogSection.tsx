// Extracted from ./POSDashboard.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { safeFmtTime, usePOSDashboardState } from "./usePOSDashboardState";

export function POSDashboardSection({
  formatAmount,
  formatDisplayDate,
  shiftHistory,
}: Pick<ReturnType<typeof usePOSDashboardState>, "formatAmount" | "formatDisplayDate" | "shiftHistory">) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Recent Shifts</p>
      <div className="border rounded-xl overflow-hidden">
        <div className="table-responsive">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs hidden sm:table-cell">Duration</TableHead>
                <TableHead className="text-xs text-right">Opening</TableHead>
                <TableHead className="text-xs text-right">Closing</TableHead>
                <TableHead className="text-xs text-right">Sales</TableHead>
                <TableHead className="text-xs hidden sm:table-cell text-right">Variance</TableHead>
                <TableHead className="text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shiftHistory.slice(0, 10).map((shift) => {
                const variance = parseFloat(shift.variance || "0");
                return (
                  <TableRow key={shift.id} data-testid={`row-shift-${shift.id}`}>
                    <TableCell className="text-sm">{formatDisplayDate(shift.openedAt)}</TableCell>
                    <TableCell className="text-sm hidden sm:table-cell text-muted-foreground">
                      {shift.closedAt ? (
                        <>
                          {safeFmtTime(shift.openedAt)} – {safeFmtTime(shift.closedAt)}
                        </>
                      ) : (
                        safeFmtTime(shift.openedAt) + " – Active"
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatAmount(parseFloat(shift.openingCash))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {shift.closingCash ? formatAmount(parseFloat(shift.closingCash)) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {shift.salesTotal ? formatAmount(parseFloat(shift.salesTotal)) : "—"}
                      {shift.salesCount ? (
                        <span className="text-muted-foreground text-xs ml-1">({shift.salesCount})</span>
                      ) : (
                        ""
                      )}
                    </TableCell>
                    <TableCell
                      className={`hidden sm:table-cell text-right font-mono text-sm ${variance !== 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}`}
                    >
                      {shift.variance ? formatAmount(variance) : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={shift.status === "open" ? "default" : "secondary"} className="capitalize">
                        {shift.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shiftHistory.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                    No shift history found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

export function POSDashboardDialogSection({
  closeNotes,
  closeShiftDialog,
  closeShiftMutation,
  closingCash,
  currentShift,
  formatAmount,
  setCloseNotes,
  setCloseShiftDialog,
  setClosingCash,
  toast,
}: Pick<
  ReturnType<typeof usePOSDashboardState>,
  | "closeNotes"
  | "closeShiftDialog"
  | "closeShiftMutation"
  | "closingCash"
  | "currentShift"
  | "formatAmount"
  | "setCloseNotes"
  | "setCloseShiftDialog"
  | "setClosingCash"
  | "toast"
>) {
  return (
    <Dialog open={closeShiftDialog} onOpenChange={setCloseShiftDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End Shift</DialogTitle>
          <DialogDescription>Count your cash drawer and enter the closing amount.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {currentShift && (
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between text-sm">
                <span>Opening Cash:</span>
                <span className="font-mono">{formatAmount(parseFloat(currentShift.openingCash))}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Shift Started:</span>
                <span>{safeFmtTime(currentShift.openedAt)}</span>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="closingCash">Closing Cash Amount</Label>
            <Input
              id="closingCash"
              type="number"
              step="0.01"
              placeholder="0"
              value={closingCash}
              onChange={(e) => setClosingCash(e.target.value)}
              data-testid="input-closing-cash"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="closeNotes">Notes (optional)</Label>
            <Textarea
              id="closeNotes"
              placeholder="Any notes about this shift..."
              value={closeNotes}
              onChange={(e) => setCloseNotes(e.target.value)}
              data-testid="input-close-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCloseShiftDialog(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (!navigator.onLine) {
                toast({
                  title: "Not available offline",
                  description: "Shift operations require a connection",
                  variant: "destructive",
                });
                return;
              }
              closeShiftMutation.mutate();
            }}
            disabled={closeShiftMutation.isPending || !closingCash}
            data-testid="button-confirm-end-shift"
          >
            {closeShiftMutation.isPending ? "Closing..." : "End Shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
