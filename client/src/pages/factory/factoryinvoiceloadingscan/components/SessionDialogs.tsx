/**
 * The four dialogs of the invoice loading scan page.
 *
 * Two of them confirm something that changes the session's standing — closing
 * it, or cancelling it and releasing its bales — and two only look: at what a
 * past session holds, and at every bale reference behind one invoice line. All
 * four are given the rows to show and a callback for the button pressed, so
 * the page keeps the session state and the mutations and these read none of it.
 *
 * Extracted from FactoryInvoiceLoadingScan.tsx during the god-file split.
 */
import { Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { StatusBadge } from "./StatusBadge";
import type { InvoiceBale, SessionSummary } from "../types";

export function CompleteSessionDialog({
  open,
  onOpenChange,
  sessionId,
  baleCount,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number | null;
  baleCount: number;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Complete loading session?</AlertDialogTitle>
          <AlertDialogDescription>
            This will mark session #{sessionId} as COMPLETED with {baleCount} bale
            {baleCount !== 1 ? "s" : ""}. You can start another session later for remaining bales.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-complete-dialog">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending} data-testid="button-confirm-complete">
            {isPending ? "Completing…" : "Complete Session"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function CancelSessionDialog({
  open,
  onOpenChange,
  sessionId,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number | null;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this loading session?</AlertDialogTitle>
          <AlertDialogDescription>
            Session #{sessionId} will be cancelled. Scanned bales will be kept for audit history but will no longer
            count as loaded. Bales can be re-scanned in a new session.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-cancel-dialog">Keep Session</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground"
            onClick={onConfirm}
            disabled={isPending}
            data-testid="button-confirm-cancel-session"
          >
            {isPending ? "Cancelling…" : "Cancel Session"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SessionBalesDialog({
  sessionId,
  onClose,
  session,
  bales,
  removePending,
  onRemoveBale,
}: {
  sessionId: number | null;
  onClose: () => void;
  session: SessionSummary | undefined;
  bales: InvoiceBale[];
  removePending: boolean;
  onRemoveBale: (baleId: number) => void;
}) {
  return (
    <Dialog
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex flex-wrap items-center gap-2">
            Session #{sessionId}
            {session && <StatusBadge status={session.status} />}
            {session?.truckNo && <span className="font-mono text-sm text-muted-foreground">{session.truckNo}</span>}
            {session?.driverName && <span className="text-sm text-muted-foreground">/ {session.driverName}</span>}
          </DialogTitle>
        </DialogHeader>
        {bales.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No bales found in this session.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {bales.length} bale{bales.length !== 1 ? "s" : ""}. Click the trash icon to remove a bale and return it to
              unloaded.
            </p>
            <div className="table-responsive rounded-md border">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Article</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Weight (kg)</TableHead>
                    <TableHead className="w-8"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...bales]
                    .sort((a, b) => a.baleReference.localeCompare(b.baleReference))
                    .map((b) => (
                      <TableRow key={b.baleId} data-testid={`row-view-session-bale-${b.baleId}`}>
                        <TableCell className="font-mono text-sm">{b.baleReference}</TableCell>
                        <TableCell className="text-xs">{b.articleCode || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{b.productName || "—"}</TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {parseFloat(b.weightKg || "0").toFixed(3)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={removePending}
                            onClick={() => onRemoveBale(b.baleId)}
                            data-testid={`button-delete-session-bale-${b.baleId}`}
                            title="Remove bale and return to unloaded"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReferenceGrid({ title, bales, className }: { title: string; bales: InvoiceBale[]; className: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{title}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {bales.map((b) => (
          <div key={b.baleId} className={className}>
            {b.baleReference}
          </div>
        ))}
      </div>
    </div>
  );
}

export function BaleReferencesDialog({
  line,
  onClose,
  bales,
}: {
  line: { code: string; name: string } | null;
  onClose: () => void;
  bales: InvoiceBale[];
}) {
  const sorted = [...bales].sort((a, b) => a.baleReference.localeCompare(b.baleReference));
  const loaded = sorted.filter((b) => b.loaded);
  const pending = sorted.filter((b) => !b.loaded);

  return (
    <Dialog
      open={line !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {line?.name}
            <span className="ml-2 font-mono text-sm text-muted-foreground">({line?.code})</span>
          </DialogTitle>
        </DialogHeader>
        {line &&
          (sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No bale references found for this item.</p>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {sorted.length} total ·{" "}
                <span className="text-green-700 dark:text-green-400">{loaded.length} loaded</span>
                {pending.length > 0 && (
                  <>
                    {" "}
                    · <span className="text-amber-700 dark:text-amber-400">{pending.length} pending</span>
                  </>
                )}
              </p>
              {loaded.length > 0 && (
                <ReferenceGrid
                  title="Loaded"
                  bales={loaded}
                  className="rounded-md border bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 px-2.5 py-1.5 font-mono text-sm text-center text-green-800 dark:text-green-300"
                />
              )}
              {pending.length > 0 && (
                <ReferenceGrid
                  title="Not Yet Loaded"
                  bales={pending}
                  className="rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-sm text-center"
                />
              )}
            </div>
          ))}
      </DialogContent>
    </Dialog>
  );
}
