/**
 * The three dialogs of the optimized waste dispatch page.
 *
 * Each one stands between a click and something irreversible — writing bales
 * off as waste, deleting a dispatch and restoring its bales, printing the
 * record — so they are kept together and given the figures to display rather
 * than the state to read. The page owns the state; these only render it and
 * report back which button was pressed.
 *
 * Extracted from WasteDispatchOptimized.tsx during the god-file split.
 */
import { Loader2, Trash2 } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { printDispatchDocument } from "./optimizedPrint";
import type { HistoryBale, PrintDispatch } from "./optimizedTypes";
import { fmt, fmtKg } from "./utils";

export function ConfirmDisposalDialog({
  open,
  onOpenChange,
  baleCount,
  weight,
  cost,
  dispatchDate,
  notes,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baleCount: number;
  weight: number;
  cost: number;
  dispatchDate: string;
  notes: string;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" /> Confirm Waste Disposal
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            You are about to remove the selected bales from stock as waste.
          </p>
          <div className="space-y-1.5 rounded-md border border-destructive/20 bg-destructive/5 p-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Bales</span>
              <span className="font-medium">{baleCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Weight</span>
              <span className="font-medium">{fmtKg(weight)} kg</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Cost Written Off</span>
              <span className="font-medium text-destructive">{fmt(cost)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Date</span>
              <span className="font-medium">{dispatchDate}</span>
            </div>
            {notes && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Notes</span>
                <span className="max-w-xs text-right font-medium">{notes}</span>
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending || baleCount === 0}
            data-testid="button-confirm-dispatch"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" /> Confirm Disposal
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDispatchDialog({
  dispatchId,
  onClose,
  isPending,
  onConfirm,
}: {
  dispatchId: number | null;
  onClose: () => void;
  isPending: boolean;
  onConfirm: (dispatchId: number) => void;
}) {
  return (
    <Dialog
      open={dispatchId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" /> Delete Waste Dispatch?
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This will delete the dispatch record, restore all linked bales to stock, and remove its daybook entry.
        </p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isPending}
            onClick={() => {
              if (dispatchId !== null) onConfirm(dispatchId);
            }}
            data-testid="button-confirm-delete-dispatch"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting...
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" /> Delete &amp; Restore Bales
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PrintDispatchDialog({
  printData,
  onClose,
}: {
  printData: { dispatch: PrintDispatch; bales: HistoryBale[] } | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={printData !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Waste Dispatch Created</DialogTitle>
        </DialogHeader>
        {printData && (
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Dispatch:</span> {printData.dispatch.dispatchNumber}
            </p>
            <p>
              <span className="text-muted-foreground">Bales:</span> {printData.bales.length}
            </p>
            <p>
              <span className="text-muted-foreground">Weight:</span>{" "}
              {fmtKg(printData.bales.reduce((sum, bale) => sum + bale.weightKg, 0))} kg
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <ExportButton
            kind="print"
            variant="default"
            onClick={() => {
              if (printData) printDispatchDocument(printData.dispatch, printData.bales);
            }}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
